-- Migration 024: memory_cache for prompt-targeted lookup
CREATE TABLE IF NOT EXISTS memory_cache (
  presence_key TEXT PRIMARY KEY,
  memories_json TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);
