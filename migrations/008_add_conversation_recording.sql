-- Migration: Add conversation recording system
-- Version: 008
-- Description: Adds tables for recording AI agent conversations, tool executions, and analytics

-- Conversation sessions table
CREATE TABLE IF NOT EXISTS conversation_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    start_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    user_id TEXT,
    session_type TEXT NOT NULL CHECK (session_type IN ('oi_command', 'direct_call', 'mcp_integration', 'debugging', 'testing')),
    total_interactions INTEGER DEFAULT 0,
    total_execution_time_ms INTEGER DEFAULT 0,
    metadata TEXT, -- JSON for additional session data
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Conversation entries table (individual interactions)
CREATE TABLE IF NOT EXISTS conversation_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    interaction_type TEXT NOT NULL CHECK (interaction_type IN ('oi_command', 'direct_tool_call', 'intelligent_query', 'system_command', 'error_recovery')),
    user_query TEXT NOT NULL,
    ai_response TEXT,
    execution_time_ms INTEGER NOT NULL,
    context_snapshot TEXT, -- JSON snapshot of context
    privacy_mode TEXT DEFAULT 'full' CHECK (privacy_mode IN ('full', 'sanitized', 'aggregated', 'none')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id)
);

-- Tool executions table
CREATE TABLE IF NOT EXISTS conversation_tool_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    parameters TEXT, -- JSON
    result TEXT, -- JSON
    execution_time_ms INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    error_message TEXT,
    parameter_rule_used TEXT,
    execution_order INTEGER NOT NULL, -- Order within the entry
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES conversation_entries (entry_id)
);

-- Conversation metrics table (aggregated analytics)
CREATE TABLE IF NOT EXISTS conversation_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    metric_type TEXT NOT NULL CHECK (metric_type IN ('performance', 'quality', 'usage', 'error')),
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    metric_unit TEXT,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES conversation_sessions (session_id)
);

-- Conversation context table (detailed context tracking)
CREATE TABLE IF NOT EXISTS conversation_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    context_type TEXT NOT NULL CHECK (context_type IN ('query_analysis', 'intent_detection', 'parameter_generation', 'tool_selection', 'performance')),
    context_data TEXT NOT NULL, -- JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (entry_id) REFERENCES conversation_entries (entry_id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_start_time ON conversation_sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_id ON conversation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_entries_session_id ON conversation_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_entries_timestamp ON conversation_entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_tool_executions_entry_id ON conversation_tool_executions(entry_id);
CREATE INDEX IF NOT EXISTS idx_conversation_tool_executions_server_tool ON conversation_tool_executions(server_name, tool_name);
CREATE INDEX IF NOT EXISTS idx_conversation_metrics_session_id ON conversation_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_context_entry_id ON conversation_context(entry_id);

-- Create metadata table if it doesn't exist
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Update schema version
INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '8');