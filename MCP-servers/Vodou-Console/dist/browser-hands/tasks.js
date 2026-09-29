/**
 * Browser Hands tasks (PLAN-BROWSER-HANDS §13.1, §13.2, §13.7, §13.8): a browser
 * errand is a state machine that SPANS TURNS, not a long tool call.
 *
 * Why: the phone tunnel runs one turn at a time (tunnel/client.ts inbox/drain),
 * so a task that waited for "yes" inside its turn could never receive it. A
 * gate or a question ENDS the turn (the summary + screenshot is that turn's
 * reply); the task is persisted here; the next inbound message is checked
 * against the suspended task first and resumes it.
 *
 * Gates are their own mechanism, not approvals.ts:
 *   - persisted (survive a gateway restart; approvals.ts is memory-only);
 *   - ONE pending gate per conversation — a new errand while one is pending is
 *     refused/queued, never interleaved (approvals.ts resolves "the newest");
 *   - each gate has a nonce and the exact summary text it asked about; the gate
 *     is consumed atomically BEFORE the click (exactly-once — no double booking);
 *   - they fire regardless of the permissions profile (`full` auto-approves).
 *
 * The tables are this module's own, created on first use (CREATE IF NOT EXISTS),
 * in gateway.db. They are also the receipt (§6.4): every step, every gate, the
 * outcome. Screenshot paths live under .vodou/media/browser/.
 */
import * as crypto from 'crypto';
import { getGatewayDb } from '../db.js';
import { parseApprovalReply } from '../approvals.js';
/** Naive-UTC `YYYY-MM-DD HH:MM:SS`, the repo's time canon (PLAN-TIME-CANON). */
export const utc = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);
export function ensureSchema(db = getGatewayDb()) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS browser_tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      recipe_id TEXT,
      backend TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL DEFAULT '{}',
      gate_json TEXT,
      question_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_tasks_conv ON browser_tasks(conversation_id, status);
    CREATE TABLE IF NOT EXISTS browser_task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      tool TEXT NOT NULL,
      target TEXT,
      decision TEXT NOT NULL,
      outcome TEXT NOT NULL,
      note TEXT,
      screenshot TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_browser_task_steps_task ON browser_task_steps(task_id, idx);
  `);
}
function rowToTask(r) {
    return {
        id: r.id, conversationId: r.conversation_id, goal: r.goal, recipeId: r.recipe_id, backend: r.backend,
        status: r.status, step: r.step, state: JSON.parse(r.state_json || '{}'),
        gate: r.gate_json ? JSON.parse(r.gate_json) : null,
        question: r.question_json ? JSON.parse(r.question_json) : null,
        createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, outcome: r.outcome,
    };
}
export class TaskStore {
    db;
    now;
    constructor(db = getGatewayDb(), now = () => new Date()) {
        this.db = db;
        this.now = now;
        ensureSchema(db);
    }
    /** The conversation's running or suspended task, if any. Expires stale ones first. */
    active(conversationId) {
        this.expireStale();
        const r = this.db.prepare(`SELECT * FROM browser_tasks WHERE conversation_id = ? AND status IN ('running','suspended') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(conversationId);
        return r ? rowToTask(r) : null;
    }
    get(id) {
        const r = this.db.prepare(`SELECT * FROM browser_tasks WHERE id = ?`).get(id);
        return r ? rowToTask(r) : null;
    }
    /** Start a task. One active task per conversation: returns the existing one instead of a second. */
    create(input) {
        const existing = this.active(input.conversationId);
        if (existing)
            return { task: existing, created: false };
        const id = crypto.randomUUID();
        const at = utc(this.now());
        this.db.prepare(`INSERT INTO browser_tasks (id, conversation_id, goal, recipe_id, backend, status, step, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`).run(id, input.conversationId, input.goal, input.recipeId ?? null, input.backend ?? 'local', JSON.stringify(input.state ?? {}), at, at);
        return { task: this.get(id), created: true };
    }
    // Running OR suspended: a gate suspends the task inside act(), and what the caller
    // records right after (the recipe's next step, the loop's history line) must
    // still land — it was silently dropped when this required 'running'. A finished
    // task is never written.
    saveProgress(id, step, state) {
        this.db.prepare(`UPDATE browser_tasks SET step = ?, state_json = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'suspended')`).run(step, JSON.stringify(state), utc(this.now()), id);
    }
    recordStep(taskId, s) {
        this.db.prepare(`INSERT INTO browser_task_steps (task_id, idx, tool, target, decision, outcome, note, screenshot, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(taskId, s.idx, s.tool, s.target ?? null, s.decision, s.outcome, s.note ?? null, s.screenshot ?? null, utc(this.now()));
    }
    steps(taskId) {
        return this.db.prepare(`SELECT * FROM browser_task_steps WHERE task_id = ? ORDER BY id`).all(taskId);
    }
    /** Suspend at a gate. The turn ends; the summary is the reply. Default hold: 10 minutes (§13.1). */
    suspendAtGate(id, g, holdMinutes = 10) {
        const gate = { ...g, nonce: crypto.randomBytes(12).toString('hex'), createdAt: utc(this.now()) };
        const exp = utc(new Date(this.now().getTime() + holdMinutes * 60_000));
        this.db.prepare(`UPDATE browser_tasks SET status = 'suspended', gate_json = ?, question_json = NULL, expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
            .run(JSON.stringify(gate), exp, utc(this.now()), id);
        return gate;
    }
    suspendAtQuestion(id, q, holdMinutes = 10) {
        const question = { ...q, createdAt: utc(this.now()) };
        const exp = utc(new Date(this.now().getTime() + holdMinutes * 60_000));
        this.db.prepare(`UPDATE browser_tasks SET status = 'suspended', question_json = ?, gate_json = NULL, expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
            .run(JSON.stringify(question), exp, utc(this.now()), id);
        return question;
    }
    /**
     * Consume the gate ONCE (exactly-once, §13.2): succeeds only if this nonce is the
     * task's pending, unconsumed gate. Marked consumed before the click happens.
     */
    consumeGate(id, nonce, decision) {
        const t = this.get(id);
        if (!t || t.status !== 'suspended' || !t.gate || t.gate.nonce !== nonce || t.gate.consumedAt)
            return null;
        const gate = { ...t.gate, consumedAt: utc(this.now()), decision };
        const res = this.db.prepare(`UPDATE browser_tasks SET status = 'running', gate_json = ?, expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'suspended' AND json_extract(gate_json, '$.nonce') = ? AND json_extract(gate_json, '$.consumedAt') IS NULL`)
            .run(JSON.stringify(gate), utc(this.now()), id, nonce);
        return res.changes === 1 ? gate : null;
    }
    /**
     * The gate's page is gone (Vodou restarted): retire this nonce WITHOUT acting, so
     * the reply that arrived can never click anything. The loop re-reaches the step
     * and asks again with a new nonce and the current page's summary (§13.2c).
     */
    voidGate(id, nonce) {
        const t = this.get(id);
        if (!t || t.status !== 'suspended' || !t.gate || t.gate.nonce !== nonce || t.gate.consumedAt)
            return null;
        const gate = { ...t.gate, consumedAt: utc(this.now()), decision: 'void' };
        const res = this.db.prepare(`UPDATE browser_tasks SET status = 'running', gate_json = ?, expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'suspended' AND json_extract(gate_json, '$.nonce') = ? AND json_extract(gate_json, '$.consumedAt') IS NULL`)
            .run(JSON.stringify(gate), utc(this.now()), id, nonce);
        return res.changes === 1 ? gate : null;
    }
    answerQuestion(id) {
        const t = this.get(id);
        if (!t || t.status !== 'suspended' || !t.question)
            return null;
        const res = this.db.prepare(`UPDATE browser_tasks SET status = 'running', question_json = NULL, expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'suspended'`).run(utc(this.now()), id);
        return res.changes === 1 ? t.question : null;
    }
    finish(id, status, outcome) {
        this.db.prepare(`UPDATE browser_tasks SET status = ?, outcome = ?, expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running','suspended')`)
            .run(status, outcome.slice(0, 500), utc(this.now()), id);
    }
    /** Suspended tasks past their hold lapse (a restaurant hold does too). Returns the ones that lapsed. */
    expireStale() {
        const now = utc(this.now());
        const rows = this.db.prepare(`SELECT * FROM browser_tasks WHERE status = 'suspended' AND expires_at IS NOT NULL AND expires_at < ?`).all(now);
        if (rows.length)
            this.db.prepare(`UPDATE browser_tasks SET status = 'expired', outcome = 'the hold lapsed before a reply', updated_at = ? WHERE status = 'suspended' AND expires_at IS NOT NULL AND expires_at < ?`).run(now, now);
        return rows.map(rowToTask);
    }
}
// ── Inbound replies ───────────────────────────────────────────────────────────
const STOP_WORDS = ['stop', 'stop it', 'stop that', 'cancel', 'cancel that', 'never mind', 'nevermind', 'abort', 'quit'];
/**
 * Route one inbound message against the conversation's browser task, BEFORE a
 * normal turn (§13.1, §13.7). "stop" always wins, even mid-task. A suspended
 * gate takes a bare yes/no; a suspended question takes a number or the option
 * text. Anything else while a task is suspended is a normal turn (`none`) — the
 * caller mentions the pending errand in its reply; while a task is RUNNING it's
 * `busy` (queued behind the task).
 */
export function routeReply(store, conversationId, raw) {
    const task = store.active(conversationId);
    if (!task)
        return { kind: 'none' };
    const text = String(raw ?? '').trim();
    const lower = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (STOP_WORDS.includes(lower))
        return { kind: 'stop', task };
    if (task.status === 'running')
        return { kind: 'busy', task };
    if (task.gate && !task.gate.consumedAt) {
        const d = parseApprovalReply(text);
        if (d)
            return { kind: 'gate', task, decision: d };
        return { kind: 'none' };
    }
    if (task.question) {
        const opts = task.question.options ?? [];
        const n = /^\s*(\d{1,2})\s*$/.exec(text);
        if (n && opts.length) {
            const i = Number(n[1]) - 1;
            if (i >= 0 && i < opts.length)
                return { kind: 'option', task, choice: opts[i], index: i };
        }
        const hit = opts.findIndex((o) => o.toLowerCase() === lower || o.toLowerCase().replace(/\s+/g, '') === lower.replace(/\s+/g, ''));
        if (hit >= 0)
            return { kind: 'option', task, choice: opts[hit], index: hit };
        if (task.question.kind === 'text' && text)
            return { kind: 'answer', task, text };
    }
    return { kind: 'none' };
}
