-- Migration script: 003_enhance_server_registry.sql
-- Brain Trust 4: Enhanced Server Registry Schema for Universal MCP Architecture
-- Adds support for both STDIO and HTTP connection types

-- Add connection_type column (defaulting to 'stdio' for backward compatibility)
ALTER TABLE mcp_servers ADD COLUMN connection_type TEXT NOT NULL DEFAULT 'stdio';

-- Add description column if it doesn't exist
ALTER TABLE mcp_servers ADD COLUMN description TEXT;

-- Add install_method column 
ALTER TABLE mcp_servers ADD COLUMN install_method TEXT;

-- Add health_status column with default value
ALTER TABLE mcp_servers ADD COLUMN health_status TEXT DEFAULT 'unknown';

-- Add last_health_check column for health monitoring
ALTER TABLE mcp_servers ADD COLUMN last_health_check DATETIME;

-- Add connection_config column for HTTP configuration
ALTER TABLE mcp_servers ADD COLUMN connection_config TEXT;

-- Add capabilities column for storing JSON capabilities
ALTER TABLE mcp_servers ADD COLUMN capabilities TEXT;

-- Add external_registry column for source tracking
ALTER TABLE mcp_servers ADD COLUMN external_registry TEXT;

-- Add tags column for server categorization (JSON array)
ALTER TABLE mcp_servers ADD COLUMN tags TEXT;

-- Add metadata column for rich server information (JSON object)
ALTER TABLE mcp_servers ADD COLUMN metadata TEXT;

-- Create schema_version table if it doesn't exist
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Update schema version to 3
INSERT OR REPLACE INTO schema_version (version) VALUES (3);