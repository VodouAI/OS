/**
 * PLAN-PRESENCE-DOCK (0.6.18) Phase A — registry unit tests.
 * Pure-function coverage: classification, stream-event reduction, tab merge
 * (stable-id match + ephemeral mint), URL conv-token extraction, and full
 * snapshot assembly with injected deps (no DB, no bridge).
 */
import { describe, it, expect } from 'vitest';
import { classifyConversation, convTokenFromUrl, providerForHost, reduceStreamEvent, mergeTabs, buildSnapshot, LIVE_WINDOW_MS, } from '../presence.js';
const NOW = Date.parse('2026-07-16T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
function conv(partial) {
    return {
        title: partial.id,
        created_at: iso(60 * 60 * 1000),
        updated_at: iso(60 * 1000),
        ...partial,
    };
}
describe('providerForHost', () => {
    it('maps known AI hosts (with and without www)', () => {
        expect(providerForHost('chatgpt.com')).toBe('chatgpt');
        expect(providerForHost('www.claude.ai')).toBe('claude');
        expect(providerForHost('gemini.google.com')).toBe('gemini');
    });
    it('rejects everything else — privacy rule', () => {
        expect(providerForHost('github.com')).toBeNull();
        expect(providerForHost('mail.google.com')).toBeNull();
        expect(providerForHost('evil-chatgpt.com.attacker.io')).toBeNull();
    });
});
describe('convTokenFromUrl', () => {
    it('extracts ChatGPT /c/<uuid>', () => {
        expect(convTokenFromUrl('https://chatgpt.com/c/6877c2f1-1234-4abc-9def-0123456789ab'))
            .toBe('6877c2f1-1234-4abc-9def-0123456789ab');
    });
    it('extracts Claude /chat/<uuid>', () => {
        expect(convTokenFromUrl('https://claude.ai/chat/AbCd1234-ffff-4444-aaaa-999999999999'))
            .toBe('abcd1234-ffff-4444-aaaa-999999999999');
    });
    it('returns null for landing pages', () => {
        expect(convTokenFromUrl('https://chatgpt.com/')).toBeNull();
        expect(convTokenFromUrl('not a url')).toBeNull();
    });
});
describe('classifyConversation', () => {
    it('webcap → stable browser session id from provider conv token', () => {
        const c = classifyConversation(conv({ id: 'webcap:chatgpt:abc123', source: 'capture:web:chatgpt', title: 'Web capture · chatgpt' }));
        expect(c?.session.id).toBe('web:chatgpt:abc123');
        expect(c?.session.surface).toBe('browser');
        expect(c?.session.capture).toBe('on');
        expect(c?.session.injectable).toBe('body-rewrite');
    });
    it('claude webcap injects via composer (SW realm)', () => {
        const c = classifyConversation(conv({ id: 'webcap:claude:xyz', source: 'capture:web:claude' }));
        expect(c?.session.injectable).toBe('composer');
    });
    it('channel conversations classify by id prefix', () => {
        const c = classifyConversation(conv({ id: 'channel:12345', source: 'telegram', sender_name: 'Chad' }));
        expect(c?.session.surface).toBe('channel');
        expect(c?.session.provider).toBe('telegram');
        expect(c?.session.id).toBe('ch:channel:12345');
    });
    it('heartbeat/board/skill-console are autonomous', () => {
        expect(classifyConversation(conv({ id: 'vodou-heartbeat', source: 'heartbeat' }))?.session.surface).toBe('autonomous');
        expect(classifyConversation(conv({ id: 'board-chat', source: 'board' }))?.session.provider).toBe('board');
        expect(classifyConversation(conv({ id: 'skill-1', source: 'skill-console' }))?.session.provider).toBe('skill');
    });
    it('heartbeat capture is n/a (extractor excludes it)', () => {
        expect(classifyConversation(conv({ id: 'vodou-heartbeat' }))?.session.capture).toBe('n/a');
    });
    it('CLI sessions split from gateway by title marker', () => {
        expect(classifyConversation(conv({ id: 'u1', title: 'Vodou CLI' }))?.session.surface).toBe('cli');
        expect(classifyConversation(conv({ id: 'u2', title: 'My chat' }))?.session.surface).toBe('gateway');
    });
    it('imports, manual snippets, byok buffers are not sessions', () => {
        expect(classifyConversation(conv({ id: 'import:chatgpt:1', source: 'import:chatgpt' }))).toBeNull();
        expect(classifyConversation(conv({ id: 'manual:claude:1', source: 'capture:manual:claude' }))).toBeNull();
        expect(classifyConversation(conv({ id: 'byok:cursor:abc' }))).toBeNull();
    });
    it('carries project scope', () => {
        expect(classifyConversation(conv({ id: 'u3', project_id: 'proj_x' }))?.session.memoryScope.projectId).toBe('proj_x');
    });
});
describe('reduceStreamEvent', () => {
    it('chunk → active; done → cleared', () => {
        expect(reduceStreamEvent(undefined, 'chunk', NOW)).toEqual({ state: 'active', at: NOW });
        expect(reduceStreamEvent({ state: 'active', at: NOW }, 'done', NOW)).toBeNull();
    });
    it('approval holds through subsequent activity, clears on done', () => {
        const held = reduceStreamEvent({ state: 'active', at: NOW }, 'approval_requested', NOW);
        expect(held).toEqual({ state: 'awaiting_approval', at: NOW });
        expect(reduceStreamEvent(held, 'chunk', NOW + 1)).toEqual({ state: 'awaiting_approval', at: NOW + 1 });
        expect(reduceStreamEvent(held, 'done', NOW + 2)).toBeNull();
    });
    it('unknown event types are no-ops', () => {
        expect(reduceStreamEvent(undefined, 'history', NOW)).toBeUndefined();
        expect(reduceStreamEvent(undefined, '', NOW)).toBeUndefined();
    });
});
describe('mergeTabs', () => {
    const captured = {
        id: 'web:chatgpt:6877c2f1-1234-4abc-9def-0123456789ab',
        surface: 'browser',
        provider: 'chatgpt',
        title: 'Web capture · chatgpt',
        state: 'stale',
        lastActivity: iso(60 * 60 * 1000),
        capture: 'on',
        injectable: 'body-rewrite',
        memoryScope: { vault: null, projectId: null },
        actions: ['open'],
        detail: { convId: 'webcap:chatgpt:6877c2f1-1234-4abc-9def-0123456789ab' },
    };
    it('merges an open tab into its captured session (stable identity)', () => {
        const out = mergeTabs([{ ...captured }], [
            { id: 47, url: 'https://chatgpt.com/c/6877c2f1-1234-4abc-9def-0123456789ab', title: 'ChatGPT', active: true },
        ], true, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].detail?.tabId).toBe(47);
        expect(out[0].state).toBe('idle'); // tab open upgrades stale
    });
    it('mints an ephemeral session for an uncaptured tab, capture pending when armed', () => {
        const out = mergeTabs([], [{ id: 9, url: 'https://claude.ai/new', title: 'Claude' }], true, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('web:claude:tab:9');
        expect(out[0].capture).toBe('pending');
        expect(out[0].injectable).toBe('composer');
    });
    it('capture off when lane disarmed; non-AI tabs never appear', () => {
        const out = mergeTabs([], [
            { id: 1, url: 'https://claude.ai/new' },
            { id: 2, url: 'https://github.com/some/repo' },
        ], false, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].capture).toBe('off');
    });
});
describe('buildSnapshot (injected deps)', () => {
    function deps(over = {}) {
        return {
            loadConversations: () => [
                conv({ id: 'main-chat', title: 'My chat', updated_at: iso(30_000) }),
                conv({ id: 'channel:777', source: 'slack', sender_name: 'Team', updated_at: iso(120_000) }),
                conv({ id: 'webcap:chatgpt:6877c2f1-1234-4abc-9def-0123456789ab', source: 'capture:web:chatgpt', updated_at: iso(300_000) }),
                conv({ id: 'import:chatgpt:zz', source: 'import:chatgpt' }), // excluded
                conv({ id: 'old-chat', updated_at: iso(48 * 60 * 60 * 1000) }), // beyond 24h
            ],
            listAiTabs: async () => [],
            bridgeConnected: () => false,
            captureLanes: () => ({
                ide: { enabled: true, sources: ['cursor'], connected: true, lastRunAt: iso(200_000), lagSeconds: 200 },
                web: { armed: true },
            }),
            now: () => NOW,
            ...over,
        };
    }
    it('assembles all surfaces, excludes non-sessions and >24h rows', async () => {
        const snap = await buildSnapshot(deps());
        const ids = snap.sessions.map((s) => s.id);
        expect(ids).toContain('gw:main-chat');
        expect(ids).toContain('ch:channel:777');
        expect(ids).toContain('web:chatgpt:6877c2f1-1234-4abc-9def-0123456789ab');
        expect(ids).toContain('ide:cursor');
        expect(ids.find((i) => i.includes('import'))).toBeUndefined();
        expect(ids).not.toContain('gw:old-chat');
    });
    it('bridge disconnected → no tab sessions, honest bridge flag', async () => {
        const snap = await buildSnapshot(deps({
            listAiTabs: async () => { throw new Error('must not be called'); },
        }));
        expect(snap.bridge.connected).toBe(false);
        expect(snap.sessions.filter((s) => s.id.includes(':tab:'))).toHaveLength(0);
    });
    it('bridge connected → tabs merge in', async () => {
        const snap = await buildSnapshot(deps({
            bridgeConnected: () => true,
            listAiTabs: async () => [{ id: 3, url: 'https://chatgpt.com/c/6877c2f1-1234-4abc-9def-0123456789ab', title: 'ChatGPT' }],
        }));
        const web = snap.sessions.find((s) => s.id === 'web:chatgpt:6877c2f1-1234-4abc-9def-0123456789ab');
        expect(web?.detail?.tabId).toBe(3);
    });
    it('counts: live window + capturing + approvals', async () => {
        const snap = await buildSnapshot(deps());
        expect(snap.liveWindowMs).toBe(LIVE_WINDOW_MS);
        // main-chat, channel, webcap, ide all within 15 min in the fixture
        expect(snap.counts.live).toBeGreaterThanOrEqual(4);
        expect(snap.counts.awaitingApproval).toBe(0);
    });
    it('actions are server-computed per surface (IDE observe-only)', async () => {
        const snap = await buildSnapshot(deps());
        const ide = snap.sessions.find((s) => s.surface === 'ide');
        expect(ide?.actions).toEqual(['view-memory']);
        const gw = snap.sessions.find((s) => s.id === 'gw:main-chat');
        expect(gw?.actions).toContain('send');
        expect(gw?.actions).not.toContain('approve');
    });
});
