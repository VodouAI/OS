import { describe, it, expect, afterEach } from 'vitest';
import { modelCapabilities, resolveToolChoice } from '../src/model-capabilities.js';

afterEach(() => {
  delete process.env.VODOU_NO_TOOLS_MODELS;
  delete process.env.VODOU_WHOLE_FILE_MODELS;
});

describe('modelCapabilities — defaults', () => {
  it('a normal chat model supports tools, auto tool_choice, not a reasoner', () => {
    const c = modelCapabilities('kimi-k2p6');
    expect(c.supportsTools).toBe(true);
    expect(c.toolChoiceMode).toBe('auto');
    expect(c.isReasoner).toBe(false);
  });

  it('empty / null model defaults to tool-capable, non-reasoner', () => {
    expect(modelCapabilities('').supportsTools).toBe(true);
    expect(modelCapabilities(undefined).supportsTools).toBe(true);
    expect(modelCapabilities(null).isReasoner).toBe(false);
  });
});

describe('modelCapabilities — reasoner detection', () => {
  it.each(['deepseek-reasoner', 'Qwen/QwQ-32B', 'qwen3-235b-thinking', 'o1-preview', 'o3-mini'])(
    'flags %s as a reasoner',
    (m) => {
      expect(modelCapabilities(m).isReasoner).toBe(true);
      // reasoners still support tools (current deepseek-reasoner does); only tool_choice is constrained
      expect(modelCapabilities(m).supportsTools).toBe(true);
    },
  );

  it('does not flag plain models as reasoners', () => {
    expect(modelCapabilities('deepseek-chat').isReasoner).toBe(false);
    expect(modelCapabilities('qwen2.5-coder-32b').isReasoner).toBe(false);
  });
});

describe('modelCapabilities — VODOU_NO_TOOLS_MODELS operator lever', () => {
  it('disables tools for a substring-matched model id', () => {
    process.env.VODOU_NO_TOOLS_MODELS = 'broken-model, some-old-reasoner';
    expect(modelCapabilities('vendor/broken-model-v2').supportsTools).toBe(false);
    expect(modelCapabilities('some-old-reasoner').supportsTools).toBe(false);
    expect(modelCapabilities('kimi-k2p6').supportsTools).toBe(true); // not listed
  });

  it('handles whitespace/comma separation and case-insensitivity', () => {
    process.env.VODOU_NO_TOOLS_MODELS = 'FooBar';
    expect(modelCapabilities('acme/foobar-instruct').supportsTools).toBe(false);
  });

  it('empty lever disables nothing', () => {
    process.env.VODOU_NO_TOOLS_MODELS = '';
    expect(modelCapabilities('anything').supportsTools).toBe(true);
  });
});

describe('modelCapabilities — editFormat (#1.3)', () => {
  it('defaults to targeted (gets edit_file/multi_edit)', () => {
    expect(modelCapabilities('kimi-k2p6').editFormat).toBe('targeted');
    expect(modelCapabilities('deepseek-chat').editFormat).toBe('targeted');
  });
  it('VODOU_WHOLE_FILE_MODELS downgrades a matched model to whole-file', () => {
    process.env.VODOU_WHOLE_FILE_MODELS = 'tiny-1b, flaky-editor';
    expect(modelCapabilities('vendor/tiny-1b-instruct').editFormat).toBe('whole-file');
    expect(modelCapabilities('flaky-editor').editFormat).toBe('whole-file');
    expect(modelCapabilities('kimi-k2p6').editFormat).toBe('targeted'); // not listed
  });
});

describe('resolveToolChoice — reasoner guard for future tool-forcing code', () => {
  it('clamps required/named to auto for reasoners', () => {
    expect(resolveToolChoice('deepseek-reasoner', 'required')).toBe('auto');
    expect(resolveToolChoice('qwq-32b', 'some_tool')).toBe('auto');
  });
  it('leaves non-reasoner desired choices intact', () => {
    expect(resolveToolChoice('deepseek-chat', 'required')).toBe('required');
    expect(resolveToolChoice('kimi-k2p6', 'auto')).toBe('auto');
  });
  it('never overrides an explicit none', () => {
    expect(resolveToolChoice('deepseek-reasoner', 'none')).toBe('none');
  });
});
