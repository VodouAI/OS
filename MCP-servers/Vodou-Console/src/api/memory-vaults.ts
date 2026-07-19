/**
 * Memory Vaults API — PLAN-MEMORY-VAULTS V2 (PLANS/0.6.16).
 *
 * Segmented sharing: named, rule-based selections of memory ("share the family
 * vault, not the bank vault"). This router is the WRITE path for the brain
 * console's vault manager — brain (:8767) stays a read-only surface over
 * memory.db, so its UI calls the gateway cross-origin (localhost CORS + CSRF
 * guard already permit 127.0.0.1 origins) and every operation shells the Rust
 * CLI (`mem vault … --json` / `mem export --vault`), which owns ALL rule
 * semantics. No vault logic lives in TypeScript — same Board pattern as
 * memory-import.ts.
 *
 *   GET    /api/vaults                       — list (rules included)
 *   POST   /api/vaults                       — { name, rules } create
 *   PUT    /api/vaults/:name                 — { rules } replace rules
 *   DELETE /api/vaults/:name                 — delete definition
 *   GET    /api/vaults/:name/preview         — counts + resolved member ids
 *   POST   /api/vaults/:name/overrides       — { chunk_id, action: include|exclude|clear }
 *   POST   /api/vaults/:name/export          — build the pack ZIP, returns its path
 */

import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { getProjectRoot } from '../db.js';
import { runCore } from './memory-capture.js';

export const memoryVaultsRouter = Router();

/** Vault names reach the CLI as positional argv — same guard class as job ids
 * (no leading dash = no clap flag injection; charset mirrors the Rust validator). */
function isValidVaultName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(name);
}

function isValidChunkId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9/:_.-]*$/.test(id) && id.length <= 300;
}

interface RulesBody {
  scopes?: unknown;
  tags?: unknown;
  project?: unknown;
  since_days?: unknown;
  include_imports?: unknown;
}

/** Translate a rules object into `mem vault create/update` flags. */
function ruleArgs(rules: RulesBody): string[] | { error: string } {
  const args: string[] = [];
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
  const scopes = list(rules.scopes);
  const tags = list(rules.tags);
  // Comma-delimited values land as one argv token — reject embedded commas/dashes-first.
  for (const s of [...scopes, ...tags]) {
    if (s.includes(',') || s.startsWith('-')) return { error: `invalid rule token: ${s}` };
  }
  if (scopes.length) args.push('--scopes', scopes.join(','));
  if (tags.length) args.push('--tags', tags.join(','));
  if (rules.project !== undefined && rules.project !== null && String(rules.project).trim() !== '') {
    const p = String(rules.project).trim();
    if (p.startsWith('-')) return { error: 'invalid project id' };
    args.push('--project', p);
  }
  if (rules.since_days !== undefined && rules.since_days !== null && String(rules.since_days) !== '') {
    const d = Number(rules.since_days);
    if (!Number.isFinite(d) || d < 1 || d > 36500) return { error: 'since_days must be 1-36500' };
    args.push('--since-days', String(Math.floor(d)));
  }
  if (rules.include_imports === true) args.push('--include-imports');
  return args;
}

async function shell(res: Response, args: string[], timeout = 60_000): Promise<void> {
  const r = await runCore(args, { timeout });
  if (r.status !== 0) {
    let msg = (r.stderr || r.stdout || 'vodou-core failed').trim();
    try { msg = JSON.parse(r.stdout).error || msg; } catch { /* keep raw */ }
    res.status(422).json({ error: msg.slice(0, 500) });
    return;
  }
  try {
    res.json(JSON.parse(r.stdout));
  } catch {
    res.json({ ok: true, output: (r.stdout || '').trim().slice(0, 2000) });
  }
}

// ── GET /api/vaults ───────────────────────────────────────────────────────────
memoryVaultsRouter.get('/', async (_req: Request, res: Response) => {
  await shell(res, ['mem', 'vault', 'list', '--json']);
});

// ── POST /api/vaults  { name, rules } ─────────────────────────────────────────
memoryVaultsRouter.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { name?: unknown; rules?: RulesBody };
  if (!isValidVaultName(body.name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  const args = ruleArgs(body.rules ?? {});
  if (!Array.isArray(args)) { res.status(400).json({ error: args.error }); return; }
  await shell(res, ['mem', 'vault', 'create', body.name, ...args, '--json']);
});

// ── PUT /api/vaults/:name  { rules } ──────────────────────────────────────────
memoryVaultsRouter.put('/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidVaultName(name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  const args = ruleArgs(((req.body ?? {}) as { rules?: RulesBody }).rules ?? {});
  if (!Array.isArray(args)) { res.status(400).json({ error: args.error }); return; }
  await shell(res, ['mem', 'vault', 'update', name, ...args, '--json']);
});

// ── DELETE /api/vaults/:name ──────────────────────────────────────────────────
memoryVaultsRouter.delete('/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidVaultName(name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  await shell(res, ['mem', 'vault', 'delete', name, '--json']);
});

// ── GET /api/vaults/:name/preview ─────────────────────────────────────────────
// Counts by scope/tag + the exact resolved chunk-id list (the brain UI dims the
// constellation to this set before anything is shared).
memoryVaultsRouter.get('/:name/preview', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidVaultName(name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  await shell(res, ['mem', 'vault', 'preview', name, '--json'], 120_000);
});

// ── POST /api/vaults/:name/overrides  { chunk_id, action } ───────────────────
memoryVaultsRouter.post('/:name/overrides', async (req: Request, res: Response) => {
  const name = req.params.name;
  const body = (req.body ?? {}) as { chunk_id?: unknown; action?: unknown };
  if (!isValidVaultName(name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  if (!isValidChunkId(body.chunk_id)) { res.status(400).json({ error: 'invalid chunk_id' }); return; }
  const verb =
    body.action === 'include' ? 'include'
    : body.action === 'exclude' ? 'exclude'
    : body.action === 'clear' ? 'clear-override'
    : null;
  if (!verb) { res.status(400).json({ error: "action must be include|exclude|clear" }); return; }
  await shell(res, ['mem', 'vault', verb, name, body.chunk_id, '--json']);
});

// ── POST /api/vaults/:name/export ─────────────────────────────────────────────
// Builds the vault pack ZIP under .vodou/exports/ and returns its path plus a
// download URL the UI navigates to (Content-Disposition: attachment → the
// browser drops a copy in ~/Downloads; the .vodou/exports copy stays). Export
// can chew on a big memory store — generous timeout, still async (runCore).
memoryVaultsRouter.post('/:name/export', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!isValidVaultName(name)) { res.status(400).json({ error: 'invalid vault name' }); return; }
  const dir = path.join(getProjectRoot(), '.vodou', 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const base = `vault-${name.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}.zip`;
  const out = path.join(dir, base);
  const r = await runCore(['mem', 'export', '--vault', name, '--out', out], { timeout: 300_000 });
  if (r.status !== 0) {
    res.status(422).json({ error: (r.stderr || r.stdout || 'export failed').trim().slice(0, 500) });
    return;
  }
  res.json({
    ok: true,
    file: out,
    download: `/api/vaults/export-file/${encodeURIComponent(base)}`,
    summary: (r.stdout || '').trim(),
  });
});

// ── GET /api/vaults/export-file/:base ─────────────────────────────────────────
// Serve a previously built pack as an attachment download. Basename-only, strict
// pattern, and resolved inside .vodou/exports/ — no traversal surface.
memoryVaultsRouter.get('/export-file/:base', (req: Request, res: Response) => {
  const base = req.params.base;
  if (!/^vault-[A-Za-z0-9._-]+\.zip$/.test(base) || base.includes('..')) {
    res.status(400).json({ error: 'invalid export file name' });
    return;
  }
  const dir = path.join(getProjectRoot(), '.vodou', 'exports');
  const file = path.resolve(dir, base);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
    res.status(404).json({ error: 'no such export' });
    return;
  }
  res.download(file, base);
});
