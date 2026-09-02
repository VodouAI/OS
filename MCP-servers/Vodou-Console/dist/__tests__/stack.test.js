import { describe, it, expect, afterEach } from 'vitest';
import { currentStack } from '../stack.js';
// PLAN-SEAMS P4 — which run composition a process is.
describe('currentStack', () => {
    const original = process.env.VODOU_STACK;
    afterEach(() => {
        if (original === undefined)
            delete process.env.VODOU_STACK;
        else
            process.env.VODOU_STACK = original;
    });
    it('reads the launcher declaration', () => {
        process.env.VODOU_STACK = 'web';
        expect(currentStack()).toBe('web');
    });
    // Null, not a guess. An entrypoint that declares no stack is exactly the
    // condition entrypoint-guard exists to catch, and a fabricated name would
    // hide it while looking like an answer.
    it('is null when the entrypoint declared nothing, and never a default', () => {
        delete process.env.VODOU_STACK;
        expect(currentStack()).toBeNull();
        process.env.VODOU_STACK = '';
        expect(currentStack()).toBeNull();
        process.env.VODOU_STACK = '   ';
        expect(currentStack()).toBeNull();
    });
    it('trims, so an export with a trailing space is still a stack', () => {
        process.env.VODOU_STACK = ' headless ';
        expect(currentStack()).toBe('headless');
    });
});
