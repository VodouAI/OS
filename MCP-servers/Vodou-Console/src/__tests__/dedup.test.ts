import { describe, it, expect } from 'vitest';
import { dedupeInFlight } from '../executor.js';

// Single-flight dedup guards the 2026-06-08 spawn storm: concurrent identical
// tool dispatches must collapse onto ONE underlying call, and the in-flight map
// must never leak (entry cleared on resolve AND reject).
describe('dedupeInFlight (tool-call single-flight)', () => {
  it('collapses N concurrent identical calls to ONE factory invocation', async () => {
    const map = new Map<string, Promise<string>>();
    let calls = 0;
    let resolve!: (v: string) => void;
    const factory = () => {
      calls++;
      return new Promise<string>((r) => { resolve = r; });
    };
    const p1 = dedupeInFlight(map, 'k', factory);
    const p2 = dedupeInFlight(map, 'k', factory);
    const p3 = dedupeInFlight(map, 'k', factory);

    expect(calls).toBe(1);          // factory ran once for 3 concurrent calls
    expect(p1).toBe(p2);            // same shared promise
    expect(p2).toBe(p3);
    expect(map.size).toBe(1);       // exactly one in-flight entry

    resolve('done');
    await Promise.all([expect(p1).resolves.toBe('done'), expect(p2).resolves.toBe('done')]);
    expect(map.size).toBe(0);       // cleared on settle — no leak
  });

  it('clears the in-flight entry on REJECTION too (no leak)', async () => {
    const map = new Map<string, Promise<string>>();
    let reject!: (e: Error) => void;
    const p = dedupeInFlight(map, 'k', () => new Promise<string>((_, rj) => { reject = rj; }));
    expect(map.size).toBe(1);

    reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(map.size).toBe(0);
  });

  it('runs distinct keys independently', async () => {
    const map = new Map<string, Promise<string>>();
    let calls = 0;
    const factory = () => { calls++; return Promise.resolve('x'); };
    await Promise.all([
      dedupeInFlight(map, 'a', factory),
      dedupeInFlight(map, 'b', factory),
    ]);
    expect(calls).toBe(2);          // different keys are NOT collapsed
  });

  it('re-invokes after the in-flight window closes (sequential calls untouched)', async () => {
    const map = new Map<string, Promise<string>>();
    let calls = 0;
    const factory = () => { calls++; return Promise.resolve('x'); };
    await dedupeInFlight(map, 'k', factory); // settles, entry cleared
    await dedupeInFlight(map, 'k', factory); // fresh call → runs again
    expect(calls).toBe(2);
  });
});
