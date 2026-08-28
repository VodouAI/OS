/**
 * page-match — "what do I know about the page I'm on?"
 *
 * PLAN-MEMORY-ON-EVERY-PAGE P1. Mirrors `library.ts`'s endpoint shape on purpose
 * (LRU cache, daemon warm path, extension-origin admission) because the panel
 * calls this on every tab activation and the two lanes should behave alike.
 *
 * Tiers, each capped, each a different KIND of claim:
 *   T1 `page`  — memories stamped with this exact page. A fact, not a guess.
 *   T2 `site`  — memories from elsewhere on the same host. Also a fact.
 *   T3 `about` — the existing semantic/library lane, left to /api/library/match.
 *
 * T1/T2 are deliberately NOT semantic. Provenance is recorded, so answering it
 * with a similarity score would downgrade a fact into an opinion — and the panel
 * would then show "from this page" rows that were never on this page.
 */

import { Router, Request, Response } from 'express';
import net from 'node:net';
import path from 'node:path';
import { getProjectRoot } from '../db.js';
import { normalizeUrl } from '../page-id.js';
import { runCore } from './memory-capture.js';
import { getSiteMode, setSiteMode, listSiteModes, SITE_MODES, type SiteMode } from '../page-site-mode.js';
import { slugOf } from '../doc-attach.js';

export const pageMatchRouter = Router();

const CACHE_MS = 30_000;
const CACHE_MAX = 200;
const _cache = new Map<string, { at: number; body: unknown }>();

function cacheGet(k: string): unknown | null {
  const hit = _cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    _cache.delete(k);
    return null;
  }
  return hit.body;
}

/** Drop every cached answer for one page key — a write to that page (note,
 *  link) must show up on the next panel refresh, not 30 s later. */
function cacheDropPage(pageKey: string): void {
  for (const k of [..._cache.keys()]) if (k.startsWith(pageKey + '|')) _cache.delete(k);
}

function cacheSet(k: string, body: unknown): void {
  if (_cache.size >= CACHE_MAX) {
    // Cheapest sane eviction: drop the oldest insertion. A page-match cache does
    // not need true LRU, and a heap here would cost more than the misses.
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(k, { at: Date.now(), body });
}

/** Generic daemon command over the unix socket. Returns null on any failure. */
export function askDaemonCmd(cmd: string, payload: unknown, timeoutMs = 2500): Promise<any | null> {
  return new Promise((resolve) => {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    let settled = false;
    const done = (v: any | null) => { if (settled) return; settled = true; try { client.destroy(); } catch { /* ignore */ } resolve(v); };
    let buf = '';
    const client = net.createConnection(sockPath, () => { client.write(JSON.stringify({ cmd, payload }) + '\n'); });
    client.setTimeout(timeoutMs, () => done(null));
    client.on('data', (d) => { buf += d.toString('utf8'); const nl = buf.indexOf('\n'); if (nl < 0) return; try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); } });
    client.on('error', () => done(null));
    client.on('close', () => done(null));
  });
}

/** Ask the warm daemon. Returns null on any failure so the caller can degrade.
 *  Exported for vbb/page-probe.ts (the badge lane) so both use ONE socket path
 *  and ONE payload shape. */
export function askDaemon(url: string, topK: number, timeoutMs = 2500): Promise<any | null> {
  return new Promise((resolve) => {
    const sockPath = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
    let settled = false;
    const done = (v: any | null) => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    let buf = '';
    const client = net.createConnection(sockPath, () => {
      client.write(JSON.stringify({ cmd: 'page_match', payload: { url, top_k: topK } }) + '\n');
    });
    client.setTimeout(timeoutMs, () => done(null));
    client.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try { done(JSON.parse(buf.slice(0, nl))); } catch { done(null); }
    });
    client.on('error', () => done(null));
    client.on('close', () => done(null));
  });
}

// ── POST /api/page-match { url, topK } ───────────────────────────────────────
pageMatchRouter.post('/', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const topK = Math.min(Math.max(Number(req.body?.topK) || 10, 1), 50);

  const pid = normalizeUrl(url);
  if (!pid) {
    // Not an error the caller can fix, and not worth a 4xx: the panel asks about
    // whatever tab is focused, including chrome:// and file://. Empty is the
    // honest answer.
    res.json({ ok: true, pageKey: null, host: null, page: [], site: [], reason: 'not an http(s) page' });
    return;
  }

  // P4 — per-site mode. 'off' means Vodou does not look at this site: answer
  // empty WITHOUT asking the daemon (and without caching), and say why.
  const verdict = getSiteMode(pid.host);
  if (verdict.mode === 'off') {
    res.json({ ok: true, pageKey: pid.pageKey, host: pid.host, page: [], site: [], docs: [], siteDocs: [], mode: 'off', modeSource: verdict.source });
    return;
  }

  const ck = `${pid.pageKey}|${topK}`;
  const cached = cacheGet(ck);
  if (cached) {
    res.json({ ...(cached as object), cached: true, mode: verdict.mode, modeSource: verdict.source });
    return;
  }

  const d = await askDaemon(url, topK);
  if (!d || d.ok !== true) {
    // Degrade to empty rather than 500: a panel section that says "nothing here"
    // is recoverable; one that errors on every tab switch is not. The daemon
    // being down is already surfaced by /health.
    res.json({
      ok: true, pageKey: pid.pageKey, host: pid.host, page: [], site: [], docs: [], siteDocs: [],
      degraded: true, reason: 'daemon unavailable', mode: verdict.mode, modeSource: verdict.source,
    });
    return;
  }

  const body = {
    ok: true,
    pageKey: d.page_key ?? pid.pageKey,
    host: d.host ?? pid.host,
    // `at` is naive UTC (PLAN-TIME-CANON) and is passed through UNCHANGED. The
    // client appends the 'Z' before parsing; doing it here would invent a
    // timezone in a payload other callers also read.
    page: (d.page ?? []).map((r: any) => ({ id: r.chunk_id, text: r.text, path: r.path, at: r.created_at ?? null })),
    site: (d.site ?? []).map((r: any) => ({ id: r.chunk_id, text: r.text, path: r.path, at: r.created_at ?? null })),
    // Library documents saved FROM this page / site — one row per document.
    // Their chunks are deliberately absent from `page`/`site` (a 111-chunk
    // article flooded the fact tier on 2026-08-17); the panel renders each as
    // a document with an `@doc:` token, the same as the library-match lane.
    // `slug` is minted by the resolver (COHERENCE F13): the panel pastes the
    // token it was handed rather than deriving one, so a document cannot end up
    // with a different token depending on which surface produced it.
    docs: (d.docs ?? []).map((x: any) => ({ id: x.id, name: x.name, kind: x.kind, slug: slugOf(x.name, x.id), chunks: x.chunk_count ?? 0, at: x.created_at ?? null })),
    siteDocs: (d.site_docs ?? []).map((x: any) => ({ id: x.id, name: x.name, kind: x.kind, slug: slugOf(x.name, x.id), chunks: x.chunk_count ?? 0, at: x.created_at ?? null })),
  };
  cacheSet(ck, body);
  // mode is NOT cached with the body: a user can flip it between two reads.
  res.json({ ...body, mode: verdict.mode, modeSource: verdict.source });
});

// ── PLAN-MEMORY-ON-EVERY-PAGE P2 — write lanes ──────────────────────────────
//
// Both are USER GESTURES in the panel (a typed note, a clicked 📎). They go
// through the CLI rather than the daemon socket because `mem store` is the one
// choke point every "remember this" caller funnels through (tool-fiction
// guard, sanitizer, daily-log write, sync) — a second writer here would be a
// second place for that discipline to drift.

/** POST /api/page-match/note {url, text} — a note ABOUT the page you're on. */
pageMatchRouter.post('/note', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const pid = normalizeUrl(url);
  if (!pid) { res.status(400).json({ ok: false, error: 'not an http(s) page' }); return; }
  if (text.length < 3) { res.status(400).json({ ok: false, error: 'note is empty' }); return; }
  if (text.length > 4000) { res.status(400).json({ ok: false, error: 'note is too long (4000 chars max)' }); return; }
  const v = getSiteMode(pid.host);
  if (v.mode !== 'collect') {
    res.status(403).json({ ok: false, error: v.mode === 'off' ? `page memory is off for ${pid.host}` : `page memory is suggest-only for ${pid.host} — switch it to "suggest + collect" to save notes here`, mode: v.mode });
    return;
  }
  const r = await runCore(['mem', 'store', text, '--url', url, '--json'], { timeout: 30_000 });
  let out: any = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
  if (r.status !== 0 || !out || out.ok !== true) {
    // Say what the guard said (tool-fiction, empty after sanitize) — the panel
    // shows it verbatim; "failed" alone would send the user to retry blindly.
    const why = (out && out.error) || (r.stderr || '').trim().split('\n').pop() || `vodou-core exit ${r.status}`;
    res.status(422).json({ ok: false, error: String(why).slice(0, 300) });
    return;
  }
  cacheDropPage(pid.pageKey);
  res.json({ ok: true, pageKey: pid.pageKey, host: pid.host, path: out.path ?? null });
});

/** POST /api/page-match/link {url, chunkId} — stamp an existing memory with the page. */
pageMatchRouter.post('/link', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const chunkId = typeof req.body?.chunkId === 'string' ? req.body.chunkId.trim() : '';
  const pid = normalizeUrl(url);
  if (!pid) { res.status(400).json({ ok: false, error: 'not an http(s) page' }); return; }
  if (!chunkId || chunkId.length > 300) { res.status(400).json({ ok: false, error: 'chunkId is required' }); return; }
  const v = getSiteMode(pid.host);
  if (v.mode !== 'collect') {
    res.status(403).json({ ok: false, error: v.mode === 'off' ? `page memory is off for ${pid.host}` : `page memory is suggest-only for ${pid.host}`, mode: v.mode });
    return;
  }
  const r = await runCore(['mem', 'page-link', chunkId, '--url', url, '--json'], { timeout: 20_000 });
  let out: any = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
  if (r.status !== 0 || !out) {
    res.status(500).json({ ok: false, error: (r.stderr || `vodou-core exit ${r.status}`).slice(0, 300) });
    return;
  }
  if (out.ok !== true) { res.status(404).json({ ok: false, error: 'no memory with that id' }); return; }
  cacheDropPage(pid.pageKey);
  res.json({ ok: true, chunkId, pageKey: pid.pageKey, host: pid.host });
});

// ── P4 — per-site mode + forget ────────────────────────────────────────────

/** GET /api/page-match/site-mode?url=…|host=… → the resolved verdict for one host. */
pageMatchRouter.get('/site-mode', (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  let host = typeof req.query.host === 'string' ? req.query.host : '';
  if (!host && url) { const pid = normalizeUrl(url); host = pid ? pid.host : ''; }
  if (!host) { res.status(400).json({ ok: false, error: 'url or host is required' }); return; }
  res.json({ ok: true, ...getSiteMode(host) });
});

/** PUT /api/page-match/site-mode {url|host, mode: off|suggest|collect|null} — a user rule (null clears it). */
pageMatchRouter.put('/site-mode', (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  let host = typeof req.body?.host === 'string' ? req.body.host : '';
  if (!host && url) { const pid = normalizeUrl(url); host = pid ? pid.host : ''; }
  const modeRaw = req.body?.mode;
  const mode: SiteMode | null = modeRaw === null || modeRaw === '' ? null : modeRaw;
  if (!host) { res.status(400).json({ ok: false, error: 'url or host is required' }); return; }
  if (mode !== null && !SITE_MODES.includes(mode as SiteMode)) { res.status(400).json({ ok: false, error: 'mode must be off | suggest | collect | null' }); return; }
  try {
    const v = setSiteMode(host, mode);
    // A mode change must show on the next read — drop the whole page cache
    // (30 s TTL, ≤200 entries; a rule flip is rare and cheap to pay for).
    _cache.clear();
    res.json({ ok: true, ...v });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/** GET /api/page-match/site-modes → every user rule. */
pageMatchRouter.get('/site-modes', (_req: Request, res: Response) => {
  res.json({ ok: true, rules: listSiteModes() });
});

/** POST /api/page-match/forget-host {host|url, dryRun?, undo?} → `mem forget --host` (soft; invalid_at). */
pageMatchRouter.post('/forget-host', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  let host = typeof req.body?.host === 'string' ? req.body.host : '';
  if (!host && url) { const pid = normalizeUrl(url); host = pid ? pid.host : ''; }
  host = String(host || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) { res.status(400).json({ ok: false, error: 'host is required' }); return; }
  const args = ['mem', 'forget', '--host', host, '--json'];
  if (req.body?.dryRun) args.push('--dry-run');
  if (req.body?.undo) args.push('--undo');
  const r = await runCore(args, { timeout: 30_000 });
  let out: any = null;
  try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
  if (r.status !== 0 || !out || out.ok !== true) {
    res.status(500).json({ ok: false, error: (out && out.error) || (r.stderr || `vodou-core exit ${r.status}`).slice(0, 300) });
    return;
  }
  _cache.clear();
  res.json({ ok: true, host, dryRun: !!req.body?.dryRun, undo: !!req.body?.undo, chunksMatched: out.chunks_matched ?? 0, chunksUpdated: out.chunks_updated ?? 0, libraryDocuments: out.library_documents_from_host ?? 0 });
});

// ── P6 — Page Actions: fill from memory + learn-back ───────────────────────

/** POST /api/page-match/fill-plan {url, title, fields[]} → proposals. Read-only.
 *  The form MODEL (labels, names, types, options — never values of password /
 *  payment / one-time-code fields, which the extension strips and the core
 *  drops again) is the only page content that travels, on the user's gesture,
 *  to the local core. Allowed unless the site is `off`. */
pageMatchRouter.post('/fill-plan', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 300) : '';
  const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
  const pid = normalizeUrl(url);
  if (!pid) { res.status(400).json({ ok: false, error: 'not an http(s) page' }); return; }
  if (!fields.length) { res.status(400).json({ ok: false, error: 'no fields' }); return; }
  const v = getSiteMode(pid.host);
  if (v.mode === 'off') { res.status(403).json({ ok: false, error: `page memory is off for ${pid.host}`, mode: v.mode }); return; }
  const clean = fields.slice(0, 60).map((f: any) => ({
    id: String(f?.id ?? '').slice(0, 120),
    label: String(f?.label ?? '').slice(0, 200),
    name: String(f?.name ?? '').slice(0, 120),
    type: String(f?.type ?? '').slice(0, 40),
    autocomplete: String(f?.autocomplete ?? '').slice(0, 60),
    placeholder: String(f?.placeholder ?? '').slice(0, 200),
    required: !!f?.required,
    value: '',                                   // current values never leave the page
    options: Array.isArray(f?.options) ? f.options.slice(0, 60).map((o: any) => String(o).slice(0, 120)) : [],
    multiline: !!f?.multiline,
  })).filter((f: any) => f.id);
  const reqBody = { url, title, fields: clean, no_llm: !!req.body?.noLlm };
  // Warm daemon first (models loaded; sub-second for the instant phase), CLI as
  // the cold fallback. Phase 2 may take the provider's latency: long timeout.
  let out: any = await askDaemonCmd('page_fill_plan', reqBody, req.body?.noLlm ? 15_000 : 90_000);
  let via = 'daemon';
  if (!out || out.ok !== true) {
    via = 'cli';
    const args = ['mem', 'fill-plan', '--stdin-json'];
    if (req.body?.noLlm) args.push('--no-llm');
    const r = await runCore(args, { input: JSON.stringify(reqBody), timeout: 90_000 });
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
    if (r.status !== 0 || !out || out.ok !== true) {
      res.status(500).json({ ok: false, error: (out && out.llm_note) || (r.stderr || `vodou-core exit ${r.status}`).slice(0, 300) });
      return;
    }
  }
  console.log(`[fill-plan] ${pid.host} via ${via} · ${(out.proposals || []).length} proposals · askedLlm=${out.asked_llm ?? 0}${reqBody.no_llm ? ' (instant)' : ''}`);
  res.json({
    ok: true, pageKey: out.page_key, host: out.host, mode: v.mode,
    proposals: (out.proposals || []).map((p: any) => ({ id: p.id, value: p.value, confidence: p.confidence, kind: p.kind, sourceId: p.source_id ?? null, source: p.source ?? null })),
    askedLlm: out.asked_llm ?? 0, note: out.llm_note ?? null,
  });
});

/** POST /api/page-match/learn {url, answers:[{label, value}]} — remember accepted
 *  answers on this page (learn-back). Requires `collect`. Each becomes a
 *  page-stamped [PREF] fact via `mem store --url`, in the exact bullet shape
 *  the planner parses back. */
pageMatchRouter.post('/learn', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const pid = normalizeUrl(url);
  if (!pid) { res.status(400).json({ ok: false, error: 'not an http(s) page' }); return; }
  const v = getSiteMode(pid.host);
  if (v.mode !== 'collect') { res.status(403).json({ ok: false, error: `page memory is ${v.mode === 'off' ? 'off' : 'suggest-only'} for ${pid.host}`, mode: v.mode }); return; }
  // Dedupe against what this page already knows: an identical label+value is
  // skipped (a second fill of the same form stored every answer twice on
  // 2026-08-17); a changed value IS stored — the planner prefers the latest.
  const known = new Set<string>();
  try {
    const d = await askDaemon(url, 200);
    for (const r of (d && d.ok === true && Array.isArray(d.page)) ? d.page : []) {
      const t = String((r as any).text || '').replace(/^-\s*/, '').replace(/^.*?\|\s*/, '').replace(/^\[[A-Z_]+\]\s*/, '');
      const m = /^Form answer on [^—]+ — (.+?): (.*)$/.exec(t.trim());
      if (m) known.add(m[1].trim().toLowerCase() + '\u0000' + m[2].trim());
    }
  } catch { /* dedupe is best-effort */ }
  let stored = 0; let skipped = 0; const errors: string[] = [];
  for (const a of answers.slice(0, 20)) {
    const label = String(a?.label ?? '').trim().slice(0, 120);
    const value = String(a?.value ?? '').trim().slice(0, 500);
    if (!label || !value) continue;
    if (known.has(label.toLowerCase() + '\u0000' + value)) { skipped++; continue; }
    const text = `Form answer on ${pid.host} — ${label}: ${value}`;
    const r = await runCore(['mem', 'store', text, '--tag', 'PREF', '--url', url, '--json'], { timeout: 30_000 });
    let out: any = null;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
    if (r.status === 0 && out && out.ok === true) stored++;
    else errors.push(`${label}: ${(out && out.error) || (r.stderr || '').trim().split('\n').pop() || 'store failed'}`.slice(0, 200));
  }
  cacheDropPage(pid.pageKey);
  res.json({ ok: true, stored, skipped, errors });
});

/** POST /api/page-match/correct {url, fixes:[{chunkId, right, wrong?}]} — P6b: the user edited a
 *  memory-backed proposal AND asked to fix the source: `mem correct "<right>" --chunk-id <id>`
 *  (soft supersession — the old fact is hidden, not deleted). An explicit user action; requires
 *  only that the site is not `off`. */
pageMatchRouter.post('/correct', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const fixes = Array.isArray(req.body?.fixes) ? req.body.fixes : [];
  const pid = normalizeUrl(url);
  if (!pid) { res.status(400).json({ ok: false, error: 'not an http(s) page' }); return; }
  if (getSiteMode(pid.host).mode === 'off') { res.status(403).json({ ok: false, error: `page memory is off for ${pid.host}` }); return; }
  let corrected = 0; const errors: string[] = [];
  for (const f of fixes.slice(0, 10)) {
    const chunkId = String(f?.chunkId ?? '').trim().slice(0, 300);
    const right = String(f?.right ?? '').trim().slice(0, 600);
    if (!chunkId || right.length < 3) continue;
    const r = await runCore(['mem', 'correct', right, '--chunk-id', chunkId, '--json'], { timeout: 30_000 });
    let out: any = null;
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
    if (r.status === 0 && out && out.ok !== false) corrected++;
    else errors.push(`${chunkId}: ${(out && out.error) || (r.stderr || '').trim().split('\n').pop() || 'correct failed'}`.slice(0, 200));
  }
  _cache.clear();
  res.json({ ok: true, corrected, errors });
});
