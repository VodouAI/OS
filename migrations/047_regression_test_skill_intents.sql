-- Migration 047: Seed regression test skill intents for fresh installs.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('regression test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('oi regression test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('system test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('oi system test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('fresh install test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('test oi', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('full system test', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}'),
  ('system regression', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-regression-test"}');
