import { describe, it, expect } from 'vitest';
import {
  lensesAllowedForConversation,
  stripLensBlocks,
} from '../src/lenses-policy.js';

describe('lensesAllowedForConversation', () => {
  it('allows primary web chat', () => {
    expect(lensesAllowedForConversation('conv-abc-123', 'web')).toBe(true);
    expect(lensesAllowedForConversation('conv-abc-123', null)).toBe(true);
    expect(lensesAllowedForConversation('conv-abc-123', undefined)).toBe(true);
  });

  it('blocks workbench and channel sources', () => {
    expect(lensesAllowedForConversation('workbench:channel:telegram', 'workbench:channel:telegram')).toBe(false);
    expect(lensesAllowedForConversation('conv-x', 'telegram')).toBe(false);
    expect(lensesAllowedForConversation('conv-x', 'slack')).toBe(false);
    expect(lensesAllowedForConversation('conv-x', 'heartbeat')).toBe(false);
  });
});

describe('stripLensBlocks', () => {
  it('removes closed lens fence and preserves prose', () => {
    const inText = 'Here is the route.\n\n```lens\n{"type":"map.directions"}\n```\n';
    expect(stripLensBlocks(inText)).toBe('Here is the route.');
  });

  it('removes unclosed streaming fence', () => {
    const inText = 'Summary.\n\n```lens\n{"type":"x"';
    expect(stripLensBlocks(inText)).toBe('Summary.');
  });

  it('leaves text without lens fences unchanged', () => {
    const t = 'Normal answer with a ```bash block unchanged.';
    expect(stripLensBlocks(t)).toBe(t);
  });
});
