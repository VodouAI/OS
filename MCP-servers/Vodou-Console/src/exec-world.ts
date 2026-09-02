/**
 * P2b — which world did this run in?
 *
 * The `world-tagged` grader has answered `?` across 464 tool calls, because
 * `emitToolEvent` accepts a `world` and nothing ever passed one. The plumbing was
 * built; the value was never supplied.
 *
 * This is deliberately SMALL. The original P2b proposed four execution worlds
 * with a runtime sandbox each. Two of those did not survive re-measurement
 * (SEAMS §36): `remote` was already "declared stub, NOT built", and `lab` was
 * justified by "broken-lab touches the live DB", which `broken-lab.sh:263` now
 * prevents by asserting isolation and refusing to continue.
 *
 * So what is left is the honest part: SAY which world a call ran in, so the log
 * can be read and the grader can stop saying `?`. Everything runs locally today —
 * except under the lab harness, and that distinction is worth recording because
 * a lab run's tool calls sitting unlabelled next to real ones is exactly how a
 * harness's output gets mistaken for the live system.
 */

export type ExecWorld = 'local' | 'lab';

/**
 * `broken-lab.sh` runs an isolated instance by pointing `VODOU_PROJECT_PATH` at a
 * temp directory it owns. That env var IS the tell — it is how the harness's own
 * teardown finds its processes (`ps -E | grep VODOU_PROJECT_PATH=`).
 *
 * Read per call rather than cached at import: a cached answer would be wrong for
 * any process that outlives a change, and this is cheap.
 */
export function currentExecWorld(): ExecWorld {
  const root = process.env.VODOU_PROJECT_PATH || '';
  if (!root) return 'local';
  // The harness works under the OS temp dir; a real install does not.
  return /vodou-broken-lab|[\\/](tmp|T)[\\/].*vodou/i.test(root) ? 'lab' : 'local';
}
