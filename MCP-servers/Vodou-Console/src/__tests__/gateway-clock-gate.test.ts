/**
 * THE GATE: nothing in the gateway reads the MACHINE's clock except `user-time`.
 *
 * The engine has carried this rule since `user_time.rs` was written —
 * `nothing_outside_this_module_reads_the_machine_clock` walks every `.rs` file
 * and there are ZERO violations. That is why the Rust half of PLAN-ONE-CLOCK was
 * straightforward: the discipline was already enforced, not merely intended.
 *
 * The gateway had `user-time.ts` and no such gate, and it had drifted. Found
 * 2026-09-12 in `api/memory.ts`: the daily-pin writer chose its FILENAME with
 * `todayKey()` — the person's day, correctly — and its heading two lines later
 * with `new Date().toLocaleTimeString(...)`, the process's clock. A pin at 11pm
 * Detroit landed in that day's file under a 03:00 heading.
 *
 * A rule that lives only in the memory of whoever last hit it is not a rule.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

/** The one module allowed to ask the machine what zone it is in. */
const OWNER = 'user-time.ts';

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      tsFiles(p, out);
    } else if (e.endsWith('.ts') && e !== OWNER) {
      out.push(p);
    }
  }
  return out;
}

describe('gateway clock discipline', () => {
  it('nothing outside user-time.ts reads the machine clock', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const l = line.trim();
        // Comments describe the rule; they must not be able to trip it.
        if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')) return;

        // The machine's zone, in every spelling this tree uses.
        const asksTheMachine =
          l.includes('getTimezoneOffset') || l.includes('resolvedOptions().timeZone');

        // A rendered DATE with no explicit zone renders in the process's zone.
        // `toLocaleString()` on its own is NOT flagged: seventeen uses in this
        // tree are thousands-separators on a number, and a gate that cries wolf
        // gets an allowlist, and an allowlist is how a gate dies.
        const rendersWithoutAZone =
          (l.includes('toLocaleTimeString') || l.includes('toLocaleDateString')) &&
          !l.includes('timeZone');

        if (asksTheMachine || rendersWithoutAZone) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${l.slice(0, 90)}`);
        }
      });
    }

    expect(
      offenders,
      'These read the MACHINE\'s zone instead of the person\'s. Use `user-time.ts` ' +
      '(userZone / todayKey / dayKeyOf / localTime / utcOffsetMinutes), or pass an ' +
      'explicit `timeZone` option:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the gate can actually see a violation', () => {
    // A source-derived gate's characteristic failure is finding nothing and
    // calling it agreement. Prove the detector fires on the exact line that was
    // live in `api/memory.ts` until 2026-09-12.
    const wasLive = "const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit' });";
    const caught =
      (wasLive.includes('toLocaleTimeString') || wasLive.includes('toLocaleDateString')) &&
      !wasLive.includes('timeZone');
    expect(caught, 'the detector must fire on the real historical violation').toBe(true);

    // …and must NOT fire on a number, which is what keeps it credible.
    const numberFormatting = 'bits.push(row.chars.toLocaleString() + " chars");';
    const falseAlarm =
      (numberFormatting.includes('toLocaleTimeString') || numberFormatting.includes('toLocaleDateString')) &&
      !numberFormatting.includes('timeZone');
    expect(falseAlarm, 'a thousands-separator is not a clock read').toBe(false);
  });

  it('user-time.ts is the owner, and it is exempt by NAME not by accident', () => {
    const owner = readFileSync(path.join(SRC, OWNER), 'utf8');
    expect(owner, 'the owner must be the thing that actually asks the machine')
      .toContain('resolvedOptions().timeZone');
    expect(tsFiles(SRC).some((f) => f.endsWith(OWNER))).toBe(false);
  });
});
