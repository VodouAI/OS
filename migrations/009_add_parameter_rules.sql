-- Migration 009: Add parameter_rules table for KISS optimization
-- This replaces the hardcoded 7,071-line JSON with database storage

-- Create parameter_rules table
CREATE TABLE IF NOT EXISTS parameter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_signature TEXT NOT NULL UNIQUE, -- "server::tool"
    required_fields TEXT NOT NULL,        -- JSON array of required fields
    field_generators TEXT NOT NULL,       -- JSON object of field generators
    patterns TEXT NOT NULL,               -- JSON array of query patterns
    success_count INTEGER DEFAULT 0,
    last_used TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_name, tool_name)
);

-- Create indices for fast server-specific lookups (KISS optimization)
CREATE INDEX IF NOT EXISTS idx_parameter_rules_server ON parameter_rules(server_name);
CREATE INDEX IF NOT EXISTS idx_parameter_rules_signature ON parameter_rules(tool_signature);
CREATE INDEX IF NOT EXISTS idx_parameter_rules_server_tool ON parameter_rules(server_name, tool_name);

-- Update schema version  
INSERT OR IGNORE INTO schema_version (version) VALUES (9);