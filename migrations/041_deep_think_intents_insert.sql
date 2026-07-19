-- Migration 041: Ensure "deep think" intents exist with priority 95 (so they win over "memory" 90).
-- Some DBs never had these seeded; INSERT OR REPLACE so deep think works.

INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('deep think', 'Vodou-Enhanced-Thinking', 'start_thinking_session', 95),
  ('think deep', 'Vodou-Enhanced-Thinking', 'start_thinking_session', 95),
  ('deep research', 'Vodou-Enhanced-Thinking', 'start_thinking_session', 95),
  ('analyze deeply', 'Vodou-Enhanced-Thinking', 'start_thinking_session', 95),
  ('comprehensive analysis', 'Vodou-Enhanced-Thinking', 'start_thinking_session', 95);
