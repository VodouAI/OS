/**
 * Turn receipt — what the turn actually DID, as data.
 *
 * PLAN-INJECT-RECEIPT-UI (panel) + PLAN-CONSOLE-SHOWS-ITS-WORK §4.3 (console).
 *
 * Vodou's own code comment states the claim exactly: "the panel can render
 * `4 memories · 2 tools · 1 skill`. This is the product claim made visible.
 * Memory alone is table stakes." Every competitor retrieves and pastes; the
 * receipt is the only artifact showing the brain ACTED, and a retrieve-and-paste
 * product cannot render one because it never did anything to report.
 *
 * This module exists because the console needed the same receipt the panel
 * already had, and the semantics below are earned rather than obvious — the
 * `?::Bash` guard and silent-by-design both came from real defects. Two copies
 * would have drifted, and a receipt that disagrees with itself across surfaces is
 * worse than no receipt.
 *
 * It is COUNTING, not new plumbing: memories already ride the `done` frame, tools
 * already stream as `tool_start`, skills are already recorded by llm.ts.
 */

import { getLastSkillsUsed, resetSkillsUsed, getTotalMemoryCount, takeTurnLanes, persistTurnLanes } from './llm.js';
import { markFunnel } from './funnel.js';

function safe<T>(fn: () => T, dflt: T): T {
  try {
    return fn();
  } catch {
    return dflt;
  }
}

const _turnTools = new Map<string, string[]>();

/** Start a fresh receipt for a turn — call BEFORE the turn runs, not after. */
export function receiptReset(convId: string): void {
  _turnTools.delete(convId);
  try {
    resetSkillsUsed(convId);
  } catch {
    /* best-effort */
  }
}

/**
 * Record one tool the turn ran. `server` is often absent — CLI-provider tools
 * (Bash, ToolSearch, `mcp__claude_ai_*`) stream with no serverName, and a naive
 * `${server}::${tool}` produced chips reading `?::Bash`. Emit the bare tool name
 * in that case: the receipt is a human-facing count, not a dispatch address.
 */
export function receiptAddTool(convId: string, server: string | undefined, tool: string | undefined): void {
  if (!tool) return; // nothing meaningful to report
  const label = server ? `${server}::${tool}` : String(tool);
  if (label.includes('undefined')) return; // never report a broken dispatch as work done
  const seen = _turnTools.get(convId) || [];
  if (!seen.includes(label)) {
    seen.push(label);
    _turnTools.set(convId, seen);
  }
}

export interface TurnReceipt {
  memories: { used: number; total: number; items: string[] };
  tools: string[];
  skills: string[];
  /**
   * Set only when the context pipeline missed its budget this turn (P0-3).
   *
   * COHERENCE F42 — the field naming the pipeline STAGE was called `scope`,
   * which in this codebase already means a memory's provenance, an OAuth
   * permission, and a vault. It renders to a person as *"Degraded: context"*,
   * where "context" is a stage, not a scope — and a reader who has just seen
   * `scope` mean "where a memory came from" now reasonably looks for the
   * memory scope named `context`, which does not exist.
   *
   * `stage` is the field. `scope` is emitted ALONGSIDE it and is deprecated:
   * the extension ships through the Chrome Web Store on its own clock, so a
   * gateway that dropped the old name immediately would go silent on every
   * panel that had not updated yet — a fix that reads to the user as the
   * feature breaking. Drop `scope` once the population has rolled.
   */
  degraded?: { reason: string; stage: string; ms: number; /** @deprecated use `stage` */ scope?: string } | null;
  /**
   * PLAN-PROJECT-VAULTS §4.5 — WHICH memory this turn was allowed to see.
   *
   * The audit line the plan asks for: "answered from team-shared, 3 memories". On
   * a guest turn (a Slack room, an attached editor) the vault is the entire
   * disclosure boundary, and a receipt that reports 3 memories without naming the
   * boundary they came from is the more dangerous half of the sentence.
   *
   * `vault` is null for an owner turn — the owner sees everything, so there is no
   * boundary to name and printing one would imply a limit that does not exist.
   */
  vault?: string | null;
  /** The project whose memory this turn drew on. Null = global/Default. */
  project?: string | null;
  /** Wall-clock for the turn, when the caller tracked it. */
  ms?: number;
}

/**
 * Build the receipt for a finished turn. SILENT BY DESIGN: a turn that used
 * nothing returns null and the client renders nothing — never "0 memories", which
 * reads as a failure and is exactly the noise the inject lane's
 * silence-when-ignorant rule exists to avoid.
 *
 * A `degraded` turn is NOT silent even when it used nothing: "I tried and the
 * pipeline missed its budget" is information the user needs, and staying quiet
 * there is how a degraded turn gets mistaken for an empty one.
 */
export function buildReceipt(
  convId: string,
  memoriesUsed: string[],
  extra?: {
    /** `scope` accepted on input too, so callers migrate independently. */
    degraded?: { reason: string; stage?: string; ms: number; scope?: string } | null;
    ms?: number;
    vault?: string | null;
    project?: string | null;
  },
): TurnReceipt | null {
  const tools = _turnTools.get(convId) || [];
  const skills = safe(() => getLastSkillsUsed(convId), [] as string[]);
  // P7-0 — the lanes this turn was assembled from: taken once, attached to the
  // live frame AND persisted to the row, so reload shows what live showed.
  // TAKE always — the accumulator must be cleared even on a silent turn, or this
  // turn's lanes ride into the next one. PERSIST only if a receipt is actually
  // sent (below): `index.ts` states the rule this obeys — "an absent receipt must
  // stay absent so a client can tell 'used nothing' from 'we don't know'." The
  // first cut persisted here, so a turn that sent NO live receipt came back from
  // a reload carrying one. That is F8 inverted, introduced by the very change
  // that exists to prevent it, and it was caught by reading a real row.
  const noted = safe(() => takeTurnLanes(convId), [] as Array<{ lane: string; chars: number; cached?: boolean; evicted_tok?: number; state?: string; ms?: number }>);
  // Accept either name in, emit both out. A caller still saying `scope` keeps
  // working; nothing has to change in lockstep.
  const degradedIn = extra?.degraded ?? null;
  const degraded = degradedIn
    ? { ...degradedIn, stage: degradedIn.stage ?? degradedIn.scope ?? 'context', scope: degradedIn.stage ?? degradedIn.scope ?? 'context' }
    : null;
  if (!memoriesUsed.length && !tools.length && !skills.length && !degraded) {
    console.error(`[receipt] ${convId.substring(0, 28)} — nothing used; sending no receipt (silent by design)`);
    return null;
  }
  // P2: the daemon appended the child's hook lane to the row during the turn;
  // persist returns the merged set so live and reloaded show the same lanes.
  const lanes = safe(() => persistTurnLanes(convId, noted), noted);
  markFunnel('first_receipt'); // PLAN-EXECUTION-SHELF-FUNNEL §5 — a turn that DID something
  if (skills.length) markFunnel('first_skill');
  console.error(
    `[receipt] ${convId.substring(0, 28)} — ${memoriesUsed.length} memories · ` +
      `${tools.length} tools${tools.length ? ` (${tools.join(', ')})` : ''} · ` +
      `${skills.length} skills${skills.length ? ` (${skills.join(', ')})` : ''}` +
      `${degraded ? ` · DEGRADED (${degraded.stage}/${degraded.reason})` : ''}` +
      `${extra?.vault ? ` · vault=${extra.vault}` : ''}`,
  );
  return {
    memories: { used: memoriesUsed.length, total: safe(getTotalMemoryCount, 0), items: memoriesUsed.slice(0, 5) },
    tools,
    skills,
    degraded,
    ms: extra?.ms,
    // §4.5 — normalize '' to null so "no boundary" is one value, not two.
    vault: extra?.vault || null,
    project: extra?.project || null,
    ...(lanes.length ? { lanes } : {}),
  };
}

/** PLAN-CONTEXT-COORDINATION P7-0 — `turn_receipts.lanes` as stored (JSON) → records.
 *  Tolerant on purpose: a pre-088 row has NULL, a torn write must not break history. */
export function parseReceiptLanes(raw: unknown): Array<{ lane: string; chars: number; cached?: boolean; evicted_tok?: number; state?: string; ms?: number }> {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is { lane: string; chars: number } => !!x && typeof x.lane === 'string' && typeof x.chars === 'number')
      .map(x => {
        const r = x as { lane: string; chars: number; cached?: unknown; evicted_tok?: unknown; state?: unknown; ms?: unknown };
        return {
          lane: r.lane, chars: r.chars,
          ...(r.cached === true ? { cached: true } : {}),
          ...(typeof r.evicted_tok === 'number' && r.evicted_tok > 0 ? { evicted_tok: r.evicted_tok } : {}),
          ...(typeof r.state === 'string' ? { state: r.state } : {}),
          ...(typeof r.ms === 'number' ? { ms: r.ms } : {}),
        };
      });
  } catch {
    return [];
  }
}
