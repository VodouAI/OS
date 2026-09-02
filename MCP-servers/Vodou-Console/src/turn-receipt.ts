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

import { currentStack } from './stack.js';
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
  /**
   * P0 — the turn's identity, so the UI can ask the log what a lane actually
   * said. Without it the Context rows can show sizes and never the bytes, which
   * is the difference between a receipt and a claim.
   */
  turnId?: string;
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
  /**
   * PLAN-SEAMS P4 — which run composition this turn ran in (`stacks.toml`).
   *
   * `web` and `headless` inject different lane sets, so a receipt read without
   * knowing the stack cannot distinguish "this lane is not part of how you are
   * running" from "this lane failed". Absent when the entrypoint declared no
   * stack — a fabricated name would be worse than none.
   */
  stack?: string;
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
    /** P0 — lets the receipt point at its own turn in the event log. */
    turnId?: string;
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
  // P2: the daemon appended the child's hook lane to the row during the turn;
  // persist returns the merged set so live and reloaded show the same lanes.
  //
  // ORDER MATTERS, and it was wrong. This ran AFTER the suppression check below,
  // so a turn that used no memory was declared "nothing used" and returned null
  // before the lanes were ever consulted — let alone persisted. A real turn:
  // "what is my dog's name", answered correctly, 48,952 characters across seven
  // lanes (a 39,877-char system prompt, ground truth, convo recall, 7,443 chars
  // of history) and NO receipt at all, because `memories_used` was 0.
  // Hand the turn's own id down. `persistTurnLanes` used to re-derive it from
  // the conversation map, which is empty by the time a heartbeat or a scheduled
  // skill console builds its receipt — so the projection was skipped and the
  // receipt kept one lane out of eight.
  const lanes = safe(() => persistTurnLanes(convId, noted, extra?.turnId), noted);

  // "Nothing used" has to mean nothing REACHED THE MODEL, not "no memory
  // matched". Judged on memories/tools/skills alone it was answering a different
  // question than the one the receipt exists to answer — and it is the question
  // this whole build is about: what was this model told?
  //
  // A turn that injected forty-nine thousand characters is not silent.
  if (!memoriesUsed.length && !tools.length && !skills.length && !degraded && !lanes.length) {
    console.error(`[receipt] ${convId.substring(0, 28)} — nothing used and no lane fired; sending no receipt (silent by design)`);
    return null;
  }
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
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
    memories: { used: memoriesUsed.length, total: safe(getTotalMemoryCount, 0), items: memoriesUsed.slice(0, 5) },
    tools,
    skills,
    degraded,
    ms: extra?.ms,
    // §4.5 — normalize '' to null so "no boundary" is one value, not two.
    vault: extra?.vault || null,
    project: extra?.project || null,
    // P4 — spread only when known, so an undeclared entrypoint omits the key
    // rather than sending `stack: null`. A client that has to distinguish "no
    // stack" from "the stack is literally null" is being handed the ambiguity
    // this field exists to remove.
    ...((): { stack?: string } => { const st = currentStack(); return st ? { stack: st } : {}; })(),
    ...(lanes.length ? { lanes } : {}),
  };
}

/** PLAN-CONTEXT-COORDINATION P7-0 — `turn_receipts.lanes` as stored (JSON) → records.
 *  Tolerant on purpose: a pre-088 row has NULL, a torn write must not break history. */
export function parseReceiptLanes(raw: unknown): Array<{ lane: string; chars: number; cached?: boolean; evicted_tok?: number; state?: string; ms?: number; items?: number }> {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is { lane: string; chars: number } => !!x && typeof x.lane === 'string' && typeof x.chars === 'number')
      .map(x => {
        const r = x as { lane: string; chars: number; cached?: unknown; evicted_tok?: unknown; state?: unknown; ms?: unknown; items?: unknown };
        return {
          lane: r.lane, chars: r.chars,
          ...(r.cached === true ? { cached: true } : {}),
          ...(typeof r.evicted_tok === 'number' && r.evicted_tok > 0 ? { evicted_tok: r.evicted_tok } : {}),
          ...(typeof r.state === 'string' ? { state: r.state } : {}),
          ...(typeof r.ms === 'number' ? { ms: r.ms } : {}),
          // b90c4144 — how many actual memories the block held; without this
          // passthrough the read path silently dropped the one field that
          // distinguishes "context injected" from "memories injected".
          ...(typeof r.items === 'number' ? { items: r.items } : {}),
        };
      });
  } catch {
    return [];
  }
}

// ── PLAN-RECEIPTS-BROWSE-TAB — the browse endpoint's pure core ──────────────
//
// The three-shape verdict rule exists TWICE: Rust `grade_flow14` grades the
// nightly corpus; this grades rows for the Memory → Receipts page. Two
// spellings, one gate: `fixtures/receipt-shapes.json` is asserted by both
// suites, and the thresholds below are the flow's, verbatim
// (`src/flows_cmd.rs` RAN_MS_FLOOR — change one, change both, the fixture
// test fails until you do).

export type ReceiptShape = 'injected' | 'ran_empty' | 'never_ran' | 'unrecorded';

const MEMORY_FAMILY = new Set(['memory', 'hook_memory']);
/** Below this many ms a "run" is the resolved-empty-promise signature (0–1ms
 *  measured), not a search that went out (600–2800ms measured). Flow 14's
 *  RAN_MS_FLOOR. */
const RAN_MS_FLOOR = 5;

export function receiptShape(lanes: ReturnType<typeof parseReceiptLanes>): ReceiptShape {
  if (!lanes.length) return 'unrecorded';
  let ran = false;
  for (const l of lanes) {
    if (!MEMORY_FAMILY.has(l.lane)) continue;
    if (l.chars > 0) return 'injected';
    if ((l.ms ?? 0) >= RAN_MS_FLOOR) ran = true;
  }
  return ran ? 'ran_empty' : 'never_ran';
}

/** conversation_id → lane group. The THIRD spelling of this mapping (Rust
 *  `lane_group` in flows_cmd.rs, the plan-of-record's SQL) — fixture-gated. */
export function receiptLaneGroup(conversationId: string): string {
  if (conversationId.startsWith('workbench:skill-console')) return 'skill-console';
  if (conversationId.startsWith('workbench:channel')) return 'channel';
  if (conversationId === 'vodou-heartbeat') return 'heartbeat';
  if (conversationId.startsWith('workbench:')) return 'workbench:other';
  return 'interactive';
}

export interface BrowseReceiptRow {
  at: string;                    // naive UTC as stored — the CLIENT renders local (time canon)
  conversation_id: string;
  turn_id: string | null;        // null = pre-D-6 receipt, unjoinable by construction
  lane_group: string;
  shape: ReceiptShape;
  memories_used: number;
  degraded: string | null;
  /** memory-family lane detail, when recorded */
  items: number | null;
  chars: number | null;
  ms: number | null;
  lanes: ReturnType<typeof parseReceiptLanes>;
}

export interface BrowseSummaryLane {
  turns: number; injected: number; ran_empty: number; never_ran: number; unrecorded: number;
}

/** Raw turn_receipts rows → the page's payload. Pure so the fixture tests hit
 *  the exact code the endpoint serves. */
export function browseReceipts(
  raw: Array<{ at: string; conversation_id: string; turn_id: string | null; memories_used: number; degraded: string | null; lanes: string | null }>,
  opts: { lane?: string; problems?: boolean } = {},
): { summary: Record<string, BrowseSummaryLane>; rows: BrowseReceiptRow[] } {
  const summary: Record<string, BrowseSummaryLane> = {};
  const rows: BrowseReceiptRow[] = [];
  for (const r of raw) {
    const lanes = parseReceiptLanes(r.lanes);
    const shape = receiptShape(lanes);
    const group = receiptLaneGroup(r.conversation_id);
    const s = (summary[group] ??= { turns: 0, injected: 0, ran_empty: 0, never_ran: 0, unrecorded: 0 });
    s.turns += 1;
    s[shape] += 1;
    if (opts.lane && group !== opts.lane) continue;
    if (opts.problems && shape !== 'never_ran' && !r.degraded) continue;
    const mem = lanes.find((l) => MEMORY_FAMILY.has(l.lane)) ?? null;
    rows.push({
      at: r.at,
      conversation_id: r.conversation_id,
      turn_id: r.turn_id,
      lane_group: group,
      shape,
      memories_used: r.memories_used ?? 0,
      degraded: r.degraded ?? null,
      items: mem && typeof mem.items === 'number' ? mem.items : null,
      chars: mem ? mem.chars : null,
      ms: mem && typeof mem.ms === 'number' ? mem.ms : null,
      lanes,
    });
  }
  return { summary, rows };
}
