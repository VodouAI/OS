-- Migration script: 015_add_server_credentials.sql
-- Brain Trust 4: Add server_credentials table for remote MCP server authentication

-- Create server_credentials table
CREATE TABLE IF NOT EXISTS server_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    credential_type TEXT NOT NULL, -- "api_key", "oauth_token", "bearer_token", "env_var"
    credential_value TEXT, -- Encrypted or plain (NULL if using env_var)
    env_var_name TEXT, -- Environment variable name (e.g., "GUSTO_API_KEY")
    header_name TEXT, -- "Authorization", "X-API-Key", etc.
    header_format TEXT, -- "Bearer {token}", "{key}", etc.
    source TEXT DEFAULT 'database', -- "database", "env", "cli"
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE,
    UNIQUE(server_id, credential_type)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_server_credentials_server_id ON server_credentials(server_id);
CREATE INDEX IF NOT EXISTS idx_server_credentials_type ON server_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_server_credentials_env_var ON server_credentials(env_var_name);

-- Update schema version to 15
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (15, CURRENT_TIMESTAMP);











