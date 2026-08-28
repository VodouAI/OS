/**
 * COHERENCE F14 — "It was broken for 38 hours because it was quietly running
 * last week's build, and nothing could tell us that."
 *
 * The gateway is the third long-lived process in the stack and the one that
 * wedged on 2026-08-20. The engine reports its build identity from
 * `src/build_identity.rs`; this pins the same contract on the node side.
 *
 * What matters here is not the field list but two invariants that the Rust side
 * also holds, because an identity that gets either one wrong is worse than none:
 *
 *   1. The stamp is taken at process start, so a rebuild UNDER a running
 *      process shows as drift rather than being papered over.
 *   2. Stamps travel as naive UTC — the same shape every other Vodou timestamp
 *      uses (PLAN-TIME-CANON), so a reader renders them local without guessing.
 */

import { describe, it, expect } from 'vitest';
import { gatewayBuild, gatewayBuildHints } from '../build-identity.js';

describe('gateway build identity', () => {
  it('names the running process', () => {
    const b = gatewayBuild();
    expect(b.pid).toBe(process.pid);
    expect(b.node).toBe(process.version);
    expect(b.entry).toMatch(/index\.js$/);
    expect(typeof b.version).toBe('string');
  });

  it('stamps time as naive UTC, never RFC3339', () => {
    const b = gatewayBuild();
    expect(b.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    if (b.mtime !== null) {
      expect(b.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(b.mtime).not.toContain('T');
      expect(b.mtime).not.toContain('Z');
    }
  });

  it('says something concrete whenever it flags a problem', () => {
    // Whatever this checkout's state, a hint must always be a sentence a person
    // can act on — the failure mode of every finding in this family is a
    // surface that knows something is wrong and does not say what to do.
    for (const h of gatewayBuildHints()) {
      expect(h.length).toBeGreaterThan(40);
      expect(h).toMatch(/rebuild|Restart|restart/);
    }
  });

  it('reports drift for a build replaced under a running process', () => {
    const stale = {
      version: '1.0.0',
      entry: '/x/dist/index.js',
      size: 100,
      mtime: '2026-08-19 14:02:00',
      startedAt: '2026-08-19 14:03:00',
      pid: 1,
      node: 'v22.0.0',
      staleOnDisk: true,
      srcNewest: null,
      srcTouchedAfterBuild: false,
    };
    const hints = gatewayBuildHints(stale);
    expect(hints.some((h) => h.includes('no longer on disk'))).toBe(true);
  });

  it('calls a source file dated after the build a prompt, not a verdict', () => {
    // mtime moves on a checkout as well as on an edit, and this check produced
    // a false positive the first time it ran against a dist that was in fact
    // current. Overclaiming here is the same defect the finding is about.
    const touched = {
      version: '1.0.0',
      entry: '/x/dist/index.js',
      size: 100,
      mtime: '2026-08-19 14:02:00',
      startedAt: '2026-08-19 14:03:00',
      pid: 1,
      node: 'v22.0.0',
      staleOnDisk: false,
      srcNewest: '2026-08-21 01:51:02',
      srcTouchedAfterBuild: true,
    };
    const hints = gatewayBuildHints(touched);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('prompt rather than a verdict');
    expect(hints[0]).not.toContain('is serving older code');
  });

  it('is quiet when nothing is wrong', () => {
    const clean = {
      version: '1.0.0',
      entry: '/x/dist/index.js',
      size: 100,
      mtime: '2026-08-21 12:00:00',
      startedAt: '2026-08-21 12:00:01',
      pid: 1,
      node: 'v22.0.0',
      staleOnDisk: false,
      srcNewest: '2026-08-21 11:00:00',
      srcTouchedAfterBuild: false,
    };
    expect(gatewayBuildHints(clean)).toEqual([]);
  });
});
