import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VODOU_TOOLS,
  FS_TOOLS,
  getOpenAITools,
  getAnthropicTools,
  getToolNames,
  getTool,
  fsToolsActive,
  isWebChatSource,
} from '../src/tools.js';
import { getSystemPromptToolsNative } from '../src/llm.js';

const FS_NAMES = ['write_file', 'read_file', 'list_dir', 'edit_file', 'multi_edit'];
const BASE_NAMES = VODOU_TOOLS.map((t) => t.name);

afterEach(() => {
  delete process.env.VODOU_FS_TOOLS_ENABLED;
  delete process.env.VODOU_WHOLE_FILE_MODELS;
});

// §9 — flag-off must be PROVABLY byte-identical on BOTH tool surfaces.
describe('FS tools gating — flag OFF (byte-identical, both surfaces)', () => {
  beforeEach(() => {
    delete process.env.VODOU_FS_TOOLS_ENABLED;
  });

  it('getOpenAITools() returns the original set, no FS tools', () => {
    const names = getOpenAITools().map((t) => t.function.name);
    expect(names).toEqual(BASE_NAMES);
    for (const n of FS_NAMES) expect(names).not.toContain(n);
  });

  it('getAnthropicTools() returns VODOU_TOOLS unchanged', () => {
    expect(getAnthropicTools()).toBe(VODOU_TOOLS);
    expect(getAnthropicTools({ source: 'web' })).toBe(VODOU_TOOLS); // off ⇒ source irrelevant
  });

  it('getToolNames() unchanged', () => {
    expect(getToolNames()).toEqual(BASE_NAMES);
  });

  it('system prompt has no FS-tools text when off', () => {
    const p = getSystemPromptToolsNative(false);
    expect(p).not.toContain('write_file');
    expect(p).not.toContain('File Tools');
    expect(p).not.toContain('two tools'); // stale wording also gone
  });
});

describe('FS tools gating — flag ON', () => {
  beforeEach(() => {
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
  });

  it('web source (null | "web" | undefined) exposes all 4 FS tools on BOTH surfaces', () => {
    for (const src of [null, 'web', undefined] as Array<string | null | undefined>) {
      const oa = getOpenAITools({ source: src }).map((t) => t.function.name);
      const an = getAnthropicTools({ source: src }).map((t) => t.name);
      for (const n of FS_NAMES) {
        expect(oa).toContain(n);
        expect(an).toContain(n);
      }
      expect(getOpenAITools({ source: src }).length).toBe(VODOU_TOOLS.length + FS_TOOLS.length);
    }
  });

  it('NON-web sources (channels / scheduler / board) are gated OUT', () => {
    for (const src of ['slack', 'telegram', 'discord', 'whatsapp', 'heartbeat', 'board']) {
      expect(getOpenAITools({ source: src }).length).toBe(VODOU_TOOLS.length);
      expect(getAnthropicTools({ source: src })).toBe(VODOU_TOOLS);
    }
  });

  it('getTool resolves FS tools by name; getToolNames stays base-only (conv-scoped, not a global capability — finding #4)', () => {
    for (const n of FS_NAMES) expect(getTool(n)?.name).toBe(n);
    const names = getToolNames();
    for (const n of FS_NAMES) expect(names).not.toContain(n);
    expect(names).toEqual(BASE_NAMES);
  });

  it('system prompt describes FS tools when on', () => {
    const p = getSystemPromptToolsNative(true);
    expect(p).toContain('write_file');
    expect(p).toContain('per-conversation workspace');
  });
});

describe('FS tools gating — #1.3 per-model edit-format', () => {
  beforeEach(() => {
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    process.env.VODOU_WHOLE_FILE_MODELS = 'tiny-1b';
  });

  it('a whole-file model is offered write/read/list but NOT edit_file/multi_edit', () => {
    const names = getOpenAITools({ source: 'web', model: 'vendor/tiny-1b' }).map((t) => t.function.name);
    expect(names).toContain('write_file');
    expect(names).toContain('read_file');
    expect(names).toContain('list_dir');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('multi_edit');
  });

  it('a targeted model still gets all FS tools', () => {
    const names = getOpenAITools({ source: 'web', model: 'kimi-k2p6' }).map((t) => t.function.name);
    for (const n of FS_NAMES) expect(names).toContain(n);
  });

  it('system prompt omits the targeted-edit tools when fsTargetedEdits=false', () => {
    const p = getSystemPromptToolsNative(true, false);
    expect(p).toContain('write_file');
    expect(p).not.toContain('edit_file');
    expect(p).not.toContain('multi_edit');
    const p2 = getSystemPromptToolsNative(true, true);
    expect(p2).toContain('edit_file');
    expect(p2).toContain('multi_edit');
  });
});

describe('gate predicates', () => {
  it('isWebChatSource: null/undefined/"web" are web; others are not', () => {
    expect(isWebChatSource(null)).toBe(true);
    expect(isWebChatSource(undefined)).toBe(true);
    expect(isWebChatSource('web')).toBe(true);
    expect(isWebChatSource('slack')).toBe(false);
    expect(isWebChatSource('board')).toBe(false);
  });

  it('fsToolsActive requires BOTH the flag and a web source', () => {
    delete process.env.VODOU_FS_TOOLS_ENABLED;
    expect(fsToolsActive('web')).toBe(false);
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    expect(fsToolsActive('web')).toBe(true);
    expect(fsToolsActive(null)).toBe(true);
    expect(fsToolsActive('slack')).toBe(false);
  });

  it('fsToolsActive excludes non-interactive (workbench/skill-fire) conversations even with a web source (§10.2 #3)', () => {
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    // main web chat → active
    expect(fsToolsActive('web', 'conv-abc123')).toBe(true);
    expect(fsToolsActive(null, undefined)).toBe(true);
    // workbench:skill (skill-console + scheduled skill-fire) → excluded
    expect(fsToolsActive('web', 'workbench:skill:my-skill')).toBe(false);
    expect(fsToolsActive('web', 'workbench:integration:asana')).toBe(false);
  });

  it('getOpenAITools withholds ALL FS tools for a workbench conversation (flag on, web source)', () => {
    process.env.VODOU_FS_TOOLS_ENABLED = '1';
    const names = getOpenAITools({ source: 'web', conversationId: 'workbench:skill:x' }).map((t) => t.function.name);
    expect(names).toEqual(BASE_NAMES);
    const main = getOpenAITools({ source: 'web', conversationId: 'conv-1' }).map((t) => t.function.name);
    for (const n of FS_NAMES) expect(main).toContain(n);
  });
});
