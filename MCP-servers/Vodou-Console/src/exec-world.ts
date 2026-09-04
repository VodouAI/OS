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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { currentStack } from './stack.js';

export type ExecWorld = 'local' | 'lab';

function asWorld(v: string | undefined): ExecWorld | null {
  const t = (v || '').trim();
  return t === 'local' || t === 'lab' ? t : null;
}

/**
 * PLAN-SEAMS P4 item 5 — the stack's declaration, read from `stacks.toml`.
 *
 * Parsed line-wise like `laneTrustOf` reads lanes.toml, and for the same reason:
 * a moved comment must never fail a tool call, and the two readers agreeing on
 * the shape matters more than either being clever. Cached per process; the file
 * is a launch-time fact, and a live edit is not a supported way to change worlds
 * (`VODOU_EXEC_WORLD` is).
 */
let _stackWorlds: Map<string, ExecWorld> | null = null;
function stackExecWorld(stack: string): ExecWorld | null {
  if (!_stackWorlds) {
    _stackWorlds = new Map();
    try {
      const root = process.env.VODOU_PROJECT_PATH || path.resolve(process.cwd(), '..', '..');
      const toml = readFileSync(path.join(root, 'stacks.toml'), 'utf-8');
      let name = '';
      for (const line of toml.split('\n')) {
        const h = line.match(/^\[stacks\.([A-Za-z0-9_-]+)\]/); if (h) { name = h[1]; continue; }
        const w = line.match(/^exec_world\s*=\s*"([^"]+)"/);
        if (w && name) { const v = asWorld(w[1]); if (v) _stackWorlds.set(name, v); }
      }
    } catch { /* no registry → no declaration; the heuristic below still answers */ }
  }
  return _stackWorlds.get(stack) ?? null;
}

/** Test seam: forget the parsed registry so a fixture can be re-read. */
export function _resetExecWorldCache(): void {
  _stackWorlds = null;
}

/**
 * Which world this process executes in. One precedence, the lane-canon rule:
 *
 *   1. `VODOU_EXEC_WORLD` in the process environment — the operator's word wins;
 *   2. the stack this process was launched as (`VODOU_STACK` → stacks.toml
 *      `exec_world`) — the launcher's declaration;
 *   3. the path heuristic: `broken-lab.sh` runs an isolated instance by pointing
 *      `VODOU_PROJECT_PATH` at a temp directory it owns. That env var IS the tell —
 *      it is how the harness's own teardown finds its processes
 *      (`ps -E | grep VODOU_PROJECT_PATH=`).
 *
 * The env arms are read per call rather than cached at import: a cached answer
 * would be wrong for any process that outlives a change, and this is cheap.
 */
export function currentExecWorld(): ExecWorld {
  const forced = asWorld(process.env.VODOU_EXEC_WORLD);
  if (forced) return forced;
  const stack = currentStack();
  if (stack) {
    const declared = stackExecWorld(stack);
    if (declared) return declared;
  }
  const root = process.env.VODOU_PROJECT_PATH || '';
  if (!root) return 'local';
  // The harness works under the OS temp dir; a real install does not.
  return /vodou-broken-lab|[\\/](tmp|T)[\\/].*vodou/i.test(root) ? 'lab' : 'local';
}
