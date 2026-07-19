-- Migration 023: workspace_bootstrap cache
CREATE TABLE IF NOT EXISTS workspace_bootstrap (
  workspace_path TEXT PRIMARY KEY,
  content_hash TEXT,
  cached_content TEXT,
  last_synced DATETIME
);
