-- Migration 025: OI Memory System Skills - Intent Mappings
-- Date: 2026-02-14
-- Adds intent mappings for oi-presence, oi-soul, oi-context (Phase 13)

BEGIN TRANSACTION;

-- oi-presence: "what am I working on", presence, current project, etc.
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('presence', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}'),
  ('what am I working on', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}'),
  ('current project', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}'),
  ('what project', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}'),
  ('show presence', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}'),
  ('workspace context', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-presence"}');

-- oi-soul: soul, SOUL.md, persona, preferences, boundaries
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('soul', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('show my soul', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('update SOUL', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('SOUL.md', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('persona', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('my boundaries', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}'),
  ('update preference', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-soul"}');

-- oi-context: what context, refresh memory, memory cache
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('oi context', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('what context is loaded', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('what context', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('refresh memory', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('refresh cache', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('loaded context', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}'),
  ('memory cache', 'brain-trust4', 'bt4_load_skill', 10, '{"skill_name": "oi-context"}');

COMMIT;
