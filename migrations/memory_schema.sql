-- memory_schema.sql — Standalone DDL for memory.db
-- Extracted from migrations 021, 024, 038. Idempotent (all IF NOT EXISTS).
-- Run at every daemon startup via Database::init_memory_tables().

-- memory_chunks: chunked text from MEMORY.md and memory/**/*.md
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  start_line INT,
  end_line INT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'web',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Columns historically added only by init_memory_tables' idempotent ALTERs (so a
  -- raw-SQL template lacked them and read-only consumers like the brain console 500'd
  -- on `pinned`/`chunk_tag` before the daemon ran init). Defined here so the fresh
  -- schema is complete; the Rust ALTERs remain as migration for pre-existing DBs.
  extractor_backend TEXT NOT NULL DEFAULT 'unknown',
  chunk_tag TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  principal_id TEXT,
  project_id TEXT,
  -- P3b (PLAN-EXTRACTION-ROBUSTNESS §3.3.2) — shadow of the pre-strip embedded
  -- text. NULL = row not yet processed by `mem reembed`; equal to `text` when
  -- the strip was a no-op. Kept until the retrieval eval confirms no
  -- regression, then droppable. New (clean-from-source) rows stay NULL.
  legacy_text TEXT
);

-- FTS5 for keyword search (content table mode — syncs with memory_chunks)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path,
  text,
  content='memory_chunks',
  content_rowid='rowid'
);

-- Triggers to keep memory_fts in sync with memory_chunks
CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_fts(rowid, path, text) VALUES (new.rowid, new.path, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, text) VALUES ('delete', old.rowid, old.path, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, text) VALUES ('delete', old.rowid, old.path, old.text);
  INSERT INTO memory_fts(rowid, path, text) VALUES (new.rowid, new.path, new.text);
END;

-- memory_embeddings: vector embeddings for semantic search
CREATE TABLE IF NOT EXISTS memory_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES memory_chunks(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL
);

-- memory_cache: prompt-targeted lookup cache
CREATE TABLE IF NOT EXISTS memory_cache (
  presence_key TEXT PRIMARY KEY,
  memories_json TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

-- memory_refs: structured cross-document references extracted from chunk text.
-- Each row = one citation inside a chunk. Lets priming show the CURRENT state
-- of what a memory cited (§B3a, PLAN-XYZ.md, src/foo.rs:42, commit SHA).
-- Added 2026-04-19 (Stage 1 of smarter-memory plan).
CREATE TABLE IF NOT EXISTS memory_refs (
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,      -- 'section' | 'plan' | 'memory' | 'source' | 'sha' | 'issue'
  raw      TEXT NOT NULL,      -- literal token as it appeared in chunk text
  target   TEXT,               -- resolved path / heading / one-liner (nullable when unresolvable)
  offset   INTEGER NOT NULL,   -- byte offset within chunk.text
  PRIMARY KEY (chunk_id, offset)
);
CREATE INDEX IF NOT EXISTS idx_memory_refs_kind_target ON memory_refs (kind, target);
CREATE INDEX IF NOT EXISTS idx_memory_refs_chunk ON memory_refs (chunk_id);
-- Note: no denormalized ref_count column on memory_chunks — Stage 2 (reranker)
-- can cheaply compute it via `SELECT COUNT(*) FROM memory_refs WHERE chunk_id = ?`
-- on the pre-rerank candidate set (≤100 rows). Keeping the schema additive-only
-- makes this migration idempotent with plain execute_batch (no ALTER conditional).

-- memory_files: per-file content-hash watermark (PLAN-UNIVERSAL-MEMORY Phase 0).
-- MemorySync consults this before the delete+re-chunk+re-embed cycle: if a file's
-- whole-content hash is unchanged since it was last indexed, the file is skipped
-- entirely (no re-embed). Without this, every boot sync re-embeds every file — a
-- multi-thousand-note import tree = minutes of CPU per boot. Flat per-file hashes
-- give the same effect as a Merkle tree for a local store with far less machinery.
CREATE TABLE IF NOT EXISTS memory_files (
  path         TEXT PRIMARY KEY,   -- relative path (memory/…) or 'scan:<abs-root>/<rel>'
  content_hash TEXT NOT NULL,      -- sha256 of the whole file's UTF-8 content
  indexed_at   TEXT                -- ISO timestamp of the last successful index
);

-- import_jobs: one row per import/capture run (PLAN-UNIVERSAL-MEMORY Lane A/B).
-- Conversation-corpus imports (ChatGPT/Claude) distill memory on a SEPARATE
-- per-job watermark (`extract_watermark`) so a huge historical backfill never
-- starves the live extractor. Lane-B file imports use it for provenance + undo.
CREATE TABLE IF NOT EXISTS import_jobs (
  id                TEXT PRIMARY KEY,
  source            TEXT,          -- 'chatgpt' | 'claude' | 'obsidian' | 'openclaw' | 'pack' | …
  origin_path       TEXT,          -- source ZIP/dir the job read from
  status            TEXT,          -- 'pending' | 'extracting' | 'done' | 'failed'
  conv_count        INTEGER,
  msg_count         INTEGER,
  extract_watermark INTEGER DEFAULT 0,  -- highest gateway_messages.id distilled for this job
  created_at        TEXT,
  meta              TEXT           -- JSON: counts, flagged lines, source-specific fields
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs (status);

-- memory_vaults: named, rule-based selections of memory for segmented sharing
-- (PLAN-MEMORY-VAULTS V1 — "share the family vault, not the bank vault").
-- Membership is a live rule + explicit per-chunk exceptions, NOT a copy:
-- rules_json = {"scopes":[prefixes],"tags":[],"project":null,"since_days":null,
-- "include_imports":false}. Resolution lives in src/memory/vaults.rs (Rust is
-- the single resolver — UIs shell `mem vault` / `mem export --vault`).
CREATE TABLE IF NOT EXISTS memory_vaults (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  rules_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Per-chunk exceptions to a vault's rules ("everything except this one memory").
CREATE TABLE IF NOT EXISTS memory_vault_overrides (
  vault_id INTEGER NOT NULL REFERENCES memory_vaults(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  action   TEXT NOT NULL CHECK (action IN ('include','exclude')),
  PRIMARY KEY (vault_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_vault_overrides_vault ON memory_vault_overrides (vault_id);

-- ── V2 Phase B: entity resolution / contradiction review / fact-group dedup ──
-- Canonical home for these tables. They were previously created only lazily inside
-- their scans (src/memory/{entities,contradictions,fact_groups}.rs ensure_table[s]),
-- so a memory.db that never ran a scan — the shipped clean-db template + every fresh
-- install — lacked them and read-only consumers (the brain console) errored with
-- "no such table: memory_entities". Defining them here (the file the packager builds
-- the template from AND init_memory_tables runs) fixes both. The per-module
-- ensure_table[s] remain as idempotent no-ops; keep these definitions in sync with them.
CREATE TABLE IF NOT EXISTS memory_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'name'  -- org | handle | name
);
CREATE TABLE IF NOT EXISTS memory_entity_aliases (
  alias_key TEXT PRIMARY KEY,        -- normalized (org_key)
  entity_id INTEGER NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  display TEXT NOT NULL,
  derived INTEGER NOT NULL DEFAULT 0 -- 1 = machine-derived (e.g. unique surname)
);
CREATE INDEX IF NOT EXISTS idx_memory_entity_aliases_entity ON memory_entity_aliases(entity_id);
CREATE TABLE IF NOT EXISTS memory_entity_mentions (
  chunk_id TEXT NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity ON memory_entity_mentions(entity_id);

CREATE TABLE IF NOT EXISTS memory_contradictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_chunk_id TEXT NOT NULL,
  native_chunk_id TEXT NOT NULL,
  slot TEXT,
  import_value TEXT,
  native_value TEXT,
  import_text TEXT NOT NULL,
  native_text TEXT NOT NULL,
  import_scope TEXT,
  native_scope TEXT,
  cosine REAL,
  status TEXT NOT NULL DEFAULT 'open', -- open | no_conflict | kept_native | kept_import
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE(import_chunk_id, native_chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_contradictions_status ON memory_contradictions(status);

CREATE TABLE IF NOT EXISTS memory_fact_groups (
  chunk_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,          -- canonical chunk's id
  is_canonical INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,              -- canonical chunk id (NULL on the canonical row)
  reason TEXT NOT NULL DEFAULT 'near_dup', -- near_dup | resolution:<contradiction_id>
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_fact_groups_group ON memory_fact_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_memory_fact_groups_noncanon ON memory_fact_groups(is_canonical) WHERE is_canonical = 0;
