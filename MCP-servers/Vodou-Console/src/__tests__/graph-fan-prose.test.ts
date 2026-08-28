/**
 * B8 — a prose step in `together:` actually runs.
 *
 * `members` was filtered to server+tool before the fan ran, so a prose branch
 * was dropped silently: a prose-only fan reached the runner with zero steps
 * ("group spec has no steps"), a mixed fan lost its prose while the join
 * counted the whole block. The compiler INTENDS prose in a fan — `ask first:`
 * puts a `plan:` there, and independent `then:` prose is moved up. So the
 * driver must run it. This drives the real driver with a fake LLM and asserts
 * the branch SETTLES, in the run record, as a first-class member of the fan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeSteps, _setRawLLMCallForTest } from '../workflow-driver.js';
import { listRuns, getRun } from '../graph-runs.js';

// No engine gate here, on purpose. The mixed fan's tool branch DOES shell
// `vodou-core call-group`, and on the gateway CI runner that cannot start. But
// a tool branch that cannot start must fail ALONE (6621d310) — the prose
// sibling settles, the join reads 1/2 — so this suite holds on a machine with
// no engine at all. Gating it would hide exactly the behaviour it exists to pin.

const CONV = 'b8-prose-fan';

describe('B8 — prose in a fan', () => {
  /** Every prompt the fake model was handed, so a test can assert what a
   *  step SAW — the real contract — rather than guess at substitution. */
  const seen: string[] = [];
  beforeEach(() => { seen.length = 0; _setRawLLMCallForTest(async (_c: string, prompt: string) => { seen.push(prompt); return `LLM says: ${prompt.slice(0, 40)}`; }); });

  it('a prose-only fan runs every branch instead of asking the runner to run nothing', async () => {
    const steps = [
      { id: 'a', prompt: 'name three colours', parallel_group: 'g' },
      { id: 'b', prompt: 'name three primes', parallel_group: 'g' },
      { id: 'j', kind: 'join', in: ['a', 'b'], min_success: 2 },
    ];
    const out = await executeSteps(steps as never, {}, () => {}, CONV, 'b8-prose-only');
    expect(out).not.toContain('group spec has no steps');
    expect(out).toMatch(/Join.*2\/2/);
    const run = listRuns('b8-prose-only', 1)[0];
    const states = JSON.parse(String(getRun(run.run_id)?.node_states_json ?? '[]')) as Array<{ id: string; state: string; server?: string }>;
    for (const id of ['a', 'b']) {
      const b = states.find((s) => s.id === id);
      expect(b?.state, `prose branch ${id} must settle ok`).toBe('ok');
      expect(b?.server).toBe('llm');
    }
  });

  it('a mixed fan keeps its prose branch, and a later template can read it', async () => {
    const steps = [
      { id: 'plan', prompt: 'draft an approach', parallel_group: 'g' },
      { id: 'cpu', server: 'no-such-server-b8', tool: 'nope', args: {}, parallel_group: 'g', on_fail: 'skip' },
      { id: 'j', kind: 'join', in: ['plan', 'cpu'], min_success: 1 },
      { id: 'grill', prompt: 'attack this: {plan}', depends_on: ['j'] },
    ];
    const out = await executeSteps(steps as never, {}, () => {}, CONV, 'b8-mixed');
    // The prose branch is counted — 1 ok of 2 expected, not 0 of 1.
    expect(out).toMatch(/Join.*1\/2/);
    // `{plan}` is a reference, not a template: the compiler makes it a
    // depends_on edge and the branch's OUTPUT reaches `grill` as prior context
    // — exactly as a tool branch's would. Assert what grill was handed.
    const grillPrompt = seen.find((p) => p.startsWith('attack this:'));
    expect(grillPrompt, 'the dependent prose step never ran').toBeDefined();
    expect(grillPrompt).toContain('## Output from earlier steps');
    expect(grillPrompt).toContain('### llm::plan');
    expect(grillPrompt).toContain('LLM says: draft an approach');
  });

  /**
   * The failure CI found on 2026-08-27 (run #426/#427). The tool half of a fan
   * is ONE engine process; when that process cannot start — the committed
   * binary is macOS/arm64 and ubuntu cannot exec it — the rejection used to
   * reach the whole-group catch, which recorded the fan as 0/2 settled while
   * the prose branch sat finished in memory. A transport failure must settle
   * only the branches that needed the transport.
   *
   * VC_PATH is the executor's binary override; pointing it nowhere is exactly
   * the CI condition, on any machine.
   */
  it('a tool branch whose engine cannot start fails alone — the prose sibling still settles', async () => {
    const prev = process.env.VC_PATH;
    process.env.VC_PATH = '/nonexistent/vodou-core-for-b8';
    try {
      const steps = [
        { id: 'plan', prompt: 'draft an approach', parallel_group: 'g' },
        { id: 'cpu', server: 'no-such-server-b8', tool: 'nope', args: {}, parallel_group: 'g', on_fail: 'skip' },
        { id: 'j', kind: 'join', in: ['plan', 'cpu'], min_success: 1 },
      ];
      const out = await executeSteps(steps as never, {}, () => {}, CONV, 'b8-no-engine');
      expect(out).toMatch(/Join.*1\/2/);
      const run = listRuns('b8-no-engine', 1)[0];
      const states = JSON.parse(String(getRun(run.run_id)?.node_states_json ?? '[]')) as Array<{ id: string; state: string; detail?: string; error?: string }>;
      expect(states.find((s) => s.id === 'plan')?.state, 'the prose branch never touched the engine').toBe('ok');
      const cpu = states.find((s) => s.id === 'cpu');
      expect(cpu?.state, 'the tool branch is the one that failed').toBe('failed');
      expect(String(cpu?.detail ?? cpu?.error ?? ''), 'and it says WHY, in the run record').toContain('engine unavailable');
    } finally {
      if (prev === undefined) delete process.env.VC_PATH; else process.env.VC_PATH = prev;
    }
  });
});
