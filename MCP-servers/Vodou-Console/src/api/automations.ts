/**
 * Automations API — CRUD for cross-integration event-driven automations.
 *
 * Integration Hub Phase 3 Item 3 — Phase 3.1 (this file): schema + REST
 * endpoints + validation. No engine yet.
 * Phase 3.2 (Rust): polling tick, diff against state.last_seen_ids,
 *                   chained action execution with template substitution.
 * Phase 3.3 (frontend): UI builder + run-history viewer.
 *
 * Named "automations" to avoid colliding with `workflows.ts` (skill
 * orchestration from PLAN-12; unrelated).
 *
 * Automation shape:
 *   {
 *     name: "echo-new-linear-issues",
 *     description: "optional",
 *     trigger: {
 *       integration: "linear",
 *       tool: "search_issues",
 *       args: { ... },
 *       // optional JSONPath into the array of events returned by the tool;
 *       // engine uses this to compute a dedup key per event.
 *       event_id_path: "$.issues[*].id"
 *     },
 *     actions: [
 *       {
 *         integration: "notion",
 *         tool: "notion-search",
 *         args: { query: "{{trigger.issue.title}}" }    // {{trigger.X}} / {{action<N>.X}}
 *       }
 *     ],
 *     notify: { url: "https://hooks.slack.com/…", template: "New event: {{trigger.title}}" },
 *     interval_minutes: 15,
 *     enabled: 1
 *   }
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';

export const automationsRouter = Router();

// ── Validation ──────────────────────────────────────────────────────────

interface TriggerDef { integration: string; tool: string; args?: unknown; event_id_path?: string }
interface ActionDef { integration: string; tool: string; args?: unknown }
interface NotifyDef { url?: string; template?: string }

function isStringField(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function validateTrigger(t: unknown): { ok: true; value: TriggerDef } | { ok: false; error: string } {
  if (!t || typeof t !== 'object') return { ok: false, error: 'trigger is required (object)' };
  const obj = t as Record<string, unknown>;
  if (!isStringField(obj.integration)) return { ok: false, error: 'trigger.integration must be a non-empty string' };
  if (!isStringField(obj.tool)) return { ok: false, error: 'trigger.tool must be a non-empty string' };
  return {
    ok: true,
    value: {
      integration: obj.integration,
      tool: obj.tool,
      args: obj.args ?? {},
      event_id_path: typeof obj.event_id_path === 'string' ? obj.event_id_path : undefined,
    },
  };
}

function validateActions(a: unknown): { ok: true; value: ActionDef[] } | { ok: false; error: string } {
  if (a === undefined || a === null) return { ok: true, value: [] };
  if (!Array.isArray(a)) return { ok: false, error: 'actions must be an array' };
  const out: ActionDef[] = [];
  for (let i = 0; i < a.length; i++) {
    const step = a[i];
    if (!step || typeof step !== 'object') return { ok: false, error: `actions[${i}] must be an object` };
    const s = step as Record<string, unknown>;
    if (!isStringField(s.integration)) return { ok: false, error: `actions[${i}].integration required` };
    if (!isStringField(s.tool)) return { ok: false, error: `actions[${i}].tool required` };
    out.push({ integration: s.integration, tool: s.tool, args: s.args ?? {} });
  }
  return { ok: true, value: out };
}

function validateNotify(n: unknown): { ok: true; value: NotifyDef | null } | { ok: false; error: string } {
  if (n === undefined || n === null) return { ok: true, value: null };
  if (typeof n !== 'object') return { ok: false, error: 'notify must be an object or null' };
  const obj = n as Record<string, unknown>;
  const out: NotifyDef = {};
  if (obj.url !== undefined) {
    if (typeof obj.url !== 'string') return { ok: false, error: 'notify.url must be a string' };
    out.url = obj.url;
  }
  if (obj.template !== undefined) {
    if (typeof obj.template !== 'string') return { ok: false, error: 'notify.template must be a string' };
    out.template = obj.template;
  }
  return { ok: true, value: out };
}

// ── Row shape helpers ───────────────────────────────────────────────────

interface AutomationRow {
  id: number;
  name: string;
  description: string | null;
  trigger_json: string;
  actions_json: string;
  notify_json: string | null;
  state_json: string | null;
  enabled: number;
  interval_minutes: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  run_count: number;
  post_to_chat: number | null;
  created_at: string;
  updated_at: string | null;
}

function rowToApi(row: AutomationRow) {
  let trigger: unknown = null;
  let actions: unknown = [];
  let notify: unknown = null;
  let state: unknown = {};
  try { trigger = JSON.parse(row.trigger_json); } catch { /* leave null */ }
  try { actions = JSON.parse(row.actions_json); } catch { /* leave empty */ }
  try { notify = row.notify_json ? JSON.parse(row.notify_json) : null; } catch { /* leave null */ }
  try { state = row.state_json ? JSON.parse(row.state_json) : {}; } catch { /* leave empty */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger,
    actions,
    notify,
    state,
    enabled: row.enabled === 1,
    interval_minutes: row.interval_minutes,
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    last_error: row.last_error,
    run_count: row.run_count,
    post_to_chat: row.post_to_chat === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Endpoints ───────────────────────────────────────────────────────────

// GET /api/automations — list
automationsRouter.get('/', (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, name, description, trigger_json, actions_json, notify_json, state_json,
              enabled, interval_minutes, last_run_at, next_run_at, last_error, run_count,
              post_to_chat, created_at, updated_at
         FROM automations
     ORDER BY id DESC`
    ).all() as unknown as AutomationRow[];
    res.json({ count: rows.length, automations: rows.map(rowToApi) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/automations/:id — detail + recent runs
automationsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const row = db.prepare(
      `SELECT id, name, description, trigger_json, actions_json, notify_json, state_json,
              enabled, interval_minutes, last_run_at, next_run_at, last_error, run_count,
              post_to_chat, created_at, updated_at
         FROM automations WHERE id = ?`
    ).get(id) as AutomationRow | undefined;
    if (!row) return res.status(404).json({ error: 'automation not found' });
    const runs = db.prepare(
      `SELECT id, started_at, finished_at, trigger_result, actions_result,
              events_matched, success, error
         FROM automation_runs
        WHERE automation_id = ?
     ORDER BY started_at DESC
        LIMIT 50`
    ).all(id);
    return res.json({ automation: rowToApi(row), runs });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/automations — create
automationsRouter.post('/', (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name required' });

    const tr = validateTrigger(body.trigger);
    if (!tr.ok) return res.status(400).json({ error: tr.error });

    const ac = validateActions(body.actions);
    if (!ac.ok) return res.status(400).json({ error: ac.error });

    const nt = validateNotify(body.notify);
    if (!nt.ok) return res.status(400).json({ error: nt.error });

    const interval = Number.isFinite(body.interval_minutes) && body.interval_minutes > 0
      ? Math.floor(body.interval_minutes)
      : 15;
    const enabled = body.enabled === false ? 0 : 1;
    const postToChat = body.post_to_chat === true ? 1 : 0;
    const description = typeof body.description === 'string' ? body.description : null;

    const db = getDb();
    try {
      const stmt = db.prepare(
        `INSERT INTO automations (name, description, trigger_json, actions_json, notify_json, state_json, enabled, interval_minutes, post_to_chat, next_run_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, datetime('now', '+' || ? || ' minutes'))`
      );
      const result = stmt.run(
        name,
        description,
        JSON.stringify(tr.value),
        JSON.stringify(ac.value),
        nt.value ? JSON.stringify(nt.value) : null,
        enabled,
        interval,
        postToChat,
        interval,
      );
      return res.status(201).json({ id: Number(result.lastInsertRowid), name });
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `automation name "${name}" already exists` });
      }
      throw err;
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// PATCH /api/automations/:id — partial update
automationsRouter.patch('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const body = req.body || {};
    const sets: string[] = [];
    const params: unknown[] = [];

    if (typeof body.name === 'string' && body.name.trim()) {
      sets.push('name = ?'); params.push(body.name.trim());
    }
    if (body.description !== undefined) {
      sets.push('description = ?'); params.push(typeof body.description === 'string' ? body.description : null);
    }
    if (body.trigger !== undefined) {
      const tr = validateTrigger(body.trigger);
      if (!tr.ok) return res.status(400).json({ error: tr.error });
      sets.push('trigger_json = ?'); params.push(JSON.stringify(tr.value));
    }
    if (body.actions !== undefined) {
      const ac = validateActions(body.actions);
      if (!ac.ok) return res.status(400).json({ error: ac.error });
      sets.push('actions_json = ?'); params.push(JSON.stringify(ac.value));
    }
    if (body.notify !== undefined) {
      const nt = validateNotify(body.notify);
      if (!nt.ok) return res.status(400).json({ error: nt.error });
      sets.push('notify_json = ?'); params.push(nt.value ? JSON.stringify(nt.value) : null);
    }
    if (body.interval_minutes !== undefined) {
      const m = Number(body.interval_minutes);
      if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: 'interval_minutes must be > 0' });
      sets.push('interval_minutes = ?'); params.push(Math.floor(m));
    }
    if (body.enabled !== undefined) {
      sets.push('enabled = ?'); params.push(body.enabled ? 1 : 0);
    }
    if (body.post_to_chat !== undefined) {
      sets.push('post_to_chat = ?'); params.push(body.post_to_chat ? 1 : 0);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

    sets.push("updated_at = datetime('now')");
    params.push(id);

    const stmt = db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`);
    const result = stmt.run(...(params as never[]));
    if (result.changes === 0) return res.status(404).json({ error: 'automation not found' });

    return res.json({ id, updated: result.changes });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DELETE /api/automations/:id — cascade-deletes run history
automationsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare('DELETE FROM automations WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'automation not found' });
    return res.json({ id, deleted: true });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/automations/:id/run — manual trigger
// Advances next_run_at to now so the engine picks it up on the next tick (≤60s).
automationsRouter.post('/:id/run', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare(
      "UPDATE automations SET next_run_at = datetime('now') WHERE id = ? AND enabled = 1"
    ).run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'automation not found or disabled' });
    return res.json({ id, queued: true, note: 'Will execute on the next worker tick (≤60s).' });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /api/automations/:id/reset-state — clear last_seen_ids
// Next run becomes a "first run" and re-seeds without firing any actions,
// so historical events don't re-trigger the action chain.
automationsRouter.post('/:id/reset-state', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
    const result = db.prepare(
      "UPDATE automations SET state_json = '{}', last_error = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'automation not found' });
    return res.json({ id, reset: true });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
