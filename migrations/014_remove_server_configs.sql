-- Migration script: 014_remove_server_configs.sql
-- Brain Trust 4: Remove unused server_configs table
-- This table was never used and is redundant with mcp_servers table

-- Drop the server_configs table if it exists
DROP TABLE IF EXISTS server_configs;

-- Update schema version to 14
INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (14, CURRENT_TIMESTAMP);

