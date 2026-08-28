/**
 * Turn receipt semantics — PLAN-CONSOLE-SHOWS-ITS-WORK §4.3 / PLAN-INJECT-RECEIPT-UI.
 *
 * These rules are earned, not obvious: silence-by-design and the `?::Bash` guard
 * both came from real defects, and the module is now shared by the panel and the
 * console, so a regression here breaks two surfaces at once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// The module reads skills/memory-count from llm.ts and pings the funnel. Stub
// both so these are unit tests of the receipt rules, not of the whole gateway.
vi.mock('../llm.js', () => ({
    getLastSkillsUsed: (id) => (id === 'conv-skill' ? ['competitor-intel'] : []),
    resetSkillsUsed: () => { },
    getTotalMemoryCount: () => 44273,
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
});
