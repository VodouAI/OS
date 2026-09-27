import { describe, it, expect, beforeEach } from 'vitest';
import { hydrateLlmConversationFromDb } from '../../src/conversation-hydrate.js';
import { getConversationManager } from '../../src/conversation.js';
import { ensureConversation, saveMessage } from '../../src/conversation-store.js';

const text = (m: any) => Array.isArray(m.content)
  ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  : String(m.content);

// Fresh ids every run. These were the fixed 't-open' / 't-trunc', and the
// messages written here are never deleted: 404 of them reached the LIVE
// gateway.db (2026-09-19), every later run cloned them in, and 'OPENED' counted
// 5 messages where it wrote 1. Clearing the in-memory manager never touched the
// stored rows. A unique id is correct whatever the database already holds.
const run = Math.random().toString(36).slice(2);
const OPEN = `t-open-${run}`;
const TRUNC = `t-trunc-${run}`;

describe('hydrate: an assistant-first replay keeps its first message', () => {
  beforeEach(() => { getConversationManager().delete(OPEN); getConversationManager().delete(TRUNC); });

  it('OPENED — a thread that genuinely starts with the assistant', () => {
    const id = OPEN;
    ensureConversation(id, 'open', 'web');
    saveMessage(id, 'assistant', 'SUMMARY-BODY-XYZ');
    const n = hydrateLlmConversationFromDb(id);
    const msgs = getConversationManager().getMessages(id);
    expect(n).toBe(1);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(text(msgs[0])).toMatch(/opens with your own message/);
    expect(text(msgs[1])).toBe('SUMMARY-BODY-XYZ');   // the message that used to vanish
  });

  it('a long thread is capped at MAX_HISTORY and still starts with a user turn', () => {
    const id = TRUNC;
    ensureConversation(id, 'trunc', 'web');
    for (let i = 0; i < 100; i++) { saveMessage(id, 'assistant', `a${i}`); saveMessage(id, 'user', `u${i}`); }
    hydrateLlmConversationFromDb(id);
    const msgs = getConversationManager().getMessages(id);
    // The manager caps at MAX_HISTORY (40) and trims from the front, so the
    // primer never survives here — and does not need to: the leading assistant
    // turn it would have protected is trimmed away by the same pass.
    expect(msgs.length).toBeLessThanOrEqual(40);
    expect(msgs[0].role).toBe('user');                 // the invariant holds either way
    expect(text(msgs[msgs.length - 1])).toBe('u99');   // newest turns are the ones kept
  });
});
