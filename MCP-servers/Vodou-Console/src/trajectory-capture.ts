// PLAN-SKILL-LEARNING-LOOP Phase 1A — LLM-agnostic tool-trajectory capture.
//
// One accumulator keyed by conversationId. Every provider path records its tool
// calls here; the single flush point in dispatchToProvider() persists the turn.
//
// Why an accumulator (not per-provider inline capture): the gateway has ~5
// tool-execution surfaces (the shared executeOITool sink used by all API
// providers, plus the claude-cli and kimi-cli subprocess stream parsers). A
// per-loop hook only covers one provider. Recording into a shared, conversation-
// keyed accumulator and flushing once at the universal turn boundary makes
// capture work for whatever LLM is selected. Keyed by conversationId because the
// gateway runs concurrent conversations — a single global would interleave them.
//
// Known gap: kimi-cli streams text only (no structured tool events parsed), so
// its tool calls are not observable. Documented, not silently dropped.

import { createHash } from 'crypto';
import { recordToolTrajectory, setLatestTrajectoryUserSignal } from './db.js';

export interface TrajectoryStep {
  server: string;
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
}

const _byConversation = new Map<string, TrajectoryStep[]>();

/** Append one completed tool call to the current turn for a conversation. No-op
 *  when conversationId is absent (e.g. board-worker or non-chat callers of
 *  executeOITool) so off-chat tool use never creates phantom trajectories. */
export function recordTrajectoryStep(conversationId: string | undefined | null, step: TrajectoryStep): void {
  if (!conversationId) return;
  let arr = _byConversation.get(conversationId);
  if (!arr) { arr = []; _byConversation.set(conversationId, arr); }
  arr.push(step);
}

/** Persist and clear the conversation's accumulated trajectory. Called once per
 *  turn from dispatchToProvider(). No-op for turns that used zero tools. Best-
 *  effort: never throws into the chat path. */
/**
 * Strip system wrappers so the trajectory records what a HUMAN typed.
 *
 * PLAN-ALPHA F4. The overnight skill-proposer clusters `prompt_excerpt` to find
 * "things Chad does repeatedly" and offers to automate them. It was clustering
 * on packaging instead of content: its top recurring "intent" was a piece of
 * XML. Because no real intent could then reach `OPT_MIN_DECIDED=3`, the whole
 * learning loop stalled and `skill_metrics` stayed empty (D11) — this is that
 * bug's root cause, not a cosmetic one.
 *
 * TWO wrappers, not one. The plan named only the security envelope; measured
 * 2026-08-19 the CLI preamble was the LARGER polluter (52 rows vs 33 of 588):
 *
 *   1. `<untrusted_channel_message …>` … `</untrusted_channel_message>` plus the
 *      `<channel_rules>` block trailing it. Correct and must stay in the PROMPT
 *      — it is the instruction-source boundary — but it is not what the user
 *      said, so it must not be what we learn from.
 *   2. `[Vodou CLI — your working directory is: …]`, a cwd preamble. It never
 *      starts with `<`, so the plan's "drop anything starting with `<`" filter
 *      would have sailed straight past it and fixed ~40% of the problem.
 *
 * Stripping BEFORE storage matters: `prompt_excerpt` is truncated to 280 chars
 * at insert (db.ts) and the CLI preamble alone is ~250, so the user's actual
 * words were being cut off entirely. The wrapper was not merely first in the
 * excerpt — it was the whole excerpt.
 *
 * Conservative by construction: if stripping would leave nothing, the original
 * is returned. A blank excerpt teaches the proposer even less than a wrapper.
 */
export function stripPromptWrappers(raw: string): string {
  if (!raw) return raw;
  let text = raw;

  // 1. Security envelope. The closing tag and everything after it (the
  //    <channel_rules> block) go together — rules are not user text either.
  const openTag = /^\s*<untrusted_channel_message[^>]*>\s*/i;
  if (openTag.test(text)) {
    text = text.replace(openTag, '');
    const close = text.search(/<\/untrusted_channel_message>/i);
    if (close >= 0) text = text.slice(0, close);
  }

  // 2. Leading bracketed system preamble, e.g. the Vodou CLI cwd block. Matched
  //    to the FIRST ']' — these preambles contain no nested brackets, and a
  //    greedy match would eat a user's own bracketed text further down.
  text = text.replace(/^\s*\[Vodou[^\]]*\]\s*/i, '');

  const cleaned = text.trim();
  return cleaned.length > 0 ? cleaned : raw;
}

/**
 * Is this excerpt structural packaging rather than something a person typed?
 *
 * Used as a belt for the braces above — a wrapper introduced later, or a row
 * written before the strip shipped, should still be kept out of clustering.
 */
export function looksLikeWrapper(excerpt: string): boolean {
  const t = (excerpt || '').trim();
  if (!t) return true;
  return t.startsWith('<') || /^\[Vodou\b/i.test(t);
}

export function flushTrajectory(conversationId: string | undefined | null, promptExcerpt?: string): void {
  if (!conversationId) return;
  const steps = _byConversation.get(conversationId);
  _byConversation.delete(conversationId);
  if (!steps || steps.length === 0) return;
  try {
    const shapeSeq = steps.map(s => `${s.server}.${s.tool}`).join('>');
    const shapeHash = createHash('sha1').update(shapeSeq).digest('hex').slice(0, 16);
    const outcome = steps.every(s => !s.ok) ? 'failure'
      : steps.some(s => !s.ok) ? 'partial' : 'success';
    // Strip wrappers HERE rather than at the llm.ts call site the plan names:
    // this is the one choke point every caller passes through, so a future
    // caller cannot reintroduce the problem by forgetting to sanitise.
    recordToolTrajectory(
      conversationId,
      steps,
      shapeHash,
      outcome,
      promptExcerpt ? stripPromptWrappers(promptExcerpt) : promptExcerpt,
    );
  } catch (e) {
    console.error('[Trajectory] flush failed:', (e as Error).message);
  }
}

/** Drop a conversation's in-flight steps without persisting (e.g. client abort). */
export function discardTrajectory(conversationId: string | undefined | null): void {
  if (conversationId) _byConversation.delete(conversationId);
}

// ── CLI envelope normalization ───────────────────────────────────────────────
// CLI-subprocess providers (claude-cli, and later kimi-cli) reach vodou tools by
// running `./vodou-core call <server> <tool> '<json>'` through their Bash tool —
// the documented single-spawn primitive (CLAUDE.md). So a captured CLI step
// arrives as a Bash call with the real vodou call inside the command string. We
// parse it back to a clean {server, tool, args} at capture time so the stored
// trajectory is provider-uniform (matches the API path's clean steps) and the
// proposer never sees Bash. Non-vodou shell stays labelled 'shell' (still part
// of the trajectory shape, but filterable as non-replayable).

interface CliStep { server: string; tool: string; args: unknown }

/** Extract EVERY `(./)?(vodou-core|oi|vodou) call <server> <tool> '<json>'`
 *  invocation from a shell command. Handles compound/backgrounded pipelines
 *  (claude-cli often runs several calls in one Bash: `a & b & c & wait`), and
 *  extracts each call's quoted JSON arg by scanning to its matching closing
 *  quote (so trailing `2>/dev/null & …` is NOT swallowed into the args). */
export function parseAllVodouCoreCalls(command: string): CliStep[] {
  if (!command) return [];
  const out: CliStep[] = [];
  const re = /(?:\.\/)?(?:vodou-core|oi|vodou)\s+call\s+(\S+)\s+(\S+)[ \t]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const server = m[1];
    const tool = m[2];
    let args: unknown = {};
    const rest = command.slice(re.lastIndex);
    const q = rest[0];
    if (q === "'" || q === '"') {
      const end = rest.indexOf(q, 1); // shell single-quotes don't nest/escape
      if (end > 0) {
        const raw = rest.slice(1, end);
        try { args = JSON.parse(raw); } catch { args = { _raw: raw }; }
        re.lastIndex += end + 1; // advance past the closing quote
      }
    }
    out.push({ server, tool, args });
  }
  return out;
}

/** Back-compat single-call parser (first vodou-core call only). */
export function parseVodouCoreCall(command: string): CliStep | null {
  return parseAllVodouCoreCalls(command)[0] ?? null;
}

/** Normalize a CLI-subprocess tool call into clean trajectory step(s).
 *  A Bash command wrapping `vodou-core call`(s) → one clean {server,tool,args}
 *  per call (compound commands yield several); other Bash → 'shell'; other
 *  native CLI tools (Read/Edit/…) → 'cli'. Returns an array (usually length 1). */
export function normalizeCliToolSteps(toolName: string, toolArgs: unknown): CliStep[] {
  const cmd = (toolArgs && typeof (toolArgs as any).command === 'string') ? (toolArgs as any).command as string : null;
  if ((toolName === 'Bash' || toolName === 'shell') && cmd) {
    const calls = parseAllVodouCoreCalls(cmd);
    if (calls.length > 0) return calls;
    return [{ server: 'shell', tool: 'Bash', args: toolArgs }];
  }
  return [{ server: 'cli', tool: toolName, args: toolArgs }];
}

// ── user_signal backfill ─────────────────────────────────────────────────────
// The quality of a trajectory is judged by what the user does NEXT: a follow-up
// that accepts or refines the result is positive evidence; a correction means
// the chain was wrong (Hermes wrongly nudges skill-creation on corrections — we
// exclude them). The signal can only be known one turn later, so we classify the
// next user message and backfill the most-recent unscored trajectory.

export type UserSignal = 'accepted' | 'refined' | 'corrected' | 'none';

/** Heuristic classifier (no LLM call — cheap, deterministic, runs every turn).
 *  'none' is the neutral default; the skill-worthy gate (Phase 1B) counts only
 *  'accepted'/'refined'. An LLM fallback for 'none' cases can be added later. */
export function classifyUserSignal(message: string): UserSignal {
  const m = (message || '').toLowerCase().trim();
  if (!m) return 'none';
  // Correction — the prior result was wrong / didn't work.
  if (/^(no\b|nope\b|actually,? no\b)/.test(m)
    || /\b(wrong|incorrect|not right|that'?s not|did ?n'?t work|does ?n'?t work|is broken|it broke|that failed|that'?s wrong|not what i (wanted|asked|meant))\b/.test(m)) {
    return 'corrected';
  }
  // Refinement — adjust or extend the same thing.
  if (/\b(also|additionally|one more|now (do|add|change|make|try)|instead|tweak|adjust|refine|redo|add (a|an|the|some)|change the|update the|but (can|could|make)|as well|on top of that)\b/.test(m)) {
    return 'refined';
  }
  // Acceptance — explicit positive.
  if (/\b(thanks|thank you|thx|perfect|great|awesome|nice|looks good|lgtm|that works|works great|got it|exactly|love it)\b/.test(m)) {
    return 'accepted';
  }
  return 'none';
}

/** Classify the new user message and stamp it onto the most-recent unscored
 *  trajectory for this conversation. No-op when there's no prior trajectory
 *  (the UPDATE matches nothing). Best-effort. */
export function backfillUserSignal(conversationId: string | undefined | null, message: string): void {
  if (!conversationId) return;
  try {
    setLatestTrajectoryUserSignal(conversationId, classifyUserSignal(message));
  } catch (e) {
    console.error('[Trajectory] user_signal backfill failed:', (e as Error).message);
  }
}
