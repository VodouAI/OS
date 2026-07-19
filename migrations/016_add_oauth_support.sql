-- Migration script: 016_add_oauth_support.sql
-- Brain Trust 4: Add OAuth support (expires_at field + oauth_configs table)

-- Add expires_at to server_credentials if not present
ALTER TABLE server_credentials ADD COLUMN expires_at TEXT;

-- Create oauth_configs table
CREATE TABLE IF NOT EXISTS oauth_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL UNIQUE,
    authorization_endpoint TEXT,
    token_endpoint TEXT,
    client_id TEXT,
    client_secret TEXT,
    redirect_uri TEXT DEFAULT 'http://localhost:8080/callback',
    scope TEXT,
    provider_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Update schema version to 16
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (16, CURRENT_TIMESTAMP);
