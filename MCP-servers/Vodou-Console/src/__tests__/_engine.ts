/**
 * Is there a `vodou-core` in this tree that can actually RUN here?
 *
 * Four suites shell the engine binary and each used to `throw` from `beforeAll`
 * when it could not find a usable one. That is correct on a developer machine —
 * "run cargo build" is the right instruction — and wrong in CI, where it is not
 * a broken build but a missing platform.
 *
 * The gateway CI job (`.github/workflows/vodou-console.yml`) has node and no
 * Rust toolchain; only the `chains` job installs cargo, deliberately, so the
 * engine is not built twice. The only binary the gateway job sees is the one
 * committed to the repo — `Mach-O 64-bit executable arm64`, which cannot execute
 * on `ubuntu-latest`. Every one of those four suites therefore threw on every
 * run, and the job had never been able to pass.
 *
 * So: probe by EXECUTING, not by `existsSync`. A file that is present and of the
 * wrong architecture is exactly the case that made a presence check useless.
 * When nothing runs, say so loudly and skip — a skip is visible in the run
 * output, whereas relaxing the assertions would hide the gap behind a green
 * check.
 *
 * One rule, used by all four. Four private copies of "is the engine here" is how
 * two of them end up disagreeing.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

const CANDIDATES = [
  path.join(ROOT, 'target', 'release', 'vodou-core'),
  path.join(ROOT, 'target', 'debug', 'vodou-core'),
  path.join(ROOT, 'vodou-core'),
].filter(existsSync);

/**
 * The first candidate that runs `args` here and whose output matches `mustMatch`.
 * `null` when none does — including when the file exists but is built for
 * another platform.
 */
export function findEngine(args: string[], mustMatch?: RegExp): string | null {
  for (const bin of CANDIDATES) {
    try {
      const out = execFileSync(bin, args, {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!mustMatch || mustMatch.test(out)) return bin;
    } catch {
      /* wrong platform, missing subcommand, or a refusal — all mean "not usable" */
    }
  }
  return null;
}

/** Say what did not run and why, once, where a CI log will show it. */
export function announceEngineSkip(suite: string, needs: string): void {
  console.error(
    `[${suite}] SKIPPED: no vodou-core in this tree can run \`${needs}\`.\n` +
      `${' '.repeat(suite.length + 2)}Candidates: ${CANDIDATES.join(', ') || 'none found'}.\n` +
      `${' '.repeat(suite.length + 2)}On a dev machine: run \`cargo build --bin vodou-core\`.\n` +
      `${' '.repeat(suite.length + 2)}In CI this is expected — the gateway job has no Rust toolchain and the\n` +
      `${' '.repeat(suite.length + 2)}committed binary is macOS/arm64. Environment gap, NOT a passing test.`,
  );
}
