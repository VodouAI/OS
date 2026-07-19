/**
 * board_show — read the current task's full worker_context blob.
 *
 * Defaults to env's VODOU_BOARD_TASK if no task_id is passed (the typical
 * worker-spawned case). Returns the §6.3 shape from the main plan: task,
 * prior_attempts, parent_handoffs, role_history, comments, memory, budget,
 * workspace_path, model, guidance.
 *
 * Memory section is Phase 2 (always empty in Phase 1). The other sections
 * are populated from board.db / core.principals / core.skills_registry.
 */
import { z } from 'zod';
import { getReadDb } from '../db.js';
import { currentTaskId } from '../gating.js';
export const showInputSchema = z.object({
    task_id: z.string().optional(),
});
const ATTEMPT_CAP = 10;
const COMMENT_CAP = 30;
const ROLE_HISTORY_CAP = 5;
const PARENT_HANDOFF_CAP = 10;
const SUMMARY_CHAR_CAP = 4096;
const BODY_CHAR_CAP = 8192;
const COMMENT_CHAR_CAP = 2048;
export async function handleShow(args) {
    const { task_id } = showInputSchema.parse(args ?? {});
    const id = task_id ?? currentTaskId();
    const db = getReadDb();
    const task = db.prepare(`SELECT id, board_id, tenant_id, title, body, status, assignee, assignee_principal_id,
            priority, workspace, current_run_id, current_step_key, max_runtime_seconds,
            max_retries, budget_tokens_cap, budget_usd_cap, model_override, skills_json,
            requires_approval_on, workflow_template_id, workflow_template_version,
            created_at, updated_at
       FROM tasks WHERE id = ?`).get(id);
    if (!task) {
        return errorOut(`task not found: ${id}`);
    }
    const priorAttempts = db.prepare(`SELECT attempt_no, outcome, summary, error, ended_at
       FROM task_runs
      WHERE task_id = ? AND ended_at IS NOT NULL
   ORDER BY attempt_no DESC
      LIMIT ?`).all(id, ATTEMPT_CAP).map((r) => ({
        attempt_no: r.attempt_no,
        outcome: r.outcome,
        summary: truncate(r.summary, SUMMARY_CHAR_CAP),
        error: truncate(r.error, SUMMARY_CHAR_CAP),
        ended_at: r.ended_at,
    }));
    const parentHandoffs = db.prepare(`SELECT t.id AS task_id, t.title, r.summary, r.metadata_json
       FROM task_links l
       JOIN tasks t ON t.id = l.parent_id
  LEFT JOIN task_runs r ON r.id = t.current_run_id
      WHERE l.child_id = ? AND t.status = 'done'
   ORDER BY t.updated_at DESC
      LIMIT ?`).all(id, PARENT_HANDOFF_CAP).map((r) => ({
        task_id: String(r.task_id),
        title: truncateRequired(r.title, BODY_CHAR_CAP),
        summary: truncate(r.summary, SUMMARY_CHAR_CAP),
        metadata: parseJson(r.metadata_json),
    }));
    const roleHistory = task.assignee
        ? db.prepare(`SELECT t.id AS task_id, t.title, r.summary, t.updated_at AS completed_at
           FROM task_runs r
           JOIN tasks t ON t.id = r.task_id
          WHERE t.assignee = ? AND r.outcome = 'completed' AND t.id != ?
       ORDER BY r.ended_at DESC
          LIMIT ?`).all(task.assignee, id, ROLE_HISTORY_CAP).map((r) => ({
            task_id: String(r.task_id),
            title: truncateRequired(r.title, BODY_CHAR_CAP),
            summary: truncate(r.summary, SUMMARY_CHAR_CAP),
            completed_at: String(r.completed_at),
        }))
        : [];
    const comments = db.prepare(`SELECT body, author_label, author_principal_id, created_at
       FROM task_comments
      WHERE task_id = ?
   ORDER BY id DESC
      LIMIT ?`).all(id, COMMENT_CAP).reverse().map((r) => ({
        body: truncateRequired(r.body, COMMENT_CHAR_CAP),
        author_label: String(r.author_label ?? r.author_principal_id ?? 'unknown'),
        created_at: String(r.created_at),
    }));
    // Cumulative spend on the active run
    const spent = db.prepare(`SELECT COALESCE(SUM(tokens_used), 0) AS tokens, COALESCE(SUM(usd_spent), 0) AS usd
       FROM task_runs WHERE task_id = ?`).get(id) ?? { tokens: 0, usd: 0 };
    // Memory section: Phase 2 ships the hybrid_search pre-injection.
    // Phase 1 returns an empty array; the dispatcher will populate this from
    // memory.db once src/board/context.rs::build_worker_context() is wired (Day 4).
    const memory = [];
    const ctx = {
        task: {
            id: String(task.id),
            title: truncateRequired(task.title, BODY_CHAR_CAP),
            body: truncate(task.body, BODY_CHAR_CAP),
            assignee: task.assignee ?? null,
            priority: Number(task.priority),
            workspace: task.workspace,
            current_step_key: task.current_step_key ?? null,
            skills_loaded: parseJsonArray(task.skills_json),
        },
        prior_attempts: priorAttempts,
        parent_handoffs: parentHandoffs,
        role_history: roleHistory,
        comments,
        memory,
        budget: {
            tokens_cap: task.budget_tokens_cap,
            usd_cap: task.budget_usd_cap,
            tokens_used: spent.tokens,
            usd_spent: spent.usd,
        },
        workspace_path: process.env.VODOU_BOARD_WORKSPACE ?? '<unset>',
        model: task.model_override ?? process.env.VODOU_BOARD_WORKER_MODEL ?? process.env.VODOU_BOARD_MODEL ?? 'sonnet',
        guidance: 'See board-worker SKILL.md for the full lifecycle. Read memory[] first, then work, heartbeat, close.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }] };
}
function truncate(s, cap) {
    if (s == null)
        return null;
    return s.length > cap ? s.slice(0, cap) + '… (truncated)' : s;
}
/** Variant for fields the type system requires non-null. NULL → empty string. */
function truncateRequired(s, cap) {
    if (s == null)
        return '';
    return s.length > cap ? s.slice(0, cap) + '… (truncated)' : s;
}
function parseJson(s) {
    if (!s)
        return null;
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
function parseJsonArray(s) {
    if (!s)
        return [];
    try {
        const v = JSON.parse(s);
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
function errorOut(msg) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
    };
}
