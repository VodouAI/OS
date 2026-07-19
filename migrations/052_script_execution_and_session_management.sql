-- ============================================================================
-- Migration: Script Execution & Session Management Systems
-- ============================================================================
-- 
-- This migration adds support for:
-- 1. Script Execution System (Vodou-script-executor)
-- 2. Session Management System (Vodou-session-manager)
--
-- Version: 1.0.0
-- Date: 2025-12-30
-- 
-- Usage:
--   sqlite3 brain-trust4.db < migrations/001_script_execution_and_session_management.sql
--
-- This migration is IDEMPOTENT - safe to run multiple times
-- ============================================================================

BEGIN TRANSACTION;

-- ============================================================================
-- SCRIPT EXECUTION SYSTEM TABLES
-- ============================================================================

-- Table: script_registry
-- Stores registered scripts that can be executed via Vodou-script-executor
CREATE TABLE IF NOT EXISTS script_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,              -- e.g., "in-memoria"
    script_name TEXT NOT NULL,               -- e.g., "learn", "learn:force"
    command TEXT NOT NULL,                   -- e.g., "npm run learn"
    working_directory TEXT NOT NULL,         -- e.g., "./MCP-servers/OI-In-Memoria"
    description TEXT,                        -- Human-readable description
    parameters TEXT,                        -- JSON array: [{"name": "path", "type": "string", "optional": true}]
    auto_discovered BOOLEAN DEFAULT 0,       -- True if found via package.json scan
    background_execution BOOLEAN DEFAULT 0, -- True if script should run in background
    estimated_duration INTEGER,             -- Estimated duration in seconds (for UI)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_name, script_name)
);

CREATE INDEX IF NOT EXISTS idx_script_registry_server ON script_registry(server_name);
CREATE INDEX IF NOT EXISTS idx_script_registry_name ON script_registry(script_name);
CREATE INDEX IF NOT EXISTS idx_script_registry_server_name ON script_registry(server_name, script_name);

-- Table: script_jobs
-- Tracks background script execution jobs
CREATE TABLE IF NOT EXISTS script_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT UNIQUE NOT NULL,            -- UUID for job tracking
    server_name TEXT NOT NULL,
    script_name TEXT NOT NULL,
    command TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',  -- 'running', 'completed', 'failed', 'cancelled'
    pid INTEGER,                             -- Process ID of background job
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    exit_code INTEGER,
    output_file TEXT,                       -- Path to stdout log file
    error_file TEXT,                        -- Path to stderr log file
    progress TEXT,                          -- Progress information (JSON)
    FOREIGN KEY (server_name, script_name) REFERENCES script_registry(server_name, script_name)
);

CREATE INDEX IF NOT EXISTS idx_script_jobs_job_id ON script_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_script_jobs_status ON script_jobs(status);
CREATE INDEX IF NOT EXISTS idx_script_jobs_server_script ON script_jobs(server_name, script_name);
CREATE INDEX IF NOT EXISTS idx_script_jobs_started ON script_jobs(started_at);

-- Table: script_intent_metadata
-- Maps natural language keywords to scripts in script_registry
CREATE TABLE IF NOT EXISTS script_intent_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT UNIQUE NOT NULL,            -- Natural language keyword (e.g., "in-memoria auto learn")
    target_server TEXT NOT NULL,              -- Server name from script_registry
    target_script TEXT NOT NULL,              -- Script name from script_registry
    priority INTEGER DEFAULT 10,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (target_server, target_script) REFERENCES script_registry(server_name, script_name)
);

CREATE INDEX IF NOT EXISTS idx_script_intent_keyword ON script_intent_metadata(keyword);
CREATE INDEX IF NOT EXISTS idx_script_intent_target ON script_intent_metadata(target_server, target_script);

-- ============================================================================
-- SESSION MANAGEMENT SYSTEM TABLES
-- ============================================================================

-- Table: mcp_sessions
-- Tracks active MCP server sessions for long-running operations
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,         -- UUID for session
    server_name TEXT NOT NULL,                -- e.g., "chrome-devtools"
    server_command TEXT NOT NULL,             -- e.g., "npx"
    server_args TEXT,                         -- JSON array: e.g. ["-y", "chrome-devtools-mcp@latest"]
    working_directory TEXT,
    status TEXT NOT NULL DEFAULT 'active',    -- 'active', 'idle', 'closed', 'error'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,                     -- Auto-cleanup for idle sessions
    metadata TEXT,                            -- JSON: {"browser_type": "chromium", "url": "..."}
    pid INTEGER,                              -- Process ID of detached MCP server
    port INTEGER                              -- HTTP/SSE port for communication (if http_sse transport)
);

CREATE INDEX IF NOT EXISTS idx_mcp_sessions_server ON mcp_sessions(server_name);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_status ON mcp_sessions(status);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_session_id ON mcp_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_server_status ON mcp_sessions(server_name, status);

-- Note: The port column is included in the CREATE TABLE above
-- If the table already exists without the port column, it will be added
-- by the migration runner script (run-migration.sh) which checks
-- for the column before adding it

-- Table: mcp_session_calls
-- Optional analytics table for tracking tool calls on sessions
CREATE TABLE IF NOT EXISTS mcp_session_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments TEXT,                           -- JSON
    response_status TEXT,                     -- 'success', 'error'
    duration_ms INTEGER,
    error_message TEXT,
    called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES mcp_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_session_calls_session ON mcp_session_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_session_calls_tool ON mcp_session_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_session_calls_status ON mcp_session_calls(response_status);
CREATE INDEX IF NOT EXISTS idx_session_calls_called_at ON mcp_session_calls(called_at);

-- ============================================================================
-- INTENT MAPPINGS TABLE EXTENSIONS
-- ============================================================================

-- Add execution_type column to intent_mappings if it doesn't exist
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we need to check first
-- We'll use a pragma check to see if the column exists
-- If it doesn't exist, we'll add it

-- For SQLite 3.37.0+, we can use pragma_table_info in a subquery
-- For older versions, we'll need to handle this differently

-- Approach: Try to add the column, ignore error if it exists
-- SQLite will throw an error if column exists, which we'll catch in the migration script

-- Note: The actual ALTER TABLE will be handled by checking pragma_table_info
-- This is done in the migration runner script, not in pure SQL

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
-- ============================================================================
-- 
-- The following columns need to be added conditionally (handled by migration runner):
-- 1. intent_mappings.execution_type (if not exists)
-- 2. mcp_sessions.port (if table exists but column doesn't)
--
-- These are handled by run-migration.sh which checks before adding
-- ============================================================================

