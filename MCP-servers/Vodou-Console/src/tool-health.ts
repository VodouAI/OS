/**
 * tool-health — notice when a tool is failing EVERY time.
 *
 * PLAN-CONSOLE-SHOWS-ITS-WORK §7 S-5, and §7.5 is the argument for it:
 *
 *   "Every bug found on 2026-08-15 shared one shape: a lower layer knew the right
 *    answer and the layer above didn't ask, and nothing noticed. The release gates
 *    prove the model works … Both are build-time. Nothing watches the running
 *    system."
 *
 * `add_thought` returned isError on 100% of calls for an unknown number of months.
 * Nothing was wrong with the logs — the failure was visible in every single one.
 * What was missing is anything that counts.
 *
 * The executor already had `trackAddThoughtError`, hardcoded to that one tool.
 * That is the §7.5 shape again: the lesson learned on one path and never carried
 * to the others. This is the general form.
 *
 * Deliberately a CONSECUTIVE counter, not a rate. A tool that fails 30% of the
 * time is usually doing its job (bad input, absent record, expired token); a tool
 * that has failed its last N calls with no success in between is broken, and that
 * distinction is what keeps this from crying wolf.
 */

export interface ToolHealthEntry {
  server: string;
  tool: string;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

/** Consecutive failures before a tool is called unhealthy. */
export const UNHEALTHY_AFTER = 5;

const _tools = new Map<string, ToolHealthEntry>();

function keyOf(server: string, tool: string): string {
  return `${server}::${tool}`;
}

function entry(server: string, tool: string): ToolHealthEntry {
  const k = keyOf(server, tool);
  let e = _tools.get(k);
  if (!e) {
    e = {
      server,
      tool,
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
      firstFailureAt: null,
      lastFailureAt: null,
      lastError: null,
    };
    _tools.set(k, e);
  }
  return e;
}

/**
 * Record one tool call. Returns the entry so a caller can react (e.g. log the
 * crossing). Success RESETS the consecutive counter — that reset is the whole
 * reason this reports "broken" rather than "flaky".
 */
export function recordToolResult(
  server: string,
  tool: string,
  ok: boolean,
  error?: string,
): ToolHealthEntry {
  const e = entry(server || 'unknown', tool || 'unknown');
  e.totalCalls += 1;
  if (ok) {
    if (e.consecutiveFailures >= UNHEALTHY_AFTER) {
      console.error(`[tool-health] ${e.server}::${e.tool} RECOVERED after ${e.consecutiveFailures} consecutive failures`);
    }
    e.consecutiveFailures = 0;
    return e;
  }
  e.totalFailures += 1;
  e.consecutiveFailures += 1;
  const now = new Date().toISOString();
  if (!e.firstFailureAt) e.firstFailureAt = now;
  e.lastFailureAt = now;
  if (error) e.lastError = error.slice(0, 300);
  // Log exactly at the crossing, not on every call after it: a broken tool
  // should announce itself once, not become the noise it is trying to surface.
  if (e.consecutiveFailures === UNHEALTHY_AFTER) {
    console.error(
      `[tool-health] ${e.server}::${e.tool} has failed ${UNHEALTHY_AFTER} consecutive calls ` +
        `— treating as BROKEN (last error: ${e.lastError ?? 'n/a'})`,
    );
  }
  return e;
}

/** Tools currently at or past the threshold, worst first. */
export function unhealthyTools(): ToolHealthEntry[] {
  return [...
    _tools.values()]
    .filter((e) => e.consecutiveFailures >= UNHEALTHY_AFTER)
    .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);
}

/** Everything seen this process, for a debug surface. */
export function allToolHealth(): ToolHealthEntry[] {
  return [..._tools.values()].sort((a, b) => b.totalFailures - a.totalFailures);
}

/** The `/health` summary. `ok:false` is what an operator should act on. */
export function toolHealthSummary(): {
  ok: boolean;
  unhealthy: Array<{ tool: string; consecutiveFailures: number; lastError: string | null; since: string | null }>;
  tracked: number;
} {
  const bad = unhealthyTools();
  return {
    ok: bad.length === 0,
    unhealthy: bad.map((e) => ({
      tool: keyOf(e.server, e.tool),
      consecutiveFailures: e.consecutiveFailures,
      lastError: e.lastError,
      since: e.firstFailureAt,
    })),
    tracked: _tools.size,
  };
}

/** Test seam. */
export function _resetToolHealth(): void {
  _tools.clear();
}
