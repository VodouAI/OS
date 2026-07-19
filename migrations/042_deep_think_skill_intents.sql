-- Route "deep think" (and variants) to oi-deep-thinking SKILL so agents get full workflow
-- (stopping points, add_thought, analyze_thinking). Priority 96 beats MCP intents at 95.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('deep think', 'brain-trust4', 'bt4_load_skill', 96, '{"skill_name": "oi-deep-thinking"}'),
  ('think deep', 'brain-trust4', 'bt4_load_skill', 96, '{"skill_name": "oi-deep-thinking"}'),
  ('deep research', 'brain-trust4', 'bt4_load_skill', 96, '{"skill_name": "oi-deep-thinking"}'),
  ('analyze deeply', 'brain-trust4', 'bt4_load_skill', 96, '{"skill_name": "oi-deep-thinking"}'),
  ('comprehensive analysis', 'brain-trust4', 'bt4_load_skill', 96, '{"skill_name": "oi-deep-thinking"}');
