/**
 * B17 — the single-shot CLI path has a watchdog, on the pool's budget.
 *
 * A structural test, said plainly: `chatWithCLI` spawns a real `claude` and
 * there is no binary-swap hook, so a hung one-shot cannot be reproduced here
 * without a real process. What CAN be pinned is the shape that was missing:
 * the watchdog exists, it reads the SAME constant the pool reads, it honours
 * the same `> 0` disable, it kills AND rejects (a reject alone leaves an
 * orphan; a kill alone leaves the slot), and `close` clears it. The live
 * proof is /health after a restart: `oneShotTurns` returns to 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const src = readFileSync(path.resolve(__dirname, '../llm.ts'), 'utf-8');
const oneShot = src.slice(src.indexOf('_oneShotTurns.add(_oneShot)'), src.indexOf('_oneShotDone.finally('));

describe('B17 — one-shot watchdog', () => {
  it('exists inside the one-shot Promise', () => {
    expect(oneShot).toContain('_oneShotWatchdog = setTimeout(');
  });
  it('reads the pool\'s constant, not a second budget, and honours 0 the same way', () => {
    expect(oneShot).toContain('if (CLI_TURN_TIMEOUT_MS > 0)');
    expect(oneShot).toContain('}, CLI_TURN_TIMEOUT_MS);');
    expect(oneShot).not.toMatch(/ONE_SHOT_TIMEOUT|oneShotTimeoutMs|900000/);
  });
  it('kills AND rejects on expiry — either alone reproduces the leak', () => {
    const wd = oneShot.slice(oneShot.indexOf('_oneShotWatchdog = setTimeout('), oneShot.indexOf('}, CLI_TURN_TIMEOUT_MS);'));
    expect(wd).toContain("proc.kill('SIGKILL')");
    expect(wd).toContain('reject(new Error(msg))');
  });
  it('is cleared when the process closes normally', () => {
    const close = oneShot.slice(oneShot.indexOf("proc.on('close'"));
    expect(close.slice(0, 200)).toContain('clearTimeout(_oneShotWatchdog)');
  });
});
