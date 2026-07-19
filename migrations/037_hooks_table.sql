-- Migration 037: OI Hooks System
-- Date: 2026-02-22
-- Adds hooks table for user-defined lifecycle hooks (PreToolUse, PostToolUse, etc.)

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS hooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_name TEXT NOT NULL,
    matcher_type TEXT,
    matcher_value TEXT,
    hook_type TEXT NOT NULL DEFAULT 'command',
    hook_command TEXT NOT NULL,
    hook_config TEXT,
    priority INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hooks_event ON hooks(event_name, enabled);
CREATE INDEX IF NOT EXISTS idx_hooks_matcher ON hooks(matcher_type, matcher_value);
CREATE INDEX IF NOT EXISTS idx_hooks_priority ON hooks(event_name, priority);

COMMIT;
