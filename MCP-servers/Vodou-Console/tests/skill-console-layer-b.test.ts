import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseWorkflowStoppingPointsJson,
  ensureSkillConsoleLayerBWorkflow,
  handleWorkflowChoice,
  clearWorkflow,
  hasActiveWorkflow,
} from '../src/workflow-driver.js';

const minimalSp = JSON.stringify({
  stopping_points: [
    {
      id: 1,
      title: 'Pick one',
      options: {
        '1': { label: 'Option A', steps: [] },
        '2': { label: 'Option B', steps: [] },
      },
    },
  ],
});

afterEach(() => {
  clearWorkflow('workbench:skill-console:t-layer-b');
});

describe('Layer B — skill console workflow', () => {
  it('parseWorkflowStoppingPointsJson accepts object and bare array', () => {
    const p = parseWorkflowStoppingPointsJson(minimalSp);
    expect(p?.stoppingPoints.length).toBe(1);
    const arr = JSON.stringify([JSON.parse(minimalSp).stopping_points[0]]);
    const p2 = parseWorkflowStoppingPointsJson(arr);
    expect(p2?.stoppingPoints.length).toBe(1);
  });

  it('ensureSkillConsoleLayerBWorkflow clears when phase past end', () => {
    ensureSkillConsoleLayerBWorkflow({
      conversationId: 'workbench:skill-console:t-layer-b',
      skillName: 't-layer-b',
      skillMetaId: 1,
      stoppingPointsJson: minimalSp,
      currentPhaseDb: 5,
    });
    expect(hasActiveWorkflow('workbench:skill-console:t-layer-b')).toBe(false);
  });

  it('invalid menu reply re-shows menu for skill_console origin', async () => {
    ensureSkillConsoleLayerBWorkflow({
      conversationId: 'workbench:skill-console:t-layer-b',
      skillName: 't-layer-b',
      skillMetaId: 42,
      stoppingPointsJson: minimalSp,
      currentPhaseDb: 0,
    });
    const onEvent = vi.fn();
    const r = await handleWorkflowChoice(
      'workbench:skill-console:t-layer-b',
      'not-a-valid-choice',
      onEvent,
    );
    expect(r).toBeTruthy();
    expect(r).toContain('__MENU_ONLY__');
    expect(r).toContain('That did not match');
    expect(r).toContain('Pick one');
  });
});
