/**
 * Document Library — gateway routes (PLAN-DOCUMENT-LIBRARY §3.4, P2).
 *
 * Additive by construction: a new `/library/` page and a new `/api/library/*`
 * namespace. No existing route, page or stylesheet is touched — the same
 * constraint Console Two ships under, and the reason this can land while the
 * shell question (D-3) is still open. `/library/` is a standalone page like
 * `feed.html` and `compare.html` already are, so the classic console can link
 * to it and Console Two can frame it.
 *
 * Four routes:
 *   GET  /api/library            — sources + their state (broken / truncated / un-carded)
 *   GET  /api/library/:id        — one source: card + body, for the viewer
 *   GET  /api/library/:id/raw    — the ORIGINAL file bytes, so a PDF renders in
 *                                  Chrome's own viewer via <iframe #page=N>.
 *                                  We ship no pdf.js: bundle weight and a CSP
 *                                  fight for something the browser does well.
 *   GET  /library/               — the page itself
 *
 * Reads go through `vodou-core` rather than opening memory.db here, so the
 * gateway and the CLI can never disagree about what the library contains.
 */

import type { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { runCore, resolveCoreBin } from './memory-capture.js';
import { getProjectRoot } from '../db.js';
import { daemonRequest } from '../daemon-client.js';
import { slugOf } from '../doc-attach.js';

interface LibrarySource {
  id: number;
  kind: string;
  name: string;
  path: string | null;
  bytes: number | null;
  chunks: number;
  truncated_at_chunk: number | null;
  card_state: string | null;
  card_skipped_reason: string | null;
  watch: boolean;
  inject: boolean;
  last_synced_at: string | null;
  broken_reason: string | null;
}

async function listSources(): Promise<LibrarySource[]> {
  const r = await runCore(['mem', 'library', 'list', '--json'], { timeout: 30_000 });
  if (r.status !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * COHERENCE F13 — attach the `@doc:` token minted by the resolver, so no client
 * has to know the rule. `doc-attach.ts` owns it; everyone else is handed it.
 */
function withSlug<T extends { id: number; name: string }>(src: T): T & { slug: string } {
  return { ...src, slug: slugOf(src.name, src.id) };
}

/**
 * Only ever serve a file the LIBRARY knows about, resolved from the registry —
 * never a path taken from the request. `/api/library/:id/raw` takes an id, not a
 * filename, precisely so this route cannot be walked into an arbitrary read.
 */
function isServable(src: LibrarySource): src is LibrarySource & { path: string } {
  return typeof src.path === 'string' && src.path.length > 0 && fs.existsSync(src.path);
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.epub': 'application/epub+zip',
};

/**
 * Pull the human line and the `id=` tail out of an ingest run.
 *
 * The id is what lets a caller LINK to the document it just filed. Without it
 * the only honest thing a success message can say is "it's in the library
 * somewhere", which makes the user go hunting for their own document.
 */
function parseIngest(stdout: string): { output: string; id: number | null } {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const idLine = lines.find((l) => /^id=\d+$/.test(l));
  const id = idLine ? Number(idLine.slice(3)) : null;
  const output = lines.filter((l) => !/^id=\d+$/.test(l)).join(' ').trim();
  return { output, id };
}

/**
 * Turn a failed `runCore` into something the operator can act on.
 *
 * A bare "ingest failed" is what you get when BOTH streams are empty, and empty
 * streams almost always mean the process was killed rather than that it failed —
 * a watchdog SIGKILL, or the runCore timeout. Reporting that as a generic
 * failure sent an operator hunting for a bug in extraction that never ran.
 */
function ingestError(r: { status: number; stdout: string; stderr: string }): string {
  const detail = (r.stderr || r.stdout || '').trim();
  if (detail) return detail.slice(0, 400);
  // 101 is Rust's panic exit code, and it needs saying: a panic and a kill look
  // identical from here (non-zero status, empty streams) but point at opposite
  // fixes. Calling a panic "probably killed" sent an operator to check timeouts
  // while the real cause was a slice landing mid-character.
  if (r.status === 101) {
    return 'vodou-core PANICKED while ingesting this document (exit 101). This is a bug, ' +
      'not a timeout — the document itself triggered it. Please report it with the page ' +
      'type, and it will reproduce from the CLI with `mem library add-text`.';
  }
  return `vodou-core exited ${r.status} with no output — probably killed ` +
    `(watchdog or timeout). Reproduce from the CLI to see the real error: ` +
    `./vodou-core mem library add-text --title T --url U --text-file F`;
}

export function mountLibrary(app: Express, publicDir: string): void {
  app.get('/api/library', async (_req: Request, res: Response) => {
    res.json({ sources: (await listSources()).map(withSlug) });
  });

  app.get('/api/library/:id(\\d+)', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = (await listSources()).find((s) => s.id === id);
    if (!src) {
      res.status(404).json({ error: 'no such document' });
      return;
    }
    // The card is the routing summary; the body is what the viewer renders. Both
    // come from vodou-core so the UI shows exactly what a model would be given.
    const [cardRes, bodyRes] = await Promise.all([
      runCore(['mem', 'library', 'show', String(id), '--card', '--json'], { timeout: 30_000 }),
      runCore(['mem', 'library', 'show', String(id), '--body', '--json'], { timeout: 60_000 }),
    ]);
    let card: string | null = null;
    let body = '';
    try { card = JSON.parse(cardRes.stdout.trim() || 'null')?.card ?? null; } catch { /* un-carded */ }
    try { body = JSON.parse(bodyRes.stdout.trim() || '{}')?.body ?? ''; } catch { /* empty */ }
    res.json({ source: withSlug(src), card, body });
  });

  /**
   * PLAN-DOCUMENT-LIBRARY §3.7.1 Lane A — "Add to Library" by URL.
   *
   * The extension posts a STRING; localhost fetches and extracts. That is the
   * whole trick: no host permission, no page read, and no second extractor in the
   * extension bundle. It also covers Chrome's built-in PDF viewer, whose contents
   * a content script cannot read anyway.
   *
   * SSRF is guarded in vodou-core (private/loopback refused), not here, so the
   * CLI and this route cannot disagree about what is fetchable.
   */
  app.post('/api/library/url', async (req: Request, res: Response) => {
    const url = String((req.body as { url?: unknown })?.url ?? '').trim();
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const args = ['mem', 'library', 'add-url', url];
    if ((req.body as { inject?: unknown })?.inject) args.push('--inject');
    if ((req.body as { noCards?: unknown })?.noCards) args.push('--no-cards');
    // Generous: fetch + extract + one card call.
    const r = await runCore(args, { timeout: 180_000 });
    if (r.status !== 0) {
      res.status(422).json({ error: ingestError(r) });
      return;
    }
    invalidateMatchCache();
    res.json({ ok: true, ...parseIngest(r.stdout) });
  });

  /**
   * §3.7.1 Lane B — ingest text the gateway cannot fetch itself.
   *
   * Google Docs, Notion and Confluence need the OPERATOR'S session, which
   * localhost does not have. So the extension reads the current tab on a user
   * gesture (`activeTab` — current tab only, no broad grant, no install warning)
   * and posts the text here. This is the only ingest path with no file format.
   */
  app.post('/api/library/text', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { title?: unknown; url?: unknown; text?: unknown; inject?: unknown };
    const title = String(b.title ?? '').trim();
    const url = String(b.url ?? '').trim();
    const text = String(b.text ?? '');
    if (!text.trim()) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    // Hand off via a temp file: page text routinely exceeds what is comfortable
    // on a command line, and argv has a hard size limit.
    const tmp = path.join(os.tmpdir(), `vodou-lane-b-${Date.now()}.txt`);
    try {
      await fs.promises.writeFile(tmp, text, 'utf-8');
      const args = ['mem', 'library', 'add-text', '--title', title || url || 'Untitled page',
                    '--url', url || 'about:blank', '--text-file', tmp];
      if (b.inject) args.push('--inject');
      const r = await runCore(args, { timeout: 180_000 });
      if (r.status !== 0) {
        res.status(422).json({ error: ingestError(r) });
        return;
      }
      invalidateMatchCache();
    res.json({ ok: true, ...parseIngest(r.stdout) });
    } finally {
      fs.promises.unlink(tmp).catch(() => { /* best effort */ });
    }
  });

  /**
   * §3.7.1 Lane C-lite — which documents match what the operator is looking at?
   *
   * Queries the CARD index only (~1 row per document), so it is cheap enough to
   * run whenever the panel is open. Deliberately NOT ambient: full Lane C would
   * need broad host access and a recurring CWS review tax, and the panel being
   * open is already an expression of intent.
   */
  /**
   * Match cache. The panel re-asks on every tab activation, and moving cards to
   * the cross-encoder took a match from ~360ms to 4-6s: `runCore` spawns a fresh
   * process, which loads the ONNX reranker COLD every single time.
   *
   * The structural fix is routing match through the daemon, which already holds
   * these models warm for `mem search` — recorded as a follow-on rather than
   * done here. Until then this makes the common case (returning to a tab you
   * already had open) instant, and bounds the damage to one slow first look per
   * distinct page.
   *
   * Keyed by query+topK, dropped wholesale whenever the library changes, so a
   * freshly added document can never be invisible to a page you already visited.
   */
  const matchCache = new Map<string, unknown[]>();
  const MATCH_CACHE_MAX = 128;
  const invalidateMatchCache = () => matchCache.clear();

  // COHERENCE F39 — "It told me the system was overloaded. I ran one command."
  //
  // The cold fallback below is deliberate: the daemon being down must cost
  // latency, never correctness. But it had no coalescing, no cap and no
  // backoff, and the panel fires this endpoint on every tab activation. So one
  // slow daemon lane became: 15s timeout per request -> a cold `mem library
  // match` process per request, several at once, each loading the embedder and
  // cross-encoder the daemon was already busy with -> the VODOU_MAX_PROCESSES
  // valve saturates -> an unrelated `./do "log: …"` is refused and its work log
  // dropped. Three subsystems, and the only one that spoke blamed the caller.
  //
  // Three bounds, each closing one of those steps:
  const coldInFlight = new Map<string, Promise<Hit[] | null>>();
  let coldRunning = 0;
  const COLD_MAX_CONCURRENT = 1;
  // How long to stop forking after the daemon says it is BUSY. Not a circuit
  // breaker for a dead daemon — `down` still falls back immediately.
  const BUSY_COOLDOWN_MS = 30_000;
  let busyUntil = 0;

  type Hit = { source_id: number; display_name: string; kind: string; score: number; card: string; via?: string; evidence?: string };

  /**
   * One cold match, shared by every concurrent caller asking the same thing.
   * Returns null when the answer is unavailable — which this endpoint already
   * renders as "no match", the sanctioned degradation for a chip documented
   * below as PRECISE OVER COMPLETE. A silent chip costs nothing; a fork storm
   * costs someone else's work log.
   */
  const coldMatch = (cacheKey: string, q: string, topK: number): Promise<Hit[] | null> => {
    const shared = coldInFlight.get(cacheKey);
    if (shared) return shared;
    if (coldRunning >= COLD_MAX_CONCURRENT) {
      console.warn('[library] cold match already running — answering empty rather than forking another');
      return Promise.resolve(null);
    }
    coldRunning += 1;
    const run = (async (): Promise<Hit[] | null> => {
      const r = await runCore(['mem', 'library', 'match', q, '--top-k', String(topK), '--json'], { timeout: 45_000 });
      if (r.status !== 0) return null;
      try {
        return JSON.parse(r.stdout.trim() || '[]') as Hit[];
      } catch {
        return null;
      }
    })().finally(() => {
      coldRunning -= 1;
      coldInFlight.delete(cacheKey);
    });
    coldInFlight.set(cacheKey, run);
    return run;
  };

  app.post('/api/library/match', async (req: Request, res: Response) => {
    const q = String((req.body as { query?: unknown })?.query ?? '').trim();
    if (!q) {
      res.json({ matches: [] });
      return;
    }
    const topK = Math.min(5, Math.max(1, Number((req.body as { topK?: unknown })?.topK ?? 3)));
    const cacheKey = `${topK}\u0000${q}`;
    const cached = matchCache.get(cacheKey);
    if (cached) {
      res.json({ matches: cached, cached: true });
      return;
    }
    // WARM PATH FIRST. The daemon already holds the embedder and cross-encoder
    // in memory; `runCore` spawns a process that loads both cold, which is 6-10s
    // for something the panel fires on every tab activation. Identical results
    // either way -- both call `cards::lookup` -- so this is purely which process
    // pays the model load.
    //
    // The cold path stays as the fallback rather than being replaced: the daemon
    // being down must cost latency, never correctness.
    let hits: Hit[] | null = null;
    // D18a — which process answered is a FACT the response carries, not a guess
    // a test makes from latency. The warm and cold paths return identical rows,
    // so nothing else in the body betrays a silent fall back.
    let servedBy: 'daemon' | 'cli' | 'none' = 'none';
    const warm = await daemonRequest('library_match', { query: q, top_k: topK });
    if (warm.ok) {
      servedBy = 'daemon';
      const m = (warm.data as { matches?: unknown })?.matches;
      if (Array.isArray(m)) hits = m as Hit[];
    } else if (warm.kind === 'busy') {
      // F39's core distinction. The daemon is ALIVE and slow — forking a cold
      // matcher would load the very models it is busy with. Back off instead,
      // and say which it is, because "busy" and "down" need opposite responses.
      busyUntil = Date.now() + BUSY_COOLDOWN_MS;
      console.warn(
        `[library] daemon busy (${warm.reason}) — NOT falling back to CLI; `
        + `a cold matcher would add load to the lane that is already slow. `
        + `Answering empty for up to ${BUSY_COOLDOWN_MS / 1000}s.`,
      );
    } else {
      // Logged, not swallowed: "daemon is down" and "the warm path is broken"
      // look identical from here and need different fixes.
      console.warn(`[library] warm match unavailable (${warm.reason}) — falling back to CLI`);
    }

    if (hits === null && warm.kind !== 'busy' && Date.now() >= busyUntil) {
      hits = await coldMatch(cacheKey, q, topK);
      if (hits !== null) servedBy = 'cli';
    }
    if (hits === null) {
      res.json({ matches: [], served_by: servedBy, reason: warm.ok ? undefined : warm.reason });
      return;
    }

    try {
      // Floor CALIBRATED against a 22-query labelled set (8 relevant / 14 noise,
      // including deliberate lexical collisions), re-measured 2026-08-10 AFTER
      // cards moved to cross-encoder scoring. Bi-encoder cosine could not do
      // this job at any threshold — its two populations overlapped outright
      // (relevant 0.553-0.845, noise 0.455-0.686), and "Sourdough Starter
      // Recipe" outscored a genuine contract query. The cross-encoder collapses
      // every noise query to ~0.000, including all three planted collisions
      // ("Getting Started with React", "Starter home mortgage rates").
      //
      // Remaining population edges:  relevant hits 0.838-0.994
      //                              worst noise   0.627  ("Google Docs" on a
      //                                                    stored Google Doc)
      // 0.70 sits in that gap with real headroom rather than shaving the 0.627
      // leak by a thousandth, which would be fitting the sample, not the task.
      // Result: 0 false positives, and the correct document every time it fires.
      //
      // This is deliberately PRECISE OVER COMPLETE. Queries about a document's
      // interior (a specific clause, a job history) score low and stay silent,
      // because an ambient chip that lights up on ordinary browsing is ignored
      // inside a week, while a silent one costs nothing. Recall is recoverable
      // later by improving card `what` lines — the MSA's opens with provenance
      // boilerplate, which measurably dilutes the pair.
      const floor = Number(process.env.VODOU_LIBRARY_MATCH_FLOOR ?? 0.70);
      // TWO LANES, TWO SCALES — never one floor for both.
      //
      // `subject` ("this page is ABOUT the document") is a cross-encoder
      // probability. `topic` ("the document DISCUSSES this") is a raw cosine,
      // already floored inside vodou-core at 0.50 against populations documented
      // on SearchResult::raw_vector_sim (relevant 0.4-0.6, noise 0.1-0.2).
      // Applying the subject floor to a topic score would discard the entire
      // lane; applying the topic floor to a subject score would readmit the
      // sourdough false positive. So each lane is trusted on its own terms.
      const matches = hits
          .filter((h) => h.via === 'topic' || (h.score ?? 0) >= floor)
          .map((h) => ({
            id: h.source_id,
            name: h.display_name,
            kind: h.kind,
            // COHERENCE F13 — the `@doc:` token travels WITH the row. The panel
            // used to derive it from `name`, which made this route and the
            // resolver two deciders of one string.
            slug: slugOf(h.display_name, h.source_id),
            score: h.score,
            via: h.via ?? 'subject',
            // Say WHY, in the document's own words. A topic hit cites the
            // passage that matched ("12. Limitation of Liability"); a subject
            // hit shows the card's `what`. Either way the reader can check the
            // claim instead of taking the panel's word for it.
            why: h.via === 'topic'
              ? `mentions: ${h.evidence ?? ''}`.slice(0, 180)
              : (h.card.split('\nwhat: ')[1] ?? '').split('\n')[0].slice(0, 180),
          }));
      if (matchCache.size >= MATCH_CACHE_MAX) {
        matchCache.delete(matchCache.keys().next().value as string);
      }
      matchCache.set(cacheKey, matches);
      res.json({ matches, served_by: servedBy });
    } catch {
      res.json({ matches: [], served_by: servedBy });
    }
  });

  /**
   * §3.4 — ingest a LOCAL path from the Library page.
   *
   * One ingest at a time, detached, polled. A directory add embeds every chunk
   * and a real folder takes minutes to hours (PLANS: 643 files ≈ 3.5h measured),
   * so holding an HTTP request open is not an option; the CLI process is
   * spawned detached with its output teed to a log, and `GET /api/library/ingest`
   * serves progress. One at a time because two concurrent adds fight over the
   * memory.db write lock — the exact collision that produced transient
   * "indexing failed" errors when the daemon raced a manual add (2026-08-11).
   *
   * SECURITY — the extension origin is refused here on purpose. The paired
   * extension can add URLs and page text, but it CANNOT read the user's disk,
   * and an ingest-by-path route reachable from `chrome-extension://` would
   * quietly grant it that: name a path, then read the file back through
   * `/api/library/:id`. This route exists for the Library page (a localhost
   * web origin) and the CLI already covers everything else. A local process
   * gains nothing here — it can run `mem library add` itself.
   */
  let ingest: {
    path: string; startedAt: number; done: boolean;
    exitCode: number | null; tail: string[]; summary: string;
  } | null = null;

  /**
   * GET /api/library/browse?path=<abs> — directory listing for the file picker.
   *
   * A browser cannot hand a web page an absolute path: `<input type="file">`
   * yields bytes, never a location. The ingest lane works on server-side paths
   * (`mem library add <abs>`), so the picker has to be served from this side.
   *
   * NOT jailed — the whole filesystem is browsable, by product decision: a user
   * adds documents from wherever they keep them (an external drive, /opt, a repo
   * outside $HOME), and a picker that cannot reach them is worse than the text
   * box beside it. `/api/library/path` has always accepted any absolute path, so
   * jailing only the BROWSER never removed a capability — it just made the
   * discoverable route weaker than the typed one.
   *
   * What actually bounds this is the gateway itself, not this handler: it binds
   * to 127.0.0.1, CORS is locked to localhost, and a Host-header guard rejects
   * DNS-rebinding (index.ts ~1055) — which is the attack that would otherwise
   * let a website read directory listings off this port.
   *
   * Starts at $HOME because that is where the documents usually are; `..` and
   * absolute paths go anywhere. Unreadable directories still 403 — that is the
   * OS answering, which is the correct authority for "may this user read it".
   */
  app.get('/api/library/browse', (req: Request, res: Response) => {
    const home = os.homedir();
    let p = String((req.query as { path?: unknown }).path ?? '').trim() || home;
    if (p.startsWith('~/')) p = path.join(home, p.slice(2));
    if (!path.isAbsolute(p)) p = path.join(home, p);

    // Resolve symlinks so the reported path is the real one and `..` collapses.
    let real: string;
    try {
      real = fs.realpathSync(p);
    } catch {
      res.status(404).json({ error: `no such directory: ${p}` });
      return;
    }
    let st: fs.Stats;
    try { st = fs.statSync(real); } catch { res.status(404).json({ error: 'not found' }); return; }
    if (!st.isDirectory()) { res.status(400).json({ error: 'not a directory' }); return; }

    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(real, { withFileTypes: true }); }
    catch { res.status(403).json({ error: 'cannot read that directory' }); return; }

    // Hidden entries are noise by default, but outside $HOME they are sometimes
    // the whole point (a dot-directory holding notes, a hidden mount), so the
    // picker can ask for them.
    const showHidden = String((req.query as { hidden?: unknown }).hidden ?? '') === '1';
    const items = entries
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(real, e.name);
        let size = 0;
        let dir = e.isDirectory();
        if (e.isSymbolicLink()) {
          // Report what the link POINTS AT, so the row is honest.
          try { const s = fs.statSync(full); dir = s.isDirectory(); size = s.size; } catch { return null; }
        } else if (!dir) {
          try { size = fs.statSync(full).size; } catch { /* unreadable — show it at 0 */ }
        }
        return { name: e.name, path: full, isDir: dir, size };
      })
      .filter(Boolean) as Array<{ name: string; path: string; isDir: boolean; size: number }>;

    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    // Only the filesystem root has no parent now. `home` still rides along so
    // the UI can offer a jump back without hardcoding a path.
    const parent = real === path.parse(real).root ? null : path.dirname(real);
    const realHome = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
    res.json({ path: real, parent, home: realHome, entries: items });
  });

  /**
   * POST /api/library/mkdir — create ONE directory inside an existing one.
   *
   * Lives beside /browse because it is the same capability: picker support for
   * a UI that must name a server-side path. Both are used by the Library page
   * and by the Projects dialog — a new project usually wants a new folder, and
   * making the user leave for a terminal to create it is the same dead end the
   * browse endpoint exists to remove.
   *
   * Bounded exactly like /browse, and by the same things: the gateway binds
   * 127.0.0.1, CORS is localhost-only, and the Host-header guard rejects
   * DNS-rebinding. This one WRITES, so it is stricter in two ways that cost the
   * user nothing:
   *
   *   - `name` must be a single path segment. No separators, no "." or "..",
   *     so the result is always a direct child of a directory the user is
   *     looking at. A path typed into the name box cannot climb anywhere.
   *   - mkdir is NOT recursive. "a/b/c" is rejected by the segment rule rather
   *     than quietly materialising three levels from a typo.
   *
   * Creating something that already exists is not an error when it is already a
   * directory — the user asked for a folder to exist and it does. `existed`
   * tells the caller which happened so the UI can say so.
   */
  app.post('/api/library/mkdir', (req: Request, res: Response) => {
    const body = req.body as { parent?: unknown; name?: unknown };
    const parentRaw = String(body?.parent ?? '').trim();
    const name = String(body?.name ?? '').trim();
    if (!parentRaw || !name) { res.status(400).json({ error: 'parent and name are required' }); return; }

    // One segment, and nothing that can traverse or hit a reserved name.
    if (name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
      res.status(400).json({ error: 'name must be a single folder name, not a path' });
      return;
    }

    const home = os.homedir();
    let p = parentRaw;
    if (p.startsWith('~/')) p = path.join(home, p.slice(2));
    if (!path.isAbsolute(p)) p = path.join(home, p);

    let realParent: string;
    try { realParent = fs.realpathSync(p); }
    catch { res.status(404).json({ error: `no such directory: ${p}` }); return; }
    try {
      if (!fs.statSync(realParent).isDirectory()) { res.status(400).json({ error: 'parent is not a directory' }); return; }
    } catch { res.status(404).json({ error: 'parent not found' }); return; }

    const full = path.join(realParent, name);
    // Belt to the segment check's braces: whatever `name` was, the result has
    // to sit directly inside the directory the user was browsing.
    if (path.dirname(full) !== realParent) { res.status(400).json({ error: 'refusing to create outside that folder' }); return; }

    if (fs.existsSync(full)) {
      let isDir = false;
      try { isDir = fs.statSync(full).isDirectory(); } catch { /* treat as conflict */ }
      if (isDir) { res.json({ path: full, existed: true }); return; }
      res.status(409).json({ error: 'a file with that name is already there' });
      return;
    }

    try {
      fs.mkdirSync(full);
    } catch (e) {
      // EACCES/EROFS/ENOSPC — the OS is the right authority for "may this user
      // write here", same as /browse defers to it for reads.
      res.status(403).json({ error: `cannot create that folder: ${(e as Error).message}` });
      return;
    }
    res.json({ path: full, existed: false });
  });

  /**
   * POST /api/library/inbox — durable landing spot for a drop that carried only
   * bytes.
   *
   * Deliberately NOT /api/files/upload, which writes to /tmp. That is right for
   * a chat attachment and wrong here: the library indexes a path and re-reads it
   * on every re-scan, so a /tmp source turns into a "broken" row the first time
   * the OS cleans up. This writes under the project so the row keeps resolving.
   *
   * Prefer a real path when the drop supplies one — an in-place source tracks
   * edits to the user's actual file. This is the fallback, not the happy path.
   */
  app.post('/api/library/inbox', (req: Request, res: Response) => {
    const body = req.body as { name?: unknown; data?: unknown; rel?: unknown };
    const name = String(body?.name ?? '').trim();
    const data = String(body?.data ?? '');
    if (!name || !data) { res.status(400).json({ error: 'name and data are required' }); return; }
    const m = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) { res.status(400).json({ error: 'invalid data URI' }); return; }

    const root = path.join(getProjectRoot(), '.vodou', 'library-inbox');

    // `rel` carries the path a file had INSIDE a dropped folder, so a dropped
    // tree lands as a tree rather than a flattened pile — the folder is the unit
    // the user chose, and its shape is part of what they dropped.
    //
    // Every segment is sanitized independently and anything that could climb out
    // (empty, ".", "..", absolute) is dropped. This is the one place in the
    // library that writes attacker-influenced names to disk.
    const rel = String(body?.rel ?? '');
    const segs = rel.split('/')
      .filter((s) => s && s !== '.' && s !== '..')
      .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_'))
      .filter(Boolean);
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'dropped';
    const dir = segs.length ? path.join(root, ...segs) : root;

    // Belt and braces: even after per-segment scrubbing, refuse anything that
    // does not resolve inside the inbox.
    const dest = path.join(dir, safeName);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      res.status(400).json({ error: 'refusing to write outside the inbox' });
      return;
    }
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { res.status(500).json({ error: `cannot create inbox: ${(e as Error).message}` }); return; }
    try { fs.writeFileSync(dest, Buffer.from(m[2], 'base64')); }
    catch (e) { res.status(500).json({ error: `cannot write: ${(e as Error).message}` }); return; }

    // Tell the caller the FOLDER to ingest when this was part of a tree, so the
    // client does not have to reassemble it.
    res.json({ path: dest, root: segs.length ? path.join(root, segs[0]) : dest, copied: true });
  });

  app.post('/api/library/path', (req: Request, res: Response) => {
    const origin = String(req.headers.origin ?? '');
    if (origin.startsWith('chrome-extension://')) {
      res.status(403).json({ error: 'path ingest is not available to the extension — it has no disk access by design' });
      return;
    }
    if (ingest && !ingest.done) {
      res.status(409).json({ error: `an ingest of ${ingest.path} is already running`, running: ingest.path });
      return;
    }
    let p = String((req.body as { path?: unknown })?.path ?? '').trim();
    if (!p) { res.status(400).json({ error: 'path is required' }); return; }
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    if (!path.isAbsolute(p)) p = path.join(getProjectRoot(), p);
    if (!fs.existsSync(p)) { res.status(404).json({ error: `no such file or directory: ${p}` }); return; }

    const recursive = !!(req.body as { recursive?: unknown })?.recursive;
    const noCards = (req.body as { noCards?: unknown })?.noCards !== false; // default true: cards are a separate, LLM-priced step
    const args = ['mem', 'library', 'add', p];
    if (recursive) args.push('--recursive');
    if (noCards) args.push('--no-cards');

    const job: NonNullable<typeof ingest> = {
      path: p, startedAt: Date.now(), done: false, exitCode: null, tail: [], summary: '',
    };
    ingest = job;
    const child = spawn(resolveCoreBin(), args, {
      cwd: getProjectRoot(), detached: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const feed = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        const l = line.trim();
        if (!l) continue;
        job.tail.push(l);
        if (job.tail.length > 30) job.tail.shift();
        if (/ingested/.test(l)) job.summary = l;
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('close', (code) => {
      job.done = true;
      job.exitCode = code ?? -1;
      // New documents exist; cached match answers do not know about them.
      invalidateMatchCache();
    });
    child.on('error', (e) => {
      job.done = true;
      job.exitCode = -1;
      job.tail.push(`spawn failed: ${String((e as Error).message ?? e)}`);
    });
    res.json({ started: true, path: p, recursive, noCards });
  });

  /** Progress for the one running (or last finished) path ingest. */
  app.get('/api/library/ingest', (_req: Request, res: Response) => {
    if (!ingest) { res.json({ idle: true }); return; }
    res.json({
      idle: false,
      path: ingest.path,
      done: ingest.done,
      exitCode: ingest.exitCode,
      seconds: Math.round((Date.now() - ingest.startedAt) / 1000),
      summary: ingest.summary,
      tail: ingest.tail.slice(-6),
    });
  });

  /** Surgical removal — this source's chunks, watermark and row. Nothing else. */
  app.delete('/api/library/:id(\\d+)', async (req: Request, res: Response) => {
    const r = await runCore(['mem', 'library', 'remove', String(Number(req.params.id))], { timeout: 60_000 });
    if (r.status !== 0) {
      res.status(422).json({ error: ingestError(r) });
      return;
    }
    invalidateMatchCache();
    res.json({ ok: true });
  });

  app.get('/api/library/:id(\\d+)/raw', async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const src = (await listSources()).find((s) => s.id === id);
    if (!src || !isServable(src)) {
      res.status(404).send('document file is not available');
      return;
    }
    const ext = path.extname(src.path).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    // inline so the PDF renders in the browser's viewer rather than downloading.
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(src.path).replace(/"/g, '')}"`);
    fs.createReadStream(src.path).pipe(res);
  });

  // The page. Served explicitly (not via express.static's directory index) so
  // `/library` and `/library/` both work.
  const page = path.join(publicDir, 'library', 'index.html');
  app.get(['/library', '/library/'], (_req: Request, res: Response) => {
    if (!fs.existsSync(page)) {
      res.status(404).send('library page not built');
      return;
    }
    res.sendFile(page);
  });
}
