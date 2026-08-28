/**
 * page-match — PLAN-MEMORY-ON-EVERY-PAGE P1.
 *
 * The endpoint's job is narrow and its FAILURE modes are what matter: the panel
 * calls it on every tab activation, so anything that 500s, leaks across pages, or
 * answers a foreign origin is worse than an empty box. Each test below is one of
 * those, not a happy-path restatement.
 *
 * The daemon is stubbed. What is under test is the endpoint's contract — tiering,
 * caching, degradation, normalization — not the retrieval underneath it, which has
 * its own Rust tests (`memory::search::by_page`, `memory::page_id`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
const daemon = vi.hoisted(() => ({ reply: null, calls: [] }));
// The daemon socket is the one dependency worth faking: a real one would make
// these tests depend on whatever happens to be in the operator's memory.db.
vi.mock('node:net', async (orig) => {
    const actual = await orig();
    return {
        ...actual,
        default: {
            ...actual,
            createConnection: (_p, onConnect) => {
                const handlers = {};
                const self = {
                    on(ev, fn) { (handlers[ev] ||= []).push(fn); return self; },
                    setTimeout() { return self; },
                    destroy() { return self; },
                    write(payload) {
                        daemon.calls.push(JSON.parse(payload));
                        queueMicrotask(() => {
                            if (daemon.reply === null) {
                                (handlers.error || []).forEach((f) => f(new Error('down')));
                                return;
                            }
                            (handlers.data || []).forEach((f) => f(Buffer.from(JSON.stringify(daemon.reply) + '\n')));
                        });
                        return true;
                    },
                };
                queueMicrotask(onConnect);
                return self;
            },
        },
    };
});
const settings = vi.hoisted(() => new Map());
vi.mock('../db.js', () => ({
    getProjectRoot: () => '/tmp/vodou-page-match-test',
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => { settings.set(k, v); },
}));
// P2 write lanes shell out to `vodou-core mem store|page-link`; the CLI is
// stubbed so the test asserts the CONTRACT (args, cache drop, error surfacing),
// not the Rust side (which has its own tests).
const core = vi.hoisted(() => ({ calls: [], inputs: [], reply: { status: 0, stdout: '', stderr: '' } }));
vi.mock('../api/memory-capture.js', () => ({
    runCore: async (args, opts) => { core.calls.push(args); core.inputs.push(opts?.input ?? ''); return core.reply; },
    resolveCoreBin: () => '/nonexistent/vodou-core',
}));
const { pageMatchRouter } = await import('../api/page-match.js');
let server;
let base = '';
async function post(body, headers = {}) {
    return fetch(`${base}/api/page-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}
beforeEach(async () => {
    daemon.reply = null;
    daemon.calls.length = 0;
    core.calls.length = 0;
    core.inputs.length = 0;
    settings.clear();
    core.reply = { status: 0, stdout: '', stderr: '' };
    if (!server) {
        const app = express();
        app.use(express.json());
        app.use('/api/page-match', pageMatchRouter);
        const started = await new Promise((r) => {
            const s = app.listen(0, '127.0.0.1', () => r(s));
        });
        server = started;
        base = `http://127.0.0.1:${started.address().port}`;
    }
});
describe('page-match', () => {
    it('separates the two tiers instead of merging them into one ranked list', async () => {
        // T1 and T2 are different KINDS of claim -- "recorded on this page" vs
        // "recorded elsewhere on this host". Merging them would let the weaker one
        // borrow the stronger one's authority, which is the whole reason the panel
        // labels them separately.
        daemon.reply = {
            ok: true,
            page_key: 'example.com/pricing',
            host: 'example.com',
            page: [{ chunk_id: 'c1', text: 'we agreed on tiered pricing', path: 'memory/a.md', created_at: '2026-08-17 10:00:00' }],
            site: [{ chunk_id: 'c2', text: 'their docs are on the same host', path: 'memory/b.md', created_at: '2026-08-16 09:00:00' }],
        };
        const r = await post({ url: 'https://example.com/pricing' });
        const j = await r.json();
        expect(j.ok).toBe(true);
        expect(j.page.map((x) => x.id)).toEqual(['c1']);
        expect(j.site.map((x) => x.id)).toEqual(['c2']);
    });
    it('lists a saved document ONCE, separately from the fact tiers', async () => {
        // A Wikipedia article saved from the page is 111 chunks. Those chunks must
        // not appear as facts; the document appears once, with the same @doc
        // token the library lane uses. Verified live 2026-08-17 -- before this the
        // fact tier was flooded with `# Title\n\nSource: ...` fragments.
        daemon.reply = {
            ok: true, page_key: 'en.wikipedia.org/wiki/Long-term_memory', host: 'en.wikipedia.org',
            page: [{ chunk_id: 'f1', text: 'LTM splits into explicit and implicit', path: 'memory/x.md', created_at: '2026-08-17 21:00:00' }],
            site: [],
            docs: [{ id: 225, name: 'Long-term memory - Wikipedia', kind: 'md', chunk_count: 111, source_url: 'en.wikipedia.org/wiki/Long-term_memory', created_at: '2026-08-17 22:04:38' }],
            site_docs: [{ id: 226, name: 'Working memory - Wikipedia', kind: 'md', chunk_count: 40, source_url: 'en.wikipedia.org/wiki/Working_memory', created_at: '2026-08-17 22:10:00' }],
        };
        const r = await post({ url: 'https://en.wikipedia.org/wiki/Long-term_memory' });
        const j = await r.json();
        expect(j.page.map((x) => x.id)).toEqual(['f1']);
        // COHERENCE F13 — `slug` rides on the row. The panel used to derive the
        // token from `name`, which made this route and doc-attach.ts two deciders
        // of one string; it now pastes what it was handed.
        expect(j.docs).toEqual([{
                id: 225, name: 'Long-term memory - Wikipedia', kind: 'md',
                slug: 'long-term-memory-wikipedia', chunks: 111, at: '2026-08-17 22:04:38',
            }]);
        expect(j.siteDocs.map((x) => x.id)).toEqual([226]);
        expect(j.siteDocs[0].slug).toBe('working-memory-wikipedia');
    });
    it('answers with empty doc lists when the daemon predates them (older core)', async () => {
        daemon.reply = { ok: true, page_key: 'example.com/a', host: 'example.com', page: [], site: [] };
        const j = await (await post({ url: 'https://example.com/a' })).json();
        expect(j.docs).toEqual([]);
        expect(j.siteDocs).toEqual([]);
    });
    it('carries the age, because a row with no date reads as undated not recent', async () => {
        daemon.reply = {
            ok: true, page_key: 'example.com/x', host: 'example.com',
            page: [{ chunk_id: 'c1', text: 't', path: 'p', created_at: '2026-08-17 10:00:00' }], site: [],
        };
        const j = await (await post({ url: 'https://example.com/x' })).json();
        // Passed through UNCHANGED as naive UTC (PLAN-TIME-CANON). Stamping a zone
        // here would invent one for every other caller of this payload.
        expect(j.page[0].at).toBe('2026-08-17 10:00:00');
        expect(j.page[0].at).not.toMatch(/[zZ]$/);
    });
    it('reports a missing age as null rather than inventing "now"', async () => {
        daemon.reply = {
            ok: true, page_key: 'example.com/no-age', host: 'example.com',
            page: [{ chunk_id: 'c1', text: 't', path: 'p' }], site: [],
        };
        const j = await (await post({ url: 'https://example.com/no-age' })).json();
        expect(j.page[0].at).toBeNull();
    });
    it('answers a non-http page with empty, not an error', async () => {
        // The panel asks about whatever tab is focused, including chrome:// and
        // file://. A 4xx per tab switch would be noise the caller cannot act on.
        for (const url of ['chrome://extensions', 'file:///etc/hosts', 'about:blank', '']) {
            const r = await post({ url });
            expect(r.status).toBe(200);
            const j = await r.json();
            expect(j.ok).toBe(true);
            expect(j.pageKey).toBeNull();
            expect(j.page).toEqual([]);
            expect(j.site).toEqual([]);
        }
        expect(daemon.calls, 'a non-page must never reach the daemon').toHaveLength(0);
    });
    it('DEGRADES to empty when the daemon is down, and says so', async () => {
        // A panel section that says "nothing here" is recoverable; one that errors on
        // every tab switch is not. `degraded` is what keeps that honest -- without it
        // "daemon down" and "you know nothing about this page" are the same response.
        daemon.reply = null;
        const r = await post({ url: 'https://example.com/daemon-down' });
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.ok).toBe(true);
        expect(j.degraded).toBe(true);
        expect(j.page).toEqual([]);
        expect(j.pageKey, 'the page is still identified even when retrieval failed').toBe('example.com/daemon-down');
    });
    it('does not cache a degraded answer as if it were an answer', async () => {
        // Caching "the daemon was down" for 30s would keep the panel empty for half a
        // minute after the daemon came back.
        daemon.reply = null;
        await post({ url: 'https://example.com/cache-probe' });
        daemon.reply = {
            ok: true, page_key: 'example.com/cache-probe', host: 'example.com',
            page: [{ chunk_id: 'c9', text: 'now available', path: 'p' }], site: [],
        };
        const j = await (await post({ url: 'https://example.com/cache-probe' })).json();
        expect(j.degraded).toBeUndefined();
        expect(j.page).toHaveLength(1);
    });
    it('serves a repeat request from cache without re-asking the daemon', async () => {
        daemon.reply = {
            ok: true, page_key: 'example.com/hot', host: 'example.com',
            page: [{ chunk_id: 'c1', text: 't', path: 'p' }], site: [],
        };
        await post({ url: 'https://example.com/hot' });
        const before = daemon.calls.length;
        const j = await (await post({ url: 'https://example.com/hot' })).json();
        expect(daemon.calls.length, 'second call must be served from cache').toBe(before);
        expect(j.cached).toBe(true);
    });
    it('does not serve one page from another page\'s cache entry', async () => {
        // The cache key is the normalized page key. If it were the host, every page on
        // a site would show the first page's memories -- a confident, wrong panel.
        daemon.reply = {
            ok: true, page_key: 'example.com/one', host: 'example.com',
            page: [{ chunk_id: 'one', text: 't', path: 'p' }], site: [],
        };
        await post({ url: 'https://example.com/one' });
        daemon.reply = {
            ok: true, page_key: 'example.com/two', host: 'example.com',
            page: [{ chunk_id: 'two', text: 't', path: 'p' }], site: [],
        };
        const j = await (await post({ url: 'https://example.com/two' })).json();
        expect(j.page[0].id).toBe('two');
    });
    it('treats two spellings of the same page as ONE cache entry', async () => {
        // normalizeUrl strips tracking params and the fragment, so these are the same
        // page. Missing that would mean a link from a campaign shows nothing while the
        // bare URL shows everything.
        daemon.reply = {
            ok: true, page_key: 'example.com/post', host: 'example.com',
            page: [{ chunk_id: 'c1', text: 't', path: 'p' }], site: [],
        };
        await post({ url: 'https://example.com/post' });
        const before = daemon.calls.length;
        await post({ url: 'https://www.example.com/post?utm_source=x#section' });
        expect(daemon.calls.length, 'the same page spelled two ways must hit one cache entry').toBe(before);
    });
    it('clamps topK instead of trusting the caller', async () => {
        daemon.reply = { ok: true, page_key: 'example.com/k', host: 'example.com', page: [], site: [] };
        await post({ url: 'https://example.com/k', topK: 9999 });
        expect(daemon.calls.at(-1).payload.top_k).toBeLessThanOrEqual(50);
        await post({ url: 'https://example.com/k2', topK: -5 });
        expect(daemon.calls.at(-1).payload.top_k).toBeGreaterThanOrEqual(1);
    });
    // ── P2 write lanes ──────────────────────────────────────────────────────
    it('note: stores through `mem store --url` and drops that page from the cache', async () => {
        // Warm the cache for the page first.
        daemon.reply = { ok: true, page_key: 'example.com/a', host: 'example.com', page: [], site: [] };
        await post({ url: 'https://example.com/a' });
        expect((await (await post({ url: 'https://example.com/a' })).json()).cached).toBe(true);
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, scope: 'import:mcp', path: 'memory/imports/mcp/store-2026-08.md', page: 'example.com/a' }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/note', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/a?utm_source=x', text: 'the pricing page lists three tiers' }),
        });
        const j = await r.json();
        expect(r.status).toBe(200);
        expect(j.ok).toBe(true);
        expect(core.calls[0].slice(0, 3)).toEqual(['mem', 'store', 'the pricing page lists three tiers']);
        expect(core.calls[0]).toContain('--url');
        // The next read must NOT be served from the pre-note cache entry.
        daemon.reply = { ok: true, page_key: 'example.com/a', host: 'example.com', page: [{ chunk_id: 'n1', text: 'the pricing page lists three tiers', path: 'm', created_at: '2026-08-17 22:00:00' }], site: [] };
        const again = await (await post({ url: 'https://example.com/a' })).json();
        expect(again.cached).toBeUndefined();
        expect(again.page.map((x) => x.id)).toEqual(['n1']);
    });
    it('note: surfaces the storage guard verbatim instead of a bare failure', async () => {
        core.reply = { status: 1, stdout: JSON.stringify({ ok: false, guard: 'storage-boundary', error: 'refused: text is a bare tool invocation (tool-fiction), not a fact — store the actual fact instead' }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/note', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/a', text: 'vodou_core_call(...)' }),
        });
        expect(r.status).toBe(422);
        expect((await r.json()).error).toMatch(/tool-fiction/);
    });
    it('note: refuses a non-http page and an empty note without touching the CLI', async () => {
        let r = await fetch(base + '/api/page-match/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'chrome://extensions', text: 'hello there' }) });
        expect(r.status).toBe(400);
        r = await fetch(base + '/api/page-match/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a', text: '  ' }) });
        expect(r.status).toBe(400);
        expect(core.calls.length).toBe(0);
    });
    it('link: stamps an existing memory via `mem page-link` and 404s an unknown id', async () => {
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, chunk_id: 'memory/x.md:12:abc', page_key: 'example.com/a', host: 'example.com', updated: 1 }) + '\n', stderr: '' };
        let r = await fetch(base + '/api/page-match/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a', chunkId: 'memory/x.md:12:abc' }) });
        expect(r.status).toBe(200);
        expect(core.calls[0].slice(0, 3)).toEqual(['mem', 'page-link', 'memory/x.md:12:abc']);
        core.reply = { status: 0, stdout: JSON.stringify({ ok: false, chunk_id: 'nope', updated: 0 }) + '\n', stderr: '' };
        r = await fetch(base + '/api/page-match/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a', chunkId: 'nope' }) });
        expect(r.status).toBe(404);
    });
    // ── P4 — per-site mode ──────────────────────────────────────────────────
    it('answers a sensitive host as mode=off WITHOUT asking the daemon, and carries mode on normal answers', async () => {
        const j = await (await post({ url: 'https://www.chase.com/personal/checking' })).json();
        expect(j.mode).toBe('off');
        expect(j.modeSource).toBe('sensitive');
        expect(j.page).toEqual([]);
        expect(daemon.calls.length).toBe(0);
        daemon.reply = { ok: true, page_key: 'example.com/a', host: 'example.com', page: [], site: [] };
        const k = await (await post({ url: 'https://example.com/a' })).json();
        expect(k.mode).toBe('collect');
        expect(k.modeSource).toBe('default');
    });
    it('a user rule overrides the default and its parent domain covers subdomains; PUT then GET agree', async () => {
        let r = await fetch(base + '/api/page-match/site-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'Wikipedia.org', mode: 'suggest' }) });
        expect((await r.json())).toMatchObject({ ok: true, host: 'wikipedia.org', mode: 'suggest', source: 'user' });
        r = await fetch(base + '/api/page-match/site-mode?url=' + encodeURIComponent('https://en.wikipedia.org/wiki/Memory'));
        expect(await r.json()).toMatchObject({ ok: true, host: 'en.wikipedia.org', mode: 'suggest', source: 'user', ruleHost: 'wikipedia.org' });
        // And a rule can turn a sensitive default back on.
        r = await fetch(base + '/api/page-match/site-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'chase.com', mode: 'collect' }) });
        expect((await r.json()).mode).toBe('collect');
        daemon.reply = { ok: true, page_key: 'chase.com/x', host: 'chase.com', page: [], site: [] };
        expect((await (await post({ url: 'https://chase.com/x' })).json()).mode).toBe('collect');
        // null clears it.
        r = await fetch(base + '/api/page-match/site-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'chase.com', mode: null }) });
        expect((await r.json())).toMatchObject({ mode: 'off', source: 'sensitive' });
    });
    it('suggest-only refuses note and link with 403 and a reason; collect allows them', async () => {
        await fetch(base + '/api/page-match/site-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'example.com', mode: 'suggest' }) });
        let r = await fetch(base + '/api/page-match/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a', text: 'a note here' }) });
        expect(r.status).toBe(403);
        expect((await r.json()).error).toMatch(/suggest-only/);
        r = await fetch(base + '/api/page-match/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a', chunkId: 'x:1:a' }) });
        expect(r.status).toBe(403);
        expect(core.calls.length).toBe(0);
    });
    it('forget-host shells to `mem forget --host` and passes dry-run/undo through', async () => {
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, host: 'reddit.com', chunks_matched: 12, chunks_updated: 0, library_documents_from_host: 1 }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/forget-host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.reddit.com/r/x', dryRun: true }) });
        const j = await r.json();
        expect(j).toMatchObject({ ok: true, host: 'reddit.com', dryRun: true, chunksMatched: 12, libraryDocuments: 1 });
        expect(core.calls[0]).toEqual(['mem', 'forget', '--host', 'reddit.com', '--json', '--dry-run']);
    });
    // ── P6 — fill-plan + learn ──────────────────────────────────────────────
    it('fill-plan ships the form MODEL to the core (never current values), maps proposals, and refuses off sites', async () => {
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, page_key: 'httpbin.org/forms/post', host: 'httpbin.org', asked_llm: 2, proposals: [
                    { id: 'instr', value: 'leave at the side door', confidence: 0.95, kind: 'page', source_id: 'm/x.md:1:a1' },
                    { id: 'email', value: 'chad@linkies.com', confidence: 0.8, kind: 'memory', source: "User's email is chad@linkies.com" },
                ] }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/fill-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                url: 'https://httpbin.org/forms/post', title: 'form',
                fields: [{ id: 'instr', label: 'Delivery instructions', type: 'text', value: 'SECRET CURRENT VALUE' }, { id: 'email', label: 'E-mail', type: 'email', autocomplete: 'email' }],
            }) });
        const j = await r.json();
        expect(r.status).toBe(200);
        expect(j.proposals.map((p) => [p.id, p.kind])).toEqual([['instr', 'page'], ['email', 'memory']]);
        expect(core.calls[0].slice(0, 3)).toEqual(['mem', 'fill-plan', '--stdin-json']);
        const sent = JSON.parse(core.inputs[0]);
        expect(sent.fields[0].value).toBe(''); // current values never leave the page
        expect(sent.fields[0].label).toBe('Delivery instructions');
        // off site → 403, nothing asked
        core.calls.length = 0;
        const off = await fetch(base + '/api/page-match/fill-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://www.chase.com/x', fields: [{ id: 'a', label: 'Name' }] }) });
        expect(off.status).toBe(403);
        expect(core.calls.length).toBe(0);
    });
    it('learn stores each accepted answer as a page-stamped [PREF] fact in the planner\'s bullet shape, collect only', async () => {
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, path: 'memory/imports/mcp/store-2026-08.md' }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                url: 'https://httpbin.org/forms/post', answers: [{ label: 'Delivery instructions', value: 'leave at the side door' }, { label: '', value: 'x' }],
            }) });
        const j = await r.json();
        expect(j).toMatchObject({ ok: true, stored: 1 });
        expect(core.calls[0]).toEqual(['mem', 'store', 'Form answer on httpbin.org — Delivery instructions: leave at the side door', '--tag', 'PREF', '--url', 'https://httpbin.org/forms/post', '--json']);
        await fetch(base + '/api/page-match/site-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: 'httpbin.org', mode: 'suggest' }) });
        const s2 = await fetch(base + '/api/page-match/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://httpbin.org/forms/post', answers: [{ label: 'a', value: 'b' }] }) });
        expect(s2.status).toBe(403);
    });
    it('learn skips an answer the page already holds and stores a changed one', async () => {
        daemon.reply = { ok: true, page_key: 'httpbin.org/forms/post', host: 'httpbin.org', page: [
                { chunk_id: 'm:1:a', text: '- scope:import:mcp page:httpbin.org/forms/post | [PREF] Form answer on httpbin.org — Delivery instructions: leave at the side door', path: 'm', created_at: '2026-08-17 21:00:00' },
            ], site: [] };
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                url: 'https://httpbin.org/forms/post', answers: [{ label: 'Delivery instructions', value: 'leave at the side door' }, { label: 'Delivery instructions', value: 'ring twice' }],
            }) });
        const j = await r.json();
        expect(j).toMatchObject({ ok: true, stored: 1, skipped: 1 });
        expect(core.calls.filter((c) => c[1] === 'store').length).toBe(1);
        expect(core.calls.find((c) => c[1] === 'store')[2]).toBe('Form answer on httpbin.org — Delivery instructions: ring twice');
    });
    it('correct supersedes the source fact via `mem correct --chunk-id` for each fix', async () => {
        core.reply = { status: 0, stdout: JSON.stringify({ ok: true, superseded: 1 }) + '\n', stderr: '' };
        const r = await fetch(base + '/api/page-match/correct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                url: 'https://httpbin.org/forms/post', fixes: [{ chunkId: 'memory/x.md:3:abc', right: "User's phone number is (586) 555-0000", wrong: '(586) 201-3686' }],
            }) });
        expect(await r.json()).toMatchObject({ ok: true, corrected: 1 });
        expect(core.calls[0]).toEqual(['mem', 'correct', "User's phone number is (586) 555-0000", '--chunk-id', 'memory/x.md:3:abc', '--json']);
    });
});
