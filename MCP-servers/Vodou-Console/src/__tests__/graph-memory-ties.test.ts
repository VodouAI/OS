/**
 * §3.2 M2 — LLM nodes write in the user's voice without the recipe saying so.
 *
 * What is worth asserting is the DISCIPLINE, not that a subprocess ran:
 * the profile is bounded and cached, and a missing or slow profile degrades to
 * "no personalisation" rather than to "no run".
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { findEngine, announceEngineSkip } from './_engine.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { getMemoryProfile, _resetMemoryProfileCache } from '../executor.js';

let binOk = false;

const ENGINE = findEngine(['mem', 'profile']);
const ENGINE_OK = ENGINE !== null;
if (!ENGINE_OK) announceEngineSkip('graph-memory-ties', 'mem profile');

beforeAll(() => {
  if (ENGINE) process.env.VC_PATH = ENGINE;
  // `binOk` is asserted by the first test. Dropping it when this block was
  // rewritten turned a green suite red — caught by running it, not by tsc.
  binOk = ENGINE_OK;
});

beforeEach(() => _resetMemoryProfileCache());

describe('memory profile for LLM nodes (M2)', () => {
  it.runIf(ENGINE_OK)('returns durable personal facts as text', async () => {
    expect(binOk).toBe(true);
    const p = await getMemoryProfile();
    // The profile may legitimately be empty on a fresh install; when it is not,
    // it must be prose, not JSON, and bounded rather than a memory dump.
    expect(typeof p).toBe('string');
    if (p) {
      expect(p.trim().startsWith('{')).toBe(false);
      expect(p.length).toBeLessThan(8000);
    }
  });

  it.runIf(ENGINE_OK)('caches, so a fan of prompt steps does not spawn one subprocess each', async () => {
    const t0 = Date.now();
    await getMemoryProfile();
    const cold = Date.now() - t0;
    const t1 = Date.now();
    await getMemoryProfile();
    const warm = Date.now() - t1;
    expect(warm).toBeLessThanOrEqual(Math.max(cold, 5));
  });

  it.runIf(ENGINE_OK)('degrades to empty rather than throwing when the binary is unusable', async () => {
    // Personalisation is a bonus on top of the work, never a precondition:
    // a broken profile lookup must not take a run down with it.
    const saved = process.env.VC_PATH;
    process.env.VC_PATH = '/nonexistent/vodou-core';
    _resetMemoryProfileCache();
    await expect(getMemoryProfile(2000)).resolves.toBe('');
    process.env.VC_PATH = saved;
    _resetMemoryProfileCache();
  });
});
