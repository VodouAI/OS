import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __setConversationSummaryForTest,
  __clearConversationSummariesForTest,
  summaryBlockFor,
} from '../src/llm.js';

// PLAN-LONG-CONVERSATION-CONTINUITY (2026-09-10) — the reader's contract.
//
// WS5 kept a `Map` the gateway refreshed on its own key; this file pinned its
// flag/cache/fallback behaviour. The summary is now a ROW the daemon writes
// (src/conversation_summary.rs) and the gateway only reads, so the contract
// is: no row → the naive fallback, labelled as such; a row → the typed block
// under "## Earlier in this conversation", plus one-line previews of anything
// newer than the row covers, so nothing said between refreshes is lost.
// `summaryBlockFor` is the ONE function all three assemblers call.

const older = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));

beforeEach(() => __clearConversationSummariesForTest());
afterEach(() => __clearConversationSummariesForTest());

describe('summaryBlockFor', () => {
  it('no row → the naive fallback, and it SAYS it is the fallback', () => {
    const out = summaryBlockFor(undefined, older(12));
    expect(out.fallback).toBe(true);
    expect(out.state).toBe('naive fallback');
    expect(out.text).toContain('[Conversation Summary — naive fallback');
    expect(out.text).not.toContain('## Earlier in this conversation');
  });

  it('a row → the typed block under the header, naive text nowhere', () => {
    __setConversationSummaryForTest('conv-x', {
      text: '## Earlier in this conversation (summary of 12 messages)\nDecisions:\n- use SQLite\n',
      coveredCount: 12, decisions: 1, openAsks: 2,
    });
    const out = summaryBlockFor('conv-x', older(12));
    expect(out.fallback).toBe(false);
    expect(out.text.startsWith('## Earlier in this conversation')).toBe(true);
    expect(out.text).toContain('- use SQLite');
    expect(out.text).not.toContain('[Conversation Summary');
    expect(out.state).toBe('summary of 12 earlier messages · 1 decision · 2 open asks');
  });

  it('messages newer than the row covers ride along as previews, never dropped', () => {
    __setConversationSummaryForTest('conv-y', { text: '## Earlier in this conversation (summary of 10 messages)\n', coveredCount: 10 });
    const msgs = older(14);
    msgs[12] = { role: 'user', content: 'actually, ship it Friday' };
    const out = summaryBlockFor('conv-y', msgs);
    expect(out.text).toContain('Since that summary (4 not yet folded)');
    expect(out.text).toContain('- User: actually, ship it Friday');
  });

  it('tool_result messages do not count toward what the row covers', () => {
    __setConversationSummaryForTest('conv-z', { text: '## Earlier in this conversation (summary of 2 messages)\n', coveredCount: 2 });
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ignored' }] },
    ];
    const out = summaryBlockFor('conv-z', msgs);
    expect(out.text).not.toContain('Since that summary');
  });

  it('an exact-cover row appends nothing', () => {
    __setConversationSummaryForTest('conv-w', { text: 'S\n', coveredCount: 6 });
    const out = summaryBlockFor('conv-w', older(6));
    expect(out.text).toBe('S\n');
  });
});
