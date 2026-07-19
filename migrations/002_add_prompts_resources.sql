-- Brain Trust 4: Add prompts and resources tables
-- Migration script: 002_add_prompts_resources.sql

-- Add prompts table
CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    arguments TEXT, -- JSON array of argument definitions
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id),
    UNIQUE(server_id, name)
);

-- Add resources table
CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    uri TEXT NOT NULL,
    name TEXT,
    description TEXT,
    mime_type TEXT,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id),
    UNIQUE(server_id, uri)
);

-- Add database version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert current version
INSERT OR IGNORE INTO schema_version (version) VALUES (2);