-- Migration 021: OI Memory System - memory_chunks, memory_embeddings, memory_fts
-- Native memory indexing for workspace bootstrap and prompt-targeted retrieval

-- memory_chunks: stores chunked text from MEMORY.md and memory/**/*.md
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  start_line INT,
  end_line INT,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- FTS5 for keyword search (content table mode - syncs with memory_chunks)
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
