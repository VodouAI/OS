/**
 * Automations API — CRUD for cross-integration event-driven automations.
 *
 * Integration Hub Phase 3 Item 3 — Phase 3.1 (this file): validation + REST
 * surface for the console. Phase 3.2 (Rust): polling tick, diff against
 * state.last_seen_ids, chained action execution with template substitution.
 * Phase 3.3 (frontend): UI builder + run-history viewer.
 *
 * PLAN-AUTOMATIONS-WATCH-WHAT-VODOU-KNOWS P5 (2026-09-09) — ONE WRITER. This
 * router no longer touches `automations` itself. It validates the body (the
 * Rust routes accept any JSON for trigger/actions) and forwards to the
 * vodou-core HTTP API (`src/api_http/routes/automations.rs`, the OpenAPI
 * source) through the client that already existed for it in `core-client.ts`
 * and had no callers. Response shapes are unchanged for `automations.js` and
 * `chat.js`: list `{count, automations}`, detail `{automation, runs}`, create
 * `{id, name}` 201, patch `{id, updated}`, delete `{id, deleted}`, run
 * `{id, queued, note}`, reset `{id, reset}`.
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
import { VodouCore } from '../core-client.js';

export const automationsRouter = Router();

// ── Validation ──────────────────────────────────────────────────────────

interface TriggerDef { integration: string; tool: string; args?: unknown; event_id_path?: string }
type ActionDef =
  | { integration: string; tool: string; args?: unknown }
  // P2 — hand the event to a skill (console or file; the gateway resolves which).
  | { kind: 'skill'; skill: string; prompt_template?: string };
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
    if (s.kind === 'skill') {
      if (!isStringField(s.skill)) return { ok: false, error: `actions[${i}].skill required for kind "skill"` };
      out.push({ kind: 'skill', skill: s.skill.trim(), prompt_template: typeof s.prompt_template === 'string' ? s.prompt_template : undefined });
      continue;
    }
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

// ── Forwarding ──────────────────────────────────────────────────────────

/**
 * The core client throws `Error("[vodou-core] GET /x → 404: {...}")` on an
 * HTTP failure and `Error("[vodou-core] GET /x: <error>")` on `ok:false`.
 * Map those back onto the status the caller used to get from this router.
 */
function forwardError(res: Response, err: unknown, fallbackStatus = 502) {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /→ (\d{3}):/.exec(msg);
  let status = m ? Number(m[1]) : fallbackStatus;
  let error = msg;
  if (status === 404 || /automation not found/i.test(msg)) { status = 404; error = 'automation not found'; }
  else if (/UNIQUE/i.test(msg)) { status = 409; error = 'automation name already exists'; }
  else if (m) {
    // Prefer the core's own error text when it sent JSON.
    try { const j = JSON.parse(msg.slice(msg.indexOf('{'))); if (j && typeof j.error === 'string') error = j.error; } catch { /* keep msg */ }
  }
  return res.status(status).json({ error });
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return null; }
  return id;
}

// ── Endpoints ───────────────────────────────────────────────────────────

// GET /api/automations — list
automationsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const data = await VodouCore.listAutomations();
    res.json({ count: data.count, automations: data.automations });
  } catch (err) {
    forwardError(res, err);
  }
});

// GET /api/automations/:id — detail + recent runs
automationsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res); if (id === null) return;
  try {
    const data = await VodouCore.getAutomation(id);
    res.json({ automation: data.automation, runs: data.runs });
  } catch (err) {
    forwardError(res, err);
  }
});

// POST /api/automations — create
automationsRouter.post('/', async (req: Request, res: Response) => {
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
  try {
    const created = await VodouCore.createAutomation({
      name,
      description: typeof body.description === 'string' ? body.description : undefined,
      trigger: tr.value,
      actions: ac.value,
      notify: nt.value ?? undefined,
      interval_minutes: interval,
      enabled: body.enabled !== false,
      post_to_chat: body.post_to_chat === true,
      max_events_per_run: Number.isFinite(body.max_events_per_run) && body.max_events_per_run > 0 ? Math.floor(body.max_events_per_run) : undefined,
    });
    return res.status(201).json({ id: created.id, name: created.name });
  } catch (err) {
    return forwardError(res, err);
  }
});

// PATCH /api/automations/:id — partial update
automationsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res); if (id === null) return;
  const body = req.body || {};
  const params: Parameters<typeof VodouCore.updateAutomation>[1] = {};

  if (typeof body.name === 'string' && body.name.trim()) params.name = body.name.trim();
  if (body.description !== undefined) params.description = typeof body.description === 'string' ? body.description : '';
  if (body.trigger !== undefined) {
    const tr = validateTrigger(body.trigger);
    if (!tr.ok) return res.status(400).json({ error: tr.error });
    params.trigger = tr.value;
  }
  if (body.actions !== undefined) {
    const ac = validateActions(body.actions);
    if (!ac.ok) return res.status(400).json({ error: ac.error });
    params.actions = ac.value;
  }
  if (body.notify !== undefined) {
    const nt = validateNotify(body.notify);
    if (!nt.ok) return res.status(400).json({ error: nt.error });
    params.notify = nt.value;
  }
  if (body.interval_minutes !== undefined) {
    const m = Number(body.interval_minutes);
    if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: 'interval_minutes must be > 0' });
    params.interval_minutes = Math.floor(m);
  }
  if (body.enabled !== undefined) params.enabled = !!body.enabled;
  if (body.post_to_chat !== undefined) params.post_to_chat = !!body.post_to_chat;
  if (body.max_events_per_run !== undefined) {
    const m = Number(body.max_events_per_run);
    if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: 'max_events_per_run must be > 0' });
    params.max_events_per_run = Math.floor(m);
  }
  if (Object.keys(params).length === 0) return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    const r = await VodouCore.updateAutomation(id, params);
    return res.json({ id, updated: r.updated });
  } catch (err) {
    return forwardError(res, err);
  }
});

// DELETE /api/automations/:id — cascade-deletes run history
automationsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res); if (id === null) return;
  try {
    const r = await VodouCore.deleteAutomation(id);
    return res.json({ id, deleted: r.deleted });
  } catch (err) {
    return forwardError(res, err);
  }
});

// POST /api/automations/:id/run — manual trigger
// Advances next_run_at to now so the engine picks it up on the next tick (≤60s).
automationsRouter.post('/:id/run', async (req: Request, res: Response) => {
  const id = parseId(req, res); if (id === null) return;
  try {
    const r = await VodouCore.triggerAutomation(id);
    return res.json({ id, queued: r.queued, note: r.note });
  } catch (err) {
    return forwardError(res, err);
  }
});

// POST /api/automations/:id/reset-state — clear last_seen_ids (and the feed cursor)
// Next run becomes a "first run" and re-seeds without firing any actions,
// so historical events don't re-trigger the action chain.
automationsRouter.post('/:id/reset-state', async (req: Request, res: Response) => {
  const id = parseId(req, res); if (id === null) return;
  try {
    const r = await VodouCore.resetAutomationState(id);
    return res.json({ id, reset: r.reset });
  } catch (err) {
    return forwardError(res, err);
  }
});
