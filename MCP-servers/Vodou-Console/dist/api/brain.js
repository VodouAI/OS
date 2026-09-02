/**
 * Brain graph API — PLAN-BRAIN-INTO-CONSOLE P0.3 (PLANS/0.6.28).
 *
 * The 19 read-only routes the standalone brain console served on :8767
 * (`MCP-servers/brain/src/serve.ts`), ported verbatim onto the gateway so the
 * Memory view can mount the constellation in-page. Same paths, same query
 * params, same JSON — R2 in the plan is byte parity against :8767.
 *
 *   GET /api/brain/overview · scopes · graph · latest-id · latest · local ·
 *       similar · node · file · entity · entity-net · entity-ego · entity-pair ·
 *       entities · projects · hosts · search · timeline · conflicts
 *
 * Read-only by construction: `src/brain/queries.ts` opens memory.db readOnly.
 * Non-GET → 405, unknown route → 404, exactly as serve.ts did.
 *
 * `/api/brain/execute` (core-api.ts) is NOT this router's — it is the daemon's
 * BrainLoader entry point and must stay mounted ahead of this prefix. The
 * mount line in src/index.ts lands separately (hot file).
 */
import { Router } from 'express';
import * as Q from '../brain/queries.js';
export const brainRouter = Router();
function json(res, status, body) {
    res.status(status).set('cache-control', 'no-store').json(body);
}
function str(req, key) {
    const v = req.query[key];
    if (typeof v === 'string')
        return v;
    if (Array.isArray(v) && typeof v[0] === 'string')
        return v[0];
    return null;
}
function has(req, key) {
    return req.query[key] !== undefined;
}
function int(req, key, dflt) {
    return parseInt(str(req, key) || String(dflt), 10);
}
function parseFilters(req) {
    const cls = str(req, 'cls');
    const tag = str(req, 'tag');
    const since = str(req, 'since_days');
    const q = str(req, 'q');
    const project = str(req, 'project');
    const host = str(req, 'host');
    return {
        host: host || undefined,
        cls: cls ? cls.split(',').filter((c) => ['yours', 'captured', 'imported'].includes(c)) : undefined,
        tag: tag || undefined,
        sinceDays: since ? parseInt(since, 10) : undefined,
        includeArchived: str(req, 'archived') === '1',
        q: q || undefined,
        project: project || undefined,
    };
}
/** Which kinds of name to include. Absent = hide the classifier's
 *  `not_an_entity` verdicts; `kinds=all` opts back in. (serve.ts kindsParam) */
function kindsParam(req) {
    const raw = str(req, 'kinds');
    if (raw === 'all')
        return undefined;
    if (raw) {
        const want = raw.split(',').map((k) => k.trim()).filter((k) => Q.ENTITY_KINDS.includes(k));
        return want.length ? want : undefined;
    }
    return Q.ENTITY_KINDS.filter((k) => k !== 'not_an_entity');
}
/** Web-of-names closeness: same memory ('chunk') or same memory file ('file'). */
function closeness(req) {
    return str(req, 'by') === 'file' ? 'file' : 'chunk';
}
brainRouter.use((req, res, next) => {
    if (req.method !== 'GET')
        return json(res, 405, { error: 'read-only surface: GET only' });
    next();
});
brainRouter.get('/:route', (req, res) => {
    try {
        switch (req.params.route) {
            case 'overview': return json(res, 200, Q.overview());
            case 'scopes': return json(res, 200, Q.scopes());
            case 'graph': return json(res, 200, Q.graphOverview(parseFilters(req), int(req, 'max_files', 200), 40, str(req, 'sim') === '1'));
            case 'latest-id': return json(res, 200, Q.latestId(parseFilters(req)));
            case 'latest': return json(res, 200, Q.latestGraph(parseFilters(req), {
                seedId: str(req, 'seed') || undefined,
                ambientFiles: int(req, 'ambient', 160),
                includeSimilar: str(req, 'sim') === '1',
            }));
            case 'local': {
                const id = str(req, 'id');
                if (!id)
                    return json(res, 400, { error: 'id required' });
                return json(res, 200, Q.localGraph(id, int(req, 'limit', 120), str(req, 'sim') === '1'));
            }
            case 'similar': {
                const id = str(req, 'id');
                if (!id)
                    return json(res, 400, { error: 'id required' });
                return json(res, 200, {
                    neighbors: Q.similarChunks(id, {
                        topK: int(req, 'k', 6),
                        minCos: has(req, 'tau') ? parseFloat(str(req, 'tau')) : undefined,
                        sameScopeOnly: str(req, 'same_scope') === '1',
                    }),
                });
            }
            case 'node': {
                const id = str(req, 'id');
                if (!id)
                    return json(res, 400, { error: 'id required' });
                const detail = Q.nodeDetail(id);
                return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
            }
            case 'file': {
                const fp = str(req, 'path');
                if (!fp)
                    return json(res, 400, { error: 'path required' });
                return json(res, 200, Q.fileDetail(fp));
            }
            case 'entity': {
                const id = parseInt(str(req, 'id') || '', 10);
                if (!Number.isFinite(id))
                    return json(res, 400, { error: 'id required' });
                const detail = Q.entityDetail(id);
                return detail ? json(res, 200, detail) : json(res, 404, { error: 'not found' });
            }
            case 'entity-net': return json(res, 200, Q.entityNet(parseFilters(req), int(req, 'min', 1), int(req, 'max_nodes', 220), 900, closeness(req), kindsParam(req)));
            case 'entity-ego': {
                const id = parseInt(str(req, 'id') || '', 10);
                if (!Number.isFinite(id))
                    return json(res, 400, { error: 'id required' });
                return json(res, 200, Q.entityEgo(id, parseFilters(req), int(req, 'depth', 1), int(req, 'limit', 36), int(req, 'min', 1), closeness(req), kindsParam(req)));
            }
            case 'entity-pair': {
                const a = parseInt(str(req, 'a') || '', 10);
                const b = parseInt(str(req, 'b') || '', 10);
                if (!Number.isFinite(a) || !Number.isFinite(b))
                    return json(res, 400, { error: 'a and b required' });
                return json(res, 200, Q.entityPair(a, b, parseFilters(req), int(req, 'limit', 40), closeness(req)));
            }
            case 'entities': return json(res, 200, Q.entities());
            case 'projects': return json(res, 200, Q.projects());
            case 'hosts': return json(res, 200, Q.hosts());
            case 'search': {
                const q = str(req, 'q') || '';
                return json(res, 200, {
                    results: Q.search(q, int(req, 'limit', 20), str(req, 'archived') === '1'),
                });
            }
            case 'timeline': return json(res, 200, Q.timeline(int(req, 'days', 90), str(req, 'archived') === '1'));
            case 'conflicts': return json(res, 200, Q.conflicts(str(req, 'status') || undefined, str(req, 'slot') || undefined));
            default: return json(res, 404, { error: 'unknown route' });
        }
    }
    catch (err) {
        console.error('[brain-api] error:', err);
        return json(res, 500, { error: String(err instanceof Error ? err.message : err) });
    }
});
