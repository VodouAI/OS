/**
 * PLAN-CONTEXT-COORDINATION P8 — one context assembler.
 *
 * The plan's acceptance, verbatim: "`grep -c '<active_context>' src/llm.ts` = 1
 * (the assembler); the same for the ground-truth call and the tool-results
 * strip regex." Written BEFORE the extraction, against the file as it stood on
 * 2026-08-27 — 2 emitters, 5 strip copies, 5 bootstrap-for-turn calls, 4
 * callers of buildUserPromptWithOIResults — so it is red until every copy is
 * gone, and it says which copy is still there. A gate that passes before the
 * work is done is the trap; this one cannot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
const llm = readFileSync(path.resolve(__dirname, '../llm.ts'), 'utf-8');
const count = (re) => (llm.match(re) ?? []).length;
describe('P8 gate — the seam is spelled in one place', () => {
    it('<active_context> is emitted by the assembler and nowhere else', () => {
        expect(count(/<active_context>\\n\$\{/g), 'inline <active_context> emitters outside the assembler').toBe(1);
    });
    it('the tool-results strip regex exists once', () => {
        expect(count(/\.replace\(\/### Vodou Tool Results/g), 'copies of the §3.2 strip (the READ at the ground-truth site is not a copy)').toBe(1);
    });
    it('the per-turn bootstrap is decided once', () => {
        expect(count(/await getWorkspaceBootstrapForTurn\(\)/g), 'per-provider bootstrap decisions (each a chance to drop the guest/heartbeat/panel suppression)').toBe(1);
    });
    it('the API family no longer has its own lane-6 helper', () => {
        expect(count(/buildUserPromptWithOIResults\(/g), 'buildUserPromptWithOIResults call sites (the second implementation of lane 6)').toBe(0);
    });
    it('every provider calls the assembler', () => {
        expect(count(/await assembleContext\(/g)).toBeGreaterThanOrEqual(5);
    });
});
