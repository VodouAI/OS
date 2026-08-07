import { describe, it, expect, vi, beforeEach } from 'vitest';

// PLAN-FACE-OWNS-SKILLS Pillar A — driveWorkflowHeadless drives the workflow engine to
// completion with no user input, for the inject lane. We mock ./workflow-driver.js so the
// test exercises the DRIVE logic (default selection, sentinel parsing, accumulation, the
// iteration cap) without a real skill/subprocess.

// A tiny stateful fake workflow: 2 stopping points.
//   phase 0 "depth": options {1:Quick, 2:Deep} — headless must pick "1" (first/default)
//   phase 1 "next":  options {1:Go deeper, 2:Done} — headless must pick the COMPLETING one ("2")
const state: any = { active: false, phase: 0, choices: [] as string[] };

vi.mock('../src/workflow-driver.js', () => ({
  detectWorkflow: vi.fn(),
  clearWorkflow: vi.fn(() => { state.active = false; }),
  hasActiveWorkflow: vi.fn(() => state.active),
  getActiveWorkflow: vi.fn(() => state.active ? ({
    step: 'menu',
    currentPhase: state.phase,
    stoppingPoints: [{ type: 'menu' }, { type: 'menu' }],
    options: state.phase === 0
      ? { '1': { label: 'Quick Analysis' }, '2': { label: 'Deep Dive' } }
      : { '1': { label: 'Go deeper +5' }, '2': { label: 'Done — present findings' } },
    initialSteps: [],
    initialStepsRan: true,
  }) : null),
  executeInitialSteps: vi.fn(async () => ''),
  handleWorkflowChoice: vi.fn(async (_conv: string, choice: string) => {
    state.choices.push(`${state.phase}:${choice}`);
    if (state.phase === 0) {
      state.phase = 1; // advance to "what next"
      return '__RESULTS_AND_MENU__thought session ran__MENU_FOLLOWS__## What next?\n1. Go deeper\n2. Done';
    }
    // phase 1 — the completing choice ends the workflow with raw results
    state.active = false;
    return 'FINAL SYNTHESIS: the vodou system is two coupled systems.';
  }),
}));

describe('driveWorkflowHeadless (Face Pillar A)', () => {
  beforeEach(() => { state.active = true; state.phase = 0; state.choices = []; });

  it('runs a 2-phase skill to completion, returns results with NO menu text', async () => {
    const { driveWorkflowHeadless } = await import('../src/llm.js');
    const events: any[] = [];
    const out = await driveWorkflowHeadless('brainctx:chatgpt:c1', (e) => events.push(e), 'deep think about X');

    // Picked the sane default on the first menu (1=Quick) and the COMPLETING option on the
    // second (2=Done), not "Go deeper".
    expect(state.choices).toEqual(['0:1', '1:2']);
    // The final answer is the synthesis + the interim results, and contains NO menu markup.
    expect(out).toContain('FINAL SYNTHESIS');
    expect(out).toContain('thought session ran');
    expect(out).not.toMatch(/__MENU_ONLY__|__RESULTS_AND_MENU__|__MENU_FOLLOWS__/);
    expect(out).not.toMatch(/Go deeper|## What next/);
  });

  it('is bounded — clears the workflow if it never completes (no infinite loop)', async () => {
    const wf = await import('../src/workflow-driver.js');
    // Make every choice advance-but-never-complete → the 5-iteration cap must fire.
    (wf.handleWorkflowChoice as any).mockImplementation(async () => '__MENU_ONLY__## still going\n1. more');
    const { driveWorkflowHeadless } = await import('../src/llm.js');
    const out = await driveWorkflowHeadless('brainctx:x:y', () => {}, 'go');
    expect(wf.clearWorkflow).toHaveBeenCalledWith('brainctx:x:y');
    expect(typeof out).toBe('string'); // returns cleanly, doesn't hang
  });
});
