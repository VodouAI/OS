/**
 * Which run composition this process is — the TypeScript side of `stacks.toml`.
 *
 * PLAN-SEAMS P4. Mirrors `src/stack_registry.rs::current_stack` and sits beside
 * `exec-world.ts` from P2b, deliberately: both answer "what kind of run is this"
 * and neither should be inferred twice in two places.
 *
 * Precedence is the lane-canon rule, unchanged: the process environment wins.
 * There is no `.env` or gateway-setting arm here on purpose — a stack is a
 * property of HOW you were launched, and a stored setting that disagreed with
 * the launcher would be a second source of truth for the one thing stacks.toml
 * exists to make single.
 *
 * WHY THIS IS ON THE RECEIPT, and why it is NOT a per-lane `off (stack)`.
 *
 * The P4 draft asked for "a lane off in the current stack renders `off (stack)`".
 * Measured against seven days of real receipts, that premise does not hold:
 * `hook_memory` is the MOST FREQUENT lane on gateway receipts (163 rows) and it
 * is in the web stack's `lanes_off`. Both are correct. `persistTurnLanes`
 * deliberately keeps `hook_*` rows because the daemon appends the CHILD's lane
 * to the gateway's receipt — the lane is recorded on that row and injected by
 * someone else. Rendering those 163 rows `off (stack)` would have been a
 * user-visible regression dressed as a feature.
 *
 * What is true, and what a person actually needs to read a receipt, is which
 * composition the turn ran in. `web` and `headless` inject different sets; the
 * stack name is the fact that makes a missing lane interpretable instead of
 * ambiguous, and nothing else on the turn records it.
 */

export type StackName = string;

/**
 * The stack this process was launched as, or null when its entrypoint did not
 * declare one. Null is returned rather than a guess: silence when ignorant is
 * the same rule `buildReceipt` follows for everything else it reports, and a
 * fabricated stack name would be worse than an absent one.
 */
export function currentStack(): StackName | null {
  const s = (process.env.VODOU_STACK || '').trim();
  return s ? s : null;
}
