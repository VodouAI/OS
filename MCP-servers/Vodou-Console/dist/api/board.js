/**
 * Vodou Board REST API — /api/board/*
 *
 * Handlers talk to board.db via node:sqlite (built-in, sync API).
 * Phase 1 ships 14 endpoints + a long-poll /events route.  WebSocket upgrade
 * lands Day 12 with the dashboard.
 *
 * Auth: Phase 1 accepts the Authorization: Bearer header but doesn't verify.
 *       Day 8 wires in HS256 verification via the shared key in
 *       core.board_config.write_token_key_b64.
 *
 * Mirrors MCP-servers/Vodou-Console/src/api/scheduler.ts shape.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb, getBoardDb } from '../db.js';
import { boardJwtMiddleware } from './board-auth.js';
import { runPlanner } from '../plan-orchestrator.js';
import { surfaceBoardResult } from './board-surface.js';
import { getProject } from '../projects-store.js';
/**
 * Surface a finished board task's result into the shared "Board" chat tab
 * (conversation 'board-chat') so the tab shows worker OUTPUT regardless of which
 * backend ran it — the claude-cli backend writes only to a per-task log file.
 * The actual push (persist + live-broadcast + tab-flag) is implemented in
 * index.ts and injected via setBoardSurfaceImpl(); we just gather title + body.
 */
function surfaceBoardResultToTab(taskId, summary, kind) {
    let title = taskId;
    try {
        const row = getBoardDb()?.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId);
        if (row?.title)
            title = row.title;
    }
    catch { /* board db optional */ }
    const body = summary && summary.trim() ? summary.trim() : (kind === 'done' ? '(no summary)' : '(blocked, no reason given)');
    surfaceBoardResult(taskId, title, body, kind);
}
export const boardRouter = Router();
// ─────────────────────── helpers ──────────────────────────────
function db() {
    const handle = getBoardDb();
    if (!handle) {
        throw new HttpError(503, 'board.db not initialized — run `./do board migrate --init`');
    }
    return handle;
}
class HttpError extends Error {
    status;
    constructor(status, msg) {
        super(msg);
        this.status = status;
    }
}
// Resolve the vodou-core binary location. Release tarballs ship `vodou-core`
// at the project root; dev trees build into `target/release/vodou-core`. The
// default must match the release layout — defaulting to a dev path means
// fresh installs hit ENOENT on the first /api/board/init call.
function resolveCoreBin() {
    if (process.env.VODOU_CORE_BIN)
        return process.env.VODOU_CORE_BIN;
    const root = process.env.VODOU_PROJECT_PATH ?? process.cwd();
    const releasePath = path.join(root, 'vodou-core');
    if (fs.existsSync(releasePath))
        return releasePath;
    // Dev fallback: cargo-built binary in target/release. Keeps `npm run dev`
    // ergonomics working when the binary hasn't been copied to project root.
    const devPath = path.join(root, 'target', 'release', 'vodou-core');
    if (fs.existsSync(devPath))
        return devPath;
    // Last resort — return the release path so the spawn error clearly says
    // "<projectRoot>/vodou-core: ENOENT" instead of a misleading relative dev path.
    return releasePath;
}
function genTaskId() {
    return 't_' + crypto.randomBytes(4).toString('hex');
}
function genRunId() {
    return 'r_' + crypto.randomBytes(8).toString('hex');
}
function emit(taskId, kind, payload, actor) {
    const r = db().prepare(`INSERT INTO task_events (task_id, kind, payload_json, actor) VALUES (?, ?, ?, ?)`).run(taskId, kind, JSON.stringify(payload), actor);
    return Number(r.lastInsertRowid);
}
function principalFromReq(req) {
    return req.principal_id ?? 'http:cli';
}
// ── Board skill-workflow state (a board task running a skill) ──────────────
// Persists the in-flight workflow state across a `pending_approval` pause so a
// resume picks up at the right stopping point. Long-term home is the Rust
// migration (src/board/migrate.rs); ensured here so the gateway can use it now.
let _boardWfTableEnsured = false;
function ensureBoardWorkflowStateTable() {
    if (_boardWfTableEnsured)
        return;
    db().exec(`CREATE TABLE IF NOT EXISTS board_workflow_state (
    task_id       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    skill_name    TEXT NOT NULL,
    state_json    TEXT NOT NULL,
    current_phase INTEGER NOT NULL DEFAULT 0,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
    _boardWfTableEnsured = true;
}
/** A concise topic string for a task (title, falling back to the first line of
 *  the body), used to bind the `{{TOPIC}}` workflow variable when a board task
 *  runs a skill — otherwise skill templates ship the literal `{{TOPIC}}`. */
export function getTaskTopic(taskId) {
    const row = db().prepare(`SELECT title, body FROM tasks WHERE id = ?`).get(taskId);
    const title = (row?.title ?? '').trim();
    if (title)
        return title.slice(0, 500);
    const body = (row?.body ?? '').trim();
    return body ? body.split('\n')[0].slice(0, 500) : '';
}
/** First pinned skill name from a task's skills_json, or null. */
export function getTaskPinnedSkill(taskId) {
    const row = db().prepare(`SELECT skills_json FROM tasks WHERE id = ?`).get(taskId);
    if (!row?.skills_json)
        return null;
    try {
        const arr = JSON.parse(row.skills_json);
        return Array.isArray(arr) && arr.length ? String(arr[0]) : null;
    }
    catch {
        return null;
    }
}
export function saveBoardWorkflowState(taskId, skillName, stateJson, phase) {
    ensureBoardWorkflowStateTable();
    db().prepare(`INSERT INTO board_workflow_state (task_id, skill_name, state_json, current_phase, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(task_id) DO UPDATE SET
       state_json=excluded.state_json, current_phase=excluded.current_phase, updated_at=CURRENT_TIMESTAMP`).run(taskId, skillName, stateJson, phase);
}
export function loadBoardWorkflowState(taskId) {
    ensureBoardWorkflowStateTable();
    return db().prepare(`SELECT skill_name, state_json, current_phase FROM board_workflow_state WHERE task_id = ?`).get(taskId) ?? null;
}
/**
 * Pause a board task into `pending_approval` at a skill stopping point. Stores
 * the menu (title + options) in the approval event metadata so the UI can render
 * choice buttons, and persists the workflow state for resume. Engine-driven —
 * the Runner calls this; it does NOT depend on an LLM tool.
 */
export function pauseTaskForSkillChoice(opts) {
    saveBoardWorkflowState(opts.taskId, opts.skillName, opts.stateJson, opts.phase);
    db().prepare(`UPDATE tasks SET status='pending_approval', updated_at=CURRENT_TIMESTAMP WHERE id = ?`).run(opts.taskId);
    emit(opts.taskId, 'approval_requested', {
        kind: 'skill_stopping_point',
        skill: opts.skillName,
        phase: opts.phase,
        title: opts.title,
        options: opts.options,
        menu: opts.menuMarkdown,
        run_id: opts.runId ?? null,
    }, 'system');
}
/**
 * Finish a skill-driven board task (Layer 2). Closes the open run, moves the
 * task to `done`, clears the claim so the dispatcher won't reclaim it, drops the
 * persisted workflow state, and emits a `completed` event (which the board UI
 * polls on). Kept here, alongside pauseTaskForSkillChoice, so the whole skill
 * lifecycle lives on one side of the DB — symmetric with how it was parked.
 */
export function completeBoardSkillTask(taskId, runId, summary) {
    const d = db();
    if (runId) {
        d.prepare(`UPDATE task_runs SET outcome='completed', ended_at=CURRENT_TIMESTAMP, summary=? WHERE id=? AND ended_at IS NULL`).run(summary.slice(0, 4000), runId);
    }
    d.prepare(`UPDATE tasks SET status='done', claim_lock=NULL, claim_expires_at=NULL, worker_pid=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(taskId);
    d.prepare(`DELETE FROM board_workflow_state WHERE task_id=?`).run(taskId);
    emit(taskId, 'completed', { via: 'skill_workflow', summary: summary.slice(0, 2000), run_id: runId ?? null }, 'system');
}
/**
 * Completion-enforcement fallback for FREEHAND board tasks. A board worker is
 * expected to close itself via board_complete/board_block; if the LLM turn ends
 * with the task still `running` — no completion call, an empty/0-char response
 * (the Kimi failure mode), or a board_complete that itself errored — the run would
 * otherwise stay `running` FOREVER, a zombie that blocks every child task behind it.
 *
 * Called unconditionally after a board-task turn. It is a NO-OP when the task already
 * resolved itself (status != 'running'), so it can't race a board_complete that landed
 * just in time. Otherwise it closes the open run as failed and either REQUEUES (bounded
 * by max_retries, so a transient provider hiccup self-heals) or, once retries are spent,
 * BLOCKS the task for a human. Provider-agnostic — fixes the stall for Kimi and every
 * other provider, not just the one that exposed it.
 */
export function resolveIncompleteBoardTask(taskId, runId, partialOutput) {
    const d = db();
    const row = d.prepare(`SELECT status, consecutive_failures, max_retries FROM tasks WHERE id=?`).get(taskId);
    if (!row || row.status !== 'running')
        return 'noop'; // already completed/blocked itself — don't race it
    const attempt = (row.consecutive_failures ?? 0) + 1;
    const maxRetries = row.max_retries ?? 2;
    const reason = `worker turn ended without board_complete/board_block${partialOutput.trim() ? '' : ' (empty response)'}`;
    if (runId) {
        d.prepare(`UPDATE task_runs SET outcome='failed', ended_at=CURRENT_TIMESTAMP, summary=? WHERE id=? AND ended_at IS NULL`).run(`[auto] ${reason}`.slice(0, 4000), runId);
    }
    if (attempt <= maxRetries) {
        // Requeue: clear the claim so the dispatcher re-claims and re-runs it.
        d.prepare(`UPDATE tasks SET status='ready', claim_lock=NULL, claim_expires_at=NULL, worker_pid=NULL,
         consecutive_failures=?, last_failure_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(attempt, reason, taskId);
        emit(taskId, 'retry_requeued', { reason, attempt, max_retries: maxRetries, run_id: runId ?? null }, 'system');
        return 'requeued';
    }
    // Retries exhausted — block for a human instead of looping or zombie-running forever.
    d.prepare(`UPDATE tasks SET status='blocked', claim_lock=NULL, claim_expires_at=NULL, worker_pid=NULL,
       last_failure_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(reason, taskId);
    emit(taskId, 'blocked', { reason, attempts: attempt, partial_output: partialOutput.slice(0, 2000), run_id: runId ?? null }, 'system');
    return 'blocked';
}
/**
 * Emit an arbitrary task event (durable record in task_events). Used by the
 * skill resume path to record the chosen option + step output per stopping
 * point, so the drawer run view and Board-chat run block can reconstruct the
 * actual path that ran. Best-effort; never throws into the caller.
 */
export function emitTaskEvent(taskId, kind, payload, actor = 'system') {
    try {
        emit(taskId, kind, payload, actor);
    }
    catch (e) {
        console.error(`[board] emitTaskEvent ${kind} failed:`, e?.message ?? e);
    }
}
/** Current run id for a task (for closing the run on skill completion). */
export function getTaskCurrentRunId(taskId) {
    const row = db().prepare(`SELECT current_run_id FROM tasks WHERE id = ?`).get(taskId);
    return row?.current_run_id ?? null;
}
// Phrases a fabricating worker uses when it invents a skill run it never did.
// Matched against a `board_complete` summary — see skillFabricationVerdict.
const SKILL_CLAIM_RE = /ran the .* skill|stopping point|\bchose\b|checkpoints?\b[\s\S]*\bpass|all .* (passed|completed)/i;
/**
 * Layer 3 — anti-fabrication guardrail.
 *
 * A genuine skill run on the board goes through the WORKFLOW ENGINE (Layers
 * 1–2): it parks at a stopping point (`approval_requested` event) and completes
 * via `completeBoardSkillTask` — it never reaches the freehand `board_complete`
 * tool. So if a `board_complete` summary asserts a skill run *and* the task
 * pinned a skill *and* the engine recorded no execution, the worker fabricated
 * it. Return a verdict telling the caller to `board_block` instead of `done`.
 *
 * Fails open (never blocks) on any error or ambiguity — a false block is worse
 * than a missed fabrication, which the engine path already prevents structurally.
 */
export function skillFabricationVerdict(taskId, summary) {
    try {
        const pinned = getTaskPinnedSkill(taskId);
        if (!pinned)
            return { blocked: false, reason: '' }; // no skill expected → nothing to fabricate
        if (loadBoardWorkflowState(taskId))
            return { blocked: false, reason: '' }; // engine run in flight
        const engaged = db().prepare(`SELECT 1 FROM task_events WHERE task_id=? AND kind IN ('approval_requested','approval_granted','completed') AND json_extract(payload_json,'$.via')='skill_workflow' LIMIT 1`).get(taskId)
            ?? db().prepare(`SELECT 1 FROM task_events WHERE task_id=? AND kind='approval_requested' LIMIT 1`).get(taskId);
        if (engaged)
            return { blocked: false, reason: '' }; // skill genuinely engaged the engine
        if (!SKILL_CLAIM_RE.test(summary))
            return { blocked: false, reason: '' };
        const reason = `worker reported running skill "${pinned}" but the engine recorded no execution — no stopping-point gate fired and no workflow state exists. A real skill run pauses at its stopping points for a human choice; this summary describes a run that did not happen. Re-run the task so the skill actually executes; do not summarize fabricated steps or choices.`;
        emit(taskId, 'skill_fabrication_suspected', { skill: pinned, summary: summary.slice(0, 500) }, 'system');
        console.error(`[board-skill] fabrication suspected on ${taskId}: claims "${pinned}" run with no recorded execution → blocking`);
        return { blocked: true, reason };
    }
    catch (e) {
        console.error(`[board-skill] skillFabricationVerdict failed (failing open):`, e?.message ?? e);
        return { blocked: false, reason: '' };
    }
}
/**
 * Shell out to `vodou-core board <args>` and parse stdout JSON. Centralizes
 * the spawn/timeout/error-shape contract so Phase-2 endpoints (complete,
 * approve, deny) share one state-machine source of truth with the CLI/
 * dispatcher (Rust). Returns parsed JSON on success or an Express-ready
 * error object on failure.
 */
function coreCall(args, timeoutMs = 15_000) {
    const binary = resolveCoreBin();
    const fullArgs = ['board', ...args];
    const r = spawnSync(binary, fullArgs, {
        cwd: process.env.VODOU_PROJECT_PATH ?? process.cwd(),
        encoding: 'utf-8',
        timeout: timeoutMs,
    });
    if (r.status !== 0) {
        return {
            ok: false,
            status: 500,
            body: {
                error: `vodou-core board ${args.join(' ')} failed`,
                stderr: (r.stderr ?? '').trim().slice(0, 4096),
                stdout: (r.stdout ?? '').trim().slice(0, 4096),
                exit: r.status,
            },
        };
    }
    const out = (r.stdout ?? '').trim();
    try {
        return { ok: true, data: JSON.parse(out) };
    }
    catch {
        return { ok: true, data: { raw: out, parse_error: true } };
    }
}
function tryOr500(res, fn) {
    try {
        return fn();
    }
    catch (e) {
        if (e instanceof HttpError) {
            res.status(e.status).json({ error: e.message });
        }
        else {
            const msg = e.message ?? String(e);
            console.error('[board.api]', msg);
            res.status(500).json({ error: msg });
        }
    }
}
// ─────────────────────── GET /api/board ───────────────────────
// Returns the board grouped by status column, plus assignee + tenant filter
// lists. The dashboard calls this on every page load + on burst events.
boardRouter.get('/', (req, res) => {
    tryOr500(res, () => {
        const boardId = req.query.board ?? 'default';
        const includeArchived = req.query.include_archived === '1';
        const statusClause = includeArchived ? '' : `AND status != 'archived'`;
        const tasks = db().prepare(`SELECT id, board_id, tenant_id, title, body, status, assignee, priority,
              workspace, current_run_id, claim_lock, claim_expires_at, worker_pid,
              max_runtime_seconds, current_step_key, workflow_template_id,
              created_at, updated_at
         FROM tasks
        WHERE board_id = ? ${statusClause}
        ORDER BY priority DESC, updated_at DESC`).all(boardId);
        // Group by status column
        const columns = {
            plan: [], triage: [], todo: [], ready: [], running: [],
            blocked: [], done: [], archived: [], pending_approval: [],
        };
        for (const t of tasks) {
            (columns[t.status] ?? (columns[t.status] = [])).push(t);
        }
        // Distinct assignees (in-flight) + tenants for filter UIs
        const assignees = db().prepare(`SELECT assignee, COUNT(*) AS n FROM tasks
        WHERE assignee IS NOT NULL AND board_id = ?
        GROUP BY assignee ORDER BY n DESC`).all(boardId);
        const tenants = db().prepare(`SELECT tenant_id, COUNT(*) AS n FROM tasks WHERE board_id = ?
        GROUP BY tenant_id ORDER BY n DESC`).all(boardId);
        res.json({
            board_id: boardId,
            total: tasks.length,
            columns,
            filters: { assignees, tenants },
        });
    });
});
// ─────────────────────── GET /api/board/tasks/:id ─────────────
boardRouter.get('/tasks/:id', (req, res) => {
    tryOr500(res, async () => {
        const { id } = req.params;
        const task = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
        if (!task) {
            res.status(404).json({ error: `task not found: ${id}` });
            return;
        }
        const runs = db().prepare(`SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt_no DESC`).all(id);
        const events = db().prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 50`).all(id);
        const comments = db().prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY id ASC`).all(id);
        const parents = db().prepare(`SELECT parent_id FROM task_links WHERE child_id = ?`).all(id).map((r) => r.parent_id);
        const children = db().prepare(`SELECT child_id FROM task_links WHERE parent_id = ?`).all(id).map((r) => r.child_id);
        // item 14 — the GRAPH runs this task caused, if any. Lives in gateway.db
        // (a different database from the board's), so it is fetched separately and
        // failure is non-fatal: a board card must still open when the graph lane is
        // unavailable. Empty array means "no graph ran", which is the common case
        // and a different statement from "we could not look".
        let graphRuns = [];
        try {
            const { listRunsForBoardTask } = await import('../graph-runs.js');
            graphRuns = listRunsForBoardTask(id);
        }
        catch (err) {
            console.error('[Board] graph runs lookup failed (drawer still renders):', err);
        }
        res.json({ task, runs, events: events.reverse(), comments, parents, children, graphRuns });
    });
});
// ─────────────────────── POST /api/board/tasks ────────────────
// Create a new task. Body: { title, body?, assignee?, parents?, priority?,
// workspace?, status?, tenant_id?, idempotency_key?, max_runtime_seconds?,
// skills?, model_override? }
boardRouter.post('/tasks', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const b = req.body ?? {};
        if (!b.title || typeof b.title !== 'string') {
            throw new HttpError(400, 'title is required');
        }
        const id = genTaskId();
        const board_id = b.board_id ?? 'default';
        const tenant_id = b.tenant_id ?? 'self';
        const workspace = b.workspace ?? 'scratch';
        const priority = Number.isFinite(b.priority) ? b.priority : 50;
        const status = b.status ?? (Array.isArray(b.parents) && b.parents.length > 0 ? 'todo' : 'ready');
        const skills_json = Array.isArray(b.skills) && b.skills.length ? JSON.stringify(b.skills) : null;
        const requires_approval_on = Array.isArray(b.requires_approval_on) && b.requires_approval_on.length
            ? JSON.stringify(b.requires_approval_on) : null;
        const insert = db().prepare(`INSERT INTO tasks (id, board_id, tenant_id, title, body, status, assignee,
                          priority, workspace, skills_json, max_runtime_seconds,
                          max_retries, idempotency_key, model_override,
                          created_by_principal_id, source_conversation_id, source_channel,
                          workflow_template_id, requires_approval_on)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        try {
            insert.run(id, board_id, tenant_id, b.title, b.body ?? null, status, b.assignee ?? null, priority, workspace, skills_json, b.max_runtime_seconds ?? null, b.max_retries ?? null, b.idempotency_key ?? null, b.model_override ?? null, principalFromReq(req), b.source_conversation_id ?? null, b.source_channel ?? 'rest', b.workflow_template_id ?? null, requires_approval_on);
        }
        catch (e) {
            // Idempotency-key UNIQUE violation: silently return the existing row
            if (b.idempotency_key) {
                const existing = db().prepare(`SELECT * FROM tasks WHERE board_id = ? AND idempotency_key = ?`).get(board_id, b.idempotency_key);
                if (existing) {
                    res.json({ task: existing, idempotent_hit: true });
                    return;
                }
            }
            throw e;
        }
        emit(id, 'created', {}, principalFromReq(req));
        // Add parent links if present
        if (Array.isArray(b.parents)) {
            const linkStmt = db().prepare(`INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)`);
            for (const p of b.parents) {
                if (typeof p === 'string' && p !== id) {
                    linkStmt.run(p, id);
                }
            }
        }
        const created = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
        res.json({ task: created });
    });
});
// ─────────────────────── PATCH /api/board/tasks/:id ───────────
boardRouter.patch('/tasks/:id', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const existing = db().prepare(`SELECT id, status FROM tasks WHERE id = ?`).get(id);
        if (!existing) {
            res.status(404).json({ error: `task not found: ${id}` });
            return;
        }
        const b = req.body ?? {};
        const sets = [];
        const binds = [];
        for (const [col, key] of [
            ['title', 'title'],
            ['body', 'body'],
            ['priority', 'priority'],
            ['assignee', 'assignee'],
            ['model_override', 'model_override'],
            ['max_runtime_seconds', 'max_runtime_seconds'],
        ]) {
            if (key in b) {
                sets.push(`${col} = ?`);
                binds.push(b[key]);
            }
        }
        if ('status' in b) {
            sets.push('status = ?');
            binds.push(b.status);
        }
        if ('skills' in b) {
            sets.push('skills_json = ?');
            binds.push(Array.isArray(b.skills) ? JSON.stringify(b.skills) : null);
        }
        if (sets.length === 0) {
            res.json({ task: db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id), unchanged: true });
            return;
        }
        binds.push(id);
        db().prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...binds);
        emit(id, 'edited', { fields: sets.map(s => s.split(' ')[0]) }, principalFromReq(req));
        const updated = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
        res.json({ task: updated });
    });
});
// ─────────────────────── DELETE /api/board/tasks/:id ──────────
// Permanently remove a task and ALL its dependent rows. Hard delete — NOT
// recoverable (Archive = PATCH status='archived' is the soft option). All
// child tables are ON DELETE CASCADE, but we delete them explicitly so this
// works regardless of the connection's foreign_keys pragma state.
function deleteTaskCascade(id) {
    const d = db();
    ensureBoardWorkflowStateTable();
    d.exec('BEGIN');
    try {
        d.prepare(`DELETE FROM board_workflow_state WHERE task_id = ?`).run(id);
        d.prepare(`DELETE FROM task_events   WHERE task_id = ?`).run(id);
        d.prepare(`DELETE FROM task_runs     WHERE task_id = ?`).run(id);
        d.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(id);
        d.prepare(`DELETE FROM task_usage    WHERE task_id = ?`).run(id);
        d.prepare(`DELETE FROM task_links    WHERE parent_id = ? OR child_id = ?`).run(id, id);
        d.prepare(`DELETE FROM tasks         WHERE id = ?`).run(id);
        d.exec('COMMIT');
    }
    catch (e) {
        try {
            d.exec('ROLLBACK');
        }
        catch { /* noop */ }
        throw e;
    }
}
boardRouter.delete('/tasks/:id', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const existing = db().prepare(`SELECT id FROM tasks WHERE id = ?`).get(id);
        if (!existing) {
            res.status(404).json({ error: `task not found: ${id}` });
            return;
        }
        deleteTaskCascade(id);
        res.json({ deleted: id });
    });
});
const planSessions = new Map();
// Resolve a plan's codebase root + display name from either a registered
// project_id OR a free-form project_dir the user typed/dropped.
//   - project_id  → resolved through the projects table (curated, safe).
//   - project_dir → any existing directory on the user's own machine (they
//     explicitly opted out of the registered-project lockdown). Local-first +
//     user-initiated: we only validate it's a real directory, not that it's
//     "allowed". The gateway's board JWT + CSRF write-guard bound who can call
//     this at all.
function resolvePlanProject(projectId, projectDir, prior) {
    if (projectDir) {
        try {
            if (fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()) {
                const name = projectDir.replace(/\/+$/, '').split('/').pop() || projectDir;
                return { root: projectDir, name };
            }
        }
        catch { /* fall through */ }
    }
    if (projectId) {
        try {
            const p = getProject(projectId);
            if (p && p.rootPath && fs.existsSync(p.rootPath))
                return { root: p.rootPath, name: p.name };
        }
        catch { /* fall through */ }
    }
    return { root: prior?.projectRoot, name: prior?.projectName };
}
function genPlanSessionId() {
    return 'plan_' + crypto.randomBytes(6).toString('hex');
}
// POST /api/board/plan/draft — SSE. Body { prompt, planSessionId? }. Runs the
// planner, streaming phase events (`data: {phase,...}\n\n`), and ends with a
// `done` event. Persists the resulting draft for refine (re-POST with the same
// planSessionId) and commit. Uses fetch-stream on the client so it can POST a
// body + carry auth (EventSource can't).
boardRouter.post('/plan/draft', boardJwtMiddleware, async (req, res) => {
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!prompt) {
        res.status(400).json({ error: 'prompt required' });
        return;
    }
    const planSessionId = String(req.body?.planSessionId ?? '').trim() || genPlanSessionId();
    const prior = planSessions.get(planSessionId);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const write = (obj) => {
        try {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
            res.flush?.();
        }
        catch { /* client gone */ }
    };
    // If this session is ALREADY running (e.g. a duplicate submit, or a reconnect
    // that raced), don't start a second planner — replay what we have and let the
    // client poll GET /plan/:id/status for the rest.
    if (prior?.status === 'running') {
        for (const e of prior.events)
            write(e);
        write({ phase: 'reattached', planSessionId });
        try {
            res.end();
        }
        catch { /* noop */ }
        return;
    }
    const conversation = [...(prior?.conversation ?? []), { role: 'user', content: prompt }];
    const { root: projectRoot, name: projectName } = resolvePlanProject(String(req.body?.project_id ?? '').trim() || undefined, String(req.body?.project_dir ?? '').trim() || undefined, prior);
    const session = {
        status: 'running', draft: prior?.draft ?? null, prompt, conversation, events: [], startedAt: Date.now(),
        projectRoot, projectName,
    };
    planSessions.set(planSessionId, session);
    // push = buffer (for re-attach replay) + stream to the live client.
    const push = (obj) => { session.events.push(obj); write(obj); };
    push({ phase: 'session', planSessionId, projectName: projectName ?? null });
    // Client disconnect NO LONGER aborts the planner (issue #3): the run finishes
    // in the background and stores its draft; a returning client replays via
    // GET /plan/:id/status. Bounded by PLAN_TIMEOUT_MS. The AbortController is
    // kept for a future explicit-cancel button, not wired to the socket.
    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    // Run detached from the request — do NOT await, so the response lifecycle and
    // the planner run are decoupled (the request can close while the run lives on).
    runPlanner({
        prompt,
        conversation,
        priorDraft: prior?.draft ?? null,
        signal: ac.signal,
        projectRoot,
        projectName,
        onEvent: (e) => push(e),
    })
        .then((draft) => {
        session.status = 'done';
        session.draft = draft;
        session.conversation = [...conversation, { role: 'assistant', content: draft.summary }];
        push({ phase: 'done', planSessionId, taskCount: draft.tasks.length });
    })
        .catch((e) => {
        session.status = 'error';
        session.error = e.message?.slice(0, 200) ?? 'planner failed';
        push({ phase: 'error', note: session.error });
    })
        .finally(() => { if (!clientGone) {
        try {
            res.end();
        }
        catch { /* noop */ }
    } });
});
// GET /api/board/plan/:sessionId/status — re-attach point (issue #3). Returns
// the buffered run so a client that navigated away and came back can replay the
// whole plan (log + draft), and keep polling while status is 'running'.
boardRouter.get('/plan/:sessionId/status', boardJwtMiddleware, (req, res) => {
    const s = planSessions.get(String(req.params.sessionId));
    if (!s) {
        res.status(404).json({ error: 'unknown plan session' });
        return;
    }
    res.json({
        ok: true,
        status: s.status,
        events: s.events,
        draft: s.status === 'done' ? s.draft : null,
        taskCount: s.draft?.tasks?.length ?? 0,
        error: s.error ?? null,
    });
});
// POST /api/board/plan/commit — Body { planSessionId } (or explicit { tasks: [...] }).
// Creates the ordered tasks in the `plan` column: distinct descending priorities
// (so the column renders in order) + a sequential parent→child chain via
// task_links (step N depends on step N-1), so promotion through the pipeline
// respects the order. Returns the created task ids.
boardRouter.post('/plan/commit', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const planSessionId = String(req.body?.planSessionId ?? '').trim();
        const entry = planSessionId ? planSessions.get(planSessionId) : undefined;
        const bodyTasks = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
        const tasks = entry?.draft?.tasks ?? bodyTasks;
        if (!Array.isArray(tasks) || tasks.length === 0) {
            res.status(400).json({ error: 'no plan to commit (unknown planSessionId and no tasks[])' });
            return;
        }
        const board_id = String(req.body?.board_id ?? 'default');
        // Project-scoped execution: if the plan was scoped to a codebase, run every
        // committed task's worker IN that codebase via the `dir:<abs>` workspace
        // form (resolve_workspace runs the worker there directly). Otherwise the
        // NOT NULL default 'scratch' (an empty per-task dir under the Vodou root).
        // Without this, a plan generated against MTVai produced tasks whose workers
        // ran in Vodou and couldn't find the concepts they were told to build.
        const pr = entry?.projectRoot;
        const workspace = pr && pr.startsWith('/') ? `dir:${pr}` : 'scratch';
        const insert = db().prepare(`INSERT INTO tasks (id, board_id, tenant_id, title, body, status, priority, skills_json, source_channel, workspace)
       VALUES (?,?,?,?,?,?,?,?,?,?)`);
        const linkStmt = db().prepare(`INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)`);
        const created = [];
        let prevId = null;
        tasks.forEach((t, i) => {
            const title = String(t?.title ?? '').trim();
            if (!title)
                return;
            const id = genTaskId();
            const skills_json = Array.isArray(t?.skills) && t.skills.length ? JSON.stringify(t.skills) : null;
            // Distinct, descending, mid-band priorities: the column groups by
            // priority DESC so this preserves the planned order without inflating
            // priority above normal work.
            const priority = 50 + (tasks.length - i);
            insert.run(id, board_id, 'self', title.slice(0, 200), t?.body ?? null, 'plan', priority, skills_json, 'plan', workspace);
            emit(id, 'created', { via: 'planner', planSessionId: planSessionId || null }, principalFromReq(req));
            if (prevId)
                linkStmt.run(prevId, id); // chain: this task depends on the previous one
            created.push(id);
            prevId = id;
        });
        if (planSessionId)
            planSessions.delete(planSessionId);
        res.json({ created, count: created.length });
    });
});
// Bulk hard-delete every task in the given statuses (default: done + archived).
// One-click cleanup of completed clutter.
//
// SCOPED TO ONE BOARD. Every other read route already filters on board_id
// (GET / takes `?board=`), but this one deleted across ALL boards — with a
// single board that was invisible, and the moment a second board exists it is
// silent cross-board data loss: "Clear done" on board A hard-deletes board B's
// finished work, cascade included, with no undo.
//
// `board_id` defaults to 'default', which is exactly the pre-fix behavior on a
// single-board install (every task carries board_id 'default' via the column
// default in migration 001), so this is a no-op for existing users.
boardRouter.post('/tasks/clear', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const allowed = new Set(['plan', 'triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived', 'pending_approval']);
        const requested = Array.isArray(req.body?.statuses) && req.body.statuses.length
            ? req.body.statuses : ['done', 'archived'];
        const statuses = requested.filter((s) => allowed.has(s));
        if (statuses.length === 0) {
            res.status(400).json({ error: 'no valid statuses' });
            return;
        }
        const board_id = String(req.body?.board_id ?? 'default');
        const placeholders = statuses.map(() => '?').join(',');
        const rows = db().prepare(`SELECT id FROM tasks WHERE board_id = ? AND status IN (${placeholders})`).all(board_id, ...statuses);
        for (const row of rows)
            deleteTaskCascade(row.id);
        res.json({ deleted: rows.length, statuses, board_id });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/complete ───
boardRouter.post('/tasks/:id/complete', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const summary = (req.body?.summary ?? '').toString();
        const metadata = req.body?.metadata;
        // Route through `vodou-core board complete --json` so the workflow-advance
        // (§3.5) + approval-gate (§3.4) state machine lives in one place. Without
        // this, dashboard/REST completers bypass both features.
        const args = ['complete', id, '--json'];
        if (summary)
            args.push('--summary', summary);
        if (metadata !== undefined)
            args.push('--metadata', JSON.stringify(metadata));
        const r = coreCall(args);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        surfaceBoardResultToTab(id, summary, 'done');
        res.json(r.data);
    });
});
// ─────────────────────── POST /api/board/tasks/:id/approve ────
// Resume a task suspended in `pending_approval` (Phase 2 §3.4). The actor is
// taken from the JWT principal when available; falls back to the body's `by`
// field. Returns the parsed `vodou-core board approve --json` result.
boardRouter.post('/tasks/:id/approve', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const target = (req.body?.target ?? 'done').toString();
        const by = req.principal_id ?? (req.body?.by ?? 'http:cli').toString();
        const note = req.body?.note;
        const args = ['approve', id, '--target', target, '--by', by];
        if (note)
            args.push('--note', note.toString());
        const r = coreCall(args);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json({ task_id: id, status: target, approved_by: by, raw: r.data });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/deny ───────
// Deny a task suspended in `pending_approval` (Phase 2 §3.4). Transitions
// the task to `blocked` with the reason captured in `approval_denied` event
// payload. `reason` is required in the body.
boardRouter.post('/tasks/:id/deny', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const reason = (req.body?.reason ?? '').toString();
        if (!reason.trim()) {
            res.status(400).json({ error: 'reason required' });
            return;
        }
        const by = req.principal_id ?? (req.body?.by ?? 'http:cli').toString();
        const r = coreCall(['deny', id, '--reason', reason, '--by', by]);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json({ task_id: id, status: 'blocked', denied_by: by, reason });
    });
});
// ─────────────────────── POST /api/board/channel-action ──────
// Receives interactive button payloads from configured chat apps (Slack,
// Discord) and dispatches to /approve or /deny.
//
// Slack: configure your Slack app's Interactivity URL to point here. Set
//   SLACK_SIGNING_SECRET in the gateway env and the receiver verifies the
//   `X-Slack-Signature` + `X-Slack-Request-Timestamp` headers per the
//   official Slack signing-secret scheme. payloads arrive as form-urlencoded
//   `payload=<json>`.
//
// Discord: send the full interaction payload as JSON. Ed25519 verified
//   against DISCORD_PUBLIC_KEY (32-byte hex from the dev portal); unset =
//   accept-all (dev mode). type=1 PING returns type=1 PONG so the
//   interactions URL validates; type=3 message components run approve/deny.
//
// On success, returns 200 with an empty body (Slack) or {type:6} (Discord
// deferred ack). The actual approve/deny is fired and the result event
// will surface back through the notifier on the next tick.
boardRouter.post('/channel-action', (req, res) => {
    tryOr500(res, () => {
        // Slack form-encoded payload check first.
        const slackPayloadRaw = (req.body && typeof req.body === 'object' && 'payload' in req.body)
            ? req.body.payload
            : null;
        if (slackPayloadRaw) {
            // Slack interactive component payload.
            if (!verifySlackSignature(req)) {
                res.status(401).json({ error: 'slack signature verification failed' });
                return;
            }
            const payload = (() => { try {
                return JSON.parse(slackPayloadRaw);
            }
            catch {
                return null;
            } })();
            if (!payload || !Array.isArray(payload.actions) || payload.actions.length === 0) {
                res.status(400).json({ error: 'no actions in payload' });
                return;
            }
            const action = payload.actions[0];
            const taskId = (action.value ?? '').toString();
            const user = (payload.user?.username ?? payload.user?.id ?? 'slack:user').toString();
            if (!taskId.startsWith('t_')) {
                res.status(400).json({ error: 'malformed task id' });
                return;
            }
            if (action.action_id === 'board_approve') {
                const r = coreCall(['approve', taskId, '--target', 'done', '--by', `slack:${user}`]);
                res.status(r.ok ? 200 : 500).send(r.ok ? '' : JSON.stringify(r.body));
                return;
            }
            if (action.action_id === 'board_deny') {
                const r = coreCall(['deny', taskId, '--reason', 'denied via Slack button', '--by', `slack:${user}`]);
                res.status(r.ok ? 200 : 500).send(r.ok ? '' : JSON.stringify(r.body));
                return;
            }
            res.status(400).json({ error: `unknown action_id: ${action.action_id}` });
            return;
        }
        // Discord interaction (JSON body). Verify Ed25519 before doing anything.
        if (!verifyDiscordSignature(req)) {
            res.status(401).json({ error: 'discord signature verification failed' });
            return;
        }
        const body = req.body ?? {};
        // Discord PING (type=1) — respond with PONG (type=1) so the interactions
        // URL validates in the developer portal.
        if (body.type === 1) {
            res.json({ type: 1 });
            return;
        }
        if (body.type === 3 && body.data?.custom_id) {
            const [verb, taskId] = String(body.data.custom_id).split('|');
            const user = body.member?.user?.username ?? body.user?.username ?? 'discord:user';
            if (!taskId?.startsWith('t_')) {
                res.status(400).json({ error: 'malformed custom_id' });
                return;
            }
            if (verb === 'board_approve') {
                const r = coreCall(['approve', taskId, '--target', 'done', '--by', `discord:${user}`]);
                if (!r.ok) {
                    res.status(500).json(r.body);
                    return;
                }
                res.json({ type: 4, data: { content: `✓ Approved ${taskId}`, flags: 64 } });
                return;
            }
            if (verb === 'board_deny') {
                const r = coreCall(['deny', taskId, '--reason', 'denied via Discord button', '--by', `discord:${user}`]);
                if (!r.ok) {
                    res.status(500).json(r.body);
                    return;
                }
                res.json({ type: 4, data: { content: `✗ Denied ${taskId}`, flags: 64 } });
                return;
            }
            res.status(400).json({ error: `unknown verb: ${verb}` });
            return;
        }
        res.status(400).json({ error: 'unrecognized payload — expected Slack interactive or Discord type=3' });
    });
});
function verifySlackSignature(req) {
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret)
        return true; // unset = accept-all (dev mode); production must set.
    const ts = req.header('x-slack-request-timestamp');
    const sig = req.header('x-slack-signature');
    if (!ts || !sig)
        return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > 60 * 5)
        return false; // replay window
    // Slack signs over raw body; we need it as a string. Express doesn't
    // expose raw urlencoded easily — reconstruct from req.body.
    const rawBody = req.body && typeof req.body === 'object'
        ? Object.entries(req.body).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
        : '';
    const base = `v0:${ts}:${rawBody}`;
    const mac = crypto.createHmac('sha256', secret).update(base).digest('hex');
    const expected = `v0=${mac}`;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    }
    catch {
        return false;
    }
}
function verifyDiscordSignature(req) {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey)
        return true; // unset = accept-all (dev mode); production must set.
    const sig = req.header('x-signature-ed25519');
    const ts = req.header('x-signature-timestamp');
    if (!sig || !ts)
        return false;
    const rawBody = req.rawBody;
    if (!rawBody)
        return false;
    try {
        // Node's KeyObject can verify ed25519 directly when given a DER-wrapped
        // raw public key. Discord publishes the 32-byte hex; wrap it as SPKI.
        const rawKey = Buffer.from(publicKey, 'hex');
        if (rawKey.length !== 32)
            return false;
        const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
        const der = Buffer.concat([spkiPrefix, rawKey]);
        const keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        const message = Buffer.concat([Buffer.from(ts, 'utf8'), rawBody]);
        return crypto.verify(null, message, keyObject, Buffer.from(sig, 'hex'));
    }
    catch {
        return false;
    }
}
// ─────────────────────── POST /api/board/tasks/:id/budget ────
// Set per-task budget caps (Phase 2 §3.6). Body fields are optional; any
// omitted cap is left unchanged. Pass `clear: true` to wipe all four caps.
boardRouter.post('/tasks/:id/budget', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const args = ['budget', 'set', id];
        if (req.body?.clear) {
            args.push('--clear');
        }
        else {
            const { usd_cap, usd_soft_cap, tokens_cap, runtime_secs_cap } = req.body ?? {};
            if (typeof usd_cap === 'number')
                args.push('--usd-cap', String(usd_cap));
            if (typeof usd_soft_cap === 'number')
                args.push('--usd-soft-cap', String(usd_soft_cap));
            if (typeof tokens_cap === 'number')
                args.push('--tokens-cap', String(tokens_cap));
            if (typeof runtime_secs_cap === 'number')
                args.push('--runtime-secs-cap', String(runtime_secs_cap));
            if (args.length === 3) {
                res.status(400).json({ error: 'pass at least one of usd_cap, usd_soft_cap, tokens_cap, runtime_secs_cap, or clear:true' });
                return;
            }
        }
        const r = coreCall(args);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json({ task_id: id, ok: true, raw: r.data });
    });
});
// ─────────────────────── GET /api/board/tasks/:id/budget ─────
// Read the budget caps, cumulative spend, and current BudgetState for a task.
boardRouter.get('/tasks/:id/budget', (req, res) => {
    tryOr500(res, () => {
        const r = coreCall(['budget', 'report', req.params.id, '--json']);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json(r.data);
    });
});
// ─────────────────────── POST /api/board/runs/:run_id/spend ──
// Worker-side incremental spend reporter (Phase 2 §3.6). Tokens and USD are
// additive deltas — call once per LLM round-trip.
boardRouter.post('/runs/:run_id/spend', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { run_id } = req.params;
        const tokens = Number(req.body?.tokens ?? 0);
        const usd = Number(req.body?.usd ?? 0);
        if (!Number.isFinite(tokens) || !Number.isFinite(usd)) {
            res.status(400).json({ error: 'tokens and usd must be finite numbers' });
            return;
        }
        const r = coreCall(['run-spend', run_id, '--tokens', String(tokens), '--usd', String(usd)]);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json({ run_id, tokens_delta: tokens, usd_delta: usd });
    });
});
// ─────────────────────── GET /api/board/pending ───────────────
// List tasks currently waiting on approval, oldest first.
boardRouter.get('/pending', (_req, res) => {
    tryOr500(res, () => {
        const r = coreCall(['pending', '--json']);
        if (!r.ok) {
            res.status(r.status).json(r.body);
            return;
        }
        res.json({ pending: r.data });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/block ──────
boardRouter.post('/tasks/:id/block', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const reason = (req.body?.reason ?? '').toString();
        if (!reason) {
            res.status(400).json({ error: 'reason required' });
            return;
        }
        const task = db().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
        if (!task) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        if (task.current_run_id) {
            db().prepare(`UPDATE task_runs SET ended_at = CURRENT_TIMESTAMP, outcome = 'blocked', error = ?
          WHERE id = ?`).run(reason, task.current_run_id);
        }
        db().prepare(`UPDATE tasks SET status = 'blocked', current_run_id = NULL,
                        worker_pid = NULL, claim_lock = NULL,
                        claim_expires_at = NULL, last_failure_error = ?,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(reason, id);
        db().prepare(`INSERT INTO task_comments (task_id, body, author_label) VALUES (?, ?, ?)`).run(id, reason, 'system');
        emit(id, 'blocked', { reason }, principalFromReq(req));
        surfaceBoardResultToTab(id, reason, 'blocked');
        res.json({ task_id: id, status: 'blocked' });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/unblock ────
boardRouter.post('/tasks/:id/unblock', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        db().prepare(`UPDATE tasks SET status = 'ready', consecutive_failures = 0,
                        last_failure_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(id);
        if (req.body?.note) {
            db().prepare(`INSERT INTO task_comments (task_id, body, author_label) VALUES (?, ?, ?)`).run(id, req.body.note, principalFromReq(req));
        }
        emit(id, 'unblocked', { note: req.body?.note ?? null }, principalFromReq(req));
        res.json({ task_id: id, status: 'ready' });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/heartbeat ──
boardRouter.post('/tasks/:id/heartbeat', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const r = db().prepare(`UPDATE tasks SET last_heartbeat_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        if (r.changes === 0) {
            res.status(404).json({ error: 'task not found' });
            return;
        }
        emit(id, 'heartbeat', { note: req.body?.note ?? null }, principalFromReq(req));
        res.json({ task_id: id, heartbeat_at: new Date().toISOString() });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/comments ───
boardRouter.post('/tasks/:id/comments', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const body = (req.body?.body ?? '').toString();
        if (!body) {
            res.status(400).json({ error: 'body required' });
            return;
        }
        const in_reply_to = req.body?.in_reply_to ?? null;
        const r = db().prepare(`INSERT INTO task_comments (task_id, body, author_principal_id, author_label, in_reply_to)
       VALUES (?, ?, ?, ?, ?)`).run(id, body, principalFromReq(req), null, in_reply_to);
        emit(id, 'commented', { comment_id: Number(r.lastInsertRowid) }, principalFromReq(req));
        res.json({ comment_id: Number(r.lastInsertRowid), task_id: id });
    });
});
// ─────────────────────── POST /api/board/tasks/:id/artifacts ──
boardRouter.post('/tasks/:id/artifacts', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        const { kind, value, label } = req.body ?? {};
        if (!kind || !value) {
            res.status(400).json({ error: 'kind + value required' });
            return;
        }
        // Append to the active run's metadata_json under `artifacts[]`.
        const task = db().prepare(`SELECT current_run_id FROM tasks WHERE id = ?`).get(id);
        if (!task?.current_run_id) {
            res.status(409).json({ error: 'no active run; artifacts only attach to running tasks' });
            return;
        }
        const run = db().prepare(`SELECT metadata_json FROM task_runs WHERE id = ?`).get(task.current_run_id);
        const meta = run?.metadata_json ? JSON.parse(run.metadata_json) : {};
        const artifacts = Array.isArray(meta.artifacts) ? meta.artifacts : [];
        artifacts.push({ kind, value, label: label ?? null, at: new Date().toISOString() });
        meta.artifacts = artifacts;
        db().prepare(`UPDATE task_runs SET metadata_json = ? WHERE id = ?`)
            .run(JSON.stringify(meta), task.current_run_id);
        emit(id, 'artifact', { kind, value, label }, principalFromReq(req));
        res.json({ task_id: id, metadata_key: 'artifacts' });
    });
});
// ─────────────────────── POST/DELETE /api/board/links ─────────
boardRouter.post('/links', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const { parent_id, child_id } = req.body ?? {};
        if (!parent_id || !child_id) {
            res.status(400).json({ error: 'parent_id + child_id required' });
            return;
        }
        if (parent_id === child_id) {
            res.status(400).json({ error: 'self-link refused' });
            return;
        }
        // DFS cycle check
        if (pathExists(child_id, parent_id)) {
            res.status(409).json({ error: `cycle: ${child_id} already reaches ${parent_id}` });
            return;
        }
        db().prepare(`INSERT OR IGNORE INTO task_links (parent_id, child_id) VALUES (?, ?)`).run(parent_id, child_id);
        emit(parent_id, 'linked', { child_id }, principalFromReq(req));
        res.json({ ok: true, parent_id, child_id });
    });
});
boardRouter.delete('/links', boardJwtMiddleware, (req, res) => {
    tryOr500(res, () => {
        const parent_id = req.query.parent_id;
        const child_id = req.query.child_id;
        if (!parent_id || !child_id) {
            res.status(400).json({ error: 'parent_id + child_id required as query params' });
            return;
        }
        db().prepare(`DELETE FROM task_links WHERE parent_id = ? AND child_id = ?`).run(parent_id, child_id);
        emit(parent_id, 'unlinked', { child_id }, principalFromReq(req));
        res.json({ ok: true });
    });
});
function pathExists(from, to) {
    const stack = [from];
    const seen = new Set();
    const stmt = db().prepare(`SELECT child_id FROM task_links WHERE parent_id = ?`);
    while (stack.length) {
        const cur = stack.pop();
        if (cur === to)
            return true;
        if (seen.has(cur))
            continue;
        seen.add(cur);
        for (const r of stmt.all(cur)) {
            stack.push(r.child_id);
        }
    }
    return false;
}
// ─────────────────────── GET /api/board/config ────────────────
// Reads board_config from vodou-core.db.
boardRouter.get('/config', (_req, res) => {
    tryOr500(res, () => {
        const rows = getDb().prepare(`SELECT key, value FROM board_config ORDER BY key`).all();
        const obj = {};
        for (const r of rows) {
            obj[r.key] = r.value;
        }
        res.json({ board_config: obj });
    });
});
// ─────────────────────── GET /api/board/stats ─────────────────
boardRouter.get('/stats', (_req, res) => {
    tryOr500(res, () => {
        const byStatus = db().prepare(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`).all();
        const byAssignee = db().prepare(`SELECT assignee, COUNT(*) AS n FROM tasks
        WHERE assignee IS NOT NULL GROUP BY assignee ORDER BY n DESC LIMIT 20`).all();
        const recentRuns = db().prepare(`SELECT outcome, COUNT(*) AS n FROM task_runs
        WHERE ended_at > datetime('now', '-7 days')
        GROUP BY outcome`).all();
        const totalSpend = db().prepare(`SELECT COALESCE(SUM(usd_estimate), 0) AS usd FROM task_usage`).get();
        res.json({
            by_status: byStatus,
            by_assignee: byAssignee,
            runs_last_7d: recentRuns,
            total_spend_usd: totalSpend?.usd ?? 0,
        });
    });
});
// ─────────────────────── POST /api/board/ask ────────────────
// Natural-language Q&A over board state. Shells to `vodou-core board ask`
// (heuristic intent classifier + FTS5 fallback). Phase 1 has no LLM cost;
// Phase 2 adds LLM-router synthesis for fuzzier questions.
//
// POST body: { question: string, board?: string }
// Response: { question, intent, answer, cited_task_ids[], matches[], confidence, cost_usd, duration_ms }
boardRouter.post('/ask', (req, res) => {
    tryOr500(res, () => {
        const question = (req.body?.question ?? '').toString();
        if (!question.trim()) {
            res.status(400).json({ error: 'question is required' });
            return;
        }
        const board = (req.body?.board ?? 'default').toString();
        const binary = resolveCoreBin();
        const r = spawnSync(binary, ['board', 'ask', question, '--board', board, '--json'], {
            cwd: process.env.VODOU_PROJECT_PATH ?? process.cwd(),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (r.status !== 0) {
            res.status(500).json({
                error: 'ask failed',
                stderr: r.stderr,
                stdout: r.stdout,
                exit: r.status,
            });
            return;
        }
        try {
            res.json(JSON.parse(r.stdout.trim()));
        }
        catch {
            res.json({ raw: r.stdout, parse_error: true });
        }
    });
});
// ─────────────────────── POST /api/board/init ────────────────
// First-run helper. Shells to `vodou-core board migrate --init` so the
// dashboard can offer a one-click initialize button instead of throwing
// 503 errors. Idempotent.
boardRouter.post('/init', (_req, res) => {
    try {
        const binary = resolveCoreBin();
        const r = spawnSync(binary, ['board', 'migrate', '--init', '--json'], {
            cwd: process.env.VODOU_PROJECT_PATH ?? process.cwd(),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (r.status !== 0) {
            res.status(500).json({
                error: 'migrate failed',
                stderr: r.stderr,
                stdout: r.stdout,
                exit: r.status,
                hint: `vodou-core spawn failed at ${resolveCoreBin()} — confirm the binary is present at the project root, or set VODOU_CORE_BIN to its absolute path`,
            });
            return;
        }
        let report;
        try {
            report = JSON.parse(r.stdout.trim());
        }
        catch {
            report = { raw: r.stdout };
        }
        res.json({ ok: true, report });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ─────────────────────── POST /api/board/dispatch ─────────────
// Manual dispatcher nudge. Phase 1 calls `vodou-core board dispatch` via shell;
// Day 9 will replace with an in-process scheduler.
boardRouter.post('/dispatch', (req, res) => {
    tryOr500(res, () => {
        const dryRun = req.body?.dry_run === true;
        const max = Number.isFinite(req.body?.max) ? req.body.max : 5;
        const cmd = ['board', 'dispatch', '--max', String(max), '--json'];
        if (dryRun)
            cmd.push('--dry-run');
        const binary = resolveCoreBin();
        const r = spawnSync(binary, cmd, {
            cwd: process.env.VODOU_PROJECT_PATH ?? process.cwd(),
            encoding: 'utf-8',
            timeout: 30_000,
        });
        if (r.status !== 0) {
            res.status(500).json({
                error: 'dispatch failed',
                stderr: r.stderr,
                stdout: r.stdout,
                exit: r.status,
            });
            return;
        }
        try {
            res.json(JSON.parse(r.stdout.trim()));
        }
        catch {
            res.json({ raw: r.stdout, parse_error: true });
        }
    });
});
// ─────────────────────── GET /api/board/events ────────────────
// Long-poll event stream. Returns events newer than `since` (event id).
// Dashboard WS upgrade lands Day 12; Phase 1 polls every 2s.
boardRouter.get('/events', (req, res) => {
    tryOr500(res, () => {
        const since = Number(req.query.since ?? 0) || 0;
        const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
        const taskFilter = req.query.task_id;
        let sql = `SELECT id, task_id, run_id, kind, payload_json, actor, created_at
                 FROM task_events
                WHERE id > ?`;
        const binds = [since];
        if (taskFilter) {
            sql += ` AND task_id = ?`;
            binds.push(taskFilter);
        }
        sql += ` ORDER BY id ASC LIMIT ?`;
        binds.push(limit);
        const rows = db().prepare(sql).all(...binds);
        const last_id = rows.length ? rows[rows.length - 1].id : since;
        // `head` = the true global max event id, independent of since/limit/order.
        // Clients seed their poll cursor from this; `last_id` (max of the *returned*
        // page) is NOT a safe cursor seed — with limit=1 it's the OLDEST row, which
        // makes a client re-fetch the same backlog every poll (board flicker bug).
        const head = db().prepare(`SELECT MAX(id) AS m FROM task_events`).get()?.m ?? since;
        res.json({ since, last_id, head, count: rows.length, events: rows });
    });
});
// ─────────────────────── GET /api/board/tasks/:id/log ─────────
// Tail the worker's log file (last N bytes). Phase 1 = simple file read;
// streaming lands Day 12 with the dashboard.
boardRouter.get('/tasks/:id/log', (req, res) => {
    tryOr500(res, () => {
        const { id } = req.params;
        // `id` is interpolated into a filesystem path below; reject anything that
        // isn't a literal task id (t_ + hex) so `../` traversal can't escape the
        // logs dir and read arbitrary *.log files on disk.
        if (!/^t_[a-f0-9]+$/i.test(id)) {
            res.status(400).json({ error: 'invalid task id' });
            return;
        }
        const maxBytes = Math.min(Number(req.query.bytes ?? 100_000), 1_000_000);
        const root = process.env.VODOU_PROJECT_PATH ?? process.cwd();
        const logPath = path.join(root, '.vodou/board/logs', `${id}.log`);
        if (!fs.existsSync(logPath)) {
            res.status(404).json({ error: 'log not found', expected_path: logPath });
            return;
        }
        const stat = fs.statSync(logPath);
        const start = Math.max(0, stat.size - maxBytes);
        const fd = fs.openSync(logPath, 'r');
        try {
            const n = stat.size - start;
            const buf = Buffer.alloc(n);
            let got = 0;
            while (got < n) {
                const r = fs.readSync(fd, buf, got, n - got, start + got);
                if (r <= 0)
                    break; // short read — slice below so the zero-filled tail isn't sent as NULs
                got += r;
            }
            res.type('text/plain').send(buf.toString('utf8', 0, got));
        }
        finally {
            fs.closeSync(fd);
        }
    });
});
