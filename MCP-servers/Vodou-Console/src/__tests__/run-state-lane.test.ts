// PLAN-HEARTBEAT-IS-A-RUN-NOT-A-CHAT P1 — the run_state fence is found and
// bounded by the gateway, so a scheduled run's message can carry the previous
// run's state under its own lane (inline: the bytes sit inside the user's
// message, which `user_text` already counts).
import { describe, it, expect } from 'vitest';
import { extractRunStateBlock, isRunConversationId } from '../llm.js';

describe('extractRunStateBlock', () => {
  it('returns the fenced block, and only the block', () => {
    const msg = 'pre-flight…\n\n<run_state>\nYour previous run (#9): did_the_job\n</run_state>\n\ntrailing';
    expect(extractRunStateBlock(msg)).toBe('<run_state>\nYour previous run (#9): did_the_job\n</run_state>');
  });
  it('returns nothing when there is no fence, or an unclosed one', () => {
    expect(extractRunStateBlock('no state here')).toBe('');
    expect(extractRunStateBlock('<run_state> never closed')).toBe('');
    expect(extractRunStateBlock('')).toBe('');
  });
});

describe('isRunConversationId', () => {
  it('names the run surfaces, and only those', () => {
    expect(isRunConversationId('vodou-heartbeat')).toBe(true);
    expect(isRunConversationId('workbench:skill-console:blog-morning')).toBe(true);
    expect(isRunConversationId('conv-1779181598294-zjvo4h')).toBe(false);
    expect(isRunConversationId('slack:D0ANCK2Q4GG')).toBe(false);
    expect(isRunConversationId('board-chat')).toBe(false);
    expect(isRunConversationId(undefined)).toBe(false);
  });
});
