/**
 * COHERENCE F30 — the same turn must describe itself the same way everywhere.
 *
 * The finding: the server has always emitted a complete receipt (memories,
 * tools, skills, degraded) as its own `turn_receipt` frame just before `done`,
 * and NEITHER client consumed it. Console Two never handled the frame, so its
 * provenance footer could only report what `done` happened to carry — memories,
 * model, tokens — and never said a tool or a skill ran. The extension panel was
 * worse: it read `e.receipt` off the `done` frame, where no emitter has ever put
 * it, so renderReceipt() was called with undefined on every turn and returned at
 * its first line. Its receipt code was complete and had never once run.
 *
 * That second half survived review because the code READS correctly. It was only
 * visible by asking what the server actually sends. So this file pins the two
 * things source-reading missed:
 *
 *   1. Console Two reports tools and skills at all.
 *   2. It uses the panel's exact words, including pluralisation — the two
 *      surfaces drifting apart IS the defect, so equality is the invariant,
 *      not an implementation detail.
 *
 * Both functions live inside browser IIFEs that touch `document` at module
 * scope, so they are extracted from source and evaluated in isolation — the
 * convention already used by the extension's receipt.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const REPO = path.resolve(__dirname, '../../../..');
const CHAT_JS = path.join(REPO, 'MCP-servers/Vodou-Console/public/two/chat.js');
const PANEL_JS = path.join(REPO, 'extension/Store-vodou-bridge/sidepanel.js');
/** Pull one function's source out of a browser bundle by walking its braces. */
function extractFn(file, name) {
    const src = readFileSync(file, 'utf8');
    const start = src.indexOf(`function ${name}(`);
    expect(start, `${name} not found in ${path.basename(file)} — renamed?`).toBeGreaterThan(0);
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{')
            depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
    }
    expect(end, `could not find the end of ${name}`).toBeGreaterThan(0);
    return src.slice(start, end);
}
const usedBits = new Function(`${extractFn(CHAT_JS, 'usedBits')}; return usedBits;`)();
const RECEIPT = {
    memories: { used: 3, total: 47000, items: [] },
    tools: ['gmail_search', 'calendar_list'],
    skills: ['morning-briefing'],
    degraded: null,
};
describe('Console Two provenance footer', () => {
    it('reports tools and skills, which it previously never mentioned', () => {
        const bits = usedBits(RECEIPT);
        expect(bits).toContain('3 memories');
        expect(bits).toContain('2 tools');
        expect(bits).toContain('1 skill');
    });
    it('falls back to the done frame when the gateway is too old to send a receipt', () => {
        expect(usedBits(null, { used: 2 })).toEqual(['2 memories']);
    });
    it('stays silent for a turn that used nothing', () => {
        // Never "0 memories" — that reads as a failure at the moment the product is
        // meant to prove competence. buildReceipt is silent by design; so is this.
        expect(usedBits(null, { used: 0 })).toEqual([]);
        expect(usedBits({ memories: { used: 0 }, tools: [], skills: [], degraded: null })).toEqual([]);
    });
    it('speaks for a degraded turn even when nothing was used', () => {
        // buildReceipt deliberately emits a receipt in this case: "I tried and the
        // pipeline missed its budget" is information the user needs, and silence is
        // how a degraded turn gets mistaken for an empty one.
        const bits = usedBits({ memories: { used: 0 }, tools: [], skills: [], degraded: { reason: 'budget', stage: 'context', scope: 'context', ms: 900 } });
        expect(bits).toEqual(['limited context']);
    });
    it('singularises exactly as the panel does', () => {
        const one = usedBits({ memories: { used: 1 }, tools: ['t'], skills: ['s'], degraded: null });
        expect(one).toEqual(['1 memory', '1 tool', '1 skill']);
    });
});
describe('parity with the extension panel', () => {
    it('produces the panel\'s exact words — drift between surfaces IS the defect', () => {
        // This used to grep the panel's renderReceipt for three ternaries. That
        // broke the day F8's residual was fixed and the rules moved into the
        // extension's shared receipt.js — a test failing because the code got
        // BETTER is a test measuring the wrong thing.
        //
        // So it runs both implementations and compares what they say. Console Two
        // cannot import from the extension (different codebase), which is the whole
        // reason this file exists; but it can be held to the extension's output.
        const receiptJs = path.join(REPO, 'extension/Store-vodou-bridge/receipt.js');
        // The module assigns to globalThis, the way the panel and page load it.
        new Function(readFileSync(receiptJs, 'utf8'))();
        const parts = globalThis.VodouReceipt.parts;
        const cases = [
            { memories: { used: 1 }, tools: ['t'], skills: ['s'] },
            { memories: { used: 4 }, tools: ['a', 'b'], skills: ['weekly-brief'] },
            { memories: { used: 0 }, tools: ['x'], skills: [] },
            { memories: { used: 3 }, tools: [], skills: [] },
            { memories: { used: 0 }, tools: [], skills: [] },
            {},
        ];
        for (const r of cases) {
            // degraded is deliberately absent: Console Two appends 'limited context'
            // and the panel renders that state as a warn chip instead, so the two
            // legitimately differ there. What must never differ is the counting.
            expect(usedBits({ ...r, degraded: null }, undefined), `Console Two and the panel describe ${JSON.stringify(r)} differently`).toEqual(parts(r));
        }
    });
    it('the panel does not keep a private copy of the wording', () => {
        // The residual half of F8: content.js and the panel each built the phrase
        // themselves. Both read the shared module now, and this is what stops one
        // of them quietly growing its own again.
        const panelSrc = extractFn(PANEL_JS, 'renderReceipt');
        expect(panelSrc, 'the panel builds its own summary line again').toContain('VodouReceipt.parts(');
        for (const axis of ["'tool' : 'tools'", "'skill' : 'skills'"]) {
            expect(panelSrc, `the panel restates ${axis}`).not.toContain(axis);
        }
    });
    it('the panel consumes the frame the server actually emits', () => {
        // The regression that started this: renderReceipt was wired to `done`.
        const panel = readFileSync(PANEL_JS, 'utf8');
        expect(panel, 'panel must handle the turn_receipt frame').toContain("case 'turn_receipt'");
        const chat = readFileSync(CHAT_JS, 'utf8');
        expect(chat, 'Console Two must handle the turn_receipt frame').toContain("case 'turn_receipt'");
    });
});
