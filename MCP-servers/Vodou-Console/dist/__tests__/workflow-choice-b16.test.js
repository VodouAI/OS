/**
 * B16 — a reply to a parked gate must never reach a model.
 *
 * Live, 2026-08-26: the user answered "2 no add it to #alpha-testing" to
 * "post the summary to slack? 1. Yes 2. No". Option 2 matched, ran nothing,
 * returned EMPTY — and chat() dispatched the original sentence to a model,
 * which replied that the approval gate was now OFF and the post would go to
 * #alpha-testing automatically. None of it was true. A model narrated a safety
 * change that did not happen.
 *
 * Three rules, each pinned here against the real driver, not a mock of it:
 *   1. a zero-step answer returns a verbatim acknowledgement, never empty/null
 *   2. an unmatched reply on a parked menu RE-SHOWS the menu, for any origin
 *   3. "1" hidden inside a sentence does not select option 1
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerAdHocWorkflow, handleWorkflowChoice, clearWorkflow, hasActiveWorkflow } from '../workflow-driver.js';
import { startRun, recordAsk, getRun } from '../graph-runs.js';
const GATE = {
    initial_steps: [],
    stopping_points: [{
            id: 'gate', title: 'post the summary to slack?',
            options: {
                '1': { label: 'Yes', steps: [] },
                '2': { label: 'No', steps: [] },
            },
        }],
};
const CONV = 'b16-test';
const noEvents = () => { };
describe('B16 — a gate reply never reaches a model', () => {
    beforeEach(() => { try {
        clearWorkflow(CONV);
    }
    catch { /* */ } registerAdHocWorkflow(CONV, GATE, 'b16', 'recipe'); });
    it('a matched option with no steps returns an acknowledgement, not empty', async () => {
        const out = await handleWorkflowChoice(CONV, '2', noEvents);
        expect(out, 'null means chat() treats it as "not a menu reply" and calls a model').not.toBeNull();
        expect(out.trim(), 'empty means chat() dispatches the ORIGINAL message to a model').not.toBe('');
        expect(out.startsWith('__MENU_ONLY__'), 'must be the shape chat() streams verbatim').toBe(true);
        expect(out).toContain('No');
        expect(hasActiveWorkflow(CONV)).toBe(false);
    });
    it('the live input — a number followed by prose — resolves to the number and STILL never reaches a model', async () => {
        const out = await handleWorkflowChoice(CONV, '2 no add it to #alpha-testing', noEvents);
        expect(out).not.toBeNull();
        expect(out.startsWith('__MENU_ONLY__')).toBe(true);
        expect(out).toContain('"No"');
    });
    it('an unmatched reply on a parked menu re-shows the menu for an ad-hoc graph, not only a skill console', async () => {
        const out = await handleWorkflowChoice(CONV, 'make it go to alpha instead', noEvents);
        expect(out, 'null here is the exact fall-through that let a model answer a gate').not.toBeNull();
        expect(out).toContain('did not match');
        expect(out).toContain('1.');
        expect(out).toContain('2.');
        expect(hasActiveWorkflow(CONV), 'the gate must still be parked').toBe(true);
    });
    it('a digit hidden inside a sentence does not pick an option', async () => {
        const out = await handleWorkflowChoice(CONV, 'add 12 items to it', noEvents);
        expect(out).toContain('did not match');
        expect(hasActiveWorkflow(CONV)).toBe(true);
    });
    it('the unwrap the channel path applies turns an enveloped "2" into "2"', async () => {
        // What Telegram actually delivers. If this ever reaches the matcher raw,
        // it matches nothing; the channel branch must unwrap it first.
        const wrapped = '<untrusted_channel_message channel="telegram" from="chad">\n2\n</untrusted_channel_message>\n\n<channel_rules>boilerplate</channel_rules>';
        const m = wrapped.match(/<untrusted_channel_message\b[^>]*>\n?([\s\S]*?)\n?<\/untrusted_channel_message>/);
        const body = (m ? m[1] : wrapped).trim();
        expect(body).toBe('2');
        const out = await handleWorkflowChoice(CONV, body, noEvents);
        expect(out).not.toBeNull();
        expect(out).toContain('"No"');
        expect(hasActiveWorkflow(CONV)).toBe(false);
    });
    /**
     * The run RECORD must close with the workflow. On Telegram the person got
     * "Done — you chose No" and the graph_runs row stayed `running` forever —
     * the next restart's reconcile would have relabelled it `failed`.
     */
    it('a declined gate leaves the run record complete, not running', async () => {
        const runId = startRun({ skill: 'b16', surface: 'test', conversationId: CONV });
        recordAsk(runId, { askId: 'gate', title: 'post the summary?', options: [{ n: '1', label: 'Yes' }, { n: '2', label: 'No' }], type: 'menu', askedAt: Date.now() });
        const before = getRun(runId);
        expect(before?.outcome, 'precondition: the run must be parked on the ask').toBe('parked');
        const out = await handleWorkflowChoice(CONV, '2', noEvents);
        expect(out).toContain('"No"');
        const after = getRun(runId);
        expect(after?.outcome, 'the run was answered and the workflow closed, but the record was left open').toBe('complete');
        expect(after?.pending_ask_json ?? null).toBeNull();
    });
    it('the exact label still works, as a whole', async () => {
        const out = await handleWorkflowChoice(CONV, 'no', noEvents);
        expect(out).toContain('"No"');
        expect(hasActiveWorkflow(CONV)).toBe(false);
    });
});
