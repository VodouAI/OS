-- Brain Trust 4: Add parameter generation cache
-- Migration script: 007_add_parameter_cache.sql

-- Add parameter cache table for performance
CREATE TABLE IF NOT EXISTS parameter_cache (
    id INTEGER PRIMARY KEY,
    tool_signature TEXT NOT NULL,           -- "server::tool"
    query_hash TEXT NOT NULL,               -- Hash of query for fast lookup
    parameters TEXT NOT NULL,               -- JSON parameters
    success_count INTEGER DEFAULT 1,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tool_signature, query_hash)
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_parameter_cache_lookup 
ON parameter_cache(tool_signature, query_hash);

-- Insert current version
INSERT OR IGNORE INTO schema_version (version) VALUES (7);