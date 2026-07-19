-- Migration script: 004_roots_handler_implementation.sql
-- Brain Trust 4: Roots Handler Implementation with Enhanced MCP Capabilities
-- Adds support for roots/list, sampling/request, and user approval workflow

-- Table to store allowed directories per server
CREATE TABLE IF NOT EXISTS server_roots (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    uri TEXT NOT NULL,
    name TEXT,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_server_roots_server_id ON server_roots(server_id);

-- Table to store sampling configurations per server
CREATE TABLE IF NOT EXISTS server_sampling (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    sampling_type TEXT NOT NULL, -- 'data', 'context', 'performance', etc.
    configuration TEXT, -- JSON configuration for sampling
    enabled BOOLEAN DEFAULT true,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_server_sampling_server_id ON server_sampling(server_id);

-- Table to store notification preferences per server
CREATE TABLE IF NOT EXISTS server_notifications (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    notification_type TEXT NOT NULL, -- 'roots/listChanged', 'status/update', etc.
    enabled BOOLEAN DEFAULT true,
    handler_config TEXT, -- JSON configuration for notification handling
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_server_notifications_server_id ON server_notifications(server_id);

-- Table to store progress tracking for long-running operations
CREATE TABLE IF NOT EXISTS server_progress (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    operation_type TEXT, -- 'sampling', 'file_operation', 'analysis', etc.
    progress REAL, -- 0.0 to 1.0
    message TEXT,
    status TEXT DEFAULT 'running', -- 'running', 'completed', 'cancelled', 'failed'
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_server_progress_server_id ON server_progress(server_id);
CREATE INDEX IF NOT EXISTS idx_server_progress_operation_id ON server_progress(operation_id);
CREATE INDEX IF NOT EXISTS idx_server_progress_status ON server_progress(status);

-- Table to store user approval logs for sensitive operations
CREATE TABLE IF NOT EXISTS user_approvals (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    operation_type TEXT NOT NULL, -- 'sampling', 'elicitation', 'file_write', etc.
    operation_details TEXT, -- JSON details of the operation
    user_decision TEXT NOT NULL, -- 'approved', 'denied'
    user_comment TEXT, -- Optional user comment
    auto_approved BOOLEAN DEFAULT false, -- If approval was automated
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_approvals_server_id ON user_approvals(server_id);
CREATE INDEX IF NOT EXISTS idx_user_approvals_operation_type ON user_approvals(operation_type);
CREATE INDEX IF NOT EXISTS idx_user_approvals_decision ON user_approvals(user_decision);

-- Table to store auto-approval policies per server
CREATE TABLE IF NOT EXISTS server_auto_approvals (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    operation_type TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT 'manual', -- 'auto', 'manual', 'strict'
    conditions TEXT, -- JSON conditions for auto-approval
    enabled BOOLEAN DEFAULT true,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE,
    UNIQUE(server_id, operation_type)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_server_auto_approvals_server_id ON server_auto_approvals(server_id);
CREATE INDEX IF NOT EXISTS idx_server_auto_approvals_operation_type ON server_auto_approvals(operation_type);
CREATE INDEX IF NOT EXISTS idx_server_auto_approvals_policy ON server_auto_approvals(policy);

-- Update schema version to 4
INSERT OR REPLACE INTO schema_version (version) VALUES (4);