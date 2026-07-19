import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SkillRow } from '../src/api/skill-console-handler.js';

const baseSkill: SkillRow = {
  id: 7,
  name: 't',
  display_name: 'T',
  prompt_template: '{{user_message}}',
  is_active: 1,
  prefer_model: null,
  delivery_mode: 'console',
  delivery_target: null,
  history_window: 0,
  ephemeral: 0,
  principal_id: 'p',
  parameters_json: null,
  param_overrides_json: null,
  on_complete_hook: null,
  stopping_points_json: '{"stopping_points":[{"id":1,"title":"Q","options":{"1":{"label":"A","steps":[]}}}]}',
  current_phase: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('prepareSkillConsoleForLlm (POST /chat + WS parity)', () => {
  it('calls ensureSkillConsoleLayerBWorkflow before buildSkillChatArgs when active', async () => {
    const order: string[] = [];
    const wd = await import('../src/workflow-driver.js');
    vi.spyOn(wd, 'ensureSkillConsoleLayerBWorkflow').mockImplementation(() => {
      order.push('ensure');
      return { active: true, totalPhases: 1 };
    });
    const sh = await import('../src/api/skill-console-handler.js');
    vi.spyOn(sh, 'buildSkillChatArgs').mockImplementation(async () => {
      order.push('build');
      return { renderedPrompt: 'built', preferModel: null };
    });
    const { prepareSkillConsoleForLlm } = await import('../src/api/skill-console-chat-pipeline.js');
    const r = await prepareSkillConsoleForLlm(
      {} as never,
      'workbench:skill-console:x',
      baseSkill,
      true,
      'hi',
      {},
      'fallback',
    );
    expect(order).toEqual(['ensure', 'build']);
    expect(r.renderedPrompt).toBe('built');
  });

  it('skips layer B and build when skill inactive (uses fallback prompt)', async () => {
    const wd = await import('../src/workflow-driver.js');
    const sh = await import('../src/api/skill-console-handler.js');
    const ensureSpy = vi.spyOn(wd, 'ensureSkillConsoleLayerBWorkflow');
    const buildSpy = vi.spyOn(sh, 'buildSkillChatArgs');
    const { prepareSkillConsoleForLlm } = await import('../src/api/skill-console-chat-pipeline.js');
    const r = await prepareSkillConsoleForLlm(
      {} as never,
      'workbench:skill-console:x',
      { ...baseSkill, is_active: 0 },
      false,
      'x',
      {},
      'raw-fallback',
    );
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(buildSpy).not.toHaveBeenCalled();
    expect(r).toEqual({ renderedPrompt: 'raw-fallback', preferModel: null });
  });
});
