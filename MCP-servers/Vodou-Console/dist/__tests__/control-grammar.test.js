/**
 * PLAN-CONTROL-GRAMMAR P0 + P1a + P1b.
 *
 * The plan's own risk note names the one that matters: "Side ask that silently
 * writes into history → teaches the wrong lesson. Gate 1 is load-bearing."
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MODES, VERBS, BUSY_POLICIES, DEFAULT_BUSY_POLICY, BUSY_POLICY_LABELS, isBusyPolicy, resolveBusyPolicy, helpLines, watchVsSchedule, modeById, verbById, } from '../control-grammar.js';
import { validate, buildPrompt, MAX_PROMPT_CHARS } from '../side-ask.js';
const SRC = path.resolve(__dirname, '..');
const INDEX = readFileSync(path.join(SRC, 'index.ts'), 'utf-8');
const SIDE_ASK = readFileSync(path.join(SRC, 'side-ask.ts'), 'utf-8');
describe('P0 — the three modes have names, and one module owns them', () => {
    it('names all three, each with a one-line answer to "when would I want this"', () => {
        expect(MODES.map((m) => m.id)).toEqual(['schedule', 'watch', 'keep-going']);
        for (const m of MODES) {
            expect(m.name.length, m.id).toBeGreaterThan(0);
            expect(m.blurb.length, `${m.id} blurb`).toBeGreaterThan(20);
            expect(m.when.length, `${m.id} when`).toBeGreaterThan(20);
            expect(m.ends.length, `${m.id} ends`).toBeGreaterThan(5);
            // A help line is a sentence, not a paragraph.
            expect(m.blurb.length, `${m.id} blurb is too long for a help list`).toBeLessThan(120);
        }
    });
    it('names the three contention verbs', () => {
        expect(VERBS.map((v) => v.id)).toEqual(['side-ask', 'background', 'steer']);
        for (const v of VERBS)
            expect(v.blurb.length, v.id).toBeGreaterThan(20);
    });
    // P0's gate, as a test: a stranger can answer this without reading the plan.
    it('answers the one distinction people get wrong', () => {
        const s = watchVsSchedule();
        expect(s.toLowerCase()).toContain('conversation');
        expect(s.toLowerCase()).toContain('clock');
        // three sentences max in the UI; this is one
        expect(s.length).toBeLessThan(200);
    });
    it('renders a help block that mentions every mode and verb', () => {
        const help = helpLines().join('\n');
        for (const m of MODES)
            expect(help).toContain(m.name);
        for (const v of VERBS)
            expect(help).toContain(v.name);
    });
    it('looks up by id, and says no rather than guessing', () => {
        expect(modeById('watch')?.name).toBe('Watch');
        expect(modeById('nonsense')).toBeNull();
        expect(verbById('side-ask')?.name).toBe('Side ask');
        expect(verbById('nonsense')).toBeNull();
    });
    // The lane-registry shape, for the lane-registry reason: two places spelling
    // one word is how they drift.
    it('the API serves the vocabulary from the module rather than restating it', () => {
        const route = INDEX.slice(INDEX.indexOf("app.get('/api/control-grammar'"));
        const body = route.slice(0, 600);
        expect(body).toContain('controlGrammar.MODES');
        expect(body).toContain('controlGrammar.VERBS');
        for (const m of MODES) {
            // index.ts must not restate a blurb — two spellings is how they drift
            expect(body, m.id).not.toContain(m.blurb);
        }
    });
});
describe('P0 — the docs page is a surface, so it drifts like one', () => {
    const DOC = readFileSync(path.resolve(__dirname, '../../../../docs/control-grammar.md'), 'utf-8');
    // Not generated from the module — it is prose, and prose written by hand
    // reads better than prose assembled from fields. But a RENAMED mode has to
    // break something, or the docs quietly describe a product that moved.
    it('names every mode and verb the module defines', () => {
        for (const m of MODES)
            expect(DOC, `docs must name the ${m.id} mode`).toContain(m.name);
        for (const v of VERBS)
            expect(DOC, `docs must name the ${v.id} verb`).toContain(v.name);
    });
    it('names every busy policy, and says which one is not wired', () => {
        for (const p of BUSY_POLICIES)
            expect(DOC.toLowerCase()).toContain(p);
        expect(DOC).toMatch(/not wired yet/i);
    });
    // The promise the side ask is built around has to be stated where a person
    // reads it, not only where a programmer does.
    it('states the transcript guarantee in the docs, not just in the code', () => {
        const doc = DOC.toLowerCase();
        expect(doc).toContain('transcript');
        expect(doc, 'the guarantee has to be stated, not implied').toMatch(/nothing you ask[^.]*transcript/);
    });
    it('draws the boundary the plan insists on', () => {
        expect(DOC.toLowerCase()).toContain('does not own');
    });
});
describe('P1b — busy policy', () => {
    it("queue is the default, because it is today's behaviour", () => {
        expect(DEFAULT_BUSY_POLICY).toBe('queue');
        expect(resolveBusyPolicy(undefined).effective).toBe('queue');
        expect(resolveBusyPolicy('nonsense').effective).toBe('queue');
        expect(resolveBusyPolicy(null).requested).toBe('queue');
    });
    it('accepts exactly the three policies and labels all of them', () => {
        expect([...BUSY_POLICIES]).toEqual(['queue', 'interrupt', 'steer']);
        for (const p of BUSY_POLICIES) {
            expect(isBusyPolicy(p)).toBe(true);
            expect(BUSY_POLICY_LABELS[p].length).toBeGreaterThan(10);
        }
        expect(isBusyPolicy('QUEUE')).toBe(false);
        expect(isBusyPolicy(1)).toBe(false);
    });
    it('interrupt resolves to itself, with nothing to explain', () => {
        const r = resolveBusyPolicy('interrupt');
        expect(r.effective).toBe('interrupt');
        expect(r.note).toBeNull();
    });
    // "fall back to queue and say so in the UI (no silent lie)". A setting that
    // claims a behaviour it does not have is worse than not offering it.
    it('steer degrades to queue AND says so, rather than quietly doing nothing', () => {
        const r = resolveBusyPolicy('steer');
        expect(r.requested).toBe('steer');
        expect(r.effective).toBe('queue');
        expect(r.note).toBeTruthy();
        expect(r.note.toLowerCase()).toContain('queue');
    });
    it('and stops explaining once steer is actually wired', () => {
        const r = resolveBusyPolicy('steer', true);
        expect(r.effective).toBe('queue');
        expect(r.note).toBeNull();
    });
});
describe('P1a — side ask', () => {
    it('needs both a conversation and a question', () => {
        expect(validate('', 'q')).toEqual({ ok: false, reason: 'no-conversation' });
        expect(validate('c1', '   ')).toEqual({ ok: false, reason: 'empty-prompt' });
        expect(validate('c1', 'what did we decide?')).toEqual({
            ok: true, conversationId: 'c1', prompt: 'what did we decide?',
        });
    });
    it('caps the question — a side ask is a question, not a brief', () => {
        const r = validate('c1', 'x'.repeat(MAX_PROMPT_CHARS + 500));
        expect(r.ok).toBe(true);
        if (r.ok)
            expect(r.prompt.length).toBe(MAX_PROMPT_CHARS);
    });
    it('tells the model it is not taking part, so it does not answer as a turn', () => {
        const p = buildPrompt('You: hi\n\nVodou: hello', 'what did we decide?');
        expect(p).toContain('NOT taking part');
        expect(p).toContain('Do not propose next steps');
        expect(p).toContain('what did we decide?');
        expect(p).toContain('You: hi');
    });
    it('says so when the transcript is empty instead of sending a blank block', () => {
        expect(buildPrompt('', 'q')).toContain('no messages yet');
    });
    // ── GATE 1, the load-bearing one ────────────────────────────────────────
    //
    // Source-derived because the failure is invisible at runtime: a side ask that
    // wrote a user row would look like it worked, and the damage would show up on
    // the NEXT turn, as history nobody typed.
    it('cannot write to the transcript, because it never imports the thing that writes', () => {
        expect(SIDE_ASK).not.toContain('saveMessage');
        expect(SIDE_ASK).not.toContain('ensureConversation');
        expect(SIDE_ASK).not.toMatch(/\bINSERT\b/i);
        // It may READ the conversation; that is the whole point.
        expect(SIDE_ASK).toContain('loadMessages');
    });
    it('the route persists nothing and reaches the provider through the pathless seam', () => {
        const route = INDEX.slice(INDEX.indexOf("app.post('/api/chat/:id/side-ask'"));
        const end = route.indexOf("app.get('/api/chat/:id/busy-policy'");
        // the busy-policy route should follow side-ask
        expect(end).toBeGreaterThan(0);
        const body = route.slice(0, end);
        expect(body).toContain('rawLLMCall');
        expect(body).not.toContain('saveMessage');
        expect(body).not.toContain('await chat(');
        // `conversationId` attributes a one-shot to a turn; a side ask has no turn.
        expect(body).not.toContain('conversationId: parsed.conversationId,\n        agent');
        expect(body).toContain('persisted: false');
    });
});
