-- Migration 077: brain — memory-navigation MCP server registration + intent routes
-- Date: 2026-07-12
-- The brain server (MCP-servers/brain) is the read-only memory NAVIGATION surface:
-- constellation/chronicle graph, provenance, backlinks, conflicts, timeline, and the
-- Brain mini console web UI on 127.0.0.1:8767. It complements Vodou-Recall (ranked
-- recall + writes, migration 075) — no overlap in tools.
--
-- Seeding the mcp_servers row here is REQUIRED, not optional: run_migrations() is
-- followed by delete_orphan_intent_mappings(), which drops intent rows whose
-- server_name is missing from mcp_servers. Without the server row, a fresh install
-- would apply these intents and then immediately delete them.
-- Idempotent: INSERT OR IGNORE on the unique server name, OR REPLACE on keywords.

BEGIN TRANSACTION;

INSERT OR IGNORE INTO mcp_servers (name, command, args, connection_type, lifecycle_type, description)
VALUES ('brain', 'node', '["MCP-servers/brain/dist/index.js"]', 'stdio', 'ephemeral',
        'Memory-brain navigation: read-only graph/search/provenance/conflict tools over memory.db + Brain mini console web UI (127.0.0.1:8767)');

-- Open the interactive Brain console. EXPLICIT phrases only, and they pass
-- open:true (the tool no longer opens a browser tab by default — the daemon's
-- prompt-hook auto-router calls matched tools with generated {} args on ANY
-- semantically-close prompt, which opened 8767 tabs in pairs all day on
-- 2026-07-12). Fuzzy phrases ('brain map', 'memory map', 'memory graph') were
-- removed for the same reason — see migration 078 for the existing-install
-- cleanup.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('open brain', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('show my brain', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('brain console', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('memory constellation', 'brain', 'open_brain_console', 10, '{"open": true}');

-- Read-only navigation tools.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('brain overview', 'brain', 'brain_overview', 10, '{}'),
  ('memory conflicts', 'brain', 'brain_conflicts', 10, '{}'),
  ('memory contradictions', 'brain', 'brain_conflicts', 9, '{}'),
  ('memory timeline', 'brain', 'brain_timeline', 9, '{}'),
  ('memory entities', 'brain', 'brain_entities', 9, '{}');

COMMIT;
