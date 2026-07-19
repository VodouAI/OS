/**
 * Memory Import API — browser-driven conversation capture (PLAN-UNIVERSAL-MEMORY Phase 4).
 *
 * Rides the EXISTING vodou-bridge extension (getBridge()): no new extension. ChatGPT
 * uses internal-API replay via `cookies_fetch` (the user's own logged-in session);
 * Claude uses the `claude_conversation` built-in DOM extractor. Captured single-
 * conversation JSON is piped to `vodou-core mem import <src> --stdin-json`, which lands
 * it in gateway.db under `import:<src>:<uuid>` and (optionally) distils memory.
 *
 * This is the Team/Business wedge: ChatGPT Team has no export, so browser capture is
 * the ONLY memory-portability path for those users.
 *
 * Same-origin UI calls only — the existing CSRF guard already permits them; this
 * router adds no new auth surface. All heavy lifting is the Rust CLI + the bridge.
 */

import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { getBridge } from '../vbb/bridge.js';

export const memoryImportRouter = Router();

let _projectRootCache: string | null = null;
function projectRoot(): string {
  if (process.env.VODOU_PROJECT_PATH) return process.env.VODOU_PROJECT_PATH;
  if (_projectRootCache) return _projectRootCache;
  // P1-16: without VODOU_PROJECT_PATH, blindly using process.cwd() could point
  // at the Vodou-Console dir (which has its OWN memory.db), so the Console read
  // a DIFFERENT memory.db than the CLI writes. Walk up from cwd to the repo root
  // — the dir carrying the vodou-core binary / vodou-core.db / .vodou marker —
  // which is where the CLI operates. Fall back to cwd if no marker is found.
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    if (
      fs.existsSync(path.join(dir, 'vodou-core')) ||
      fs.existsSync(path.join(dir, 'vodou-core.db')) ||
      fs.existsSync(path.join(dir, '.vodou'))
    ) {
      _projectRootCache = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Validate a job id before it becomes positional argv to the Rust CLI (P1-9).
 * A `-`-prefixed id would be parsed by clap as a FLAG (argument injection —
 * no shell involved, same-origin only, but zero-cost to reject). Real job ids
 * look like `chatgpt-cap-<hash>` / `claude-<hash>`: alphanumeric start, then
 * word chars / hyphens. */
function isValidJobId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

/** Resolve the vodou-core binary (release root, then dev target/release). */
function resolveCoreBin(): string {
  if (process.env.VODOU_CORE_BIN) return process.env.VODOU_CORE_BIN;
  const root = projectRoot();
  const release = path.join(root, 'vodou-core');
  if (fs.existsSync(release)) return release;
  const dev = path.join(root, 'target', 'release', 'vodou-core');
  if (fs.existsSync(dev)) return dev;
  return release;
}

/** PLAN-QA-SWEEP P1-1 — async vodou-core runner. `spawnSync` in an HTTP
 * handler blocks the ENTIRE Node event loop (websockets, chats, channels) for
 * the child's lifetime — up to 10 min for a contradiction scan. Long-running
 * CLI calls go through this instead. */
function runCore(args: string[], opts: { input?: string; timeout?: number } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      resolveCoreBin(), args,
      { cwd: projectRoot(), timeout: opts.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        const status = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === undefined ? 1 : (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1)) : 0;
        resolve({ status, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Pipe one conversation's JSON into `vodou-core mem import <src> --stdin-json`. */
async function importStdin(source: string, json: string, extract: string): Promise<{ ok: boolean; data?: unknown; note?: string }> {
  const res = await runCore(['mem', 'import', source, '--stdin-json', '--extract', extract], { input: json, timeout: 60_000 });
  if (res.status !== 0) return { ok: false, note: `vodou-core exit ${res.status}: ${(res.stderr || '').slice(0, 400)}` };
  try {
    return { ok: true, data: JSON.parse(res.stdout) };
  } catch {
    return { ok: true, data: { raw: res.stdout.trim() } };
  }
}

/** Wait up to `timeoutMs` for the bridge to be connected (tolerates a brief reconnect). */
async function waitForBridge(timeoutMs = 5000): Promise<ReturnType<typeof getBridge>> {
  const deadline = Date.now() + timeoutMs;
  let b = getBridge();
  while (!b && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    b = getBridge();
  }
  return b;
}

/** Infer the source ('chatgpt' | 'claude') from a URL. */
function sourceFromUrl(url: string | undefined | null): 'chatgpt' | 'claude' | null {
  if (!url) return null;
  if (/chatgpt\.com|chat\.openai\.com/.test(url)) return 'chatgpt';
  if (/claude\.ai/.test(url)) return 'claude';
  return null;
}

/** Extract the ChatGPT conversation id from a /c/<uuid> URL. */
function chatgptConvIdFromUrl(url: string): string | null {
  const m = url.match(/\/c\/([0-9a-f-]{16,})/i);
  return m ? m[1] : null;
}

// ── ChatGPT internal-API replay via the bridge's cookies_fetch ────────────────

async function chatgptAccessToken(bridge: NonNullable<ReturnType<typeof getBridge>>): Promise<string> {
  const sess = await bridge.cookiesFetch('https://chatgpt.com/api/auth/session', {});
  let token = '';
  try {
    token = JSON.parse(sess.body)?.accessToken ?? '';
  } catch {
    /* fall through */
  }
  if (!token) throw new Error('no ChatGPT session — open chatgpt.com and log in first');
  return token;
}

async function chatgptFetchConversation(
  bridge: NonNullable<ReturnType<typeof getBridge>>,
  token: string,
  convId: string,
): Promise<string> {
  const r = await bridge.cookiesFetch(`https://chatgpt.com/backend-api/conversation/${convId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status && r.status >= 400) throw new Error(`ChatGPT conversation fetch ${r.status}`);
  return r.body;
}

/** Capture opts shared by the HTTP route and the WS-triggered path. */
export interface CaptureOpts { source?: string; conversationId?: string; url?: string; extract?: string }
export interface CaptureResult { ok: boolean; source?: string; result?: unknown; status?: number; error?: string }

/**
 * Core capture: given a connected bridge, resolve the chat (from an explicit url/
 * source, else by scanning open tabs), pull the conversation (ChatGPT internal API /
 * Claude DOM extractor), and ingest it via `mem import --stdin-json`. Shared by
 * POST /api/import/capture AND the WS `capture_request` path (in-page / popup button).
 */
export async function captureFromBridge(
  bridge: NonNullable<ReturnType<typeof getBridge>>,
  opts: CaptureOpts,
): Promise<CaptureResult> {
  const extract = (opts.extract || 'background').trim();
  let source = (opts.source as 'chatgpt' | 'claude' | undefined) || sourceFromUrl(opts.url);
  let chatUrl = opts.url || '';
  if (!source) {
    let tabs: Array<{ url?: string; title?: string; active?: boolean }> = [];
    try {
      tabs = (await bridge.listTabs(undefined as unknown as string)) as typeof tabs;
    } catch {
      tabs = [];
    }
    const chatTabs = tabs.filter((t) => sourceFromUrl(t.url));
    const pick =
      chatTabs.find((t) => t.active) ||
      chatTabs.find((t) => sourceFromUrl(t.url) === 'chatgpt' && chatgptConvIdFromUrl(t.url || '')) ||
      chatTabs[0];
    if (pick) {
      source = sourceFromUrl(pick.url);
      chatUrl = pick.url || '';
    }
  }
  if (source !== 'chatgpt' && source !== 'claude') {
    return { ok: false, status: 400, error: 'no ChatGPT/Claude chat tab found — open one and make sure the Vodou Bridge is connected (or pass { source }).' };
  }

  let json: string;
  if (source === 'chatgpt') {
    const convId = opts.conversationId || chatgptConvIdFromUrl(chatUrl);
    if (!convId) {
      return { ok: false, status: 400, error: 'found a ChatGPT tab but no conversation id — open a specific chat (chatgpt.com/c/…) so it has a /c/<id> URL.' };
    }
    const token = await chatgptAccessToken(bridge);
    json = await chatgptFetchConversation(bridge, token, convId);
  } else {
    const result = await bridge.extractBuiltin('claude_conversation');
    if (!result) {
      return { ok: false, status: 502, error: 'claude_conversation extractor returned nothing — is a claude.ai chat open and loaded?' };
    }
    json = typeof result === 'string' ? result : JSON.stringify(result);
  }

  const out = await importStdin(source, json, extract);
  if (!out.ok) return { ok: false, status: 500, error: out.note };
  return { ok: true, source, result: out.data };
}

// ── POST /api/import/capture ──────────────────────────────────────────────────
memoryImportRouter.post('/capture', async (req: Request, res: Response) => {
  try {
    const bridge = await waitForBridge();
    if (!bridge) {
      res.status(503).json({ error: 'Vodou Bridge not connected — install/enable the extension and open the chat tab.' });
      return;
    }
    const r = await captureFromBridge(bridge, (req.body ?? {}) as CaptureOpts);
    if (!r.ok) {
      res.status(r.status || 500).json({ error: r.error });
      return;
    }
    res.json({ ok: true, source: r.source, result: r.result });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── POST /api/import/backfill ─────────────────────────────────────────────────
// ChatGPT-only: paginate the user's whole history and ingest each conversation.
// Rate-limited (~1 req / 1.5s) to look human. This is the Team/Business story.
memoryImportRouter.post('/backfill', async (req: Request, res: Response) => {
  try {
    const bridge = await waitForBridge();
    if (!bridge) {
      res.status(503).json({ error: 'Vodou Bridge not connected.' });
      return;
    }
    const body = (req.body ?? {}) as { source?: string; limit?: number; extract?: string };
    const source = (body.source || 'chatgpt').trim();
    if (source !== 'chatgpt') {
      res.status(400).json({ error: 'backfill currently supports source=chatgpt only (Claude has an export; use mem import claude).' });
      return;
    }
    const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 5000);
    const extract = (body.extract || 'background').trim();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const token = await chatgptAccessToken(bridge);
    let offset = 0;
    let ingested = 0;
    const errors: string[] = [];
    const PAGE = 28;

    while (ingested < limit) {
      const listRes = await bridge.cookiesFetch(
        `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${PAGE}&order=updated`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      let items: Array<{ id: string }> = [];
      try {
        items = JSON.parse(listRes.body)?.items ?? [];
      } catch {
        break;
      }
      if (items.length === 0) break;

      for (const it of items) {
        if (ingested >= limit) break;
        try {
          const convJson = await chatgptFetchConversation(bridge, token, it.id);
          const out = await importStdin('chatgpt', convJson, extract);
          if (out.ok) ingested += 1;
          else errors.push(`${it.id}: ${out.note}`);
        } catch (e) {
          errors.push(`${it.id}: ${(e as Error).message}`);
        }
        await sleep(1500); // ~1 req / 1.5s
      }
      offset += items.length;
    }
    res.json({ ok: true, source, ingested, errors: errors.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── GET /api/import/jobs ──────────────────────────────────────────────────────
memoryImportRouter.get('/jobs', (_req: Request, res: Response) => {
  const memPath = path.join(projectRoot(), 'memory.db');
  if (!fs.existsSync(memPath)) {
    res.json({ jobs: [] });
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(memPath, { readOnly: true, timeout: 5000 });
    const jobs = db.prepare(
      `SELECT id, source, status, conv_count, msg_count, extract_watermark, created_at, origin_path
         FROM import_jobs ORDER BY rowid DESC LIMIT 200`,
    ).all();
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
});

// ── GET /api/import/flagged ───────────────────────────────────────────────────
// Review queue: aggregate the sanitizer-flagged lines across all import jobs (kept,
// not dropped — §5.5). The UI shows these for approve (keep) / reject (delete).
memoryImportRouter.get('/flagged', (_req: Request, res: Response) => {
  const memPath = path.join(projectRoot(), 'memory.db');
  if (!fs.existsSync(memPath)) {
    res.json({ flagged: [] });
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(memPath, { readOnly: true, timeout: 5000 });
    const rows = db.prepare(`SELECT id, source, meta FROM import_jobs WHERE meta IS NOT NULL`).all() as Array<{ id: string; source: string; meta: string }>;
    const flagged: Array<{ job_id: string; source: string; line: string }> = [];
    for (const r of rows) {
      try {
        const m = JSON.parse(r.meta);
        for (const line of m.flagged ?? []) {
          flagged.push({ job_id: r.id, source: r.source, line: String(line) });
        }
      } catch { /* skip bad meta */ }
    }
    res.json({ flagged });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
});

// ── POST /api/import/flagged/reject ───────────────────────────────────────────
// Reject a flagged item → delete the import chunk(s) containing the snippet.
memoryImportRouter.post('/flagged/reject', async (req: Request, res: Response) => {
  const snippet = String((req.body ?? {}).snippet || '').trim();
  if (snippet.length < 6) {
    res.status(400).json({ error: 'snippet too short (min 6 chars)' });
    return;
  }
  const r = await runCore(['mem', 'reject', snippet, '--json'], { timeout: 30_000 });
  if (r.status !== 0) { res.status(500).json({ error: (r.stderr || '').slice(0, 400) }); return; }
  try {
    res.json({ ok: true, ...JSON.parse(r.stdout) });
  } catch {
    res.json({ ok: true, output: (r.stdout || '').trim() });
  }
});

// ── Contradictions (PLAN-UNIVERSAL-MEMORY-V2 #3-lite) ─────────────────────────
// Review queue for same-slot/different-value conflicts between imported history
// and first-party memory. All logic lives in the Rust CLI (`mem contradictions`);
// these routes are thin shells, same as flagged/reject above.

// GET /api/import/contradictions — open conflicts awaiting resolution.
memoryImportRouter.get('/contradictions', async (_req: Request, res: Response) => {
  const r = await runCore(['mem', 'contradictions', 'list', '--json'], { timeout: 30_000 });
  if (r.status !== 0) { res.status(500).json({ error: (r.stderr || '').slice(0, 400) }); return; }
  try {
    res.json(JSON.parse(r.stdout));
  } catch {
    res.status(500).json({ error: 'unparseable CLI output' });
  }
});

// POST /api/import/contradictions/scan — LLM-judged scan (capped; judged pairs
// are cached in the queue table, so re-scans only spend on NEW pairs).
memoryImportRouter.post('/contradictions/scan', async (req: Request, res: Response) => {
  const max = String(Math.min(Math.max(Number((req.body ?? {}).max_judgements) || 25, 1), 100));
  // Async spawn (P1-1): this can legitimately run minutes of LLM judging —
  // must not block the event loop.
  const r = await runCore(['mem', 'contradictions', 'scan', '--max-judgements', max, '--json'], { timeout: 600_000 });
  if (r.status !== 0) { res.status(500).json({ error: (r.stderr || '').slice(0, 400) }); return; }
  try {
    res.json({ ok: true, ...JSON.parse(r.stdout) });
  } catch {
    res.json({ ok: true, output: (r.stdout || '').trim() });
  }
});

// POST /api/import/contradictions/:id/resolve — body {keep: 'import'|'native'|'dismiss'}.
// keep=native supersedes the import chunk; keep=import supersedes the first-party
// chunk (both reversible); keep=dismiss clears a false-positive, touching no chunk.
memoryImportRouter.post('/contradictions/:id/resolve', async (req: Request, res: Response) => {
  const id = String(Number(req.params.id));
  const keep = String((req.body ?? {}).keep || '');
  if (id === 'NaN' || !['import', 'native', 'dismiss'].includes(keep)) {
    res.status(400).json({ error: "need numeric :id and keep: 'import'|'native'|'dismiss'" });
    return;
  }
  const r = await runCore(['mem', 'contradictions', 'resolve', id, '--keep', keep, '--json'], { timeout: 30_000 });
  if (r.status !== 0) { res.status(500).json({ error: (r.stderr || '').slice(0, 400) }); return; }
  try {
    res.json({ ok: true, ...JSON.parse(r.stdout) });
  } catch {
    res.json({ ok: true, output: (r.stdout || '').trim() });
  }
});

// ── POST /api/import/jobs/:id/extract ─────────────────────────────────────────
// Foreground-drain a job's memory extraction (mirrors `mem extract-import`).
memoryImportRouter.post('/jobs/:id/extract', async (req: Request, res: Response) => {
  const jobId = req.params.id;
  if (!isValidJobId(jobId)) { res.status(400).json({ error: 'invalid job id' }); return; }
  const batches = String(Math.min(Math.max(Number((req.body ?? {}).batches) || 25, 1), 200));
  const r = await runCore(['mem', 'extract-import', '--job', jobId, '--batches', batches], { timeout: 120_000 });
  if (r.status !== 0) {
    res.status(500).json({ error: (r.stderr || '').slice(0, 400) });
    return;
  }
  res.json({ ok: true, output: (r.stdout || '').trim() });
});

// ── DELETE /api/import/jobs/:id ───────────────────────────────────────────────
// Undo (coarse per-source in v1; per-job in Phase 5). Shells `mem import-undo`.
memoryImportRouter.delete('/jobs/:id', async (req: Request, res: Response) => {
  const jobId = req.params.id;
  if (!isValidJobId(jobId)) { res.status(400).json({ error: 'invalid job id' }); return; }
  const r = await runCore(['mem', 'import-undo', jobId], { timeout: 60_000 });
  if (r.status !== 0) {
    res.status(500).json({ error: (r.stderr || '').slice(0, 400) });
    return;
  }
  res.json({ ok: true, output: (r.stdout || '').trim() });
});
