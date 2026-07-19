-- Migration 012: Add ID mappings table for name-to-ID resolution
-- This table stores mappings between human-friendly names and API IDs

CREATE TABLE IF NOT EXISTS id_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    name TEXT NOT NULL,
    mapped_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_name, entity_type, name)
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_id_mappings_lookup 
ON id_mappings(server_name, entity_type, name);

CREATE INDEX IF NOT EXISTS idx_id_mappings_server 
ON id_mappings(server_name, entity_type);

-- Sample data (optional - remove in production)
-- INSERT INTO id_mappings (server_name, entity_type, name, mapped_id) 
-- VALUES ('mcp-server-asana', 'projects', 'OI OS', '1211709902166635');