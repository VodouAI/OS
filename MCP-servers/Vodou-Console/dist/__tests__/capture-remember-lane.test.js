/**
 * POST /api/capture/remember — the lane the console's "Add to memory" button now
 * uses (2026-09-15). It used to append to today's daily file through
 * POST /api/memory; it now goes through the browser extension's manual-capture
 * lane, which the extractor distils into memory.db. What the button relies on:
 * the text reaches that lane intact, a missing lease is fetched rather than
 * refused outright, a refusal says why (409, not 500), and a deduped repeat is
 * distinguishable from a save.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
const persistCaptureTurn = vi.fn();
const captureAllowed = vi.fn();
const refreshLease = vi.fn();
vi.mock('../db.js', () => ({
    getMemoryDb: () => null,
    getGatewayDb: () => null,
    getDb: () => null,
    getSetting: () => null,
    setSetting: () => { },
    getProjectRoot: () => '/tmp',
}));
vi.mock('../vbb/bridge.js', () => ({
    persistCaptureTurn: (msg) => persistCaptureTurn(msg),
    bridgeStatus: () => ({ connected: false }),
    pushCaptureArmed: () => { },
    pushBackfill: () => { },
    disconnectBridge: () => { },
}));
vi.mock('../vbb/capture-lease.js', () => ({
    captureAllowed: () => captureAllowed(),
    refreshLease: () => refreshLease(),
}));
const { memoryCaptureRouter } = await import('../api/memory-capture.js');
async function post(body) {
    const app = express();
    app.use(express.json());
    app.use('/api/capture', memoryCaptureRouter);
    const server = app.listen(0);
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/capture/remember`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            parsed = text;
        }
        return { status: res.status, body: parsed };
    }
    finally {
        await new Promise((r) => server.close(() => r()));
    }
}
describe('POST /api/capture/remember — the console "Add to memory" lane', () => {
    beforeEach(() => {
        persistCaptureTurn.mockReset().mockResolvedValue(1);
        captureAllowed.mockReset().mockReturnValue({ ok: true, reason: null });
        refreshLease.mockReset().mockResolvedValue({ granted: true });
    });
    it('stores the text as a manual capture under the caller’s source', async () => {
        const block = 'A long reply worth keeping.\n\nWith paragraphs, kept intact.';
        const r = await post({ text: block, source: 'console' });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ ok: true, lane: 'capture:manual:console', stored: 1 });
        expect(persistCaptureTurn).toHaveBeenCalledTimes(1);
        const msg = persistCaptureTurn.mock.calls[0][0];
        expect(msg.lane).toBe('manual');
        expect(msg.provider).toBe('console');
        expect(msg.conversationId).toMatch(/^remember-[a-z0-9]+$/);
        expect(msg.turns).toEqual([{ role: 'user', content: block }]);
    });
    it('does not ask for a lease it already holds', async () => {
        await post({ text: 'keep this', source: 'console' });
        expect(refreshLease).not.toHaveBeenCalled();
    });
    it('fetches a missing lease before storing, instead of refusing the first save', async () => {
        captureAllowed.mockReturnValue({ ok: false, reason: 'engine_unreachable' });
        const r = await post({ text: 'keep this', source: 'console' });
        expect(refreshLease).toHaveBeenCalledTimes(1);
        expect(r.status).toBe(200);
        expect(persistCaptureTurn).toHaveBeenCalledTimes(1);
    });
    it('a lease refusal is a 409 that names the reason, not a 500', async () => {
        persistCaptureTurn.mockRejectedValue(Object.assign(new Error('capture refused: over_limit'), { leaseReason: 'over_limit' }));
        const r = await post({ text: 'keep this', source: 'console' });
        expect(r.status).toBe(409);
        expect(r.body).toEqual({ error: 'capture refused: over_limit', reason: 'over_limit' });
    });
    it('reports stored: 0 when the lane deduped a repeat', async () => {
        persistCaptureTurn.mockResolvedValue(0);
        const r = await post({ text: 'keep this', source: 'console' });
        expect(r.status).toBe(200);
        expect(r.body.stored).toBe(0);
    });
    it('refuses empty text and keeps the MCP default source', async () => {
        expect((await post({ text: ' ' })).status).toBe(400);
        const r = await post({ text: 'from the MCP tool' });
        expect(r.body.lane).toBe('capture:manual:mcp');
    });
});
