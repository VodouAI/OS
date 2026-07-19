-- Migration 075: Universal Memory — MCP write/read intent mappings
-- Date: 2026-07-09
-- PLAN-UNIVERSAL-MEMORY Phase 6 (§10.3). The memory brain is exposed via the EXISTING
-- Vodou-Recall MCP server: search_memory (already shipped) + memory_store / memory_get
-- (added this phase). No separate server — folding into Vodou-Recall avoids duplicating
-- its search_memory tool. Routes below let Vodou's own BrainLoader reach the brain.
-- Idempotent (INSERT OR REPLACE keyed on the keyword).

BEGIN TRANSACTION;

-- Recall durable facts/decisions/preferences + imported history (existing tool).
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('what do I know about', 'Vodou-Recall', 'search_memory', 10, '{}'),
  ('search my memory', 'Vodou-Recall', 'search_memory', 10, '{}'),
  ('what did we decide', 'Vodou-Recall', 'search_memory', 10, '{}');

-- Persist a fact into the brain (provenance import:mcp, sanitized).
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('remember that', 'Vodou-Recall', 'memory_store', 10, '{}'),
  ('store this', 'Vodou-Recall', 'memory_store', 10, '{}'),
  ('note to memory', 'Vodou-Recall', 'memory_store', 10, '{}'),
  ('save to memory', 'Vodou-Recall', 'memory_store', 10, '{}');

-- Verbatim read-back by chunk id or path.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('get memory chunk', 'Vodou-Recall', 'memory_get', 10, '{}'),
  ('read memory at', 'Vodou-Recall', 'memory_get', 10, '{}');

COMMIT;
