/**
 * Per-file escape from the cloned databases, for the tests that cannot use them.
 *
 * `vitest.globalSetup.ts` gives every run its own clones. That is right for the
 * ~130 files whose subject is a function. It is WRONG for a handful whose
 * subject is the LIVE SYSTEM: they drive the gateway on :8765 over HTTP, and
 * that process was started long before the test run and uses the real
 * databases.
 *
 * Isolating only the test process splits such a test in half. `library-e2e`
 * failed exactly that way: it ingested a document THROUGH the live gateway (so
 * the row landed in the real memory.db), then resolved `@doc:<slug>` in-process,
 * where the shadow root pointed at a clone that had never seen it —
 *
 *     @doc:e2e-fidelity-probe resolved to no document text: expected 0 to be greater than 100
 *
 * — and passed 10/10 the moment isolation was disabled. The test was right; the
 * isolation was wrong for it.
 *
 * You cannot sandbox a test whose subject is the unsandboxed thing. So these
 * files get the real paths back, and the trade is stated rather than hidden:
 * **they write to production, as they always have.** Everything else does not.
 *
 * Keep this list SHORT. A file belongs here only if it talks to a running
 * gateway; needing real DATA is not a reason — the clones carry real data.
 */
import { expect } from 'vitest';

const LIVE_SYSTEM = [
  'library-e2e.test.ts',
  'gateway-port.test.ts',
  'page-id.parity.test.ts',
  'csrf-guard.test.ts',
  'host-guard.test.ts',
];

// Captured before globalSetup's redirection is visible here, from the values it
// deliberately leaves behind for exactly this purpose.
const REAL_ROOT = process.env.VODOU_TEST_REAL_ROOT;
const REAL_GATEWAY_DB = process.env.VODOU_TEST_REAL_GATEWAY_DB;

const file = expect.getState().testPath ?? '';
if (REAL_ROOT && LIVE_SYSTEM.some((f) => file.endsWith(f))) {
  process.env.VODOU_PROJECT_PATH = REAL_ROOT;
  if (REAL_GATEWAY_DB) process.env.GATEWAY_DB_PATH = REAL_GATEWAY_DB;
  console.error(
    `[test-isolation] ${file.split('/').pop()} drives the LIVE gateway — using the real databases`,
  );
}
