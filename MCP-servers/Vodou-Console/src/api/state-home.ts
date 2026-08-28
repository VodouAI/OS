/**
 * State home — what Vodou DID while nobody was watching.
 *
 * PLAN-CONSOLE-SHOWS-ITS-WORK §4.4, and §1.1 is the test it has to pass:
 *
 *     "If the user never typed anything, would the console still be worth opening?"
 *
 * Today: no. The console renders Vodou as a chat app — a stateless,
 * request-response medium — and competes on the one axis where it structurally
 * cannot win, while hiding the axes where nothing else can compete. On any given
 * morning it has consolidated memory, re-keyed facts, run a health self-test,
 * swept integrations and produced a briefing, and rendered all of it as stderr.
 *
 * This endpoint is ROUTING, NOT NEW CAPABILITY. Every number below is already
 * computed and already logged somewhere; the defect is that it never reached a
 * surface. Nothing here runs work — it only reads what already happened.
 *
 * Every section degrades independently: a section that cannot be read returns
 * `null` with a reason rather than failing the page. A dashboard that goes blank
 * because one of six queries threw is worse than one honest gap.
 */

import { Router, Request, Response } from 'express';
import { getDb, getGatewayDb, getBoardDb, getMemoryDb } from '../db.js';

export const stateHomeRouter = Router();

function safe<T>(label: string, fn: () => T): { value: T | null; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (e) {
    console.warn(`[state-home] ${label} unavailable:`, (e as Error).message);
    return { value: null, error: (e as Error).message.slice(0, 200) };
  }
}

/** The most recent heartbeat briefing — Vodou's own morning summary. */
function heartbeat() {
  const db = getGatewayDb();
  const row = db
    .prepare(
      `SELECT content, created_at FROM gateway_messages
        WHERE conversation_id = 'vodou-heartbeat' AND role = 'assistant'
          AND TRIM(content) != ''
        ORDER BY id DESC LIMIT 1`,
    )
    .get() as { content: string; created_at: string } | undefined;
  if (!row) return null;
  return {
    at: row.created_at,
    // A briefing is long; the card wants its opening, and the full turn is one
    // click away in the Heartbeat tab.
    excerpt: row.content.slice(0, 700),
    chars: row.content.length,
  };
}

/** What the scheduler ran, what is overdue, what is next. */
function scheduler() {
  const db = getDb();
  // `next_run_at` / `last_run_at` are TEXT ISO-8601 ('2026-08-17T07:16:33.935Z'),
  // NOT unix integers — scheduler.rs writes `next_iso`. Typing them as numbers
  // and comparing against Date.now()/1000 silently yields false for every
  // comparison, so the card reported "0 overdue, next: none" forever while the
  // heartbeat was demonstrably running every hour. Caught by noticing the card
  // was too quiet, not by a failing test.
  const rows = db
    .prepare(
      `SELECT name, enabled, last_run_at, next_run_at
         FROM scheduled_tasks
        ORDER BY (next_run_at IS NULL), next_run_at ASC`,
    )
    .all() as { name: string; enabled: number; last_run_at: string | null; next_run_at: string | null }[];

  const ms = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  };
  const now = Date.now();
  const enabled = rows.filter((r) => r.enabled);

  return {
    total: rows.length,
    enabled: enabled.length,
    // Overdue is the number worth surfacing: a task whose next run is in the past
    // is not "scheduled", it is stuck, and that is invisible today. 120s grace so
    // a task mid-tick does not read as broken.
    overdue: enabled.filter((r) => {
      const t = ms(r.next_run_at);
      return t != null && t < now - 120_000;
    }).length,
    next: enabled
      .filter((r) => { const t = ms(r.next_run_at); return t != null && t >= now; })
      .sort((a, b) => (ms(a.next_run_at) || 0) - (ms(b.next_run_at) || 0))
      .slice(0, 5)
      .map((r) => ({ name: r.name, at: r.next_run_at })),
    recent: enabled
      .filter((r) => ms(r.last_run_at) != null)
      .sort((a, b) => (ms(b.last_run_at) || 0) - (ms(a.last_run_at) || 0))
      .slice(0, 5)
      .map((r) => ({ name: r.name, at: r.last_run_at })),
  };
}

/** What memory learned today — §3.2, the thing a user has never once seen. */
function memoryToday() {
  const db = getMemoryDb();
  if (!db) return null;
  const day = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    // LOCAL day, per PLANS/PLAN-TIME-CANON.md — 'today' is a local calendar day
    // even though the stored instants are naive UTC.
    added: day(
      `SELECT COUNT(*) AS n FROM memory_chunks
        WHERE archived = 0 AND date(created_at, 'localtime') = date('now', 'localtime')`,
    ),
    superseded: day(
      `SELECT COUNT(*) AS n FROM memory_chunks
        WHERE invalid_at IS NOT NULL AND date(invalid_at, 'localtime') = date('now', 'localtime')`,
    ),
    total: day(`SELECT COUNT(*) AS n FROM memory_chunks WHERE archived = 0`),
  };
}

/** Board state — how much work is queued, running, blocked. */
function board() {
  const db = getBoardDb();
  if (!db) return null;
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`)
    .all() as { status: string; n: number }[];
  const by: Record<string, number> = {};
  for (const r of rows) by[r.status] = r.n;
  return { byStatus: by, total: rows.reduce((a, r) => a + r.n, 0) };
}

/** Integration health — which servers are actually reachable. */
function integrations() {
  const db = getDb();
  // Columns verified against the live schema: mcp_servers has `active` and
  // `health_status` — NOT `enabled`/`connection_status`, which is what a
  // reasonable guess would have written and what would have failed silently
  // behind this function's own try/catch.
  const rows = db
    .prepare(`SELECT name, active, health_status FROM mcp_servers`)
    .all() as { name: string; active: number; health_status: string | null }[];
  const active = rows.filter((r) => r.active);
  const healthy = active.filter((r) => (r.health_status || '').toLowerCase() === 'healthy');
  return {
    total: rows.length,
    enabled: active.length,
    connected: healthy.length,
    // Named, not just counted: "27 of 36 healthy" prompts "which nine?", and the
    // answer should not require another click.
    disconnected: active
      .filter((r) => (r.health_status || '').toLowerCase() !== 'healthy')
      .slice(0, 8)
      .map((r) => r.name),
  };
}

/**
 * PLAN-PROJECT-VAULTS §4.4 — the project-vault card.
 *
 * "MTVai — 412 memories, shared with #mtvai-slack and Cursor." The state home is
 * where that belongs, because a vault is a SHARE SURFACE and the one thing you
 * want to know at a glance is what it currently exposes.
 *
 * Includes §4.5's runtime invariant: a vault whose `project` resolves to
 * suspiciously few members while the project itself has memory is the §1.2
 * failure — a share target that promises a project's brain and delivers a
 * rounding error. Made LOUD here rather than discovered at share time.
 */
function projectVaults() {
  const db = getMemoryDb();
  if (!db) return null;
  let rows: { name: string; rules_json: string }[];
  try {
    rows = db.prepare('SELECT name, rules_json FROM memory_vaults ORDER BY name').all() as typeof rows;
  } catch {
    return null;   // memory_vaults predates some installs
  }
  const out: Array<{ name: string; project: string | null; members: number; thin: boolean }> = [];
  for (const r of rows) {
    let rules: { project?: string | null; pinned_scopes?: string[] } = {};
    try { rules = JSON.parse(r.rules_json); } catch { /* keep empty */ }
    if (!rules.project) continue;   // global vaults are not project cards
    // Count the way vaults.rs does for the project leg: stamped ∪ pinned scopes.
    // Deliberately NOT a re-implementation of the whole resolver — that lives in
    // Rust and is the single authority. This is an indicator, and it is labelled
    // as one; the exact list comes from `mem vault preview`.
    let members = 0;
    try {
      const stamped = db
        .prepare('SELECT COUNT(*) AS n FROM memory_chunks WHERE archived = 0 AND project_id = ?')
        .get(rules.project) as { n: number };
      members = stamped.n;
      for (const sc of rules.pinned_scopes ?? []) {
        const p = db
          .prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE archived = 0 AND scope LIKE ? AND COALESCE(project_id,'') != ?")
          .get(sc + '%', rules.project) as { n: number };
        members += p.n;
      }
    } catch { /* leave the count at what we got */ }
    out.push({ name: r.name, project: rules.project, members, thin: members < 25 });
  }
  return out.length ? { vaults: out } : null;
}

/**
 * VODOU QA — the platform's own test scorecard (PLANS/0.6.28/VODOU-QA).
 *
 * `qa_health_history` is written by scripts/qa/qa.sh, the deterministic runner
 * the QA skills invoke; this reads the same table the #/system tile renders,
 * exactly the memory_health_history arrangement. A missing table means the
 * runner has never run on this install — that is `null`, not an error.
 */
function qa() {
  const db = getDb();
  let rows: { recorded_at: string; tier: string; pct: number; passed: number; failed: number }[];
  try {
    rows = db
      .prepare(
        `SELECT recorded_at, tier, pct, passed, failed FROM qa_health_history
          ORDER BY id DESC LIMIT 30`,
      )
      .all() as typeof rows;
  } catch {
    return null;   // table appears with the first qa.sh run
  }
  if (!rows.length) return null;
  const latest = rows[0];
  return {
    pct: latest.pct,
    tier: latest.tier,
    at: latest.recorded_at,
    passed: latest.passed,
    failed: latest.failed,
    history: rows.slice().reverse().map((r) => r.pct),
  };
}

/** Recently ingested documents. */
function library() {
  const db = getMemoryDb();
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        `SELECT display_name, created_at FROM memory_sources
          ORDER BY id DESC LIMIT 5`,
      )
      .all() as { display_name: string; created_at: string }[];
    return { recent: rows.map((r) => ({ name: r.display_name, at: r.created_at })) };
  } catch {
    return { recent: [] };   // memory_sources predates some installs
  }
}

// ── GET /api/home/state ──────────────────────────────────────────────────────
stateHomeRouter.get('/state', (_req: Request, res: Response) => {
  const heartbeatR = safe('heartbeat', heartbeat);
  const schedulerR = safe('scheduler', scheduler);
  const memoryR = safe('memory', memoryToday);
  const boardR = safe('board', board);
  const integrationsR = safe('integrations', integrations);
  const libraryR = safe('library', library);
  const vaultsR = safe('projectVaults', projectVaults);
  const qaR = safe('qa', qa);

  res.json({
    at: new Date().toISOString(),
    heartbeat: heartbeatR.value,
    scheduler: schedulerR.value,
    memory: memoryR.value,
    board: boardR.value,
    integrations: integrationsR.value,
    library: libraryR.value,
    projectVaults: vaultsR.value,
    qa: qaR.value,
    errors: Object.fromEntries(
      Object.entries({
        heartbeat: heartbeatR.error,
        scheduler: schedulerR.error,
        memory: memoryR.error,
        board: boardR.error,
        integrations: integrationsR.error,
        library: libraryR.error,
        projectVaults: vaultsR.error,
        qa: qaR.error,
      }).filter(([, v]) => v),
    ),
  });
});
