-- Migration: Add work logs table
-- Version: 010
-- Description: Adds work_logs table for BT3-style logging

CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    message TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    source TEXT DEFAULT 'bt4',
    agent_type TEXT,
    session_id TEXT,
    metadata TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_work_logs_timestamp ON work_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_work_logs_category ON work_logs(category);