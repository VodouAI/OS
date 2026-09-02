/**
 * Turn receipt semantics — PLAN-CONSOLE-SHOWS-ITS-WORK §4.3 / PLAN-INJECT-RECEIPT-UI.
 *
 * These rules are earned, not obvious: silence-by-design and the `?::Bash` guard
 * both came from real defects, and the module is now shared by the panel and the
 * console, so a regression here breaks two surfaces at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// The module reads skills/memory-count from llm.ts and pings the funnel. Stub
// both so these are unit tests of the receipt rules, not of the whole gateway.
// Records what `persistTurnLanes` was handed, so a test can assert the receipt
// passes the turn's OWN id down instead of making the projection re-derive it.
const _persistCalls = [];
vi.mock('../llm.js', () => ({
    getLastSkillsUsed: (id) => (id === 'conv-skill' ? ['competitor-intel'] : []),
    resetSkillsUsed: () => { },
    getTotalMemoryCount: () => 44273,
    takeTurnLanes: () => [],
    persistTurnLanes: (conv, lanes, turnId) => {
        _persistCalls.push({ conv, turnId });
        return lanes;
    },
}));
vi.mock('../funnel.js', () => ({ markFunnel: () => { } }));
const { receiptReset, receiptAddTool, buildReceipt } = await import('../turn-receipt.js');
describe('turn receipt', () => {
    beforeEach(() => {
        for (const id of ['c1', 'conv-skill'])
            receiptReset(id);
    });
    it('is SILENT when the turn did nothing (never a receipt of zeroes)', () => {
        // "0 memories" reads as a failure and is exactly the noise the inject lane's
        // silence-when-ignorant rule exists to avoid.
        expect(buildReceipt('c1', [])).toBeNull();
    });
    it('reports memories, tools and skills it actually saw', () => {
        receiptAddTool('conv-skill', 'Vodou-Recall', 'search_memory');
        receiptAddTool('conv-skill', 'mcp-monitor', 'get_cpu_info');
        const r = buildReceipt('conv-skill', ['dog is Lucy', 'prefers oat milk']);
        expect(r).not.toBeNull();
        expect(r.memories.used).toBe(2);
        expect(r.memories.total).toBe(44273);
        expect(r.tools).toEqual(['Vodou-Recall::search_memory', 'mcp-monitor::get_cpu_info']);
        expect(r.skills).toEqual(['competitor-intel']);
    });
    it('emits a bare tool name when there is no server, never "?::Bash"', () => {
        // CLI-provider tools (Bash, ToolSearch, mcp__claude_ai_*) stream with no
        // serverName; a naive `${server}::${tool}` shipped chips reading "?::Bash".
        receiptAddTool('c1', undefined, 'Bash');
        const r = buildReceipt('c1', []);
        expect(r.tools).toEqual(['Bash']);
        expect(r.tools[0]).not.toContain('::');
    });
    it('never reports a broken dispatch as work done', () => {
        receiptAddTool('c1', 'undefined', 'search');
        receiptAddTool('c1', undefined, undefined);
        expect(buildReceipt('c1', [])).toBeNull();
    });
    it('dedupes a tool called repeatedly in one turn', () => {
        receiptAddTool('c1', 'srv', 'tool');
        receiptAddTool('c1', 'srv', 'tool');
        receiptAddTool('c1', 'srv', 'tool');
        expect(buildReceipt('c1', []).tools).toEqual(['srv::tool']);
    });
    it('describes THIS turn only — reset clears the previous turn tools', () => {
        receiptAddTool('c1', 'srv', 'first-turn-tool');
        receiptReset('c1');
        receiptAddTool('c1', 'srv', 'second-turn-tool');
        expect(buildReceipt('c1', []).tools).toEqual(['srv::second-turn-tool']);
    });
    it('a DEGRADED turn is never silent, even when it used nothing', () => {
        // "I tried and the pipeline missed its budget" is information the user needs;
        // staying quiet is how a degraded turn gets mistaken for an empty one.
        const r = buildReceipt('c1', [], { degraded: { reason: 'timeout', stage: 'memory', ms: 8000 } });
        expect(r).not.toBeNull();
        // COHERENCE F42 — `stage` is the field. `scope` rides alongside it, still
        // populated, because the extension ships through the Chrome Web Store on
        // its own clock: a gateway that dropped the old name the day it renamed it
        // would go silent on every panel that had not updated, and a fix that reads
        // to a user as the feature breaking is not a fix.
        expect(r.degraded).toEqual({ reason: 'timeout', stage: 'memory', scope: 'memory', ms: 8000 });
    });
    it('accepts the OLD field name from a caller that has not migrated', () => {
        // Both directions have to hold, or the rename becomes a flag day.
        const r = buildReceipt('c1', [], { degraded: { reason: 'timeout', scope: 'rerank', ms: 900 } });
        expect(r.degraded.stage).toBe('rerank');
        expect(r.degraded.scope).toBe('rerank');
    });
    it('never emits a degraded turn with no stage at all', () => {
        // A "limited:" line with an empty subject tells a person less than silence.
        const r = buildReceipt('c1', [], { degraded: { reason: 'timeout', ms: 10 } });
        expect(r.degraded.stage).toBe('context');
    });
    it('carries turn duration when the caller tracked it', () => {
        receiptAddTool('c1', 'srv', 'tool');
        expect(buildReceipt('c1', [], { ms: 3200 }).ms).toBe(3200);
    });
    /**
     * PLAN-PROJECT-VAULTS §4.5 — the receipt names the disclosure boundary.
     *
     * On a guest turn (a Slack room, an attached editor) the vault IS the boundary,
     * and reporting "3 memories" without naming where they came from is the more
     * dangerous half of the sentence. Tested here rather than via a live turn
     * because a live turn only exercises it when retrieval happens to return
     * something — and a receipt is silent by design when it does not.
     */
    it('carries the vault and project when the turn had a boundary', () => {
        receiptAddTool('c1', 'srv', 'tool');
        const r = buildReceipt('c1', ['a fact'], { vault: 'team-shared', project: 'proj_966659d8' });
        expect(r.vault).toBe('team-shared');
        expect(r.project).toBe('proj_966659d8');
    });
    it('reports NO vault on an owner turn rather than inventing one', () => {
        // The owner sees everything, so there is no limit to state — printing one
        // would imply a restriction that does not exist.
        receiptAddTool('c1', 'srv', 'tool');
        const r = buildReceipt('c1', ['a fact'], {});
        expect(r.vault).toBeNull();
        expect(r.project).toBeNull();
    });
    it('normalizes an empty vault/project to null, so "none" is one value', () => {
        receiptAddTool('c1', 'srv', 'tool');
        const r = buildReceipt('c1', ['a fact'], { vault: '', project: '' });
        expect(r.vault).toBeNull();
        expect(r.project).toBeNull();
    });
    it('caps the memory items it echoes back at 5', () => {
        const many = Array.from({ length: 12 }, (_, i) => 'memory ' + i);
        const r = buildReceipt('c1', many);
        expect(r.memories.used).toBe(12); // the COUNT is honest
        expect(r.memories.items).toHaveLength(5); // the payload stays small
    });
    // PLAN-SEAMS P4 — `web` and `headless` inject different lane sets, so a
    // receipt read without its stack cannot tell "this composition does not
    // inject that lane" from "that lane failed".
    describe('the run composition (stacks.toml)', () => {
        const original = process.env.VODOU_STACK;
        afterEach(() => {
            if (original === undefined)
                delete process.env.VODOU_STACK;
            else
                process.env.VODOU_STACK = original;
        });
        it('names the stack the turn ran in', () => {
            process.env.VODOU_STACK = 'web';
            expect(buildReceipt('c1', ['a fact']).stack).toBe('web');
        });
        // The KEY is absent, not null. A client forced to distinguish "no stack"
        // from "the stack is literally null" is being handed the ambiguity this
        // field exists to remove — and an entrypoint declaring nothing is the
        // condition entrypoint-guard exists to catch, not something to paper over
        // with a default.
        it('omits the key entirely when the entrypoint declared no stack', () => {
            delete process.env.VODOU_STACK;
            const r = buildReceipt('c1', ['a fact']);
            expect(r.stack).toBeUndefined();
            expect('stack' in r).toBe(false);
        });
    });
});
// ── GATE: a receipt that cannot name its turn cannot show its bytes ─────────
//
// The client gates the "show me what the model saw" button on
// `receipt.turnId && l.chars`. Only `receiptsForTurns` — the RELOAD path —
// supplied one, so the feature this whole plan exists to produce appeared only
// after a page refresh. Measured 2026-08-30: every console site already passed
// one; the panel path did not, because `runTurn` minted the id INLINE in the
// chat() options and threw the reference away.
//
// A grep gate rather than a behaviour test, deliberately: the failure is a
// missing ARGUMENT at a call site, and a new call site is exactly what would
// reintroduce it.
describe('GATE — every buildReceipt call names its turn', () => {
    const SOURCES = ['../index.ts', '../vbb/chat.ts'];
    it('no live receipt is built without a turnId', () => {
        const unnamed = [];
        for (const rel of SOURCES) {
            const file = path.resolve(__dirname, rel);
            const lines = readFileSync(file, 'utf-8').split('\n');
            lines.forEach((line, i) => {
                const at = line.indexOf('buildReceipt(');
                if (at < 0)
                    return;
                // The call may wrap. Join forward until the parens balance.
                let chunk = '';
                let depth = 0;
                for (let j = i; j < Math.min(lines.length, i + 8); j++) {
                    chunk += lines[j];
                    depth += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length;
                    if (depth <= 0)
                        break;
                }
                if (!chunk.includes('turnId'))
                    unnamed.push(`${rel}:${i + 1} — ${line.trim().slice(0, 80)}`);
            });
        }
        expect(unnamed, `a receipt without a turnId cannot offer "show":\n${unnamed.join('\n')}`)
            .toEqual([]);
    });
    // The id must be the TURN's, never looked up by conversation. `turnIdFor` is
    // keyed by conversation and returns whatever turn is CURRENT at completion —
    // two interleaved turns on one conversation closed under one id once (P0b).
    it('no receipt takes its id from turnIdFor(), which is keyed by conversation', () => {
        for (const rel of SOURCES) {
            const src = readFileSync(path.resolve(__dirname, rel), 'utf-8');
            expect(src, `${rel} must not derive a receipt id from the conversation map`)
                .not.toMatch(/turnId:\s*turnIdFor\(/);
        }
    });
});
// ── the heartbeat / skill-console receipt defect ───────────────────────────
//
// `persistTurnLanes` re-derived the turn id with `turnIdFor(conversationId)` —
// a map keyed by CONVERSATION and cleared at turn end. A console turn builds its
// receipt inside the `done` callback, while the turn is still current, so it
// worked there. The heartbeat and every scheduled skill console build theirs
// AFTER `chat()` returns: the lookup returned '', the log projection was
// skipped, and the receipt kept only the daemon's `hook_*` row.
//
// Measured 2026-08-30: 8-10 lanes in the log, ONE on the receipt, across
// `vodou-heartbeat` and eleven `workbench:skill-console:*` conversations.
describe('the receipt hands its turn id to the projection', () => {
    beforeEach(() => { _persistCalls.length = 0; });
    it('passes the turn id down when the caller knows it', () => {
        buildReceipt('workbench:skill-console:nightly', ['a fact'], { turnId: 'hb-123' });
        expect(_persistCalls.at(-1)?.turnId, 'without this the projection re-derives from a map that is already empty')
            .toBe('hb-123');
    });
    // The console path still works the old way — it has no id to pass, and its
    // receipt is built while the turn is current. The change must not move it.
    it('passes undefined when the caller has none, leaving the old path intact', () => {
        buildReceipt('conv-web', ['a fact']);
        expect(_persistCalls.at(-1)?.turnId).toBeUndefined();
    });
});
