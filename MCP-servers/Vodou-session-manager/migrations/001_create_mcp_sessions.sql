-- Run this migration to set up MCP session tables
-- Execute: sqlite3 vodou-core.db < migrations/001_create_mcp_sessions.sql

-- Create mcp_sessions table
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    server_name TEXT NOT NULL,
    server_command TEXT NOT NULL,
    server_args TEXT,
    working_directory TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    metadata TEXT,
    pid INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_server ON mcp_sessions(server_name);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_status ON mcp_sessions(status);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_session_id ON mcp_sessions(session_id);

-- Create mcp_session_calls table
CREATE TABLE IF NOT EXISTS mcp_session_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments TEXT,
    response_status TEXT,
    duration_ms INTEGER,
    error_message TEXT,
    called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_calls_session ON mcp_session_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_session_calls_tool ON mcp_session_calls(tool_name);

