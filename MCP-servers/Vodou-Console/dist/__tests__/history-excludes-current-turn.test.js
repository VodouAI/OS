// PLAN-LONG-CONVERSATION-CONTINUITY P2 — the message being sent is not history.
//
// Measured 2026-09-10 on the live turn_events: every heartbeat run logged
// ~52k chars of `history` on a conversation whose prior runs were already
// excluded from context, and the cold-path DIAG line read `msgs=1 roles=user`
// on each. The one message in the manager was the run's own 26k-char prompt,
// added a line before the history block was built from the manager — so the
// block held it, and then it was appended again as "User's new message:".
// Same shape on every human first turn, just smaller.
//
// `dropCurrentTurn` is the pure half of the fix. These pin the three cases
// that matter: the current message goes, a genuinely earlier repeat stays,
// and a non-user tail is untouched.
import { describe, it, expect } from 'vitest';
import { dropCurrentTurn } from '../llm.js';
const u = (content) => ({ role: 'user', content });
const a = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
describe('dropCurrentTurn', () => {
    it('drops the trailing user message when it is the message being sent', () => {
        const msgs = [u('hello'), a('hi'), u('what did we decide?')];
        expect(dropCurrentTurn(msgs, 'what did we decide?')).toEqual([u('hello'), a('hi')]);
    });
    it('leaves a first turn with nothing — no history block for an empty conversation', () => {
        expect(dropCurrentTurn([u('first ever')], 'first ever')).toEqual([]);
    });
    it('matches block-shaped content too', () => {
        const msgs = [u([{ type: 'text', text: 'run the report' }])];
        expect(dropCurrentTurn(msgs, 'run the report')).toEqual([]);
    });
    it('keeps an earlier identical message — a person repeating themselves is real history', () => {
        const msgs = [u('again'), a('ok'), u('again')];
        expect(dropCurrentTurn(msgs, 'again')).toEqual([u('again'), a('ok')]);
    });
    it('does not touch a conversation whose last message is not the one being sent', () => {
        const msgs = [u('hello'), a('hi')];
        expect(dropCurrentTurn(msgs, 'something new')).toEqual(msgs);
        const msgs2 = [u('hello'), u('different')];
        expect(dropCurrentTurn(msgs2, 'hello')).toEqual(msgs2);
    });
});
