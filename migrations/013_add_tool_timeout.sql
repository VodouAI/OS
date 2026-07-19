-- Migration 013: Add timeout_seconds column to tools table
-- Allows per-tool timeout configuration for long-running operations

ALTER TABLE tools ADD COLUMN timeout_seconds INTEGER;

