/**
 * Database wrapper for admin dashboard
 * Direct SQLite access to vodou-core.db via node:sqlite (built into bundled Node 24).
 * Loads project root .env so VODOU_PROJECT_PATH is used everywhere.
 */

import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

import { existsSync } from 'fs';
import { isCorruptionError, reportWriteCorruption, runQuickCheck } from './db-health.js';

export type DB = DatabaseSync;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Derive project root from gateway's own location (always correct)
const DERIVED_ROOT = path.resolve(__dirname, '../../..');
// Load .env from our known location (not from potentially stale VODOU_PROJECT_PATH)
dotenv.config({ path: path.resolve(DERIVED_ROOT, '.env') });
// Trust VODOU_PROJECT_PATH only if the directory actually has vodou-core.db,
// otherwise use our derived location. Prevents stale env paths (e.g. "folder 2") from breaking things.
const envRoot = process.env.VODOU_PROJECT_PATH;
const PROJECT_ROOT = (envRoot && existsSync(path.join(envRoot, 'vodou-core.db')))
  ? envRoot
  : DERIVED_ROOT;
const DB_PATH = path.join(PROJECT_ROOT, 'vodou-core.db');
const MEMORY_DB_PATH = path.join(PROJECT_ROOT, 'memory.db');

/**
 * Where gateway.db lives. Exported so `db-health` can open a FRESH handle to the
 * same file without importing anything else from here — its confirm loop used to
 * re-read on the SAME connection, which cannot tell a damaged file from a
 * confused handle.
 */
export function resolveGatewayDbPath(): string {
  return (
    process.env.GATEWAY_DB_PATH?.trim() ||
    path.join(PROJECT_ROOT, 'MCP-servers', 'Vodou-Console', 'gateway.db')
  );
}

let db: DB | null = null;
let memDb: DB | null = null;
let gatewayDb: DB | null = null;
let thinkingDb: DB | null = null;
let boardDb: DB | null = null;

/**
 * Get the main vodou-core database connection
 */
export function getDb(): DB {
  if (!db) {
    db = new DatabaseSync(DB_PATH, { readOnly: false, timeout: 5000 });
    db.exec('PRAGMA journal_mode = WAL');
    runGatewaySideMigrations(db);
  }
  return db;
}

/**
 * Gateway-side additive migrations on vodou-core.db.
 *
 * The Rust side owns the canonical schema; these are columns/tables the
 * gateway adds on top for features Rust doesn't need to know about. Each
 * statement must be idempotent (IF NOT EXISTS / try-catch for duplicate
 * column on ALTER) so the gateway can boot cleanly even after the column
 * exists. Rust uses explicit field lists, so extra columns are inert there.
 */
function runGatewaySideMigrations(d: DB): void {
  // tools.enabled — per-tool soft toggle exposed in the Apps manage modal.
  // Rust doesn't read this yet; the gateway uses it to filter tool lists
  // surfaced to the user. Honoring it inside the LLM tool-call dispatch is
  // a Rust follow-up (see PLANS/0.5.98/PLAN-APPS-MERGE.md §0.8a phase 2b).
  try {
    d.exec('ALTER TABLE tools ADD COLUMN enabled INTEGER DEFAULT 1');
    console.error('[DB migration] added tools.enabled');
  } catch (e) {
    const msg = (e as Error).message || '';
    if (!/duplicate column/i.test(msg)) {
      console.warn('[DB migration] tools.enabled add failed:', msg);
    }
  }
  // server_health_log — append-only history of health probe results.
  // Written by /api/servers/refresh-health; read by the Apps manage modal.
  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS server_health_log (
        id INTEGER PRIMARY KEY,
        server_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_health_log_server ON server_health_log(server_id, checked_at DESC);
    `);
  } catch (e) {
    console.warn('[DB migration] server_health_log create failed:', (e as Error).message);
  }
}

/**
 * Get the memory database connection (read-only)
 */
export function getMemoryDb(): DB | null {
  if (!memDb) {
    try {
      memDb = new DatabaseSync(MEMORY_DB_PATH, { readOnly: true, timeout: 5000 });
    } catch {
      // memory.db may not exist yet
      return null;
    }
  }
  return memDb;
}

/**
 * Get the Vodou-Enhanced-Thinking database connection (read-only)
 */
export function getThinkingDb(): DB | null {
  if (!thinkingDb) {
    const thinkingDbPath = path.join(PROJECT_ROOT, 'MCP-servers', 'Vodou-Enhanced-Thinking', 'thinking.db');
    try {
      thinkingDb = new DatabaseSync(thinkingDbPath, { readOnly: true, timeout: 5000 });
    } catch {
      console.error('[DB] thinking.db not found at', thinkingDbPath, '— deep thinking history unavailable');
      return null;
    }
  }
  return thinkingDb;
}

/**
 * Get the gateway's own database (conversations, settings)
 */
/** Close cached gateway DB so the next getGatewayDb() opens a fresh file (tests, path override). */
export function closeGatewayDbOnly(): void {
  if (gatewayDb) {
    try {
      gatewayDb.close();
    } catch {
      /* ignore */
    }
    gatewayDb = null;
  }
}

export function getGatewayDb(): DB {
  if (!gatewayDb) {
    gatewayDb = new DatabaseSync(resolveGatewayDbPath(), { readOnly: false, timeout: 5000 });
    gatewayDb.exec('PRAGMA journal_mode = WAL');
    initGatewaySchema(gatewayDb);
  }
  return gatewayDb;
}

/**
 * Get the Vodou Board database connection (read+write).
 * Returns null if board.db hasn't been initialized yet (run `./do board migrate --init`).
 * Sets trusted_schema for FTS5 sync triggers per the kernel migration header.
 */
export function getBoardDb(): DB | null {
  if (!boardDb) {
    const boardDbPath = process.env.VODOU_BOARD_DB
      ?? path.join(PROJECT_ROOT, 'board.db');
    if (!existsSync(boardDbPath)) {
      return null;
    }
    try {
      boardDb = new DatabaseSync(boardDbPath, { readOnly: false, timeout: 5000 });
      // Required so FTS5 sync triggers fire on INSERT/UPDATE/DELETE.
      boardDb.exec('PRAGMA trusted_schema = ON');
      boardDb.exec('PRAGMA journal_mode = WAL');
    } catch (e) {
      console.error('[board.db open]', (e as Error).message);
      return null;
    }
  }
  return boardDb;
}

export function closeBoardDb(): void {
  if (boardDb) {
    try { boardDb.close(); } catch { /* ignore */ }
    boardDb = null;
  }
}

function initGatewaySchema(db: DB): void {
  // P0d — the turn event log is NOT here. It moved to vodou-core.db (migration
  // 090) so a Cursor turn and a turn taken with the gateway stopped are both
  // recordable, and so the receipt can be a projection of it rather than a
  // second record of the same turn (SEAMS §26). The gateway sends one batch per
  // turn over the daemon socket and READS the log from the engine's database.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_conversations (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT 'New Chat',
      source TEXT DEFAULT 'web',
      sender_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gateway_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sender_label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gw_messages_conv ON gateway_messages(conversation_id);

    CREATE TABLE IF NOT EXISTS gateway_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gateway_skill_state (
      conversation_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      oi_context TEXT,
      loaded_at INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE
    );
  `);

  // Migration: add source/sender_name columns if missing (existing DBs)
  try {
    db.prepare('SELECT source FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN source TEXT DEFAULT \'web\'');
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN sender_name TEXT');
  }

  // Migration: add deleted_at for soft-delete (existing DBs)
  try {
    db.prepare('SELECT deleted_at FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN deleted_at DATETIME');
  }

  // Migration: continuity primitive (PLAN-CONTINUITY-PRIMITIVE.md §4.2 + §5 Phase 0).
  // Adds principal_id (nullable) on conversations + messages so every row can be
  // attributed to a real user across surfaces. scope_filter_mode is the per-conversation
  // continuity scope mode (per plan §10 risk #15) — defaults to 'all' so existing
  // conversations keep current behavior; new conversations from channels will set
  // 'channel' when continuity Phase 2 (recall) ships. Idempotent: try/catch ensures
  // re-running does not fail.
  try {
    db.prepare('SELECT principal_id FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN principal_id TEXT');
  }
  try {
    db.prepare('SELECT scope_filter_mode FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec("ALTER TABLE gateway_conversations ADD COLUMN scope_filter_mode TEXT DEFAULT 'all'");
  }
  try {
    db.prepare('SELECT principal_id FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN principal_id TEXT');
  }
  // PLAN-CAPTURE-FEED P2 — which model answered this turn. Per MESSAGE, not per
  // conversation: people switch models mid-thread, and that switch is exactly the
  // thing the feed makes visible. NULL wherever the payload did not say.
  try {
    db.prepare('SELECT model FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN model TEXT');
  }
  // PLAN-CAPTURE-FEED P1 — where a captured conversation lives on the provider's
  // site, so the feed can link back to it. Captured generically from
  // location.href at capture time rather than rebuilt from a per-provider URL
  // template: templates rot, and three providers moved hosts in a single session
  // on 2026-07-27 (duck.ai, grok.x.com, notebook.google.com).
  try {
    db.prepare('SELECT source_url FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN source_url TEXT');
  }
  // The feed pages over capture rows only; without this the JOIN scans every
  // conversation to find them.
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_gw_conv_source ON gateway_conversations(source)');
  } catch { /* index is an optimisation, not a requirement */ }
  try {
    db.prepare('SELECT sender_label FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN sender_label TEXT');
  }
  // Phase 6 (PLAN-FIREWORKS-INTEGRATION) — tag skill-emitted assistant turns so the
  // conversation hydrator can strip them from LLM context after a skill is uninstalled.
  // Otherwise the model keeps replaying the skill's menus from past turns.
  try {
    db.prepare('SELECT skill_name FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN skill_name TEXT');
  }
  try {
    db.prepare('SELECT excluded_from_context FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN excluded_from_context INTEGER DEFAULT 0');
  }
  // PLAN-HISTORY-BACKFILL P0 — idempotent capture.
  //
  // Web capture had no uniqueness constraint; idempotency was deferred to the
  // extractor. Measured 2026-07-27: 50 of 189 webcap rows were duplicates, and a
  // single ChatGPT conversation held the same turn TEN times — re-opening a thread
  // re-stores the whole transcript. Extraction then sees one fact asserted ten
  // times and weights it accordingly.
  //
  // dedupe_key  = sha256(conversationId | provider msg id  OR  'h:'+sha256(role|content))
  // source_msg_id = the provider's own id, kept for debugging and for backfill.
  try {
    db.prepare('SELECT dedupe_key FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN dedupe_key TEXT');
  }
  try {
    db.prepare('SELECT source_msg_id FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN source_msg_id TEXT');
  }
  // COHERENCE F8 / D-6 — the turn a message belongs to.
  //
  // `turn_receipts` (vodou-core.db) records what every turn used — memories,
  // tools, skills, degraded — and NOTHING read it back, so a turn that showed a
  // receipt live showed none on reload. The two stores had no join key: this
  // table is in gateway.db, the receipts are in vodou-core.db, and neither
  // carried the other's id. This column is that key.
  //
  // Nullable and unbackfillable by nature: rows written before it existed have
  // no turn id and never will, so a reloaded old conversation stays silent
  // rather than claiming an empty receipt. Lanes that mint no turn id (board
  // workers, slash commands) also keep NULL, which is correct — those are not
  // turns with receipts.
  try {
    db.prepare('SELECT turn_id FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN turn_id TEXT');
  }
  // Indexes (idempotent)
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_messages_turn ON gateway_messages(turn_id) WHERE turn_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_conversations_principal ON gateway_conversations(principal_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_messages_principal ON gateway_messages(principal_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_messages_role ON gateway_messages(role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_messages_skill ON gateway_messages(skill_name) WHERE skill_name IS NOT NULL');
  // PARTIAL unique index: only rows that opt in (dedupe_key NOT NULL) participate.
  // Existing rows and every native gateway-chat insert keep NULL and are untouched,
  // so this cannot reject a legitimate duplicate-looking turn in normal chat.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gw_messages_dedupe ON gateway_messages(dedupe_key) WHERE dedupe_key IS NOT NULL');

  // PLAN-GATEWAY-PROJECTS Phase 1 — multi-workspace ("projects") support.
  // A project is a pointer to a working directory; the brain (servers, creds,
  // daemon, memory) stays shared. Conversations get a nullable project_id
  // (NULL = the seeded "Default" project = the install root). Additive + idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      root_path    TEXT NOT NULL,
      instructions TEXT,
      color        TEXT,
      archived_at  INTEGER,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  try {
    db.prepare('SELECT project_id FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_conversations ADD COLUMN project_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_conversations_project ON gateway_conversations(project_id)');
  // Seed the Default project at the install root so NULL conversations have a
  // home in the UI without a backfill. INSERT OR IGNORE → safe to re-run.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, root_path, instructions, color)
       VALUES ('proj_default', 'Default', ?, NULL, '#6b7280')`
    ).run(PROJECT_ROOT);
  } catch (e) {
    console.warn('[DB migration] seed Default project failed:', (e as Error).message);
  }

  // PLAN-PROJECT-SCOPED-DOCK Phase 1 — per-project skill filtering.
  // Many-to-many association between a project and the skills surfaced in its dock.
  // Lives in gateway.db (projects live here); skills live in vodou-core.db, so we
  // reference them by their stable `name` (no cross-DB FK). Curate-down semantics:
  // a project with zero rows is "uncurated" and shows ALL skills; ≥1 row filters.
  // Additive + idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_skills (
      project_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (project_id, skill_name)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id)');

  // PLAN-PROJECT-SCOPED-DOCK Phase 2 — per-project scheduled tasks.
  // Unlike skills (a shared catalog curated many-to-many), a scheduled task is an
  // instance with a single owner: the project it was created in. So this is a
  // 1:1 task→project tag, not a junction. Tasks live in vodou-core.db
  // (scheduled_tasks, integer id); we map by that stable id from gateway.db.
  // System/infra tasks (memory-*, heartbeat, skill-proposer/optimizer) are never
  // mapped — they're classified out at read time and shown in a System section.
  // Additive + idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_tasks (
      task_id    INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id)');

  // PLAN-MEMORY-ON-EVERY-PAGE P0 — presence as an ATTRIBUTE, never a log.
  //
  // The plan is explicit that a passive browsing/timeline log is never built (a
  // silent local log of visited pages is a Chrome Web Store violation, "Purple
  // Magnesium"). Instead: when the page-memory toggle is on, a message records
  // the page that was open while it was created, and the extractor carries that
  // into memory_chunks.source_url. No row exists for a page you merely visited —
  // only for one you were on while creating something.
  //
  // Additive + guarded, same idiom as project_id above.
  try {
    db.prepare('SELECT page_url FROM gateway_messages LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE gateway_messages ADD COLUMN page_url TEXT');
  }

  // PLAN-UNIFIED-PROJECT-SCOPE §2.3 — per-project pinning for any scoped surface.
  // Generalizes project_skills to arbitrary `workbench:<type>:<id>` scope strings,
  // with the SAME curate-down semantics: a scope with ZERO rows here is uncurated
  // and visible in EVERY project; >=1 row restricts it to those projects. That
  // "absent means visible" rule is what keeps the 44 untagged workbench surfaces on
  // this install from vanishing the day filtering turns on.
  //
  // NEVER used for OWNED surfaces (chats, skill consoles, scheduled tasks, board
  // tasks) — those have exactly one owner and resolve from their own row. Pinning
  // is many-to-many by definition: `workbench:channel:slack` is ONE conversation
  // that may belong in several projects at once, which is precisely why stamping
  // project_id on it would force a false choice. See §2.1/§2.2.
  //
  // Additive + idempotent, same idiom as every migration above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_scopes (
      project_id TEXT NOT NULL,
      scope      TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (project_id, scope)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_scopes_project ON project_scopes(project_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_scopes_scope   ON project_scopes(scope)');

  // Lens render-model cache (formerly `card_cache` pre-rename, 2026-05-17).
  // Keyed by sha256(type+source_url+payload). Per-lens TTL declared in
  // the lens's manifest.ttl_seconds. Idempotent; safe to re-run.
  // Pre-rename installs auto-migrate by copying rows from the old table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lens_cache (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source_url TEXT,
      render_model TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lens_cache_fetched ON lens_cache(fetched_at);
    CREATE INDEX IF NOT EXISTS idx_lens_cache_type ON lens_cache(type);
  `);
  try {
    const hasOld = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_cache'")
      .get();
    if (hasOld) {
      db.exec(`INSERT OR IGNORE INTO lens_cache SELECT * FROM card_cache;`);
      db.exec(`DROP TABLE card_cache;`);
      console.log('[db] migrated card_cache → lens_cache (rename pre-0.5.88)');
    }
  } catch (e) { console.warn('[db] card_cache migration skipped:', e); }

  // PLAN-SKILL-LEARNING-LOOP Phase 1A — per-turn tool-call trajectory capture.
  // One row per completed gateway chat turn that called >=1 tool, written by the
  // llm.ts tool loop (the only interactive surface we can observe; claude-CLI and
  // board-worker tool calls run in subprocesses we can't see). The Rust
  // skill_proposer reads this table from gateway.db. user_signal is backfilled
  // from the NEXT user turn; skill_worthy is a computed gate applied at proposal
  // time (recurrence of steps_shape_hash + success + accepted/refined).
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_tool_trajectories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      prompt_excerpt TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      steps_json TEXT NOT NULL,
      steps_shape_hash TEXT,
      outcome TEXT,
      user_signal TEXT,
      had_workaround INTEGER DEFAULT 0,
      skill_worthy INTEGER DEFAULT 0,
      proposed_skill TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gtt_shape ON gateway_tool_trajectories(steps_shape_hash);
    CREATE INDEX IF NOT EXISTS idx_gtt_worthy ON gateway_tool_trajectories(skill_worthy, outcome);
    CREATE INDEX IF NOT EXISTS idx_gtt_conv ON gateway_tool_trajectories(conversation_id);
  `);

  // PLAN-LENSES-MANAGEMENT §5.1 — installed_lenses metadata sidecar.
  // DB rows exist only for community installs under ~/.vodou/lenses/; built-ins
  // are filesystem-scanned and bypass this table entirely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_lenses (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      source_url TEXT,
      manifest_json TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      module_path TEXT NOT NULL,
      uses_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      health_status TEXT,
      health_last_check INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_installed_lenses_enabled ON installed_lenses(enabled);
  `);

  // PLAN-LENSES-MANAGEMENT §5.2 — per-action consents granted to lenses.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lens_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lens_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      revoked_at INTEGER,
      UNIQUE(lens_id, action_id, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_lens_consents_lens ON lens_consents(lens_id);
  `);

  // PLAN-LONG-CONVO-RECALL.md Phase 4 — FTS5 over gateway_messages.content for
  // the `convo_recall` tool. Requires Node 24 (engines spec ">=24.0.0"); the
  // bundled SQLite in Node 22 lacks the FTS5 module. External-content FTS5
  // stays in sync via 3 triggers. Idempotent. If FTS5 is unavailable (running
  // on Node 22), log and continue; the recall tool returns empty results but
  // normal chat still works.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gateway_messages_fts USING fts5(
        content,
        content='gateway_messages',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_ai AFTER INSERT ON gateway_messages BEGIN
        INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_ad AFTER DELETE ON gateway_messages BEGIN
        INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_au AFTER UPDATE ON gateway_messages BEGIN
        INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    // Backfill / repair the FTS5 index when needed. For external-content FTS5
    // the correct backfill is the magic `rebuild` command — direct
    // `INSERT INTO fts(rowid, content)` reserves rowids but does NOT tokenize
    // them, so MATCH returns zero against backfilled rows. Cheap (~200ms / 7500
    // rows on M-series), so we probe with a high-coverage term to detect both
    // the empty case AND the broken-rowids-but-no-index case.
    const msgCount = db.prepare('SELECT COUNT(*) as n FROM gateway_messages').get() as { n: number };
    if (msgCount.n > 0) {
      // Probe: count messages containing 'the' via LIKE vs FTS5. Massive disparity
      // = broken or stale FTS5 index. 'the' should hit a substantial fraction of
      // assistant rows; if FTS5 finds <10% of what LIKE finds, rebuild.
      const likeHits = db.prepare(`SELECT COUNT(*) as n FROM gateway_messages WHERE content LIKE '% the %'`).get() as { n: number };
      let ftsHits = 0;
      try { ftsHits = (db.prepare(`SELECT COUNT(*) as n FROM gateway_messages_fts WHERE content MATCH 'the'`).get() as { n: number }).n; } catch { ftsHits = 0; }
      const broken = likeHits.n > 50 && ftsHits < likeHits.n * 0.1;
      // PLAN-GATEWAY-DB-REPAIR H2 — a rebuild on a file that fails quick_check
      // writes through the same damaged freelist that broke it (that is what
      // spread the 08-15 damage into gateway_messages/gateway_settings pages).
      // Refuse, report, and point at the repair script instead.
      const preflight = broken ? runQuickCheck(() => db) : null;
      if (broken && preflight && !preflight.ok) {
        console.error(
          `[FTS5] Index broken (LIKE=${likeHits.n}, FTS=${ftsHits}) but quick_check FAILS — NOT rebuilding in place: ${preflight.error}\n` +
          `[FTS5] A rebuild here would write through the damaged file. Repair: bash scripts/repair-gateway-db.sh --dry-run, then without --dry-run.`
        );
      } else if (broken) {
        console.error(`[FTS5] Index broken or stale (LIKE=${likeHits.n}, FTS=${ftsHits}) — rebuilding...`);
        try {
          db.exec(`INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('rebuild')`);
          console.error(`[FTS5] Rebuild complete.`);
        } catch (e) {
          // A rebuild that fails is NOT a stale index — it means the index
          // cannot be read, which on 2026-08-15 meant the file was damaged and
          // every message write was already failing. This exact throw was
          // caught below and reported as "need Node 24 for FTS5" while the
          // real error read "database disk image is malformed": the right
          // diagnosis, discarded and relabelled. Escalate it instead.
          const msg = (e as Error).message;
          if (isCorruptionError(msg)) {
            console.error(
              `[FTS5] REBUILD FAILED — gateway.db is CORRUPT, not stale: ${msg}\n` +
              `[FTS5] Every message write will fail while this lasts. This is data loss in progress.\n` +
              `[FTS5] Repair: sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
            );
            reportWriteCorruption(e);
          } else {
            console.error(`[FTS5] Rebuild failed (index left stale, search degraded): ${msg}`);
          }
        }
      }
    }
  } catch (e) {
    // Reached only if CREATE VIRTUAL TABLE / the probe itself threw. Two very
    // different causes used to share one message, and the wrong one was
    // hard-coded: a genuinely absent FTS5 module (Node 22 — benign, search just
    // returns nothing) versus a corrupt database (urgent, writes are failing).
    // Tell them apart and say which.
    const msg = (e as Error).message;
    if (isCorruptionError(msg)) {
      console.error(
        `[FTS5] gateway.db is CORRUPT (not an FTS5/Node version problem): ${msg}\n` +
        `[FTS5] Message writes are failing NOW. Repair before more is lost:\n` +
        `[FTS5]   sqlite3 MCP-servers/Vodou-Console/gateway.db "PRAGMA integrity_check;"`
      );
      reportWriteCorruption(e);
    } else {
      console.error(`[FTS5] gateway_messages_fts unavailable (need Node 24 for FTS5): ${msg}`);
    }
  }

  // PLAN-SKILL-CONSOLE-LOOP §2 + §15 spike — skills_meta + skill_console_bindings
  // tables for LLM-created mutable skills with bidirectional chat consoles.
  // Spike scope: gateway.db only (deferred from vodou-core.db per §15) so the
  // POST /chat handler can do single-DB lookups. Phase 1 may relocate.
  // Idempotent CREATE IF NOT EXISTS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills_meta (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      schedule_cron   TEXT,
      output_format   TEXT NOT NULL DEFAULT 'markdown',
      is_active       INTEGER NOT NULL DEFAULT 1,
      principal_id    TEXT NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      prompt_history  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_skills_meta_principal ON skills_meta(principal_id);
    CREATE INDEX IF NOT EXISTS idx_skills_meta_active ON skills_meta(is_active);

    CREATE TABLE IF NOT EXISTS skill_console_bindings (
      conversation_id TEXT PRIMARY KEY,
      skill_id        INTEGER NOT NULL UNIQUE,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (skill_id) REFERENCES skills_meta(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_bindings_skill ON skill_console_bindings(skill_id);
  `);

  // PLAN-SKILL-CONSOLE-LOOP §30 Phase 1 polish — skills_meta column additions.
  // All ALTERs are guarded by SELECT-LIMIT-0 try/catch for idempotency on existing installs.
  // Columns added here exist as schema slots; full wiring lands across Phase 2/3 (history
  // injection, channel delivery, parameter substitution). Adding the columns now means we
  // never need a backfill later.
  const skillsMetaAlters: Array<[string, string]> = [
    ['prefer_model',     "ALTER TABLE skills_meta ADD COLUMN prefer_model TEXT"],
    ['delivery_mode',    "ALTER TABLE skills_meta ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'console'"],
    ['delivery_target',  "ALTER TABLE skills_meta ADD COLUMN delivery_target TEXT"],
    ['required_tools',   "ALTER TABLE skills_meta ADD COLUMN required_tools TEXT"],
    ['parameters_json',  "ALTER TABLE skills_meta ADD COLUMN parameters_json TEXT"],
    ['param_overrides_json', "ALTER TABLE skills_meta ADD COLUMN param_overrides_json TEXT"],
    ['on_complete_hook', "ALTER TABLE skills_meta ADD COLUMN on_complete_hook TEXT"],
    ['history_window',   "ALTER TABLE skills_meta ADD COLUMN history_window INTEGER NOT NULL DEFAULT 0"],
    ['ephemeral',        "ALTER TABLE skills_meta ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0"],
    ['stopping_points_json', "ALTER TABLE skills_meta ADD COLUMN stopping_points_json TEXT"],
    ['current_phase',    "ALTER TABLE skills_meta ADD COLUMN current_phase INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [col, sql] of skillsMetaAlters) {
    try {
      db.prepare(`SELECT ${col} FROM skills_meta LIMIT 0`).get();
    } catch {
      db.exec(sql);
    }
  }

  // ALTER gateway_conversations ADD conversation_type — distinguishes
  // 'chat' (default — generic LLM) from 'skill_console' (bound to a skill).
  // Idempotent via try/catch.
  try {
    db.prepare('SELECT conversation_type FROM gateway_conversations LIMIT 0').get();
  } catch {
    db.exec("ALTER TABLE gateway_conversations ADD COLUMN conversation_type TEXT NOT NULL DEFAULT 'chat'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_gw_conversations_type ON gateway_conversations(conversation_type)');

  // Usage tracking table (API cost tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gw_usage_conv ON gateway_usage(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_gw_usage_date ON gateway_usage(created_at);
  `);

  // Persisted WebSocket event buffer for resume-after-disconnect. Mirrors the
  // in-memory ring (_convBuffers in index.ts) but survives gateway restarts.
  // Without this, restarting the gateway during a long tool call (or during a
  // release deploy) loses every in-flight chat — the client's {type:'resume'}
  // request comes back empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_event_buffer (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_event_buffer_ts ON chat_event_buffer(ts);
  `);

  // PLAN-JOB-FOLLOWUP — background jobs a chat turn started and is still owed a
  // report on. The gateway outlives the `claude -p` subprocess that started the
  // job, so this is where the promise can actually be kept (see job-followup.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_watches (
      -- 'job_<id>' for a registered script job, 'pid:<n>:<armed_at>' for a bare
      -- background process the reply named. One table: the two differ only in
      -- how "is it finished?" is answered.
      watch_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'job',
      job_id TEXT,
      pid INTEGER,
      conversation_id TEXT NOT NULL,
      script_name TEXT,
      promised INTEGER NOT NULL DEFAULT 0,
      armed_at INTEGER NOT NULL,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_job_watches_open ON job_watches(notified_at, armed_at);
  `);

  // Drop legacy oauth_tokens table — OAuth state now lives in vodou-core.db
  // (oauth_configs + server_credentials + mcp_servers) so gateway UI and CLI share state.
  // Idempotent: no-op if the table was never created on this install.
  db.exec(`DROP TABLE IF EXISTS oauth_tokens;`);
}

/**
 * Record API usage for a conversation turn
 */
export function saveUsage(conversationId: string, provider: string, model: string, usage: {
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  cacheCreateTokens?: number; costUsd?: number; durationMs?: number;
}): void {
  try {
    const db = getGatewayDb();
    db.prepare(
      `INSERT INTO gateway_usage (conversation_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId, provider, model,
      usage.inputTokens || 0, usage.outputTokens || 0,
      usage.cacheReadTokens || 0, usage.cacheCreateTokens || 0,
      usage.costUsd || 0, usage.durationMs || 0
    );
  } catch (e) {
    console.error('[Usage] Failed to save:', (e as Error).message);
  }
}

/**
 * PLAN-SKILL-LEARNING-LOOP Phase 1A — record one completed chat turn's tool
 * trajectory. Called from the llm.ts tool loop after a turn finishes. Steps are
 * the ordered tool calls; shapeHash is a stable hash of the server.tool sequence
 * used for recurrence detection by the proposer. Best-effort: never throws into
 * the chat path. Skips no-op turns (zero tool calls) at the call site.
 */
// Conversation sources that are SYSTEM/scheduled/autonomous, not genuine
// user intents. These recur by design (heartbeat fires daily, scheduled skill
// runs repeat, the board worker is autonomous), so feeding them to the skill
// proposer floods the review queue with non-skills ("# Heartbeat Directive",
// "generating a daily morning briefing", "# Board Worker"). The proposer must
// only learn from real user-initiated chat. See PLAN-SKILL-LEARNING-LOOP.
const NON_LEARNABLE_SOURCES = new Set([
  'heartbeat', 'board', 'skill-console', 'scheduled', 'skill_run',
  'automation', 'curriculum', 'system', 'cron',
]);

/** True only for genuine user-initiated conversations the proposer may learn
 *  from. Excludes the system/scheduled/autonomous surfaces (by well-known
 *  conversation id and by gateway_conversations.source). Fails open (learnable)
 *  only when the source genuinely can't be determined. */
export function isLearnableConversation(conversationId: string): boolean {
  if (!conversationId) return false;
  if (conversationId === 'vodou-heartbeat' || conversationId === 'board-chat') return false;
  if (conversationId.startsWith('workbench:skill-console:')) return false; // scheduled skill runs
  try {
    const row = getGatewayDb()
      .prepare('SELECT source FROM gateway_conversations WHERE id = ?')
      .get(conversationId) as { source?: string } | undefined;
    if (row && row.source && NON_LEARNABLE_SOURCES.has(row.source)) return false;
  } catch { /* unknown source → treat as learnable (don't silently drop real chat) */ }
  return true;
}

export function recordToolTrajectory(
  conversationId: string,
  steps: Array<{ server: string; tool: string; args: unknown; ok: boolean; ms: number }>,
  shapeHash: string,
  outcome: string,
  promptExcerpt?: string,
): void {
  // Selectivity gate: never learn skills from system/scheduled/autonomous runs.
  if (!isLearnableConversation(conversationId)) return;
  try {
    const db = getGatewayDb();
    db.prepare(
      `INSERT INTO gateway_tool_trajectories (conversation_id, prompt_excerpt, step_count, steps_json, steps_shape_hash, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      conversationId,
      promptExcerpt ? promptExcerpt.slice(0, 280) : null,
      steps.length,
      JSON.stringify(steps),
      shapeHash,
      outcome,
    );
  } catch (e) {
    console.error('[Trajectory] Failed to record:', (e as Error).message);
  }
}

/**
 * PLAN-SKILL-LEARNING-LOOP Phase 1A — stamp a user_signal onto the most-recent
 * UNSCORED trajectory for a conversation (the turn the user is now reacting to).
 * Targets only the latest user_signal IS NULL row so each turn's signal lands on
 * the immediately-preceding tool turn; older unscored rows stay NULL. No-op when
 * the conversation has no prior trajectory.
 */
export function setLatestTrajectoryUserSignal(conversationId: string, signal: string): void {
  try {
    const db = getGatewayDb();
    db.prepare(
      `UPDATE gateway_tool_trajectories SET user_signal = ?
       WHERE id = (SELECT id FROM gateway_tool_trajectories
                   WHERE conversation_id = ? AND user_signal IS NULL
                   ORDER BY id DESC LIMIT 1)`
    ).run(signal, conversationId);
  } catch (e) {
    console.error('[Trajectory] user_signal update failed:', (e as Error).message);
  }
}

/**
 * Get usage summary (aggregated by day, optionally filtered)
 */
export function getUsageSummary(options?: { days?: number; conversationId?: string; provider?: string }): any[] {
  const db = getGatewayDb();
  const days = options?.days || 30;
  const conditions: string[] = [`created_at >= datetime('now', '-${days} days')`];
  const params: any[] = [];

  if (options?.conversationId) { conditions.push('conversation_id = ?'); params.push(options.conversationId); }
  if (options?.provider) { conditions.push('provider = ?'); params.push(options.provider); }

  return db.prepare(
    `SELECT date(created_at) as day, provider, model,
            COUNT(*) as requests,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cache_read_tokens) as total_cache_read,
            SUM(cost_usd) as total_cost_usd,
            AVG(duration_ms) as avg_duration_ms
     FROM gateway_usage
     WHERE ${conditions.join(' AND ')}
     GROUP BY day, provider, model
     ORDER BY day DESC`
  ).all(...params);
}

/**
 * Get a setting from gateway_settings
 */
export function getSetting(key: string): string | null {
  const db = getGatewayDb();
  const row = db.prepare('SELECT value FROM gateway_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting in gateway_settings
 */
export function setSetting(key: string, value: string): void {
  const db = getGatewayDb();
  db.prepare(
    'INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP'
  ).run(key, value);
}

/**
 * Get all settings as a key-value object
 */
export function getAllSettings(): Record<string, string> {
  const db = getGatewayDb();
  const rows = db.prepare('SELECT key, value FROM gateway_settings').all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// ── Progressive onboarding (feature-discovery tour) progress ───────────────
// Stored in gateway_settings under the `onboarding.*` namespace so it survives
// cache clears and is the same source of truth as eula_accepted_at. Install-
// global today (matches the rest of gateway_settings); a future per-user split
// would move these to a dedicated table. See PLANS/0.6.9/PLAN-PROGRESSIVE-ONBOARDING.md.
const ONBOARDING_PREFIX = 'onboarding.';

/** True if a settings key belongs to the onboarding namespace (write/reset guard). */
export function isOnboardingKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(ONBOARDING_PREFIX) && key.length <= 120;
}

/** All onboarding.* flags as a flat key→value map (raw). */
export function getOnboardingProgress(): Record<string, string> {
  const db = getGatewayDb();
  const rows = db
    .prepare("SELECT key, value FROM gateway_settings WHERE key LIKE 'onboarding.%'")
    .all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** Write a single onboarding flag. Throws if the key is outside the namespace. */
export function setOnboardingFlag(key: string, value: string): void {
  if (!isOnboardingKey(key)) throw new Error(`refusing to write non-onboarding key: ${key}`);
  setSetting(key, String(value));
}

/**
 * Clear ALL onboarding.* flags (replay). Deliberately leaves identity, EULA,
 * and credentials untouched — this resets discovery, not setup.
 * Returns the number of rows cleared.
 */
export function resetOnboarding(): number {
  const db = getGatewayDb();
  const info = db.prepare("DELETE FROM gateway_settings WHERE key LIKE 'onboarding.%'").run();
  return Number(info.changes || 0);
}

/**
 * Close all database connections
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  if (memDb) {
    memDb.close();
    memDb = null;
  }
  if (gatewayDb) {
    gatewayDb.close();
    gatewayDb = null;
  }
  if (thinkingDb) {
    try { thinkingDb.close(); } catch {}
    thinkingDb = null;
  }
}

/**
 * Get project root path (for vodou-core CLI calls)
 */
export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
