-- "ux" intent: open browser to Vodou-Console chat dashboard (localhost:8765)
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('ux', 'brain-trust4', 'bt4_workspace_run_command', 10, '{"command": "open http://localhost:8765/"}');
