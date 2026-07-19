import { describe, it, expect, afterEach } from 'vitest';
import { makeIterationBudget, roundIsRefundable, agentModeFor, agentModeMaxIters, setConversationAgentMode, clearConversationAgentMode, __clearAgentModeForTest, CHEAP_TOOL_NAMES, } from '../agent-loop.js';
describe('IterationBudget', () => {
    it('consumes up to max, then offers exactly one grace round', () => {
        const b = makeIterationBudget(3);
        expect(b.tryConsume()).toBe(true); // 1
        expect(b.tryConsume()).toBe(true); // 2
        expect(b.tryConsume()).toBe(true); // 3
        expect(b.tryConsume()).toBe(false); // exhausted
        expect(b.useGrace()).toBe(true); // one-shot grace
        expect(b.useGrace()).toBe(false); // never twice
        expect(b.used).toBe(3);
        expect(b.remaining).toBe(0);
    });
    it('refund returns a slot and clamps at zero', () => {
        const b = makeIterationBudget(2);
        b.tryConsume();
        b.tryConsume();
        expect(b.remaining).toBe(0);
        b.refund();
        expect(b.remaining).toBe(1);
        expect(b.tryConsume()).toBe(true); // the refunded slot is usable again
        b.refund();
        b.refund();
        b.refund(); // over-refund is harmless
        expect(b.used).toBe(0);
    });
    it('a refunded cheap round lets a budget go deeper than its nominal max', () => {
        const b = makeIterationBudget(2);
        let rounds = 0;
        // simulate: every round is all-cheap (refunded) → loop runs past max
        while ((b.tryConsume() || b.useGrace()) && rounds < 10) {
            rounds++;
            b.refund(); // all-cheap round
        }
        // grace eventually ends it, but it ran well past the nominal cap of 2
        expect(rounds).toBeGreaterThan(2);
    });
    it('guards against a non-positive max', () => {
        const b = makeIterationBudget(0);
        expect(b.max).toBe(1);
        expect(b.tryConsume()).toBe(true);
        expect(b.tryConsume()).toBe(false);
    });
});
describe('roundIsRefundable', () => {
    it('true only when every tool in the round is cheap/read-only', () => {
        expect(roundIsRefundable(['read_file', 'grep'])).toBe(true);
        expect(roundIsRefundable(['read_file', 'write_file'])).toBe(false);
        expect(roundIsRefundable(['vodou_core_call'])).toBe(false);
        expect(roundIsRefundable([])).toBe(false); // empty round isn't refundable
    });
    it('cheap set covers the read-only FS + recall tools', () => {
        for (const t of ['read_file', 'grep', 'glob', 'file_stat', 'directory_tree', 'search_files', 'expand_result']) {
            expect(CHEAP_TOOL_NAMES.has(t)).toBe(true);
        }
    });
});
describe('agent-mode flag', () => {
    const prev = process.env.VODOU_AGENT_MODE;
    const prevIters = process.env.VODOU_AGENT_MAX_ITERS;
    afterEach(() => {
        __clearAgentModeForTest();
        if (prev === undefined)
            delete process.env.VODOU_AGENT_MODE;
        else
            process.env.VODOU_AGENT_MODE = prev;
        if (prevIters === undefined)
            delete process.env.VODOU_AGENT_MAX_ITERS;
        else
            process.env.VODOU_AGENT_MAX_ITERS = prevIters;
    });
    it('defaults OFF — no conversation is in agent mode', () => {
        delete process.env.VODOU_AGENT_MODE;
        expect(agentModeFor('conv-1')).toBe(false);
        expect(agentModeFor(undefined)).toBe(false);
    });
    it('global flag turns every conversation on', () => {
        process.env.VODOU_AGENT_MODE = '1';
        expect(agentModeFor('conv-x')).toBe(true);
    });
    it('per-conversation override works with the global flag off', () => {
        delete process.env.VODOU_AGENT_MODE;
        setConversationAgentMode('conv-2', true);
        expect(agentModeFor('conv-2')).toBe(true);
        expect(agentModeFor('conv-3')).toBe(false);
        clearConversationAgentMode('conv-2');
        expect(agentModeFor('conv-2')).toBe(false);
    });
    it('agentModeMaxIters reads the env with a sane default', () => {
        delete process.env.VODOU_AGENT_MAX_ITERS;
        expect(agentModeMaxIters()).toBe(40);
        process.env.VODOU_AGENT_MAX_ITERS = '90';
        expect(agentModeMaxIters()).toBe(90);
        process.env.VODOU_AGENT_MAX_ITERS = 'garbage';
        expect(agentModeMaxIters()).toBe(40);
    });
});
