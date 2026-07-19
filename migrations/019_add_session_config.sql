-- Migration 019: Add session_config column to mcp_servers table
-- This enables universal session management for any MCP server

BEGIN TRANSACTION;

-- Add session_config column to mcp_servers table
-- JSON format: {"requires_session": true, "startup_timeout_ms": 5000, "launch_args": []}
ALTER TABLE mcp_servers ADD COLUMN session_config TEXT;

-- Auto-populate for existing servers that need sessions
UPDATE mcp_servers 
SET session_config = '{"requires_session": true, "startup_timeout_ms": 3000, "launch_args": ["--channel=stable"]}'
WHERE name = 'chrome-devtools-mcp';

-- All other servers default to no session required
UPDATE mcp_servers 
SET session_config = '{"requires_session": false}'
WHERE session_config IS NULL;

COMMIT;

