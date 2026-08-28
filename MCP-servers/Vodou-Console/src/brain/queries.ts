// COPY of MCP-servers/brain/src/queries.ts — PLAN-BRAIN-INTO-CONSOLE P0.1.
// Edit the brain copy first, then re-copy here (scripts/sync-brain-queries.sh).
// src/__tests__/brain-queries-drift.test.ts fails CI when the two diverge.
// House rule (brain/src/db.ts): servers stay standalone — copy, don't link.
//
// brain — read-only query layer over memory.db.
//
// Single source of truth for both the MCP tools (src/index.ts) and the
// mini-console HTTP API (src/serve.ts). Everything here is SELECT-only;
// the DB handle is opened readOnly, so writes are structurally impossible.
//
// Graph model (what the console draws):
//   nodes: file  — one per memory .md file (daily logs, imports, captures)
//          entity — memory_entities (people/orgs/handles, V2 Phase B)
//          doc   — non-memory ref targets (PLAN-*.md etc.) that memories cite
//          chunk — individual memory rows (local/focus graphs only)
//   edges: mention   entity↔file / entity↔chunk   (memory_entity_mentions)
//          ref       file/chunk→file/doc          (memory_refs, resolved targets)
//          comention entity↔entity                (shared chunks)
//          conflict  chunk↔chunk / file↔file      (memory_contradictions)
//          superseded chunk→chunk                 (memory_fact_groups)

import path from 'node:path';
import { open, DB } from './db.js';
import { getProjectRoot } from '../db.js';

// CONSOLE COPY: the project root comes from the gateway's own resolver
// (src/db.ts PROJECT_ROOT — honours VODOU_PROJECT_PATH when it holds a real
// install) instead of walking up from dist/. This block is the ONLY allowed
// difference from brain/src/queries.ts; the drift test compares everything
// after the `// ── Provenance` marker.
export const projectRoot = getProjectRoot();
const memoryDbPath = process.env.VODOU_MEMORY_DB?.trim()
  || path.join(projectRoot, 'memory.db');

let _db: DB | null = null;
export function db(): DB {
  if (!_db) _db = open(memoryDbPath, { readOnly: true });
  return _db;
}

// ── Provenance / trust (mirrors src/memory/search.rs trust_mult) ──────────
// first-party = 1.0, capture:% = 1 - w/2, import:% = 1 - w (w = VODOU_MEMORY_W_TRUST, 0.15)
const W_TRUST = (() => {
  const v = parseFloat(process.env.VODOU_MEMORY_W_TRUST || '0.15');
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.15;
})();

export type VaultClass = 'yours' | 'captured' | 'imported';

export function classifyScope(scope: string | null | undefined): {
  cls: VaultClass; trust: number; source: string;
} {
  const s = (scope || '').trim();
  if (s.startsWith('import:')) return { cls: 'imported', trust: 1 - W_TRUST, source: s.slice(7) || 'unknown' };
  if (s.startsWith('capture:')) return { cls: 'captured', trust: 1 - W_TRUST / 2, source: s.slice(8) || 'unknown' };
  return { cls: 'yours', trust: 1.0, source: s || 'web' };
}

const clsCase = `CASE
  WHEN scope LIKE 'import:%'  THEN 'imported'
  WHEN scope LIKE 'capture:%' THEN 'captured'
  ELSE 'yours' END`;

// ── Embedding similarity (PLAN-MEMORY-GRAPH-SIMILARITY-EDGES) ────────────────
// Cosine over memory_embeddings, computed in-process so the console's read layer
// stays standalone (no subprocess spawn). Mirrors src/memory/search.rs::
// cosine_similarity exactly — a plain normalized dot product, clamped to [0,1].
// The Rust `mem similar` CLI is the same math for non-console consumers (P0/P3).
//
// τ noise-floor + fan-out. Calibrated on the live corpus (BGE-small): genuinely
// related imports/captures sit at cos 0.65–0.73, native memory at 0.84+. A high
// floor would leave imported memory islanded — sparsity comes from top-K +
// mutual-top-K (P2), not from a high floor.
const SIM_TAU = (() => {
  const v = parseFloat(process.env.VODOU_BRAIN_SIM_TAU || '0.65');
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.65;
})();
const SIM_K = (() => {
  const v = parseInt(process.env.VODOU_BRAIN_SIM_K || '6', 10);
  return Number.isFinite(v) && v > 0 ? v : 6;
})();

/** Decode a memory_embeddings BLOB (f32 little-endian) → Float32Array. Exported for tests. */
export function decodeEmbedding(blob: unknown): Float32Array | null {
  if (!blob || !ArrayBuffer.isView(blob as ArrayBufferView)) return null;
  const view = blob as ArrayBufferView;
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const n = Math.floor(u8.byteLength / 4);
  if (n === 0) return null;
  // Copy into a fresh, 4-byte-aligned buffer so Float32Array is always valid.
  const buf = new ArrayBuffer(n * 4);
  new Uint8Array(buf).set(u8.subarray(0, n * 4));
  return new Float32Array(buf); // LE on all supported platforms
}

/** Cosine similarity in [0,1]; mirrors src/memory/search.rs. Exported for tests. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return Math.min(Math.max(dot / denom, 0), 1);
}

export interface SimNeighbor { chunk_id: string; path: string; scope: string; cls: VaultClass; cos: number; }

/** P1 — single-source top-K similarity neighbors of one chunk (focus overlay + MCP). */
export function similarChunks(
  chunkId: string,
  opts: { topK?: number; minCos?: number; excludeSameFile?: boolean; sameScopeOnly?: boolean } = {},
): SimNeighbor[] {
  const topK = opts.topK ?? SIM_K;
  const minCos = opts.minCos ?? SIM_TAU;
  const excludeSameFile = opts.excludeSameFile ?? true;
  const d = db();
  const target = d.prepare(
    `SELECT me.embedding emb, c.path, COALESCE(c.scope,'web') scope
     FROM memory_chunks c JOIN memory_embeddings me ON me.chunk_id = c.id WHERE c.id = ?`,
  ).get(chunkId) as { emb: unknown; path: string; scope: string } | undefined;
  if (!target) return [];
  const tv = decodeEmbedding(target.emb);
  if (!tv) return [];
  const targetCls = classifyScope(target.scope).cls;
  const rows = d.prepare(
    `SELECT c.id, c.path, COALESCE(c.scope,'web') scope, me.embedding emb
     FROM memory_chunks c JOIN memory_embeddings me ON me.chunk_id = c.id
     WHERE c.id != ? AND (c.archived = 0 OR c.pinned = 1)
       AND c.text NOT LIKE '[SUPERSEDED]%' AND c.text NOT LIKE '- [SUPERSEDED]%'`,
  ).all(chunkId) as { id: string; path: string; scope: string; emb: unknown }[];
  const out: SimNeighbor[] = [];
  for (const r of rows) {
    if (excludeSameFile && r.path === target.path) continue;
    const cls = classifyScope(r.scope).cls;
    if (opts.sameScopeOnly && cls !== targetCls) continue;
    const v = decodeEmbedding(r.emb);
    if (!v) continue;
    const cos = cosine(tv, v);
    if (cos < minCos) continue;
    out.push({ chunk_id: r.id, path: r.path, scope: r.scope, cls, cos });
  }
  out.sort((a, b) => b.cos - a.cos);
  return out.slice(0, topK);
}

/**
 * Batched neighbors for a SET of seed chunks — loads + decodes the corpus embeddings
 * ONCE and scores every candidate against all seeds in a single pass. This is the perf
 * fix for focus views: `attachSimilar` used to call `similarChunks` once per seed, so a
 * file with N chunks did N full-corpus scans (each re-reading + re-decoding 22k BLOBs).
 * Returns per-seed top-K as flat `{ source: seedId, nb }` pairs.
 */
export function similarForSeeds(
  seedIds: string[],
  opts: { topK?: number; minCos?: number; excludeSameFile?: boolean } = {},
): { source: string; nb: SimNeighbor }[] {
  const topK = opts.topK ?? SIM_K;
  const minCos = opts.minCos ?? SIM_TAU;
  const excludeSameFile = opts.excludeSameFile ?? true;
  if (!seedIds.length) return [];
  const d = db();
  const seedStmt = d.prepare(
    `SELECT c.path, me.embedding emb FROM memory_chunks c JOIN memory_embeddings me ON me.chunk_id = c.id WHERE c.id = ?`,
  );
  const seedSet = new Set(seedIds);
  const seeds: { id: string; path: string; v: Float32Array }[] = [];
  for (const id of seedIds) {
    const row = seedStmt.get(id) as { path: string; emb: unknown } | undefined;
    const v = row ? decodeEmbedding(row.emb) : null;
    if (v) seeds.push({ id, path: row!.path, v });
  }
  if (!seeds.length) return [];
  // Corpus loaded + decoded ONCE, regardless of seed count.
  const rows = d.prepare(
    `SELECT c.id, c.path, COALESCE(c.scope,'web') scope, me.embedding emb
     FROM memory_chunks c JOIN memory_embeddings me ON me.chunk_id = c.id
     WHERE (c.archived = 0 OR c.pinned = 1)
       AND c.text NOT LIKE '[SUPERSEDED]%' AND c.text NOT LIKE '- [SUPERSEDED]%'`,
  ).all() as { id: string; path: string; scope: string; emb: unknown }[];
  const perSeed = new Map<string, { source: string; nb: SimNeighbor }[]>();
  for (const s of seeds) perSeed.set(s.id, []);
  for (const r of rows) {
    if (seedSet.has(r.id)) continue;
    const v = decodeEmbedding(r.emb);
    if (!v) continue;
    const cls = classifyScope(r.scope).cls;
    for (const s of seeds) {
      if (excludeSameFile && r.path === s.path) continue;
      const cos = cosine(s.v, v);
      if (cos < minCos) continue;
      perSeed.get(s.id)!.push({ source: s.id, nb: { chunk_id: r.id, path: r.path, scope: r.scope, cls, cos } });
    }
  }
  const out: { source: string; nb: SimNeighbor }[] = [];
  for (const [, arr] of perSeed) {
    arr.sort((a, b) => b.nb.cos - a.nb.cos);
    out.push(...arr.slice(0, topK));
  }
  return out;
}

/**
 * P2 — file↔file similarity edges for the global graph. One representative vector
 * per file (its longest chunk), pairwise cosine among the given files, then
 * **top-K union** (an edge survives if either file is in the other's top-K) + the τ
 * floor + a global cap. At file granularity (~200 nodes) union-top-K gives a
 * visibly-connected sky; the τ floor + per-node top-K + cap are the anti-hairball
 * guards. (Pass `mutual: true` for the stricter both-sides rule.)
 */
export function fileSimilarityEdges(
  paths: string[],
  opts: { topK?: number; minCos?: number; cap?: number; mutual?: boolean; perFileChunks?: number } = {},
): { source: string; target: string; type: 'similar'; w: number }[] {
  const topK = opts.topK ?? SIM_K;
  // Max-pooling picks the single best chunk pair, which inflates vs a whole-file
  // representative — so the file floor is a touch higher than the chunk τ. Calibrated:
  // 0.72 ≈ "these two files share at least one strongly-related chunk" (~145 pairs at
  // 200-file scale, vs ~16 for a single representative — whole daily logs rarely
  // resemble each other, but they share topics chunk-to-chunk).
  const minCos = opts.minCos ?? Math.max(SIM_TAU, 0.72);
  const cap = opts.cap ?? 800;
  const mutual = opts.mutual ?? false;
  const perFileChunks = opts.perFileChunks ?? 8;
  if (paths.length < 2) return [];
  const d = db();
  const stmt = d.prepare(
    `SELECT me.embedding emb FROM memory_chunks c JOIN memory_embeddings me ON me.chunk_id = c.id
     WHERE c.path = ? AND (c.archived = 0 OR c.pinned = 1) ORDER BY length(c.text) DESC LIMIT ?`,
  );
  // Represent each file by its top-N longest chunks' vectors (not one). File↔file
  // similarity = MAX cosine over the chunk-pair grid (max-pooling).
  const vecs = new Map<string, Float32Array[]>();
  for (const p of paths) {
    const rows = stmt.all(p, perFileChunks) as { emb: unknown }[];
    const vs = rows.map((r) => decodeEmbedding(r.emb)).filter((v): v is Float32Array => !!v);
    if (vs.length) vecs.set(p, vs);
  }
  const files = [...vecs.keys()];
  const perNode = new Map<string, { p: string; cos: number }[]>();
  for (const p of files) perNode.set(p, []);
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = vecs.get(files[i])!;
      const b = vecs.get(files[j])!;
      let best = 0;
      for (const va of a) for (const vb of b) { const c = cosine(va, vb); if (c > best) best = c; }
      if (best < minCos) continue;
      perNode.get(files[i])!.push({ p: files[j], cos: best });
      perNode.get(files[j])!.push({ p: files[i], cos: best });
    }
  }
  const topset = new Map<string, Set<string>>();
  for (const [p, arr] of perNode) {
    arr.sort((a, b) => b.cos - a.cos);
    topset.set(p, new Set(arr.slice(0, topK).map((x) => x.p)));
  }
  const edges: { source: string; target: string; type: 'similar'; w: number }[] = [];
  const seen = new Set<string>();
  for (const [p, arr] of perNode) {
    for (const { p: q, cos } of arr) {
      // union: keep if in EITHER top-K (denser). mutual: require BOTH (sparser).
      const inP = topset.get(p)!.has(q);
      const inQ = topset.get(q)!.has(p);
      if (mutual ? (!inP || !inQ) : (!inP && !inQ)) continue;
      const key = p < q ? JSON.stringify([p, q]) : JSON.stringify([q, p]);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: p, target: q, type: 'similar', w: cos });
    }
  }
  edges.sort((a, b) => b.w - a.w);
  return edges.slice(0, cap);
}

// ── Filters shared by graph/timeline/file queries ─────────────────────────
export interface Filters {
  cls?: VaultClass[];        // vault classes to include (default: all)
  tag?: string;              // exact chunk_tag
  sinceDays?: number;        // created_at within N days
  includeArchived?: boolean; // default false
  q?: string;                // substring filter on path
  project?: string;          // 'global' = NULL only, otherwise a project_id; unset = all
  host?: string;             // PLAN-MEMORY-ON-EVERY-PAGE P4 — source_host (bare host; matches subdomains); 'none' = unstamped only
}

function whereChunks(f: Filters, alias = 'c'): { sql: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (!f.includeArchived) conds.push(`${alias}.archived = 0`);
  if (f.cls && f.cls.length > 0 && f.cls.length < 3) {
    const cases = f.cls.map((c) => `'${c}'`).join(',');
    conds.push(`(${clsCase.replaceAll('scope', `${alias}.scope`)}) IN (${cases})`);
  }
  if (f.tag) { conds.push(`${alias}.chunk_tag = ?`); params.push(f.tag); }
  if (f.sinceDays && f.sinceDays > 0) {
    conds.push(`${alias}.created_at >= datetime('now', ?)`);
    params.push(`-${Math.floor(f.sinceDays)} days`);
  }
  if (f.q) { conds.push(`${alias}.path LIKE ?`); params.push(`%${f.q}%`); }
  if (f.project === 'global') conds.push(`${alias}.project_id IS NULL`);
  else if (f.project) { conds.push(`${alias}.project_id = ?`); params.push(f.project); }
  // P4 — page axis. A host rule covers its subdomains, like the vault selector.
  if (f.host === 'none') conds.push(`${alias}.source_host IS NULL`);
  else if (f.host) {
    const h = f.host.toLowerCase().replace(/^www\./, '');
    conds.push(`(${alias}.source_host = ? OR ${alias}.source_host LIKE ?)`);
    params.push(h, `%.${h.replace(/[%_]/g, (c) => '\\' + c)}`);
  }
  return { sql: conds.length ? conds.join(' AND ') : '1=1', params };
}

/** PLAN-MEMORY-ON-EVERY-PAGE P4 — the sites memory came from, with counts. */
export function hosts() {
  return db().prepare(
    `SELECT source_host host, COUNT(*) n, MAX(created_at) last
     FROM memory_chunks WHERE archived = 0 AND source_host IS NOT NULL
     GROUP BY source_host ORDER BY n DESC LIMIT 200`
  ).all() as { host: string; n: number; last: string }[];
}

// Project id → display name. The NAMES live in the gateway's `projects` table (a
// separate DB); memory.db only carries `project_id`. Brain is memory.db-first, so we
// open gateway.db read-only just for the label map. Best-effort: absent/locked → ids
// fall back to raw. Cached with a short TTL — it used to be process-lifetime,
// which the standalone got away with (restarted often) but the gateway would
// not: found 2026-08-25 when a :8767 up since 08-21 still labelled a project
// created that evening by its raw id (PLAN-BRAIN-INTO-CONSOLE R2).
const PROJECT_NAMES_TTL_MS = 60_000;
let _projectNames: Map<string, string> | null = null;
let _projectNamesAt = 0;
function projectNames(): Map<string, string> {
  if (_projectNames && Date.now() - _projectNamesAt < PROJECT_NAMES_TTL_MS) return _projectNames;
  const m = new Map<string, string>();
  try {
    const gwPath = process.env.VODOU_GATEWAY_DB?.trim()
      || path.join(projectRoot, 'MCP-servers', 'Vodou-Console', 'gateway.db');
    const gw = open(gwPath, { readOnly: true });
    const rows = gw.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[];
    for (const r of rows) m.set(r.id, r.name);
    (gw as unknown as { close?: () => void }).close?.();
  } catch { /* gateway.db absent/locked → ids fall back to raw */ }
  _projectNames = m;
  _projectNamesAt = Date.now();
  return m;
}

export function projects() {
  const names = projectNames();
  return (db().prepare(
    `SELECT COALESCE(project_id, 'global') project, COUNT(*) n
     FROM memory_chunks WHERE archived = 0 GROUP BY project_id ORDER BY n DESC`
  ).all() as { project: string; n: number }[]).map((r) => ({
    ...r,
    name: r.project === 'global' ? 'Global' : (names.get(r.project) || r.project),
  }));
}

// ── Overview / stats ───────────────────────────────────────────────────────
export function overview() {
  const d = db();
  const one = (sql: string) => (d.prepare(sql).get() as Record<string, number>);
  const counts = {
    chunks_live: one(`SELECT COUNT(*) n FROM memory_chunks WHERE archived=0`).n,
    chunks_total: one(`SELECT COUNT(*) n FROM memory_chunks`).n,
    files: one(`SELECT COUNT(DISTINCT path) n FROM memory_chunks WHERE archived=0`).n,
    entities: one(`SELECT COUNT(*) n FROM memory_entities`).n,
    connections: one(`SELECT COUNT(*) n FROM memory_refs`).n,
    conflicts_open: one(`SELECT COUNT(*) n FROM memory_contradictions WHERE status='open'`).n,
    conflicts_total: one(`SELECT COUNT(*) n FROM memory_contradictions`).n,
    superseded: one(`SELECT COUNT(*) n FROM memory_fact_groups WHERE superseded_by IS NOT NULL`).n,
    pinned: one(`SELECT COUNT(*) n FROM memory_chunks WHERE archived=0 AND pinned=1`).n,
  };
  const byClass = d.prepare(
    `SELECT ${clsCase} cls, COUNT(*) n FROM memory_chunks WHERE archived=0 GROUP BY cls`
  ).all();
  const byTag = d.prepare(
    `SELECT COALESCE(NULLIF(chunk_tag,''),'UNTAGGED') tag, COUNT(*) n
     FROM memory_chunks WHERE archived=0 GROUP BY tag ORDER BY n DESC`
  ).all();
  const latest = d.prepare(
    `SELECT MAX(created_at) latest FROM memory_chunks WHERE archived=0`
  ).get();
  return { counts, byClass, byTag, ...latest, w_trust: W_TRUST };
}

export function scopes() {
  const rows = db().prepare(
    `SELECT scope, ${clsCase} cls, COUNT(*) n, MAX(created_at) last
     FROM memory_chunks WHERE archived=0 GROUP BY scope ORDER BY n DESC`
  ).all() as { scope: string; cls: VaultClass; n: number; last: string }[];
  return rows.map((r) => ({ ...r, trust: classifyScope(r.scope).trust }));
}

// ── Graph: overview (files + entities + docs) ─────────────────────────────
export function graphOverview(f: Filters = {}, maxFiles = 200, maxDocs = 40, includeSimilarity = false) {
  const d = db();
  const w = whereChunks(f);

  // File nodes: aggregate per path (dominant tag + class computed in JS).
  const fileRows = d.prepare(
    // COHERENCE-INTENTIONAL: SQL, not a DOM sink — clsCase is a CASE over the scope column, never shown raw.
    `SELECT c.path, COALESCE(NULLIF(c.chunk_tag,''),'UNTAGGED') tag, ${clsCase.replaceAll('scope', 'c.scope')} cls,
            COUNT(*) n, MAX(c.created_at) last, MAX(c.pinned) pinned
     FROM memory_chunks c WHERE ${w.sql}
     GROUP BY c.path, tag, cls`
  ).all(...w.params) as { path: string; tag: string; cls: VaultClass; n: number; last: string; pinned: number }[];

  const files = new Map<string, {
    id: string; type: 'file'; path: string; n: number; last: string;
    cls: VaultClass; trust: number; tag: string; pinned: boolean;
    tags: Record<string, number>;
  }>();
  for (const r of fileRows) {
    let fnode = files.get(r.path);
    if (!fnode) {
      fnode = {
        id: r.path, type: 'file', path: r.path, n: 0, last: r.last,
        cls: r.cls, trust: classifyScope(r.cls === 'yours' ? '' : (r.cls === 'imported' ? 'import:x' : 'capture:x')).trust,
        tag: r.tag, pinned: false, tags: {},
      };
      files.set(r.path, fnode);
    }
    fnode.n += r.n;
    fnode.tags[r.tag] = (fnode.tags[r.tag] || 0) + r.n;
    if (r.last > fnode.last) fnode.last = r.last;
    if (r.pinned) fnode.pinned = true;
    // class: imported/captured wins over yours for imports files (they're homogeneous in practice)
    if (r.cls !== 'yours') { fnode.cls = r.cls; fnode.trust = classifyScope(r.cls === 'imported' ? 'import:x' : 'capture:x').trust; }
  }
  // dominant tag per file
  for (const fnode of files.values()) {
    fnode.tag = Object.entries(fnode.tags).sort((a, b) => b[1] - a[1])[0][0];
  }
  const fileList = [...files.values()].sort((a, b) => b.n - a.n).slice(0, maxFiles);
  const keep = new Set(fileList.map((x) => x.path));

  // Entity nodes (all — there are ~dozens, they're the hubs)
  const entities = d.prepare(
    `SELECT e.id, e.canonical, e.kind, COUNT(m.chunk_id) mentions
     FROM memory_entities e
     LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
     LEFT JOIN memory_chunks c ON c.id = m.chunk_id AND c.archived = 0
     GROUP BY e.id ORDER BY mentions DESC`
  ).all() as { id: number; canonical: string; kind: string; mentions: number }[];

  // entity ↔ file edges
  const entFileEdges = d.prepare(
    `SELECT m.entity_id eid, c.path, COUNT(*) w
     FROM memory_entity_mentions m
     JOIN memory_chunks c ON c.id = m.chunk_id
     WHERE ${w.sql}
     GROUP BY m.entity_id, c.path`
  ).all(...w.params) as { eid: number; path: string; w: number }[];

  // file → file/doc edges via refs (resolved targets only)
  const refEdges = d.prepare(
    `SELECT c.path src, r.target dst, r.kind, COUNT(*) w
     FROM memory_refs r
     JOIN memory_chunks c ON c.id = r.chunk_id
     WHERE r.target IS NOT NULL AND ${w.sql}
     GROUP BY c.path, r.target, r.kind`
  ).all(...w.params) as { src: string; dst: string; kind: string; w: number }[];

  // entity ↔ entity co-mentions
  const coEdges = d.prepare(
    `SELECT a.entity_id e1, b.entity_id e2, COUNT(*) w
     FROM memory_entity_mentions a
     JOIN memory_entity_mentions b ON a.chunk_id = b.chunk_id AND a.entity_id < b.entity_id
     JOIN memory_chunks c ON c.id = a.chunk_id
     WHERE ${w.sql}
     GROUP BY e1, e2 ORDER BY w DESC LIMIT 300`
  ).all(...w.params) as { e1: number; e2: number; w: number }[];

  // conflict edges rolled up to file level
  const conflictEdges = d.prepare(
    `SELECT ci.path src, cn.path dst, x.status, COUNT(*) w
     FROM memory_contradictions x
     JOIN memory_chunks ci ON ci.id = x.import_chunk_id
     JOIN memory_chunks cn ON cn.id = x.native_chunk_id
     GROUP BY ci.path, cn.path, x.status`
  ).all() as { src: string; dst: string; status: string; w: number }[];

  // Assemble: doc nodes = ref targets that aren't memory files we kept
  const nodes: unknown[] = [];
  const links: unknown[] = [];
  for (const fnode of fileList) {
    const { tags, ...rest } = fnode;
    nodes.push({ ...rest, topTags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 4) });
  }
  for (const e of entities) {
    nodes.push({ id: `entity:${e.id}`, type: 'entity', label: e.canonical, kind: e.kind, n: e.mentions });
  }

  const docWeight = new Map<string, number>();
  for (const r of refEdges) {
    if (!keep.has(r.src)) continue;
    if (keep.has(r.dst)) {
      if (r.src !== r.dst) links.push({ source: r.src, target: r.dst, type: 'ref', kind: r.kind, w: r.w });
    } else {
      docWeight.set(r.dst, (docWeight.get(r.dst) || 0) + r.w);
    }
  }
  const docs = [...docWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxDocs);
  const docKeep = new Set(docs.map(([t]) => t));
  for (const [t, wgt] of docs) nodes.push({ id: t, type: 'doc', path: t, n: wgt });
  for (const r of refEdges) {
    if (keep.has(r.src) && docKeep.has(r.dst)) {
      links.push({ source: r.src, target: r.dst, type: 'ref', kind: r.kind, w: r.w });
    }
  }
  for (const e of entFileEdges) {
    if (keep.has(e.path)) links.push({ source: `entity:${e.eid}`, target: e.path, type: 'mention', w: e.w });
  }
  for (const e of coEdges) {
    links.push({ source: `entity:${e.e1}`, target: `entity:${e.e2}`, type: 'comention', w: e.w });
  }
  for (const e of conflictEdges) {
    if (keep.has(e.src) && keep.has(e.dst)) {
      links.push({ source: e.src, target: e.dst, type: 'conflict', status: e.status, w: e.w });
    }
  }
  // PLAN-MEMORY-GRAPH-SIMILARITY-EDGES P2 — file↔file similarity over the kept set
  // (opt-in). Mutual-top-K + τ + cap keep it from hairballing at the 200-file scale.
  if (includeSimilarity) {
    for (const e of fileSimilarityEdges([...keep])) {
      if (e.source !== e.target) links.push(e);
    }
  }
  return { nodes, links, truncated: files.size > fileList.length };
}

// ── Graph: local / focus neighborhood ──────────────────────────────────────
export function localGraph(id: string, limit = 120, includeSimilar = false) {
  if (id.startsWith('entity:')) return entityGraph(parseInt(id.slice(7), 10), limit);
  if (id.includes(':') && /:\d+:/.test(id)) return chunkGraph(id, limit, includeSimilar);
  return fileGraph(id, limit, includeSimilar);
}

// PLAN-MEMORY-GRAPH-SIMILARITY-EDGES P1 — attach embedding-similarity neighbors of
// the given center chunk(s) to a focus graph. Pulls in up to `cap` NEW chunk nodes
// (across all centers) and draws a `similar` link (w = cosine) to whichever
// neighbor nodes end up present. Additive: unknown link types are ignored by older UIs.
const SIM_SEED_CAP = 8; // max seed chunks scanned per focus (bounds corpus passes)

function attachSimilar(d: DB, centerIds: string[], nodes: any[], links: any[], cap = 30) {
  const existing = new Set(nodes.map((n) => n.id));
  // Corpus loaded ONCE for all (capped) seeds — not once per seed.
  const pairs = similarForSeeds(centerIds.slice(0, SIM_SEED_CAP));
  const wanted: string[] = [];
  for (const { nb } of pairs) {
    if (!existing.has(nb.chunk_id) && !wanted.includes(nb.chunk_id)) wanted.push(nb.chunk_id);
  }
  const keep = wanted.slice(0, cap);
  if (keep.length) {
    const ph = keep.map(() => '?').join(',');
    const rows = d.prepare(`SELECT ${CHUNK_COLS} FROM memory_chunks WHERE id IN (${ph})`).all(...keep) as any[];
    for (const r of rows) {
      if (!existing.has(r.id)) { nodes.push(chunkNodeRow(r)); existing.add(r.id); }
    }
  }
  for (const { source, nb } of pairs) {
    if (existing.has(nb.chunk_id)) links.push({ source, target: nb.chunk_id, type: 'similar', w: nb.cos });
  }
}

function chunkNodeRow(c: {
  id: string; path: string; start_line: number; text: string; scope: string;
  chunk_tag: string | null; created_at: string; pinned: number;
}) {
  const prov = classifyScope(c.scope);
  return {
    id: c.id, type: 'chunk', path: c.path, line: c.start_line,
    label: (c.text || '').replace(/^#+\s*/gm, '').trim().slice(0, 120),
    tag: c.chunk_tag || 'UNTAGGED', scope: c.scope, cls: prov.cls, trust: prov.trust,
    created_at: c.created_at, pinned: !!c.pinned, n: 1,
  };
}

const CHUNK_COLS = `id, path, start_line, end_line, text, scope, chunk_tag, created_at, pinned`;

function fileGraph(pathId: string, limit: number, includeSimilar = false) {
  const d = db();
  const chunks = d.prepare(
    `SELECT ${CHUNK_COLS} FROM memory_chunks
     WHERE path = ? AND archived = 0 ORDER BY start_line LIMIT ?`
  ).all(pathId, limit) as any[];
  const ids = chunks.map((c) => c.id);
  const nodes: any[] = [{ id: pathId, type: 'file', path: pathId, n: chunks.length, center: true }];
  const links: any[] = [];
  for (const c of chunks) {
    nodes.push(chunkNodeRow(c));
    links.push({ source: pathId, target: c.id, type: 'contains', w: 1 });
  }
  if (ids.length) attachChunkEdges(d, ids, nodes, links);
  if (includeSimilar && ids.length) attachSimilar(d, ids, nodes, links);
  return { nodes, links, center: pathId };
}

function entityGraph(eid: number, limit: number) {
  const d = db();
  const ent = d.prepare(`SELECT id, canonical, kind FROM memory_entities WHERE id = ?`).get(eid) as any;
  if (!ent) return { nodes: [], links: [], center: null };
  const aliases = d.prepare(
    `SELECT display FROM memory_entity_aliases WHERE entity_id = ?`
  ).all(eid) as { display: string }[];
  const chunks = d.prepare(
    `SELECT ${CHUNK_COLS} FROM memory_chunks c
     JOIN memory_entity_mentions m ON m.chunk_id = c.id
     WHERE m.entity_id = ? AND c.archived = 0
     ORDER BY c.created_at DESC LIMIT ?`
  ).all(eid, limit) as any[];
  const center = `entity:${eid}`;
  const nodes: any[] = [{
    id: center, type: 'entity', label: ent.canonical, kind: ent.kind,
    aliases: aliases.map((a) => a.display), n: chunks.length, center: true,
  }];
  const links: any[] = [];
  for (const c of chunks) {
    nodes.push(chunkNodeRow(c));
    links.push({ source: center, target: c.id, type: 'mention', w: 1 });
  }
  const ids = chunks.map((c) => c.id);
  if (ids.length) attachChunkEdges(d, ids, nodes, links, eid);
  return { nodes, links, center };
}

function chunkGraph(chunkId: string, limit: number, includeSimilar = false) {
  const d = db();
  const c = d.prepare(
    `SELECT ${CHUNK_COLS} FROM memory_chunks WHERE id = ?`
  ).get(chunkId) as any;
  if (!c) return { nodes: [], links: [], center: null };
  const nodes: any[] = [{ ...chunkNodeRow(c), center: true }];
  const links: any[] = [];
  // parent file
  nodes.push({ id: c.path, type: 'file', path: c.path, n: 1 });
  links.push({ source: c.path, target: c.id, type: 'contains', w: 1 });
  // backlinks: chunks whose refs resolve to this chunk's file
  const backlinks = d.prepare(
    `SELECT ${CHUNK_COLS.split(', ').map((x) => 'c.' + x).join(', ')}
     FROM memory_refs r JOIN memory_chunks c ON c.id = r.chunk_id
     WHERE r.target = ? AND c.archived = 0 AND c.id != ? LIMIT ?`
  ).all(c.path, chunkId, limit) as any[];
  for (const b of backlinks) {
    nodes.push(chunkNodeRow(b));
    links.push({ source: b.id, target: c.id, type: 'ref', kind: 'backlink', w: 1 });
  }
  attachChunkEdges(d, [chunkId], nodes, links);
  if (includeSimilar) attachSimilar(d, [chunkId], nodes, links);
  return { nodes, links, center: chunkId };
}

// Shared: entities / refs-out / supersession / conflicts for a set of chunk ids.
function attachChunkEdges(d: DB, ids: string[], nodes: any[], links: any[], skipEntity?: number) {
  const ph = ids.map(() => '?').join(',');
  const seen = new Set(nodes.map((n) => n.id));
  const addNode = (n: any) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };

  const ments = d.prepare(
    `SELECT m.chunk_id, e.id eid, e.canonical, e.kind
     FROM memory_entity_mentions m JOIN memory_entities e ON e.id = m.entity_id
     WHERE m.chunk_id IN (${ph})`
  ).all(...ids) as any[];
  for (const m of ments) {
    if (skipEntity && m.eid === skipEntity) continue;
    addNode({ id: `entity:${m.eid}`, type: 'entity', label: m.canonical, kind: m.kind, n: 1 });
    links.push({ source: `entity:${m.eid}`, target: m.chunk_id, type: 'mention', w: 1 });
  }

  const refs = d.prepare(
    `SELECT chunk_id, kind, target FROM memory_refs
     WHERE chunk_id IN (${ph}) AND target IS NOT NULL`
  ).all(...ids) as any[];
  for (const r of refs) {
    addNode({ id: r.target, type: r.target.startsWith('memory/') ? 'file' : 'doc', path: r.target, n: 1 });
    links.push({ source: r.chunk_id, target: r.target, type: 'ref', kind: r.kind, w: 1 });
  }

  const groups = d.prepare(
    `SELECT chunk_id, group_id, is_canonical, superseded_by, reason
     FROM memory_fact_groups WHERE chunk_id IN (${ph})`
  ).all(...ids) as any[];
  for (const g of groups) {
    if (g.superseded_by) {
      const win = d.prepare(`SELECT ${CHUNK_COLS} FROM memory_chunks WHERE id = ?`).get(g.superseded_by) as any;
      if (win) {
        addNode(chunkNodeRow(win));
        links.push({ source: g.chunk_id, target: g.superseded_by, type: 'superseded', reason: g.reason, w: 1 });
      }
    }
  }

  const confl = d.prepare(
    `SELECT id, import_chunk_id, native_chunk_id, status, slot FROM memory_contradictions
     WHERE import_chunk_id IN (${ph}) OR native_chunk_id IN (${ph})`
  ).all(...ids, ...ids) as any[];
  for (const x of confl) {
    for (const other of [x.import_chunk_id, x.native_chunk_id]) {
      if (!seen.has(other)) {
        const row = d.prepare(`SELECT ${CHUNK_COLS} FROM memory_chunks WHERE id = ?`).get(other) as any;
        if (row) addNode(chunkNodeRow(row));
      }
    }
    if (seen.has(x.import_chunk_id) && seen.has(x.native_chunk_id)) {
      links.push({ source: x.import_chunk_id, target: x.native_chunk_id, type: 'conflict', status: x.status, w: 1 });
    }
  }
}

// ── Graph: the latest memory, in rings ─────────────────────────────────────
// The newest memory Vodou saved, at the centre of its own sky. Everything that
// touches it sits in ring 1, everything one hop further in ring 2, and the rest
// of the constellation stays where it is — ring 3 — so the view reads as a zoom
// INTO the sky rather than a different sky. `ring` is the only thing the UI
// needs: radius, brightness and label density all fall out of it.
const CHUNK_COLS_C = CHUNK_COLS.split(', ').map((x) => 'c.' + x).join(', ');
/** Chunks written this close together in one file count as the same save. */
const BURST_SECONDS = 900;

/** Just "which memory is newest right now" — the poll the Latest view lives on.
 *  One row, no joins, no counts: cheap enough to ask every few seconds forever. */
export function latestId(f: Filters = {}) {
  const w = whereChunks(f, 'c');
  const row = db().prepare(
    `SELECT c.id, c.created_at FROM memory_chunks c
     WHERE ${w.sql} ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
  ).get(...w.params) as { id: string; created_at: string } | undefined;
  return row || { id: null, created_at: null };
}

export function latestGraph(
  f: Filters = {},
  opts: {
    seedId?: string;        // pin a specific memory instead of "the newest"
    coreCap?: number;       // ring 0 — the save burst around the seed
    ring1Cap?: number;      // ring 1 — memories that touch it
    ring2Cap?: number;      // ring 2 — one hop further
    ambientFiles?: number;  // ring 3 — the rest of the sky
    includeSimilar?: boolean;
  } = {},
) {
  const d = db();
  const coreCap = opts.coreCap ?? 8;
  const ring1Cap = opts.ring1Cap ?? 28;
  const ring2Cap = opts.ring2Cap ?? 60;
  const w = whereChunks(f, 'c');

  const seed = (opts.seedId
    ? d.prepare(`SELECT ${CHUNK_COLS_C} FROM memory_chunks c WHERE c.id = ?`).get(opts.seedId)
    : d.prepare(
      `SELECT ${CHUNK_COLS_C} FROM memory_chunks c
       WHERE ${w.sql} ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
    ).get(...w.params)) as any;
  if (!seed) return { nodes: [], links: [], center: null, seed: null, layers: {} };

  const nodes = new Map<string, any>();
  const links: any[] = [];
  const put = (n: any, ring: number) => {
    const have = nodes.get(n.id);
    if (have) { if (ring < have.ring) have.ring = ring; return have; }
    const fresh = { ...n, ring };
    nodes.set(n.id, fresh);
    return fresh;
  };

  // ── ring 0: the memory itself, the file it lives in, the save it arrived with
  put({ ...chunkNodeRow(seed), center: true, core: true }, 0);
  const burst = d.prepare(
    `SELECT ${CHUNK_COLS_C} FROM memory_chunks c
     WHERE c.path = ? AND c.archived = 0 AND c.id != ?
       AND ABS(strftime('%s', c.created_at) - strftime('%s', ?)) <= ?
     ORDER BY c.created_at DESC LIMIT ?`,
  ).all(seed.path, seed.id, seed.created_at, BURST_SECONDS, coreCap) as any[];
  for (const b of burst) put({ ...chunkNodeRow(b), core: true }, 0);
  const coreIds = [seed.id, ...burst.map((b) => b.id)];

  put({ id: seed.path, type: 'file', path: seed.path, n: coreIds.length, topic: true }, 0);
  for (const id of coreIds) links.push({ source: seed.path, target: id, type: 'contains', w: 1 });

  // The names inside the newest memory — the stars the whole view is grouped by.
  const ph0 = coreIds.map(() => '?').join(',');
  const coreEnts = d.prepare(
    `SELECT m.chunk_id, e.id eid, e.canonical, e.kind, COUNT(m2.chunk_id) n
     FROM memory_entity_mentions m
     JOIN memory_entities e ON e.id = m.entity_id
     LEFT JOIN memory_entity_mentions m2 ON m2.entity_id = e.id
     WHERE m.chunk_id IN (${ph0})
     GROUP BY m.chunk_id, e.id`,
  ).all(...coreIds) as any[];
  for (const m of coreEnts) {
    put({ id: `entity:${m.eid}`, type: 'entity', label: m.canonical, kind: m.kind, n: m.n, eid: m.eid }, 0);
    links.push({ source: `entity:${m.eid}`, target: m.chunk_id, type: 'mention', w: 1 });
  }
  const coreEids = [...new Set(coreEnts.map((m) => m.eid))];

  // Plenty of memories name nobody. Rather than show a centre with no stars
  // around it, fall back to the names that run through the FILE it landed in —
  // the topic it was saved under is the next-best grouping.
  const topicEids = [...coreEids];
  if (!topicEids.length) {
    const fileEnts = d.prepare(
      `SELECT e.id eid, e.canonical, e.kind, COUNT(*) n
       FROM memory_entity_mentions m
       JOIN memory_entities e ON e.id = m.entity_id
       JOIN memory_chunks c ON c.id = m.chunk_id
       WHERE c.path = ? AND c.archived = 0 AND e.kind != 'not_an_entity'
       GROUP BY e.id ORDER BY n DESC LIMIT 6`,
    ).all(seed.path) as any[];
    for (const e of fileEnts) {
      put({ id: `entity:${e.eid}`, type: 'entity', label: e.canonical, kind: e.kind, n: e.n, eid: e.eid, topic: true }, 1);
      links.push({ source: `entity:${e.eid}`, target: seed.path, type: 'mention', w: e.n });
      topicEids.push(e.eid);
    }
  }

  // ── ring 1: memories that share a name with it, its neighbours in the file,
  //           the memories that cite it, and (opt-in) its nearest by meaning.
  const ring1 = new Map<string, any>();
  if (topicEids.length) {
    const phE = topicEids.map(() => '?').join(',');
    const rows = d.prepare(
      `SELECT DISTINCT ${CHUNK_COLS_C}, m.entity_id eid
       FROM memory_chunks c JOIN memory_entity_mentions m ON m.chunk_id = c.id
       WHERE m.entity_id IN (${phE}) AND c.archived = 0 AND c.id NOT IN (${ph0})
       ORDER BY c.created_at DESC LIMIT ?`,
    ).all(...topicEids, ...coreIds, ring1Cap) as any[];
    for (const r of rows) {
      ring1.set(r.id, r);
      put(chunkNodeRow(r), 1);
      links.push({ source: `entity:${r.eid}`, target: r.id, type: 'mention', w: 1 });
    }
  }
  const fileNeighbors = d.prepare(
    `SELECT ${CHUNK_COLS_C} FROM memory_chunks c
     WHERE c.path = ? AND c.archived = 0 AND c.id NOT IN (${ph0})
     ORDER BY c.created_at DESC LIMIT ?`,
  ).all(seed.path, ...coreIds, 14) as any[];
  for (const r of fileNeighbors) {
    if (!ring1.has(r.id)) { ring1.set(r.id, r); put(chunkNodeRow(r), 1); }
    links.push({ source: seed.path, target: r.id, type: 'contains', w: 1 });
  }
  const citedBy = d.prepare(
    `SELECT ${CHUNK_COLS_C} FROM memory_refs r JOIN memory_chunks c ON c.id = r.chunk_id
     WHERE r.target = ? AND c.archived = 0 AND c.id NOT IN (${ph0}) LIMIT 10`,
  ).all(seed.path, ...coreIds) as any[];
  for (const r of citedBy) {
    if (!ring1.has(r.id)) { ring1.set(r.id, r); put(chunkNodeRow(r), 1); }
    links.push({ source: r.id, target: seed.id, type: 'ref', kind: 'backlink', w: 1 });
  }
  if (opts.includeSimilar) {
    for (const { source, nb } of similarForSeeds(coreIds.slice(0, 3))) {
      if (nodes.has(nb.chunk_id) && nodes.get(nb.chunk_id).ring === 0) continue;
      if (!nodes.has(nb.chunk_id)) {
        const row = d.prepare(`SELECT ${CHUNK_COLS_C} FROM memory_chunks c WHERE c.id = ?`).get(nb.chunk_id) as any;
        if (!row) continue;
        ring1.set(row.id, row);
        put(chunkNodeRow(row), 1);
      }
      links.push({ source, target: nb.chunk_id, type: 'similar', w: nb.cos });
    }
  }

  // ── ring 2: the names and files those memories in turn belong to.
  const r1ids = [...ring1.keys()].slice(0, ring2Cap);
  if (r1ids.length) {
    const phR = r1ids.map(() => '?').join(',');
    const ments = d.prepare(
      `SELECT m.chunk_id, e.id eid, e.canonical, e.kind, COUNT(m2.chunk_id) n
       FROM memory_entity_mentions m
       JOIN memory_entities e ON e.id = m.entity_id
       LEFT JOIN memory_entity_mentions m2 ON m2.entity_id = e.id
       WHERE m.chunk_id IN (${phR})
       GROUP BY m.chunk_id, e.id`,
    ).all(...r1ids) as any[];
    for (const m of ments) {
      const id = `entity:${m.eid}`;
      put({ id, type: 'entity', label: m.canonical, kind: m.kind, n: m.n, eid: m.eid }, 2);
      if (!topicEids.includes(m.eid)) links.push({ source: id, target: m.chunk_id, type: 'mention', w: 1 });
    }
    const paths = [...new Set(r1ids.map((id) => ring1.get(id).path))].filter((p) => p !== seed.path);
    if (paths.length) {
      const phP = paths.map(() => '?').join(',');
      const fileRows = d.prepare(
        `SELECT c.path, COUNT(*) n, MAX(c.created_at) last FROM memory_chunks c
         WHERE c.path IN (${phP}) AND c.archived = 0 GROUP BY c.path`,
      ).all(...paths) as any[];
      for (const fr of fileRows) put({ id: fr.path, type: 'file', path: fr.path, n: fr.n, last: fr.last }, 2);
      for (const id of r1ids) {
        const p = ring1.get(id).path;
        if (p !== seed.path && nodes.has(p)) links.push({ source: p, target: id, type: 'contains', w: 1 });
      }
    }
  }
  // Conflicts / supersessions / citations touching the inner two rings — the
  // things you most want to see about a memory you just saved.
  attachChunkEdgesRinged(d, [...coreIds, ...r1ids], nodes, links, put);

  // Last rung of the ladder: a memory that names nobody, in a file that names
  // nobody, can still borrow the names its *related* memories carry. Promote the
  // busiest of them out of the backdrop so the view has stars to group under.
  if (!topicEids.length) {
    const borrowed = [...nodes.values()]
      .filter((n) => n.type === 'entity' && n.ring === 2 && n.kind !== 'not_an_entity')
      .sort((a, b) => (b.n || 0) - (a.n || 0))
      .slice(0, 4);
    for (const e of borrowed) { e.ring = 1; e.topic = true; topicEids.push(e.eid); }
  }

  // ── ring 3: the rest of the sky, unchanged and far away.
  const ambient = graphOverview(f, opts.ambientFiles ?? 160, 24, false) as
    { nodes: any[]; links: any[] };
  for (const n of ambient.nodes) {
    if (!nodes.has(n.id)) nodes.set(n.id, { ...n, ring: 3 });
  }
  for (const l of ambient.links) {
    const a = nodes.get(typeof l.source === 'string' ? l.source : l.source.id);
    const b = nodes.get(typeof l.target === 'string' ? l.target : l.target.id);
    // Ambient edges are backdrop only: an inner node dragged into a 200-edge
    // hairball stops being the centre of anything.
    if (a && b && a.ring === 3 && b.ring === 3) links.push(l);
  }

  // The one thing this whole sky is grouped under. A name when the memory has
  // one; otherwise the file it was saved in — for a daily log that reads as the
  // date, which is the truthful answer to "what topic was this saved under".
  const topicNode = topicEids.length ? nodes.get(`entity:${topicEids[0]}`) : nodes.get(seed.path);
  if (topicNode) topicNode.topic = true;

  const list = [...nodes.values()];
  const layers = { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  for (const n of list) layers[n.ring] = (layers[n.ring] || 0) + 1;
  return {
    nodes: list,
    links,
    center: seed.id,
    seed: {
      ...chunkNodeRow(seed),
      text: seed.text,
      entities: coreEnts
        .filter((m, i, arr) => arr.findIndex((x) => x.eid === m.eid) === i)
        .map((m) => ({ id: m.eid, canonical: m.canonical, kind: m.kind, n: m.n })),
      // The stars this view is grouped under — the memory's own names, or the
      // file's when it names nobody. `borrowed` says which, so the UI can be honest.
      stars: topicEids.map((eid) => {
        const n = nodes.get(`entity:${eid}`);
        return { id: eid, canonical: n?.label, kind: n?.kind, n: n?.n };
      }),
      starsBorrowed: !coreEids.length && topicEids.length > 0,
      topic: topicNode ? {
        id: topicNode.id,
        type: topicNode.type,
        label: topicNode.type === 'entity' ? topicNode.label : topicNode.path,
      } : null,
      burst: burst.length,
    },
    layers,
  };
}

/** attachChunkEdges, but every node it invents lands in a ring. */
function attachChunkEdgesRinged(
  d: DB, ids: string[], nodes: Map<string, any>, links: any[],
  put: (n: any, ring: number) => any,
) {
  if (!ids.length) return;
  const staged: any[] = [];
  const stagedLinks: any[] = [];
  attachChunkEdges(d, ids, staged, stagedLinks);
  for (const n of staged) if (!nodes.has(n.id)) put(n, 2);
  for (const l of stagedLinks) {
    // mention edges are already drawn per-ring above; the rest are the story.
    if (l.type === 'mention') continue;
    if (nodes.has(l.source) && nodes.has(l.target)) links.push(l);
  }
}

// ── Detail: one chunk, fully hydrated ──────────────────────────────────────
export function nodeDetail(id: string) {
  const d = db();
  const c = d.prepare(
    `SELECT id, path, start_line, end_line, text, scope, chunk_tag, created_at,
            pinned, project_id, extractor_backend, archived
     FROM memory_chunks WHERE id = ?`
  ).get(id) as any;
  if (!c) return null;
  const prov = classifyScope(c.scope);
  const entities = d.prepare(
    `SELECT e.id, e.canonical, e.kind FROM memory_entity_mentions m
     JOIN memory_entities e ON e.id = m.entity_id WHERE m.chunk_id = ?`
  ).all(id);
  const refsOut = d.prepare(
    `SELECT kind, raw, target FROM memory_refs WHERE chunk_id = ? ORDER BY offset`
  ).all(id);
  const backlinks = d.prepare(
    `SELECT c.id, c.path, c.start_line, substr(c.text, 1, 200) preview, c.chunk_tag, c.created_at
     FROM memory_refs r JOIN memory_chunks c ON c.id = r.chunk_id
     WHERE r.target = ? AND c.id != ? AND c.archived = 0 LIMIT 50`
  ).all(c.path, id);
  const group = d.prepare(
    `SELECT group_id, is_canonical, superseded_by, reason FROM memory_fact_groups WHERE chunk_id = ?`
  ).get(id) as any;
  let siblings: unknown[] = [];
  if (group) {
    siblings = d.prepare(
      `SELECT g.chunk_id, g.is_canonical, g.superseded_by, substr(c.text,1,160) preview, c.scope, c.created_at
       FROM memory_fact_groups g JOIN memory_chunks c ON c.id = g.chunk_id
       WHERE g.group_id = ? AND g.chunk_id != ?`
    ).all(group.group_id, id);
  }
  const conflicts = d.prepare(
    `SELECT id, slot, import_value, native_value, import_chunk_id, native_chunk_id,
            import_scope, native_scope, status, cosine, created_at, resolved_at
     FROM memory_contradictions WHERE import_chunk_id = ? OR native_chunk_id = ?`
  ).all(id, id);
  return { ...c, pinned: !!c.pinned, ...prov, entities, refsOut, backlinks, group: group || null, siblings, conflicts };
}

export function fileDetail(pathId: string, limit = 400) {
  const d = db();
  const chunks = d.prepare(
    `SELECT id, path, start_line, end_line, text, scope, chunk_tag, created_at, pinned
     FROM memory_chunks WHERE path = ? AND archived = 0 ORDER BY start_line LIMIT ?`
  ).all(pathId, limit) as any[];
  return {
    path: pathId,
    chunks: chunks.map((c) => ({ ...c, pinned: !!c.pinned, ...classifyScope(c.scope) })),
  };
}

export function entityDetail(eid: number, limit = 100) {
  const d = db();
  const ent = d.prepare(`SELECT id, canonical, kind FROM memory_entities WHERE id = ?`).get(eid) as any;
  if (!ent) return null;
  const aliases = d.prepare(
    `SELECT display, derived FROM memory_entity_aliases WHERE entity_id = ?`
  ).all(eid);
  const mentions = d.prepare(
    `SELECT c.id, c.path, c.start_line, substr(c.text,1,200) preview, c.chunk_tag, c.scope, c.created_at
     FROM memory_entity_mentions m JOIN memory_chunks c ON c.id = m.chunk_id
     WHERE m.entity_id = ? AND c.archived = 0 ORDER BY c.created_at DESC LIMIT ?`
  ).all(eid, limit) as any[];
  return {
    ...ent, aliases,
    mentions: mentions.map((m) => ({ ...m, ...classifyScope(m.scope) })),
  };
}

// ── Search (FTS5 bm25 — fast typeahead; ranked semantic search stays with
//    the daemon pipeline via `vodou-core mem search`) ───────────────────────
export function search(q: string, limit = 20, includeArchived = false) {
  const tokens = q.split(/\s+/)
    .map((t) => t.replace(/[^\w'-]/g, '').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  if (!tokens.length) return [];
  const rows = db().prepare(
    `SELECT c.id, c.path, c.start_line, c.chunk_tag, c.scope, c.created_at, c.pinned,
            snippet(memory_fts, 1, char(1), char(2), '…', 20) snip
     FROM memory_fts f JOIN memory_chunks c ON c.rowid = f.rowid
     WHERE memory_fts MATCH ? ${includeArchived ? '' : 'AND c.archived = 0'}
     ORDER BY bm25(memory_fts) LIMIT ?`
  ).all(tokens.join(' '), limit) as any[];
  return rows.map((r) => ({
    ...r,
    // snippet() emits control-byte match markers on this sqlite build — strip them.
    snip: String(r.snip || '').replace(/[\u0000-\u0008\u000B-\u001F]/g, ''),
    pinned: !!r.pinned,
    ...classifyScope(r.scope),
  }));
}

// ── Timeline ───────────────────────────────────────────────────────────────
export function timeline(days = 90, includeArchived = false) {
  return db().prepare(
    `SELECT date(created_at, 'localtime') day, COALESCE(NULLIF(chunk_tag,''),'UNTAGGED') tag, COUNT(*) n
     FROM memory_chunks
     WHERE ${includeArchived ? '1=1' : 'archived = 0'} AND created_at >= datetime('now', ?)
     GROUP BY day, tag ORDER BY day`
  ).all(`-${Math.floor(days)} days`);
}

// ── Conflicts ──────────────────────────────────────────────────────────────
export function conflicts(status?: string) {
  const base = `SELECT id, slot, import_chunk_id, native_chunk_id, import_value, native_value,
                       import_text, native_text, import_scope, native_scope, cosine,
                       status, created_at, resolved_at
                FROM memory_contradictions`;
  const rows = (status
    ? db().prepare(`${base} WHERE status = ? ORDER BY created_at DESC`).all(status)
    : db().prepare(`${base} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC`).all()
  ) as any[];
  return rows;
}

// ── Web of names: entity ↔ entity ─────────────────────────────────────────
// The constellation shows stars with the memories underneath them. This shows
// the stars *alone* and the lines between them: two names are linked when a
// memory names them both, the weight is how many memories say so, and every
// line can be opened to read the memories that justify it. Same filters as the
// rest of the console — the web narrows with the sky.

type Pair = { e1: number; e2: number; w: number };
/** How close two names have to be to count as linked.
 *  'chunk' — named in the *same memory* (strict, and sparse: entity extraction
 *  works a sentence at a time). 'file' — named in the same memory file: the same
 *  day's log, the same imported doc. Looser, and about 15× denser in practice. */
export type Closeness = 'chunk' | 'file';

/** Kinds a name can be. `not_an_entity` is the classifier's junk verdict; the
 *  regex-era values (name/org/handle) are what an unclassified row still says. */
export const ENTITY_KINDS = [
  'person', 'org', 'product', 'place', 'project', 'event', 'handle',
  'name', 'not_an_entity',
] as const;

/** SQL fragment restricting a joined entity alias to the requested kinds.
 *  Applied INSIDE the pair query so the node cap selects from the kept set —
 *  filtering afterwards would spend the 220-node budget on names about to be
 *  thrown away. */
function kindClause(alias: string, kinds?: string[]): { sql: string; params: string[] } {
  if (!kinds || !kinds.length) return { sql: '', params: [] };
  return {
    sql: ` AND ${alias}.kind IN (${kinds.map(() => '?').join(',')})`,
    params: kinds,
  };
}

/** Co-mention pairs under the active filters. `only` restricts to a node set. */
function coPairs(
  d: DB, f: Filters, minW: number, limit: number,
  only?: number[], by: Closeness = 'chunk', kinds?: string[],
): Pair[] {
  const inSet = (col: string) => (only && only.length
    ? ` AND ${col} IN (${only.map(() => '?').join(',')})` : '');
  const setParams = only && only.length ? [...only, ...only] : [];
  const ka = kindClause('ea', kinds);
  const kb = kindClause('eb', kinds);
  const kindJoin = kinds && kinds.length
    ? (aCol: string, bCol: string) =>
      ` JOIN memory_entities ea ON ea.id = ${aCol} JOIN memory_entities eb ON eb.id = ${bCol}`
    : () => '';
  if (by === 'chunk') {
    const w = whereChunks(f);
    return d.prepare(
      `SELECT a.entity_id e1, b.entity_id e2, COUNT(DISTINCT a.chunk_id) w
       FROM memory_entity_mentions a
       JOIN memory_entity_mentions b ON b.chunk_id = a.chunk_id AND a.entity_id < b.entity_id
       JOIN memory_chunks c ON c.id = a.chunk_id${kindJoin('a.entity_id', 'b.entity_id')}
       WHERE ${w.sql}${inSet('a.entity_id')}${inSet('b.entity_id')}${ka.sql}${kb.sql}
       GROUP BY e1, e2 HAVING w >= ? ORDER BY w DESC LIMIT ?`
    ).all(...w.params, ...setParams, ...ka.params, ...kb.params, minW, limit) as Pair[];
  }
  const wa = whereChunks(f, 'ca');
  const wb = whereChunks(f, 'cb');
  return d.prepare(
    `SELECT ma.entity_id e1, mb.entity_id e2, COUNT(DISTINCT ca.path) w
     FROM memory_entity_mentions ma
     JOIN memory_chunks ca ON ca.id = ma.chunk_id
     JOIN memory_chunks cb ON cb.path = ca.path
     JOIN memory_entity_mentions mb ON mb.chunk_id = cb.id AND mb.entity_id > ma.entity_id${kindJoin('ma.entity_id', 'mb.entity_id')}
     WHERE ${wa.sql} AND ${wb.sql}${inSet('ma.entity_id')}${inSet('mb.entity_id')}${ka.sql}${kb.sql}
     GROUP BY e1, e2 HAVING w >= ? ORDER BY w DESC LIMIT ?`
  ).all(...wa.params, ...wb.params, ...setParams, ...ka.params, ...kb.params, minW, limit) as Pair[];
}

type EntMeta = { id: number; canonical: string; kind: string; n: number };
/** canonical/kind + mention count under the filters, for a set of entity ids. */
function entityMeta(d: DB, f: Filters, ids?: number[]): EntMeta[] {
  if (ids && ids.length === 0) return [];
  const w = whereChunks(f);
  const scope = ids ? ` AND e.id IN (${ids.map(() => '?').join(',')})` : '';
  return d.prepare(
    `SELECT e.id, e.canonical, e.kind, COUNT(DISTINCT m.chunk_id) n
     FROM memory_entities e
     JOIN memory_entity_mentions m ON m.entity_id = e.id
     JOIN memory_chunks c ON c.id = m.chunk_id
     WHERE ${w.sql}${scope}
     GROUP BY e.id`
  ).all(...w.params, ...(ids || [])) as EntMeta[];
}

const entNode = (m: EntMeta, extra: Record<string, unknown> = {}): any => ({
  id: `entity:${m.id}`, eid: m.id, type: 'entity',
  label: m.canonical, kind: m.kind, n: m.n, ...extra,
});

/** Typed relations for the pairs present in a graph (P5). Absent table or no
 *  verdict simply means the edge stays an untyped co-mention — the view must
 *  work identically before the classifier has ever run. */
type Rel = { predicate: string; subject_is_a: number; confidence: string | null; evidence_chunk_id: string | null };
function relationsFor(d: DB, ids: number[]): Map<string, Rel> {
  const out = new Map<string, Rel>();
  if (!ids.length) return out;
  try {
    const rows = d.prepare(
      `SELECT a_id, b_id, predicate, subject_is_a, confidence, evidence_chunk_id
       FROM memory_entity_relations
       WHERE predicate != 'none'
         AND a_id IN (${ids.map(() => '?').join(',')})
         AND b_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids, ...ids) as (Rel & { a_id: number; b_id: number })[];
    for (const r of rows) {
      out.set(`${r.a_id}:${r.b_id}`, {
        predicate: r.predicate, subject_is_a: r.subject_is_a,
        confidence: r.confidence, evidence_chunk_id: r.evidence_chunk_id,
      });
    }
  } catch { /* table not created yet — untyped edges are the correct fallback */ }
  return out;
}

/** Attach predicate + direction to co-mention links, in place. */
function attachRelations(d: DB, nodes: any[], links: any[]) {
  const ids = nodes.filter((n) => n.type === 'entity' && n.eid).map((n) => n.eid as number);
  const rels = relationsFor(d, ids);
  if (!rels.size) return;
  for (const l of links) {
    const a = typeof l.source === 'string' ? parseInt(l.source.slice(7), 10) : l.source;
    const b = typeof l.target === 'string' ? parseInt(l.target.slice(7), 10) : l.target;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const rel = rels.get(`${lo}:${hi}`);
    if (!rel) continue;
    l.predicate = rel.predicate;
    l.confidence = rel.confidence;
    l.evidence = rel.evidence_chunk_id;
    // Direction is stored against (lo, hi); re-express it for THIS link's ends.
    const subjectId = rel.subject_is_a ? lo : hi;
    l.from = `entity:${subjectId}`;
    l.to = `entity:${subjectId === lo ? hi : lo}`;
  }
}

/** The whole sky of names — every entity that shares a memory with another. */
export function entityNet(
  f: Filters = {}, minW = 1, maxNodes = 220, maxEdges = 900,
  by: Closeness = 'chunk', kinds?: string[],
) {
  const d = db();
  const pairs = coPairs(d, f, Math.max(1, minW), maxEdges, undefined, by, kinds);
  const strength = new Map<number, number>();
  for (const p of pairs) {
    strength.set(p.e1, (strength.get(p.e1) || 0) + p.w);
    strength.set(p.e2, (strength.get(p.e2) || 0) + p.w);
  }
  // Isolated names are noise here — a web is what's connected.
  const ranked = [...strength.entries()].sort((a, b) => b[1] - a[1]);
  const keep = ranked.slice(0, maxNodes).map(([id]) => id);
  const byId = new Map<number, any>();
  for (const m of entityMeta(d, f, keep)) {
    byId.set(m.id, entNode(m, { degree: 0, strength: strength.get(m.id) || 0 }));
  }
  const links: unknown[] = [];
  for (const p of pairs) {
    const a = byId.get(p.e1), b = byId.get(p.e2);
    if (!a || !b) continue;
    a.degree++; b.degree++;
    links.push({ source: a.id, target: b.id, type: 'comention', w: p.w });
  }
  const nodesOut = [...byId.values()];
  attachRelations(d, nodesOut, links as any[]);
  return {
    nodes: nodesOut, links, web: true, minW, by, kinds: kinds || null,
    truncated: ranked.length > keep.length,
    // The edge LIMIT is ordered by weight, so hitting it means "there are more,
    // weaker links than these". Silent truncation reads as "that's all there is".
    edgesCapped: pairs.length >= maxEdges,
    edgeCap: maxEdges,
  };
}

/** One name's neighborhood: who it appears with, and how they connect to each
 *  other (ring-2 optional). The triangles are the point — a fan tells you less. */
export function entityEgo(
  eid: number, f: Filters = {}, depth = 1, limit = 36, minW = 1,
  by: Closeness = 'chunk', kinds?: string[],
) {
  const d = db();
  const ent = d.prepare(
    `SELECT id, canonical, kind FROM memory_entities WHERE id = ?`
  ).get(eid) as { id: number; canonical: string; kind: string } | undefined;
  if (!ent) return { nodes: [], links: [], center: null, connections: [] };
  const w = whereChunks(f);
  const wa = whereChunks(f, 'ca');
  const wb = whereChunks(f, 'cb');
  const aliases = d.prepare(
    `SELECT display FROM memory_entity_aliases WHERE entity_id = ? AND display != ?`
  ).all(eid, ent.canonical) as { display: string }[];

  const partners = (of: number, take: number, floor: number) => (by === 'chunk'
    ? d.prepare(
      `SELECT b.entity_id other, COUNT(DISTINCT a.chunk_id) w
       FROM memory_entity_mentions a
       JOIN memory_entity_mentions b ON b.chunk_id = a.chunk_id AND b.entity_id != a.entity_id
       JOIN memory_chunks c ON c.id = a.chunk_id
       WHERE a.entity_id = ? AND ${w.sql}
       GROUP BY other HAVING w >= ? ORDER BY w DESC LIMIT ?`
    ).all(of, ...w.params, floor, take)
    : d.prepare(
      `SELECT mb.entity_id other, COUNT(DISTINCT ca.path) w
       FROM memory_entity_mentions ma
       JOIN memory_chunks ca ON ca.id = ma.chunk_id
       JOIN memory_chunks cb ON cb.path = ca.path
       JOIN memory_entity_mentions mb ON mb.chunk_id = cb.id AND mb.entity_id != ma.entity_id
       WHERE ma.entity_id = ? AND ${wa.sql} AND ${wb.sql}
       GROUP BY other HAVING w >= ? ORDER BY w DESC LIMIT ?`
    ).all(of, ...wa.params, ...wb.params, floor, take)) as { other: number; w: number }[];

  const ring = new Map<number, number>([[eid, 0]]);
  const weightToCenter = new Map<number, number>();
  for (const r of partners(eid, limit, Math.max(1, minW))) {
    ring.set(r.other, 1);
    weightToCenter.set(r.other, r.w);
  }
  if (depth >= 2) {
    const inner = [...ring.keys()].filter((id) => ring.get(id) === 1).slice(0, 12);
    for (const nb of inner) {
      if (ring.size > 70) break;
      for (const r of partners(nb, 4, Math.max(2, minW))) {
        if (!ring.has(r.other)) ring.set(r.other, 2);
      }
    }
  }

  const ids = [...ring.keys()];
  const meta = new Map(entityMeta(d, f, ids).map((m) => [m.id, m]));
  const nodes = ids.filter((id) => meta.has(id)).map((id) => entNode(meta.get(id)!, {
    ring: ring.get(id), center: id === eid,
    w: weightToCenter.get(id) || 0,
  }));
  const present = new Set(nodes.map((n) => n.eid));
  const links = coPairs(d, f, Math.max(1, minW), 1200, [...present], by, kinds)
    .map((p) => ({ source: `entity:${p.e1}`, target: `entity:${p.e2}`, type: 'comention', w: p.w }));

  attachRelations(d, nodes, links as any[]);
  const relByOther = new Map<number, any>();
  for (const l of links as any[]) {
    if (!l.predicate) continue;
    const a = parseInt(String(l.source).slice(7), 10);
    const b = parseInt(String(l.target).slice(7), 10);
    const other = a === eid ? b : (b === eid ? a : null);
    if (other != null) relByOther.set(other, l);
  }
  const connections = nodes
    .filter((n) => n.ring === 1)
    .sort((a, b) => (b.w as number) - (a.w as number))
    .map((n) => {
      const rel = relByOther.get(n.eid);
      return {
        id: n.eid, canonical: n.label, kind: n.kind, w: n.w, mentions: n.n,
        predicate: rel?.predicate ?? null,
        // true when the CENTRE is the subject: "you founded X" vs "X employs you".
        centre_is_subject: rel ? rel.from === `entity:${eid}` : null,
      };
    });

  return {
    nodes, links, web: true, center: `entity:${eid}`, depth, minW, by,
    entity: { ...ent, aliases: aliases.map((a) => a.display) },
    connections,
  };
}

/** Why two names are linked: the memories that name them both. */
export function entityPair(a: number, b: number, f: Filters = {}, limit = 40, by: Closeness = 'chunk') {
  const d = db();
  const w = whereChunks(f);
  const ents = d.prepare(
    `SELECT id, canonical, kind FROM memory_entities WHERE id IN (?, ?)`
  ).all(a, b) as { id: number; canonical: string; kind: string }[];
  const head = (rows: any[], total: number, files: number) => ({
    a: ents.find((e) => e.id === a) || null,
    b: ents.find((e) => e.id === b) || null,
    by, total, files,
    memories: rows.map((r) => ({
      ...r, pinned: !!r.pinned, both: !!r.both, ...classifyScope(r.scope),
    })),
  });

  if (by === 'chunk') {
    const from = `FROM memory_chunks c
       JOIN memory_entity_mentions ma ON ma.chunk_id = c.id AND ma.entity_id = ?
       JOIN memory_entity_mentions mb ON mb.chunk_id = c.id AND mb.entity_id = ?
       WHERE ${w.sql}`;
    const total = (d.prepare(`SELECT COUNT(DISTINCT c.id) n ${from}`)
      .get(a, b, ...w.params) as { n: number }).n;
    const rows = d.prepare(
      `SELECT DISTINCT c.id, c.path, c.start_line, substr(c.text, 1, 260) preview,
              c.chunk_tag, c.scope, c.created_at, c.pinned, 1 both
       ${from} ORDER BY c.created_at DESC LIMIT ?`
    ).all(a, b, ...w.params, limit) as any[];
    return head(rows, total, new Set(rows.map((r) => r.path)).size);
  }

  // File closeness: the memories living in files where both names appear. The
  // ones naming both outright sort first — that's the strongest evidence there is.
  const wa = whereChunks(f, 'ca');
  const wb = whereChunks(f, 'cb');
  const shared = `SELECT ca.path FROM memory_entity_mentions ma
       JOIN memory_chunks ca ON ca.id = ma.chunk_id
       WHERE ma.entity_id = ? AND ${wa.sql}
     INTERSECT
     SELECT cb.path FROM memory_entity_mentions mb
       JOIN memory_chunks cb ON cb.id = mb.chunk_id
       WHERE mb.entity_id = ? AND ${wb.sql}`;
  const sharedParams = [a, ...wa.params, b, ...wb.params];
  const files = (d.prepare(`SELECT COUNT(*) n FROM (${shared})`)
    .get(...sharedParams) as { n: number }).n;
  const body = `FROM memory_chunks c
     JOIN memory_entity_mentions m ON m.chunk_id = c.id AND m.entity_id IN (?, ?)
     WHERE c.path IN (${shared}) AND ${w.sql}`;
  const total = (d.prepare(`SELECT COUNT(DISTINCT c.id) n ${body}`)
    .get(a, b, ...sharedParams, ...w.params) as { n: number }).n;
  const rows = d.prepare(
    `SELECT c.id, c.path, c.start_line, substr(c.text, 1, 260) preview,
            c.chunk_tag, c.scope, c.created_at, c.pinned,
            (MAX(m.entity_id = ?) AND MAX(m.entity_id = ?)) both
     ${body}
     GROUP BY c.id ORDER BY both DESC, c.created_at DESC LIMIT ?`
  ).all(a, b, a, b, ...sharedParams, ...w.params, limit) as any[];
  return head(rows, total, files);
}

// ── Entities list ──────────────────────────────────────────────────────────
export function entities() {
  return db().prepare(
    `SELECT e.id, e.canonical, e.kind, COUNT(m.chunk_id) mentions,
            GROUP_CONCAT(DISTINCT a.display) aliases
     FROM memory_entities e
     LEFT JOIN memory_entity_mentions m ON m.entity_id = e.id
     LEFT JOIN memory_entity_aliases a ON a.entity_id = e.id AND a.display != e.canonical
     GROUP BY e.id ORDER BY mentions DESC`
  ).all();
}
