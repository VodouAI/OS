-- Map keyword "memory" to mcp-monitor::get_memory_info so "oi cpu memory" / "oi cpu memory disk" run in parallel.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('memory', 'mcp-monitor', 'get_memory_info', 90);
