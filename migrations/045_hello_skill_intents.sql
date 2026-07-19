-- Migration 045: Ensure hello / OI help intents (bt4_load_skill) so clean DB and fresh installs have them.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('hello', 'brain-trust4', 'bt4_load_skill', 15, '{"skill_name": "oi-hello"}'),
  ('hi oi', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('what is oi', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('how does oi work', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('help me get started', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('setup oi', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('oi help', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('oi guide', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}'),
  ('help center', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-hello"}');
