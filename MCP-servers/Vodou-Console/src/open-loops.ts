/**
 * PLAN-LOOPS-THAT-READ-THE-RECEIPTS P4 — the gateway's half of `open_loops`.
 *
 * The engine owns `vodou-core.db`, so nothing here opens it (lane canon rule
 * 4). What the gateway owns is `graph_runs`: it is the only thing that knows
 * when a run parks on a question or exits blocked. So it tells the engine, and
 * the engine decides what a loop is.
 *
 * **Every call here is fire-and-forget by contract.** A run that cannot record
 * its unfinished-ness must still run. The ledger is an observer; an observer
 * that can break the thing it observes is worse than no observer — the same
 * rule `emitTurnEvent` follows two files over.
 *
 * The `commitment` kind is deliberately not openable from here: its producer is
 * the extraction lane inside the engine, and the daemon refuses the verb.
 */

import { daemonRequest } from './daemon-client.js';

export type SurfaceLoopKind = 'parked_ask' | 'blocked_verifier' | 'disputed_fact';

/**
 * Open one loop, deduped on `ref[dedupeKey]` so a situation that repeats — a
 * run that parks, is answered, and parks again — is one row, not three.
 */
export function openLoop(
  kind: SurfaceLoopKind,
  ref: Record<string, unknown>,
  opts?: { host?: string; sourceTurn?: string; dueAt?: string; dedupeKey?: string },
): void {
  void daemonRequest('open_loops', {
    action: 'open',
    kind,
    ref,
    host: opts?.host ?? 'vodou-console',
    source_turn: opts?.sourceTurn,
    due_at: opts?.dueAt,
    dedupe_key: opts?.dedupeKey,
  }, 3_000).catch(() => { /* the run matters more than the ledger row */ });
}

/**
 * Close every open loop of `kind` whose `ref[key]` is `value`. The producer
 * carries the natural key it already has (a run id), never a loop id it would
 * have to remember across a park.
 */
export function closeLoopByRef(kind: SurfaceLoopKind, key: string, value: string, by: string): void {
  if (!value) return;
  void daemonRequest('open_loops', { action: 'close_ref', kind, key, value, by }, 3_000)
    .catch(() => { /* best effort, by contract */ });
}
