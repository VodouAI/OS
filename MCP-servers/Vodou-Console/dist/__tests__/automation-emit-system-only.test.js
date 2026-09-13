/**
 * GATE — the breaker's delivery path is not dead code.
 *
 * `/chat/automation-emit` has a `system_only` branch that writes a system
 * bubble and returns without calling the LLM. It was built for an every-tick
 * "nothing happened" notification, PLAN-AUTOMATIONS P3.1 deleted that caller,
 * and the plan's cleanup list then proposed deleting the branch too — on the
 * reasoning that "the breaker is its only caller".
 *
 * The breaker being the only caller is the reason to KEEP it. When an
 * automation fails repeatedly the engine disables it and calls
 * `automations::post_system_bubble`, which posts `system_only: true` so the
 * person sees *why* their automation stopped. Route that through the LLM
 * branch instead and the message either costs a paid turn to restate a failure
 * or 500s on `LLM not configured` — a plausible state when things are already
 * breaking.
 *
 * Source-derived, so it fails if either side of the contract moves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(__dirname, '../../../..');
const INDEX = readFileSync(path.resolve(__dirname, '../index.ts'), 'utf-8');
const AUTOMATIONS = readFileSync(path.join(ROOT, 'src/automations.rs'), 'utf-8');
describe('GATE — /chat/automation-emit keeps the branch the breaker needs', () => {
    it('the engine still posts system_only for the breaker message', () => {
        const fn = AUTOMATIONS.slice(AUTOMATIONS.indexOf('fn post_system_bubble'));
        expect(fn, 'post_system_bubble must exist').toBeTruthy();
        expect(fn.slice(0, 800)).toContain('"system_only": true');
        expect(fn.slice(0, 800)).toContain('/chat/automation-emit');
        expect(AUTOMATIONS).toContain('post_system_bubble(id, &breaker_message(');
    });
    it('the gateway still short-circuits on system_only before the LLM', () => {
        const handler = INDEX.slice(INDEX.indexOf("app.post('/chat/automation-emit'"));
        const branch = handler.indexOf('if (system_only)');
        const llmGate = handler.indexOf('if (!isConfigured())');
        expect(branch, 'the system_only branch must still exist').toBeGreaterThan(-1);
        expect(llmGate).toBeGreaterThan(-1);
        expect(branch, 'system_only must be handled BEFORE the LLM-configured gate, or a breaker message 500s exactly when things are breaking')
            .toBeLessThan(llmGate);
        expect(handler.slice(branch, llmGate)).toContain('systemOnly: true');
    });
    it('nothing else sends system_only, so the breaker is the whole contract', () => {
        const senders = [...AUTOMATIONS.matchAll(/"system_only":\s*(true|false)/g)].map((m) => m[1]);
        expect(senders.sort()).toEqual(['false', 'true']);
    });
});
