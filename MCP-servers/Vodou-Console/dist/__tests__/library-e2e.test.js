/**
 * Document Library — end-to-end regression harness (PLAN-DOCUMENT-LIBRARY).
 *
 * WHY THIS EXISTS. Every bug in this feature during the 2026-08-10 build was
 * found by a human reading a stored document, never by a test:
 *
 *   · the CSRF guard rejected every extension request  (verified with curl,
 *     which sends no Origin and sails through)
 *   · the chunker dropped 940 bytes of a 9,199-byte paragraph
 *   · an oversized first paragraph was never split, so its tail embedded as
 *     if read
 *   · the extractor welded every block together, then ate inline elements
 *
 * Chunk counts, exit codes and success toasts were GREEN for all of them. So
 * this harness asserts the only thing that actually matters: **what a document
 * says on the way in is what it says on the way out**, through the real gateway,
 * the real binary and the real database.
 *
 * It skips itself when the gateway is not running, so it never fails a CI box
 * that has no services — but it is a real end-to-end run when it does execute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '../../../..');
const GW = process.env.VODOU_GATEWAY ?? 'http://127.0.0.1:8765';
/** The paired-extension origin the CSRF guard must admit. */
const EXT_ORIGIN = 'chrome-extension://bbpfoncbncbpaefobohppifhdpncdfjb';
let live = false;
const created = [];
async function gatewayUp() {
    try {
        const r = await fetch(`${GW}/health`, { signal: AbortSignal.timeout(2500) });
        return r.ok;
    }
    catch {
        return false;
    }
}
/** POST shaped like the extension: Origin + Sec-Fetch-Site, as a browser sends. */
function extPost(path, body, origin = EXT_ORIGIN) {
    return fetch(`${GW}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: origin,
            'Sec-Fetch-Site': 'none',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
    });
}
beforeAll(async () => {
    live = await gatewayUp();
    if (!live)
        console.warn(`[library-e2e] gateway not reachable at ${GW} — skipping`);
});
afterAll(async () => {
    // Never leave test documents in a real library.
    for (const id of created) {
        try {
            await fetch(`${GW}/api/library/${id}`, { method: 'DELETE' });
        }
        catch { /* best effort */ }
    }
});
describe('library end-to-end', () => {
    it('admits the paired extension and refuses everything else', async () => {
        if (!live)
            return;
        // The exact failure that made all three lanes dead on arrival, and that curl
        // structurally could not reproduce.
        const ok = await extPost('/api/library/match', { query: 'x' });
        expect(ok.status).toBe(200);
        const otherExt = await extPost('/api/library/match', { query: 'x' }, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        expect(otherExt.status).toBe(403);
        const evil = await extPost('/api/library/url', { url: 'https://x/y.pdf' }, 'https://evil.example.com');
        expect(evil.status).toBe(403);
    }, 120000);
    it('stores a document byte-for-byte — no dropped spans, no welded blocks', async () => {
        if (!live)
            return;
        // Built to trip every text-loss bug at once:
        //  · LONG unbroken runs, so the space-boundary pull-back is large (the
        //    fixed-stride gap that dropped "notion.site" → ".ion.site")
        //  · multibyte characters at unpredictable offsets (the char-boundary panic)
        //  · an oversized FIRST paragraph (the bypass that never split)
        //  · distinct blocks, so welding is detectable
        const marks = Array.from({ length: 40 }, (_, i) => `MARK${String(i).padStart(3, '0')}`);
        const longRun = (m) => `${m}${'—abcdefghij'.repeat(22)}`;
        const text = [
            marks.slice(0, 20).map(longRun).join(' '),
            '',
            'Second block “with curly quotes” and an arrow → inline.',
            '',
            marks.slice(20).map(longRun).join(' '),
        ].join('\n');
        const res = await extPost('/api/library/text', {
            title: 'E2E fidelity probe',
            url: 'https://example.test/e2e-fidelity',
            text,
            noCards: true,
        });
        expect(res.status).toBe(200);
        const { id } = (await res.json());
        expect(id).toBeGreaterThan(0);
        created.push(id);
        const view = await fetch(`${GW}/api/library/${id}`, { signal: AbortSignal.timeout(60_000) });
        const { body } = (await view.json());
        // 1. NOTHING dropped. This is the assertion the whole harness exists for.
        const missing = marks.filter((m) => !body.includes(m));
        expect(missing, `dropped ${missing.length} marker(s): ${missing.slice(0, 5).join(', ')}`).toEqual([]);
        // 2. Multibyte survived intact — no replacement chars, no split characters.
        expect(body).not.toContain('�');
        expect(body).toContain('“with curly quotes”');
        expect(body).toContain('arrow → inline');
        // 3. Blocks stayed separate. Welding is what made a Notion page read
        //    "3 steps1. InstallVodou runs locally".
        expect(body).toMatch(/\n/);
        expect(body).not.toMatch(/inline\.MARK/);
    }, 240000);
    it('ranks a matching page and stays silent on noise', async () => {
        if (!live)
            return;
        // C-lite's whole value is the SILENCE. A panel chip that lights up on every
        // page is ignored within a week, so the negative case matters more than the
        // positive one.
        // Positive case, in the panel's own query shape: "<tab title> <host>".
        const hit = await extPost('/api/library/match', { query: 'Get Started with Vodou notion.so', topK: 3 });
        const { matches } = (await hit.json());
        expect(Array.isArray(matches)).toBe(true);
        if (matches.length) {
            // When it DOES fire it must name the right document — a confidently wrong
            // chip is worse than no chip. Cosine got this wrong on 2 of 8 relevant
            // queries; the cross-encoder got all 8 right.
            expect(matches[0].name).toMatch(/Get Started with Vodou/i);
        }
        // The noise set that calibrated the floor. The first three are PLANTED
        // LEXICAL COLLISIONS against real library documents — bi-encoder cosine
        // scored "Sourdough Starter Recipe" at 0.686, above a genuine contract
        // query, which is what forced cards onto the cross-encoder. If any of
        // these three ever match again, that regression is back.
        for (const noise of [
            'Sourdough Starter Recipe | King Arthur Baking kingarthurbaking.com',
            'Getting Started with React react.dev',
            'Starter home mortgage rates zillow.com',
            'Hacker News news.ycombinator.com',
            'Gmail mail.google.com',
            'YouTube youtube.com',
            'Amazon.com Online Shopping amazon.com',
            'How to repot a monstera houseplant thesill.com',
            'Premier League fixtures and results bbc.co.uk',
            'Weather forecast Fenton Michigan weather.com',
            'Rust ownership and borrowing doc.rust-lang.org',
        ]) {
            const r = await extPost('/api/library/match', { query: noise });
            const { matches: m } = (await r.json());
            expect(m, `"${noise}" should not match any document`).toHaveLength(0);
        }
    }, 240000);
    it('finds a document by what it DISCUSSES, not only what it is about', async () => {
        if (!live)
            return;
        // The topic lane. The card lane cannot answer interior queries and no card
        // rewrite fixes it — measured 2026-08-10, leading the MSA's `what` with
        // substance instead of provenance moved "governing law" from 0.052 to 0.224
        // against a 0.70 floor, while dropping one token ("SKU") collapsed another
        // query from 0.135 to 0.003. The content was never missing: chunk search
        // retrieves the clause at 0.72-0.80. This lane asks that index instead.
        const r = await extPost('/api/library/match', { query: 'limitation of liability indemnification clause template lawinsider.com', topK: 3 });
        const { matches } = (await r.json());
        const topic = matches.find((m) => m.via === 'topic');
        expect(topic, 'the interior query must find the document that discusses it').toBeTruthy();
        expect(topic.name).toMatch(/MASTER-AGREEMENT/i);
        // Evidence is not decoration: a topic hit asserts the WEAKER claim ("this
        // document mentions that"), so it must cite the passage a reader can check.
        expect(topic.why).toMatch(/mentions:/);
        expect(topic.why.length).toBeGreaterThan('mentions: '.length);
    }, 240000);
    it('serves matches from the warm daemon, not a cold process spawn', async () => {
        if (!live)
            return;
        // The warm path is INVISIBLE in the response — same results either way, since
        // both call cards::lookup — so the only thing that betrays a silent fall back
        // to the CLI is latency. Measured 2026-08-10: cold 6-15s per uncached query,
        // warm 0.37-2.3s. This asserts well inside that gap rather than at its edge.
        //
        // It matters because the fallback is deliberately quiet: the daemon being
        // down degrades latency, not correctness. Quiet is right for an operator and
        // wrong for a test, which is why this is measured here and logged there.
        // UNIQUE PER RUN. The match cache is keyed on the query, so fixed strings
        // are served in ~30ms on the second run and the assertion passes no matter
        // which path is live — verified by hiding the daemon socket and watching
        // this test pass anyway. A latency test that a cache can satisfy measures
        // the cache.
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const queries = [
            `zzz unmatched probe alpha quarterly ${nonce}`,
            `zzz unmatched probe beta logistics ${nonce}`,
            `zzz unmatched probe gamma horticulture ${nonce}`,
        ];
        const timings = [];
        for (const q of queries) {
            const t0 = Date.now();
            const r = await extPost('/api/library/match', { query: q, topK: 3 });
            timings.push(Date.now() - t0);
            expect(r.status).toBe(200);
        }
        // MEDIAN, not max. Asserting on the slowest of three made this flaky: it
        // passed alone and failed inside the full suite, where the noise test hits
        // the daemon with a dozen queries immediately before and one sample lands
        // above 5s while the path is perfectly warm. Cold is 6-15s per query, so a
        // median still separates the two cleanly without failing on contention.
        const sorted = [...timings].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        expect(median, `median uncached match was ${median}ms (${timings.join('/')}) — the cold CLI path is likely serving these`)
            .toBeLessThan(5000);
    }, 240000);
    it('scores the same warm and cold — one floor, one scorer', async () => {
        if (!live)
            return;
        // The warm and cold paths are supposed to differ ONLY in which process pays
        // the model load. On 2026-08-10 they silently differed in the MODEL: the
        // daemon reads `memory.toml [daemon] rerank_model` and had jina-turbo, while
        // every other process defaulted to bge-base. Same pool, same digests,
        // byte-identical card text -- 0.875 warm vs 0.994 cold, because jina-turbo's
        // logits run compressed (5.16 -> 1.94 on the identical pair).
        //
        // Both happened to separate at the 0.70 floor, so nothing was broken and
        // nothing would have caught it. But a threshold calibrated against one
        // scorer and served by another is a trap armed for the next config edit,
        // which is exactly what this test disarms.
        //
        // Honest limit: the ORIGINAL divergence can no longer be re-armed to prove
        // this test red, because the fix (every process resolves the model the same
        // way) removed the mechanism -- flipping memory.toml now moves both paths
        // together, and the test correctly stays green. What was verified is the
        // observed failure itself: 0.875 vs 0.994, a gap of 0.119 against a 0.005
        // tolerance. This guards the property going forward, by any future cause.
        const query = 'Vodou Q3 planning roadmap notion.so';
        const res = await extPost('/api/library/match', { query, topK: 3 });
        const { matches } = (await res.json());
        const warm = matches.find((m) => m.via === 'subject');
        if (!warm)
            return; // nothing carded to compare against; not this test's subject
        const { stdout } = await execFileAsync(path.join(REPO, 'vodou-core'), ['mem', 'library', 'match', query, '--top-k', '3', '--json'], { cwd: REPO, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
        const cold = JSON.parse(stdout.trim() || '[]')
            .find((h) => (h.via ?? 'subject') === 'subject');
        expect(cold, 'the CLI path returned no subject hit to compare').toBeTruthy();
        expect(Math.abs(warm.score - cold.score), `warm ${warm.score.toFixed(4)} vs cold ${cold.score.toFixed(4)} — the two paths are ` +
            'not running the same reranker (check memory.toml [daemon] rerank_model)').toBeLessThan(0.005);
    }, 240000);
    it('attaches a document from the @doc: token the panel copies', async () => {
        if (!live)
            return;
        // P4 step 4, the half that does not need a browser. The panel's click handler
        // builds the slug and writes it to the clipboard; everything after the paste
        // is this. Both ends compute the slug with the SAME expression
        // (sidepanel.js vs doc-attach.ts slugOf) — asserted here against a real
        // library document rather than by reading the two copies and hoping.
        const list = await fetch(`${GW}/api/library`, { signal: AbortSignal.timeout(30_000) });
        const { sources } = (await list.json());
        if (!sources.length)
            return;
        // Verbatim from extension/Store-vodou-bridge/sidepanel.js.
        const panelSlug = (name, id) => name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
            || String(id);
        const { resolveDocTokens } = await import('../doc-attach.js');
        const target = sources[0];
        const token = `@doc:${panelSlug(target.name, target.id)}`;
        const hit = await resolveDocTokens(`${token} what does this say?`);
        expect(hit.sawToken, `${token} was not recognised as a token`).toBe(true);
        expect(hit.context.length, `${token} resolved to no document text`).toBeGreaterThan(100);
        expect(hit.context).toContain(target.name);
        // The token is consumed, not left in the prompt the model reads.
        expect(hit.text).not.toContain('@doc:');
        // A wrong slug must FAIL LOUDLY. A dropped attachment the user believes
        // landed is worse than an error, and this is the only place that is checked.
        const bogus = await resolveDocTokens('@doc:no-such-document-anywhere hello');
        expect(bogus.sawToken).toBe(true);
        expect(bogus.context).toBe('');
        expect(bogus.notices.join(' ')).toMatch(/no such document/i);
        // And a message with no token must not touch the library at all.
        const none = await resolveDocTokens('an ordinary message');
        expect(none.sawToken).toBe(false);
        expect(none.notices).toEqual([]);
        // A BARE token — the whole message — must still leave a usable instruction.
        // This is the shape the operator actually pasted on 2026-08-11, and the bug
        // lived one layer ABOVE resolveDocTokens: llm.ts fell back to the original
        // text when `text` came back empty, so the raw "@doc:<slug>" became the
        // prompt's opening line and the auto-router tried to orchestrate it, firing
        // a Tavily search and dumping its error into the reply. The assertion below
        // is what the caller must be able to rely on: an empty `text` plus a real
        // document, so it can substitute an instruction instead of echoing a marker.
        const bare = await resolveDocTokens(token);
        expect(bare.sawToken).toBe(true);
        expect(bare.text.trim()).toBe('');
        expect(bare.context.length).toBeGreaterThan(100);
    }, 120000);
    it('refuses path ingest from the extension origin', async () => {
        if (!live)
            return;
        // The one place the library API touches the DISK by request. The paired
        // extension may add URLs and page text; it must never gain "name a local
        // path, read it back through /api/library/:id" — that is disk access with
        // extra steps. Localhost web origins (the Library page) are the intended
        // callers.
        const r = await extPost('/api/library/path', { path: '/etc/hosts' });
        expect(r.status).toBe(403);
        const { error } = (await r.json());
        expect(error).toMatch(/not available to the extension/i);
    }, 60000);
    it('refuses a near-empty capture rather than filing a stub', async () => {
        if (!live)
            return;
        const r = await extPost('/api/library/text', {
            title: 'Too short', url: 'https://example.test/short', text: 'loading…',
        });
        expect(r.status).toBe(422);
        const { error } = (await r.json());
        expect(error).toMatch(/too little/i);
    }, 120000);
    it('refuses a private-address URL (SSRF)', async () => {
        if (!live)
            return;
        for (const url of ['http://127.0.0.1:8765/health', 'http://169.254.169.254/latest/meta-data']) {
            const r = await extPost('/api/library/url', { url });
            expect(r.status).toBe(422);
            const { error } = (await r.json());
            expect(error).toMatch(/private|loopback/i);
        }
    }, 120000);
});
