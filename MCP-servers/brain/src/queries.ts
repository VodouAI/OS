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
import { fileURLToPath } from 'node:url';
import { open, DB } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/queries.js → ../../.. = project root (memory.db lives next to vodou-core.db)
export const projectRoot = path.resolve(__dirname, '..', '..', '..');
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
  return { sql: conds.length ? conds.join(' AND ') : '1=1', params };
}

// Project id → display name. The NAMES live in the gateway's `projects` table (a
// separate DB); memory.db only carries `project_id`. Brain is memory.db-first, so we
// open gateway.db read-only just for the label map. Best-effort: absent/locked → ids
// fall back to raw. Cached (names change rarely; a brain restart refreshes).
let _projectNames: Map<string, string> | null = null;
function projectNames(): Map<string, string> {
  if (_projectNames) return _projectNames;
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
    `SELECT date(created_at) day, COALESCE(NULLIF(chunk_tag,''),'UNTAGGED') tag, COUNT(*) n
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
