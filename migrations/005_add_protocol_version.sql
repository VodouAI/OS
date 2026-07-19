-- Migration script: 005_add_protocol_version.sql
-- Brain Trust 4: MCP Protocol Version Backwards Compatibility Support
-- Adds protocol_version column to track successful protocol versions per server
-- This enables smart protocol fallback and caching for faster reconnections

-- Add protocol_version column to mcp_servers table
-- Default to '2025-06-18' which is the current standard protocol version
ALTER TABLE mcp_servers ADD COLUMN protocol_version TEXT DEFAULT '2025-06-18';

-- Create index for efficient protocol version queries
CREATE INDEX IF NOT EXISTS idx_mcp_servers_protocol_version ON mcp_servers(protocol_version);

-- Update schema version to 5
INSERT OR REPLACE INTO schema_version (version) VALUES (5);