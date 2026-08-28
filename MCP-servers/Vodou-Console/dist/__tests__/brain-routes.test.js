/**
 * PLAN-BRAIN-INTO-CONSOLE P0.3/P0.4 — /api/brain/* on the gateway.
 *
 * Two things this proves without a fixture memory.db:
 *   1. Every one of the 19 routes the standalone console served
 *      (MCP-servers/brain/src/serve.ts) resolves on the router and forwards
 *      the SAME parsed arguments to the query layer — defaults included.
 *   2. Route ordering: an exact `/api/brain/execute` handler registered before
 *      the prefix router (the daemon's BrainLoader entry, core-api.ts) still
 *      wins, and the graph router never answers it.
 *
 * The query layer is mocked — its SQL is covered by byte-parity against the
 * live :8767 (plan R2, scripts/brain-parity.sh), not by this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../brain/queries.js', () => {
    const fn = (name) => vi.fn(() => ({ route: name }));
    return {
        ENTITY_KINDS: ['person', 'org', 'product', 'project', 'place', 'event', 'handle', 'name', 'not_an_entity'],
        overview: fn('overview'),
        scopes: fn('scopes'),
        graphOverview: fn('graph'),
        latestId: fn('latest-id'),
        latestGraph: fn('latest'),
        localGraph: fn('local'),
        similarChunks: vi.fn(() => []),
        nodeDetail: vi.fn((id) => (id === 'missing' ? null : { id })),
        fileDetail: fn('file'),
        entityDetail: vi.fn((id) => (id === 404 ? null : { id })),
        entityNet: fn('entity-net'),
        entityEgo: fn('entity-ego'),
        entityPair: fn('entity-pair'),
        entities: fn('entities'),
        projects: fn('projects'),
        hosts: fn('hosts'),
        search: vi.fn(() => []),
        timeline: fn('timeline'),
        conflicts: fn('conflicts'),
    };
});
import * as Q from '../brain/queries.js';
import { brainRouter } from '../api/brain.js';
const executeStub = vi.fn((_req, res) => res.json({ daemon: true }));
function app() {
    const a = express();
    // Mirrors the intended index.ts order: exact daemon route first, then the prefix.
    a.post('/api/brain/execute', executeStub);
    a.get('/api/brain/execute', executeStub);
    a.use('/api/brain', brainRouter);
    return a;
}
const DEFAULT_FILTERS = {
    host: undefined, cls: undefined, tag: undefined, sinceDays: undefined,
    includeArchived: false, q: undefined, project: undefined,
};
const KINDS_DEFAULT = ['person', 'org', 'product', 'project', 'place', 'event', 'handle', 'name'];
beforeEach(() => vi.clearAllMocks());
describe('/api/brain — ordering', () => {
    it('exact /api/brain/execute still reaches the daemon stub (GET and POST)', async () => {
        const a = app();
        expect((await request(a).post('/api/brain/execute').send({})).body).toEqual({ daemon: true });
        expect((await request(a).get('/api/brain/execute')).body).toEqual({ daemon: true });
        expect(executeStub).toHaveBeenCalledTimes(2);
    });
    it('non-GET on a graph route is 405, unknown route is 404', async () => {
        const a = app();
        expect((await request(a).post('/api/brain/overview')).status).toBe(405);
        expect((await request(a).get('/api/brain/nope')).status).toBe(404);
    });
    it('responses are no-store JSON', async () => {
        const r = await request(app()).get('/api/brain/overview');
        expect(r.headers['cache-control']).toBe('no-store');
        expect(r.headers['content-type']).toMatch(/application\/json/);
    });
});
describe('/api/brain — the 19 routes and their argument parsing', () => {
    it('overview / scopes / entities / projects / hosts take no args', async () => {
        const a = app();
        for (const r of ['overview', 'scopes', 'entities', 'projects', 'hosts']) {
            expect((await request(a).get(`/api/brain/${r}`)).body).toEqual({ route: r });
        }
    });
    it('graph: filters + max_files default 200, cap 40, sim flag', async () => {
        const a = app();
        await request(a).get('/api/brain/graph');
        expect(Q.graphOverview).toHaveBeenLastCalledWith(DEFAULT_FILTERS, 200, 40, false);
        await request(a).get('/api/brain/graph?cls=yours,imported,bogus&tag=DECISION&since_days=30&q=lucy&project=p1&host=h&archived=1&max_files=50&sim=1');
        expect(Q.graphOverview).toHaveBeenLastCalledWith({ host: 'h', cls: ['yours', 'imported'], tag: 'DECISION', sinceDays: 30, includeArchived: true, q: 'lucy', project: 'p1' }, 50, 40, true);
    });
    it('latest-id / latest', async () => {
        const a = app();
        await request(a).get('/api/brain/latest-id');
        expect(Q.latestId).toHaveBeenLastCalledWith(DEFAULT_FILTERS);
        await request(a).get('/api/brain/latest');
        expect(Q.latestGraph).toHaveBeenLastCalledWith(DEFAULT_FILTERS, { seedId: undefined, ambientFiles: 160, includeSimilar: false });
        await request(a).get('/api/brain/latest?seed=abc&ambient=20&sim=1');
        expect(Q.latestGraph).toHaveBeenLastCalledWith(DEFAULT_FILTERS, { seedId: 'abc', ambientFiles: 20, includeSimilar: true });
    });
    it('local: id required, limit default 120', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/local')).status).toBe(400);
        await request(a).get('/api/brain/local?id=c1');
        expect(Q.localGraph).toHaveBeenLastCalledWith('c1', 120, false);
        await request(a).get('/api/brain/local?id=c1&limit=5&sim=1');
        expect(Q.localGraph).toHaveBeenLastCalledWith('c1', 5, true);
    });
    it('similar: id required, k/tau/same_scope', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/similar')).status).toBe(400);
        const r = await request(a).get('/api/brain/similar?id=c1');
        expect(r.body).toEqual({ neighbors: [] });
        expect(Q.similarChunks).toHaveBeenLastCalledWith('c1', { topK: 6, minCos: undefined, sameScopeOnly: false });
        await request(a).get('/api/brain/similar?id=c1&k=3&tau=0.8&same_scope=1');
        expect(Q.similarChunks).toHaveBeenLastCalledWith('c1', { topK: 3, minCos: 0.8, sameScopeOnly: true });
    });
    it('node: 400 without id, 404 when unknown, 200 otherwise', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/node')).status).toBe(400);
        expect((await request(a).get('/api/brain/node?id=missing')).status).toBe(404);
        expect((await request(a).get('/api/brain/node?id=c9')).body).toEqual({ id: 'c9' });
    });
    it('file: path required', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/file')).status).toBe(400);
        await request(a).get('/api/brain/file?path=memory/2026-08-25.md');
        expect(Q.fileDetail).toHaveBeenLastCalledWith('memory/2026-08-25.md');
    });
    it('entity: numeric id, 404 when unknown', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/entity')).status).toBe(400);
        expect((await request(a).get('/api/brain/entity?id=x')).status).toBe(400);
        expect((await request(a).get('/api/brain/entity?id=404')).status).toBe(404);
        expect((await request(a).get('/api/brain/entity?id=7')).body).toEqual({ id: 7 });
    });
    it('entity-net: min/max_nodes defaults, closeness, kinds (default hides not_an_entity; all opts in)', async () => {
        const a = app();
        await request(a).get('/api/brain/entity-net');
        expect(Q.entityNet).toHaveBeenLastCalledWith(DEFAULT_FILTERS, 1, 220, 900, 'chunk', KINDS_DEFAULT);
        await request(a).get('/api/brain/entity-net?min=2&max_nodes=50&by=file&kinds=all');
        expect(Q.entityNet).toHaveBeenLastCalledWith(DEFAULT_FILTERS, 2, 50, 900, 'file', undefined);
        await request(a).get('/api/brain/entity-net?kinds=person,bogus');
        expect(Q.entityNet).toHaveBeenLastCalledWith(DEFAULT_FILTERS, 1, 220, 900, 'chunk', ['person']);
        await request(a).get('/api/brain/entity-net?kinds=bogus');
        expect(Q.entityNet).toHaveBeenLastCalledWith(DEFAULT_FILTERS, 1, 220, 900, 'chunk', undefined);
    });
    it('entity-ego: id required; depth/limit/min defaults', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/entity-ego')).status).toBe(400);
        await request(a).get('/api/brain/entity-ego?id=3');
        expect(Q.entityEgo).toHaveBeenLastCalledWith(3, DEFAULT_FILTERS, 1, 36, 1, 'chunk', KINDS_DEFAULT);
        await request(a).get('/api/brain/entity-ego?id=3&depth=2&limit=10&min=2&by=file');
        expect(Q.entityEgo).toHaveBeenLastCalledWith(3, DEFAULT_FILTERS, 2, 10, 2, 'file', KINDS_DEFAULT);
    });
    it('entity-pair: a and b required; limit default 40', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/entity-pair?a=1')).status).toBe(400);
        await request(a).get('/api/brain/entity-pair?a=1&b=2');
        expect(Q.entityPair).toHaveBeenLastCalledWith(1, 2, DEFAULT_FILTERS, 40, 'chunk');
    });
    it('search: q defaults to empty, limit 20, archived flag', async () => {
        const a = app();
        expect((await request(a).get('/api/brain/search')).body).toEqual({ results: [] });
        expect(Q.search).toHaveBeenLastCalledWith('', 20, false);
        await request(a).get('/api/brain/search?q=lucy&limit=5&archived=1');
        expect(Q.search).toHaveBeenLastCalledWith('lucy', 5, true);
    });
    it('timeline: days default 90; conflicts: optional status', async () => {
        const a = app();
        await request(a).get('/api/brain/timeline');
        expect(Q.timeline).toHaveBeenLastCalledWith(90, false);
        await request(a).get('/api/brain/timeline?days=30&archived=1');
        expect(Q.timeline).toHaveBeenLastCalledWith(30, true);
        await request(a).get('/api/brain/conflicts');
        expect(Q.conflicts).toHaveBeenLastCalledWith(undefined);
        await request(a).get('/api/brain/conflicts?status=open');
        expect(Q.conflicts).toHaveBeenLastCalledWith('open');
    });
    it('a throwing query is a 500 with the message, not a hung request', async () => {
        Q.overview.mockImplementationOnce(() => { throw new Error('boom'); });
        const r = await request(app()).get('/api/brain/overview');
        expect(r.status).toBe(500);
        expect(r.body).toEqual({ error: 'boom' });
    });
});
