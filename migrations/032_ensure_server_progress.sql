-- Ensure server_progress table exists (safety net if migration 004 was skipped)
CREATE TABLE IF NOT EXISTS server_progress (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    operation_type TEXT,
    progress REAL,
    message TEXT,
    status TEXT DEFAULT 'running',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_server_progress_server_id ON server_progress(server_id);
CREATE INDEX IF NOT EXISTS idx_server_progress_operation_id ON server_progress(operation_id);
CREATE INDEX IF NOT EXISTS idx_server_progress_status ON server_progress(status);
