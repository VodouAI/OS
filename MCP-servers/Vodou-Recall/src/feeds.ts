/**
 * Vodou-Recall feeds — "what is new since X" over Vodou's own tables.
 *
 * PLAN-AUTOMATIONS-WATCH-WHAT-VODOU-KNOWS P1. Every other Recall tool answers a
 * QUERY ("find me…"); these answer a FEED ("what appeared after this cursor"),
 * which is the shape the automation engine's `extract_events` consumes
 * (`src/automations.rs`): `{ items: [{ id, at, … }], cursor }`. The engine
 * stores `cursor` in the automation's state and passes it back as
 * `since_cursor`, so a feed never relies on the engine's 500-id memory.
 *
 * Cursor = `<timestamp>|<id>` of the last item returned, ordered by
 * (timestamp, id). Opaque to callers; only ever handed back verbatim.
 *
 * Without a cursor a feed returns the NEWEST `limit` items (the engine's first
 * run seeds from them and fires nothing). With a cursor it returns the OLDEST
 * items after the cursor, so a backlog drains in order across runs.
 *
 * All reads are read-only opens of the owner's file. The contract is pinned
 * from the Rust side by `automations::feed_contract_tests`.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface FeedPaths {
  gatewayDb: string;
  memoryDb: string;
  coreDb: string;
  /** Project root — `feed_json_file` paths resolve under it and never outside it. */
  projectRoot?: string;
}

export interface FeedItem {
  id: string;
  at: string;
  [k: string]: unknown;
}

export interface FeedResult {
  feed: string;
  items: FeedItem[];
  count: number;
  cursor: string | null;
  note?: string;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const TEXT_CAP = 500;

export const FEED_TOOL_NAMES = [
  'feed_captures',
  'feed_memories',
  'feed_contradictions',
  'feed_extraction_failures',
  'feed_json_file',
] as const;
export type FeedToolName = (typeof FEED_TOOL_NAMES)[number];

const cursorProp = {
  since_cursor: {
    type: 'string',
    description:
      'Opaque cursor from a previous call. Omit for the newest items; pass it back to get only what appeared after it.',
  },
  limit: {
    type: 'integer',
    description: `Max items. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
    minimum: 1,
    maximum: MAX_LIMIT,
  },
} as const;

/** Tool definitions, in the shape `Server` lists them. */
export const FEED_TOOLS = [
  {
    name: 'feed_captures',
    description:
      'New captured conversations (ChatGPT, Claude, Claude Code, channels) since a cursor. ' +
      'Returns {items:[{id, at, title, source, source_url, message_count}], cursor}. ' +
      'Feed-shaped for automations: poll it, act on each new item.',
    inputSchema: {
      type: 'object',
      properties: {
        source_glob: {
          type: 'string',
          description: "SQLite GLOB on gateway_conversations.source, e.g. 'capture:web:*'. Default 'capture:*'.",
        },
        ...cursorProp,
      },
      required: [],
    },
  },
  {
    name: 'feed_memories',
    description:
      'New durable memory chunks since a cursor, filterable by tag, scope and importance. ' +
      'Returns {items:[{id, at, tag, scope, text, importance, pinned, source_url}], cursor}. ' +
      "Feed-shaped for automations, e.g. tag='DECISION', scope_glob='capture:web:*'.",
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Exact chunk_tag, e.g. DECISION, PREF, COMMITMENT.' },
        scope_glob: { type: 'string', description: "SQLite GLOB on scope, e.g. 'capture:*' or 'web'." },
        min_importance: { type: 'integer', description: 'Only chunks with importance >= this.' },
        pinned_only: { type: 'boolean', description: 'Only pinned chunks.' },
        ...cursorProp,
      },
      required: [],
    },
  },
  {
    name: 'feed_contradictions',
    description:
      'Open memory contradictions since a cursor (two stored values for one slot). ' +
      'Returns {items:[{id, at, slot, import_value, native_value, import_scope, native_scope, cosine, status}], cursor}. ' +
      "Feed-shaped for automations, e.g. slot_glob='client.*'.",
    inputSchema: {
      type: 'object',
      properties: {
        slot_glob: { type: 'string', description: "SQLite GLOB on slot, e.g. 'client.*'." },
        ...cursorProp,
      },
      required: [],
    },
  },
  {
    name: 'feed_json_file',
    description:
      'New items in a JSON file a script maintains (a ledger, a results file) since a cursor. ' +
      'Path is relative to the project root and must stay inside it. ' +
      'Returns {items:[{id, at, …the item}], cursor}. Feed-shaped for automations: e.g. the growth hunt writes ' +
      ".vodou/growth/leads.json — items_path 'leads', id_field 'id', at_field 'found_at'.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "File path relative to the project root, e.g. '.vodou/growth/leads.json'." },
        items_path: { type: 'string', description: "Dotted path to the array inside the file, e.g. 'leads'. Omit when the file IS the array (or has 'items')." },
        id_field: { type: 'string', description: "Field holding each item's id. Default 'id'." },
        at_field: { type: 'string', description: "Field holding each item's timestamp (any sortable string). Default 'at'." },
        where: {
          type: 'object',
          description: "Equality filters on item fields, e.g. {\"status\":\"new\"} — an item must match every key. Values compare as strings.",
        },
        min: {
          type: 'object',
          description: "Numeric floors, e.g. {\"score\":5} — keeps an item whose field is a number >= the value. A missing or non-numeric field does NOT pass: a floor is a claim about a number, and an item without one has not met it.",
        },
        max: {
          type: 'object',
          description: "Numeric ceilings, e.g. {\"age_days\":60} — keeps an item whose field is a number <= the value. Same rule for missing or non-numeric fields as `min`.",
        },
        ...cursorProp,
      },
      required: ['path'],
    },
  },
  {
    name: 'feed_extraction_failures',
    description:
      'Extraction-queue spans that FAILED since a cursor (operator audience: about Vodou, not the user). ' +
      'Returns {items:[{id, at, source, conversation_id, span_start, span_end, state, attempts, last_error}], cursor}.',
    inputSchema: {
      type: 'object',
      properties: { ...cursorProp },
      required: [],
    },
  },
];

// ── helpers ──────────────────────────────────────────────────────────────

function clampLimit(raw: unknown): number {
  const n = Number(raw ?? DEFAULT_LIMIT);
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function parseCursor(raw: unknown): { at: string; id: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const i = raw.indexOf('|');
  if (i <= 0) return null;
  return { at: raw.slice(0, i), id: raw.slice(i + 1) };
}

function cap(s: unknown): string {
  const t = s == null ? '' : String(s);
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + '…' : t;
}

/**
 * Run a (timestamp, id)-keyed feed query. `select` must end with a `WHERE …`
 * fragment that already includes its own filters; this appends the cursor
 * predicate, ordering and limit. `tsCol` / `idCol` are the ordering columns.
 */
function pageRows<T extends { at: string; id: string }>(
  db: DatabaseSync,
  select: string,
  params: unknown[],
  tsCol: string,
  idCol: string,
  cursor: { at: string; id: string } | null,
  limit: number,
  map: (r: Record<string, unknown>) => T,
): { items: T[]; cursor: string | null } {
  let sql = select;
  const p = [...params];
  if (cursor) {
    sql += ` AND (${tsCol} > ? OR (${tsCol} = ? AND ${idCol} > ?)) ORDER BY ${tsCol} ASC, ${idCol} ASC LIMIT ?`;
    p.push(cursor.at, cursor.at, cursor.id, limit);
  } else {
    sql += ` ORDER BY ${tsCol} DESC, ${idCol} DESC LIMIT ?`;
    p.push(limit);
  }
  const rows = db.prepare(sql).all(...(p as never[])) as unknown as Record<string, unknown>[];
  const items = rows.map(map);
  if (!cursor) items.reverse(); // newest-first fetch, oldest-first output
  const last = items[items.length - 1];
  return { items, cursor: last ? `${last.at}|${last.id}` : null };
}

function openRo(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true, timeout: 5000 });
}

function missing(feed: string, what: string, path: string): FeedResult {
  return { feed, items: [], count: 0, cursor: null, note: `${what} not found at ${path}` };
}

function failed(feed: string, e: unknown): FeedResult {
  return { feed, items: [], count: 0, cursor: null, note: `${feed} failed: ${(e as Error).message}` };
}

// ── feeds ────────────────────────────────────────────────────────────────

export function feedCaptures(paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  const feed = 'captures';
  if (!existsSync(paths.gatewayDb)) return missing(feed, 'gateway.db', paths.gatewayDb);
  const glob = typeof args.source_glob === 'string' && args.source_glob.trim() ? args.source_glob.trim() : 'capture:*';
  let db: DatabaseSync | undefined;
  try {
    db = openRo(paths.gatewayDb);
    const { items, cursor } = pageRows(
      db,
      `SELECT c.id AS id, c.created_at AS at, c.title, c.source, c.source_url,
              (SELECT count(*) FROM gateway_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM gateway_conversations c
        WHERE c.deleted_at IS NULL AND c.source GLOB ?`,
      [glob],
      'c.created_at',
      'c.id',
      parseCursor(args.since_cursor),
      clampLimit(args.limit),
      (r) => ({
        id: String(r.id),
        at: String(r.at),
        title: r.title == null ? null : cap(r.title),
        source: r.source ?? null,
        source_url: r.source_url ?? null,
        message_count: Number(r.message_count ?? 0),
      }),
    );
    return { feed, items, count: items.length, cursor };
  } catch (e) {
    return failed(feed, e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function feedMemories(paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  const feed = 'memories';
  if (!existsSync(paths.memoryDb)) return missing(feed, 'memory.db', paths.memoryDb);
  const where: string[] = ['archived = 0'];
  const params: unknown[] = [];
  if (typeof args.tag === 'string' && args.tag.trim()) { where.push('chunk_tag = ?'); params.push(args.tag.trim()); }
  if (typeof args.scope_glob === 'string' && args.scope_glob.trim()) { where.push('scope GLOB ?'); params.push(args.scope_glob.trim()); }
  if (args.min_importance != null && Number.isFinite(Number(args.min_importance))) {
    where.push('COALESCE(importance, 0) >= ?'); params.push(Number(args.min_importance));
  }
  if (args.pinned_only === true) where.push('pinned = 1');
  let db: DatabaseSync | undefined;
  try {
    db = openRo(paths.memoryDb);
    const { items, cursor } = pageRows(
      db,
      `SELECT id, created_at AS at, chunk_tag, scope, text, importance, pinned, source_url
         FROM memory_chunks
        WHERE ${where.join(' AND ')}`,
      params,
      'created_at',
      'id',
      parseCursor(args.since_cursor),
      clampLimit(args.limit),
      (r) => ({
        id: String(r.id),
        at: String(r.at),
        tag: r.chunk_tag ?? null,
        scope: r.scope ?? null,
        text: cap(r.text),
        importance: r.importance == null ? null : Number(r.importance),
        pinned: Number(r.pinned ?? 0),
        source_url: r.source_url ?? null,
      }),
    );
    return { feed, items, count: items.length, cursor };
  } catch (e) {
    return failed(feed, e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function feedContradictions(paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  const feed = 'contradictions';
  if (!existsSync(paths.memoryDb)) return missing(feed, 'memory.db', paths.memoryDb);
  const where: string[] = ["resolved_at IS NULL", "status = 'open'"];
  const params: unknown[] = [];
  if (typeof args.slot_glob === 'string' && args.slot_glob.trim()) { where.push('slot GLOB ?'); params.push(args.slot_glob.trim()); }
  let db: DatabaseSync | undefined;
  try {
    db = openRo(paths.memoryDb);
    const { items, cursor } = pageRows(
      db,
      `SELECT id, created_at AS at, slot, import_value, native_value, import_scope, native_scope, cosine, status
         FROM memory_contradictions
        WHERE ${where.join(' AND ')}`,
      params,
      'created_at',
      'id',
      parseCursor(args.since_cursor),
      clampLimit(args.limit),
      (r) => ({
        id: String(r.id),
        at: String(r.at),
        slot: r.slot ?? null,
        import_value: cap(r.import_value),
        native_value: cap(r.native_value),
        import_scope: r.import_scope ?? null,
        native_scope: r.native_scope ?? null,
        cosine: r.cosine == null ? null : Number(r.cosine),
        status: r.status ?? null,
      }),
    );
    return { feed, items, count: items.length, cursor };
  } catch (e) {
    return failed(feed, e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function feedExtractionFailures(paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  const feed = 'extraction_failures';
  if (!existsSync(paths.coreDb)) return missing(feed, 'vodou-core.db', paths.coreDb);
  let db: DatabaseSync | undefined;
  try {
    db = openRo(paths.coreDb);
    const { items, cursor } = pageRows(
      db,
      `SELECT rowid AS rid, updated_at AS at, source, conversation_id, span_start, span_end, state, attempts, last_error
         FROM extraction_queue
        WHERE state = 'failed'`,
      [],
      'updated_at',
      'rowid',
      parseCursor(args.since_cursor),
      clampLimit(args.limit),
      (r) => ({
        // The event id is the span's identity; the cursor uses rowid so that
        // two failures with one timestamp still page deterministically.
        id: `${r.source}|${r.conversation_id}|${r.span_start}`,
        at: String(r.at),
        rid: String(r.rid),
        source: r.source ?? null,
        conversation_id: r.conversation_id ?? null,
        span_start: Number(r.span_start ?? 0),
        span_end: Number(r.span_end ?? 0),
        state: r.state ?? null,
        attempts: Number(r.attempts ?? 0),
        last_error: cap(r.last_error),
      }),
    );
    // pageRows built the cursor from `id`; this feed pages on rowid.
    const last = items[items.length - 1] as (FeedItem & { rid: string }) | undefined;
    return { feed, items, count: items.length, cursor: last ? `${last.at}|${last.rid}` : cursor };
  } catch (e) {
    return failed(feed, e);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * A script's own output file as a feed. The growth hunt runs as a background
 * job, so `execute_script` returns a job handle, not leads; what the hunt
 * PRODUCES is `.vodou/growth/leads.json`, and that file is the feed.
 */
export function feedJsonFile(paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  const feed = 'json_file';
  const root = path.resolve(paths.projectRoot || process.cwd());
  const rel = typeof args.path === 'string' ? args.path.trim() : '';
  if (!rel) return { feed, items: [], count: 0, cursor: null, note: 'path is required' };
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { feed, items: [], count: 0, cursor: null, note: `path must stay inside the project root` };
  }
  if (!existsSync(abs)) return missing(feed, rel, abs);
  const idField = typeof args.id_field === 'string' && args.id_field.trim() ? args.id_field.trim() : 'id';
  const atField = typeof args.at_field === 'string' && args.at_field.trim() ? args.at_field.trim() : 'at';
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (e) {
    return failed(feed, e);
  }
  let arr: unknown = doc;
  const ip = typeof args.items_path === 'string' ? args.items_path.trim() : '';
  if (ip) {
    for (const seg of ip.split('.').filter(Boolean)) {
      arr = arr && typeof arr === 'object' ? (arr as Record<string, unknown>)[seg] : undefined;
    }
  } else if (!Array.isArray(doc) && doc && typeof doc === 'object' && Array.isArray((doc as Record<string, unknown>).items)) {
    arr = (doc as Record<string, unknown>).items;
  }
  if (!Array.isArray(arr)) {
    return { feed, items: [], count: 0, cursor: null, note: `no array at ${ip || '(root)'} in ${rel}` };
  }
  const where = args.where && typeof args.where === 'object' && !Array.isArray(args.where)
    ? Object.entries(args.where as Record<string, unknown>).map(([k, v]) => [k, String(v)] as const)
    : [];
  // Numeric bounds (PLAN-AUTOMATIONS §9.2 item 4). `where` is equality-only, and
  // the live growth run showed why that is not enough: the fourth triage of the
  // night was a `status: new` lead with `score 0.0`, which an LLM turn was spent
  // on to conclude what the score already said. `min: {score: 5}` is the filter
  // that would have cut it.
  //
  // A bound only accepts a real number on BOTH sides. A missing field, a null,
  // an empty string or a non-numeric string fails the bound rather than passing
  // it — a floor is a claim about a number, and an item carrying no number has
  // not met it. Silently keeping those would make `min` a no-op on exactly the
  // malformed rows it is meant to exclude.
  const bounds = (raw: unknown, keep: (v: number, bound: number) => boolean) =>
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
          .map(([k, v]) => [k, Number(v)] as const)
          .filter(([, v]) => Number.isFinite(v))
          .map(([k, bound]) => (r: Record<string, unknown>) => {
            const got = r[k];
            if (got === null || got === undefined || got === '') return false;
            const n = typeof got === 'number' ? got : Number(got);
            return Number.isFinite(n) && keep(n, bound);
          })
      : [];
  const numeric = [
    ...bounds(args.min, (v, b) => v >= b),
    ...bounds(args.max, (v, b) => v <= b),
  ];
  const all: FeedItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r[idField]; const at = r[atField];
    if (id == null || at == null) continue;
    // The growth ledger keeps stale and off-topic leads for its own bookkeeping;
    // an automation that runs an LLM turn per item should see only the ones it
    // asked for (`where: {status: "new"}` cut 3 of 4 turns on the first live run).
    if (where.some(([k, v]) => String(r[k] ?? '') !== v)) continue;
    if (numeric.some((pass) => !pass(r))) continue;
    const item: FeedItem = { id: String(id), at: String(at) };
    for (const [k, v] of Object.entries(r)) {
      if (k === idField || k === atField) continue;
      item[k] = typeof v === 'string' ? cap(v) : v;
    }
    all.push(item);
  }
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cursor = parseCursor(args.since_cursor);
  const limit = clampLimit(args.limit);
  let items: FeedItem[];
  if (cursor) {
    items = all.filter((i) => i.at > cursor.at || (i.at === cursor.at && i.id > cursor.id)).slice(0, limit);
  } else {
    items = all.slice(Math.max(0, all.length - limit));
  }
  const last = items[items.length - 1];
  return { feed, items, count: items.length, cursor: last ? `${last.at}|${last.id}` : null };
}

export function runFeed(name: FeedToolName, paths: FeedPaths, args: Record<string, unknown>): FeedResult {
  switch (name) {
    case 'feed_json_file': return feedJsonFile(paths, args);
    case 'feed_captures': return feedCaptures(paths, args);
    case 'feed_memories': return feedMemories(paths, args);
    case 'feed_contradictions': return feedContradictions(paths, args);
    case 'feed_extraction_failures': return feedExtractionFailures(paths, args);
  }
}

export function isFeedTool(name: string): name is FeedToolName {
  return (FEED_TOOL_NAMES as readonly string[]).includes(name);
}
