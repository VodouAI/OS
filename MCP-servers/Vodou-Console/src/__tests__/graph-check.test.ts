/**
 * The verifier bridge (PLAN-GRAPH-SKILLS P2 §7).
 *
 * The property that matters is not "checks run". It is that a check which
 * CANNOT run answers `unknown` and never `pass` — a verifier that greenlights
 * because its own machinery broke is worse than no verifier, because it
 * manufactures confidence.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { findEngine, announceEngineSkip } from './_engine.js';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { runCheck } from '../executor.js';

const ENGINE = findEngine(['recipe', 'check', '--help'], /artifact/);
const ENGINE_OK = ENGINE !== null;
if (!ENGINE_OK) announceEngineSkip('graph-check', 'recipe check');

beforeAll(() => {
  if (ENGINE) process.env.VC_PATH = ENGINE;
});

describe('anchored checks answer without a model', () => {
  it.runIf(ENGINE_OK)('fails unattributed work and names the offending line', async () => {
    const v = await runCheck('every item names its source', '- revenue rose 4%\n- churn fell, per the board deck\n');
    expect(v.check).toBe('has_source');
    expect(v.verdict).toBe('fail');
    expect(v.offenders?.[0]).toContain('revenue rose 4%');
    expect(v.detail).toContain('1/2');
  });

  it.runIf(ENGINE_OK)('passes work where every claim is attributed', async () => {
    const v = await runCheck('every item names its source', '- revenue rose 4% (source: Q3 filing)\n- see https://x.test/a\n');
    expect(v.verdict).toBe('pass');
  });

  it.runIf(ENGINE_OK)('answers unknown, not pass, when there is nothing to look at', async () => {
    // A grader with no evidence says "nobody looked", not "fine".
    const v = await runCheck('every item names its source', '# heading only\n');
    expect(v.verdict).toBe('unknown');
    expect(v.verdict).not.toBe('pass');
  });

  it.runIf(ENGINE_OK)('validates JSON through a code fence', async () => {
    expect((await runCheck('is it valid JSON', '```json\n{"a":1}\n```')).verdict).toBe('pass');
    expect((await runCheck('is it valid JSON', '{oops}')).verdict).toBe('fail');
  });
});

describe('unanchored rules hand back a rubric instead of a verdict', () => {
  it.runIf(ENGINE_OK)('returns needs_judge with the prompt, and never invents a pass', async () => {
    const v = await runCheck('do the numbers add up', '2 + 2 = 5');
    expect(v.verdict).toBe('needs_judge');
    expect(v.check).toBe('llm_judge');
    expect(v.prompt).toContain('do the numbers add up');
    expect(v.prompt).toContain('Do not invent an objection');
    expect(v.prompt).toContain('UNKNOWN');
  });

  it.runIf(ENGINE_OK)('refuses fact_in_source with no source — the source IS the anchor', async () => {
    const v = await runCheck('is this actually in the source', 'the user prefers concise replies');
    expect(v.verdict).toBe('unknown');
    expect(v.detail).toContain('needs --source');
  });

  it.runIf(ENGINE_OK)('builds the fact_in_source rubric around "does the source say it"', async () => {
    // The live bridge bug: a 4B produced a [PREF] from "just saying hi".
    // Plausible-given-the-source is exactly the trap.
    const v = await runCheck('is this actually in the source', 'the user prefers concise replies', 'just saying hi');
    expect(v.verdict).toBe('needs_judge');
    expect(v.check).toBe('fact_in_source');
    expect(v.prompt).toContain('just saying hi');
    expect(v.prompt).toContain('merely plausible given the source is NO');
  });
});

describe('a check that cannot run', () => {
  it.runIf(ENGINE_OK)('is unknown, never pass', async () => {
    const saved = process.env.VC_PATH;
    process.env.VC_PATH = '/nonexistent/vodou-core';
    const v = await runCheck('every item names its source', '- a claim');
    expect(v.verdict).toBe('unknown');
    expect(v.verdict).not.toBe('pass');
    process.env.VC_PATH = saved;
  });
});
