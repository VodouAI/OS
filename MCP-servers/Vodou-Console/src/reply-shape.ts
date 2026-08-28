/**
 * Is this reply the WORK, or talk about the work?
 *
 * Two lanes arrived at that question independently, six weeks apart, and each
 * answered it privately:
 *
 *   - `vbb/chat.ts` (browser panel tasks) — `looksLikeNarration`: the agent did
 *     the work and then reported ON it instead of delivering it ("Now the
 *     synthesis thought (5)."). Withheld from the composer, shown on the card.
 *   - `job-followup.ts` (gateway chat) — `promisesFollowup`: the reply defers the
 *     result to a turn that will never come ("I'll report when it lands").
 *
 * Same question, two halves: one reply is about work already done, the other is
 * about work not yet done. Both are the product describing itself rather than
 * answering. They belong in one file so the next person who needs "does this
 * reply actually deliver?" finds the answer instead of writing a third copy —
 * which is exactly how the dock ended up with four unread-badge blocks.
 *
 * Pure functions over text. No imports, no state, no I/O: callers own the policy
 * (what to do about it), this module owns only the reading.
 */

/** Enough of a reply to see how it signed off. */
export const TAIL_SCAN_CHARS = 700;

/**
 * The reply promises a later report. Drawn from real gateway turns, not
 * imagined: "I'll read the exit code straight out of the log when it lands and
 * report…", "still compiling in the background; I'll report when they land",
 * "Watching it in the background."
 */
const PROMISE_PATTERNS: RegExp[] = [
  /\bwatcher armed\b/i,
  /\bi'?ll\s+(?:\w+\s+){0,6}?(?:report|update you|let you know|check back|come back|tell you|post)\b/i,
  /\b(?:report|update|results?|answer)\s+(?:back\s+)?(?:when|once)\s+(?:it|they|the job|the run|that)\b/i,
  /\bwhen\s+(?:it|they|the job|the run)\s+(?:lands?|finish(?:es)?|exits?|completes?)\b/i,
  /\bwatching\s+(?:it|them|this)\s+in the background\b/i,
];

/** Does this reply defer its result to a later turn? Only the tail matters — a
 *  promise is a sign-off, not a mid-paragraph aside. */
export function promisesFollowup(text: string): boolean {
  const tail = String(text || '').slice(-TAIL_SCAN_CHARS);
  return PROMISE_PATTERNS.some((re) => re.test(tail));
}

/**
 * Does this "result" merely NARRATE the work instead of delivering it?
 *
 * A skill's tool call STORES its output (e.g. add_thought writes a thought to the
 * Enhanced-Thinking DB); it does not SHOW it. When the model then replies "Now the
 * synthesis thought (5)." the real analysis is stranded in the database and the user
 * gets nothing — observed 2026-08-05. The skill prompt now forbids this, but a prompt
 * is behavioural, not a guarantee: a weaker local model (kimi/Qwen) narrates far more
 * readily than the model this was verified on.
 *
 * We deliberately do NOT try to reconstruct the missing content (pulling raw tool
 * output would inject exactly the JSON that cleanForDelivery strips). We only make an
 * invisible failure VISIBLE: flag it, keep it out of the user's composer, and let the
 * Tasks card say what happened.
 *
 * Conservative on purpose — a genuinely short answer ("Apple M1 Pro, 10 cores") must
 * never be flagged, so this requires BOTH heavy tool work AND a narration shape. The
 * 400/120-char bounds are load-bearing, not taste: "Now that I check, your CPU is an
 * M1 Pro with 10 cores…" is a real answer that merely opens with "Now", and flagging
 * it would withhold a correct result — worse than the bug being guarded.
 */
export function looksLikeNarration(text: string, heavy: boolean): boolean {
  const t = String(text || '').trim();
  if (!heavy || !t) return false;              // only after real tool/skill work
  if (t.length > 400) return false;            // substantial output is not narration

  // (a) Explicitly about the PROCESS — "…thought 5.", "…step 3 of 5". Unambiguous.
  if (/\b(thought|step|iteration)\s*\(?\d+\)?\s*(of\s*\d+)?\s*[.…]?$/i.test(t)) return true;

  // (b) A stock lead-in AND too short to carry an answer. (Caught by its own
  // test, 2026-08-05.)
  return t.length < 120
    && /^(now|next|let me|i'?ll|i am going to|proceeding|continuing|adding|running|here'?s? the (next|final))\b/i.test(t);
}
