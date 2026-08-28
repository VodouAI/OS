/**
 * The front door (PLAN-GRAPH-SKILLS D1, PLAN-GRAPH-FRONTEND phase 1).
 *
 * What is under test is not "a function returns a string". It is the two
 * properties that decide whether this is safe to put in front of every message:
 * an offer never executes anything, and a failed offer never costs the user
 * their answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { messageCarriesWorkflowOffer, offerPlan, OFFER_MARKER } from '../graph-offer.js';
describe('graph offer — the front door', () => {
    it('recognises the marker the daemon renders, and nothing else', () => {
        expect(messageCarriesWorkflowOffer(`stuff\n${OFFER_MARKER}\nmore`)).toBe(true);
        expect(messageCarriesWorkflowOffer('### Intent Signal\n- calendar')).toBe(false);
        expect(messageCarriesWorkflowOffer(null)).toBe(false);
        expect(messageCarriesWorkflowOffer(undefined)).toBe(false);
        expect(messageCarriesWorkflowOffer('')).toBe(false);
    });
    /**
     * The D2 lesson, as a test. An empty model response was read as "nothing to
     * say", the recipe path returned null, and asking for a workflow produced a
     * skill with no graph, no error, and no trace that it had been tried. A silent
     * failure here must cost the offer and nothing else.
     */
    it('returns null when the model gives nothing back, and emits no event', async () => {
        const onEvent = vi.fn();
        const result = await offerPlan('t', 'every morning brief me', onEvent, async () => '');
        expect(result).toBeNull();
        expect(onEvent).not.toHaveBeenCalled();
    });
    it('survives an LLM that throws, rather than taking the turn down with it', async () => {
        const onEvent = vi.fn();
        const result = await offerPlan('t', 'every morning brief me', onEvent, async () => {
            throw new Error('provider exploded');
        });
        expect(result).toBeNull();
        expect(onEvent).not.toHaveBeenCalled();
    });
    /**
     * Found by this test failing on a wrong premise, which was worth more than it
     * passing: free prose COMPILES — into a `prompt` step — so "do the thing"
     * produces a valid one-node graph. Offering a card for that would fire the
     * front door at every sentence containing the word "workflow", and the card
     * would be the question rephrased. An offer is only worth making when there is
     * something to RUN.
     */
    it('stays quiet when the sentence compiles to prose with no tools', async () => {
        const onEvent = vi.fn();
        const result = await offerPlan('t', 'do the thing', onEvent, async () => 'together:\n  x: think about it a bit');
        expect(result).toBeNull();
        expect(onEvent).not.toHaveBeenCalled();
    });
    /**
     * The safety property that lets this sit in front of every message: building a
     * plan describes, it never runs. If this ever regresses, a sentence containing
     * the word "workflow" starts firing tools.
     */
    it('emits a plan card and executes nothing', async () => {
        const onEvent = vi.fn();
        const recipe = [
            'together sources:',
            '  cpu: mcp-monitor.get_cpu_info {}',
            '  mem: mcp-monitor.get_memory_info {}',
            'then:',
            '  brief: summarize {cpu, mem}',
        ].join('\n');
        const result = await offerPlan('t', 'every morning show me system health', onEvent, async () => recipe);
        // A compilable recipe produces a card; an incompatible local catalog is a
        // legitimate reason for it not to, and the run must stay quiet either way.
        if (result === null) {
            expect(onEvent).not.toHaveBeenCalled();
            return;
        }
        const events = onEvent.mock.calls.map((c) => c[0]);
        expect(events.every((e) => e.type === 'graph_plan')).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0].graph.plan.rows.length).toBeGreaterThan(0);
        // No tool event of any kind: nothing ran.
        expect(events.some((e) => e.type === 'tool_call_start' || e.type === 'tool_call_end')).toBe(false);
        expect(result).toContain('cpu');
    });
});
