-- Migration script: 017_add_prm_support.sql
-- Brain Trust 4: Add PRM (Protected Resource Metadata) and Dynamic Client Registration support

-- Add PRM document storage
CREATE TABLE IF NOT EXISTS protected_resource_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    resource_server TEXT NOT NULL,
    prm_document TEXT NOT NULL, -- JSON blob
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE,
    UNIQUE(server_id)
);

-- Add dynamic client credentials
CREATE TABLE IF NOT EXISTS dynamic_oauth_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT,
    registration_endpoint TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE,
    UNIQUE(server_id)
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_prm_server_id ON protected_resource_metadata(server_id);
CREATE INDEX IF NOT EXISTS idx_dynamic_client_server_id ON dynamic_oauth_clients(server_id);

-- Update schema version to 17
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (17, CURRENT_TIMESTAMP);

