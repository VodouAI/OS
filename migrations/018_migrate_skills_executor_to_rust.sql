-- Migration 018: Migrate Skills Executor from TypeScript to Rust
-- Date: 2026-01-19
-- Description: Update intent mappings from OI-skills-executor to brain-trust4

BEGIN TRANSACTION;

-- Update server_name from 'OI-skills-executor' to 'brain-trust4'
UPDATE intent_mappings
SET server_name = 'brain-trust4'
WHERE server_name = 'OI-skills-executor';

-- Update tool_name from 'load_skill' to 'bt4_load_skill'
UPDATE intent_mappings
SET tool_name = 'bt4_load_skill'
WHERE server_name = 'brain-trust4' AND tool_name = 'load_skill';

-- Update tool_name from 'list_skills' to 'bt4_list_skills'
UPDATE intent_mappings
SET tool_name = 'bt4_list_skills'
WHERE server_name = 'brain-trust4' AND tool_name = 'list_skills';

-- Update tool_name from 'search_skills' to 'bt4_search_skills'
UPDATE intent_mappings
SET tool_name = 'bt4_search_skills'
WHERE server_name = 'brain-trust4' AND tool_name = 'search_skills';

-- Note: tool_parameters do NOT need to change - same JSON format
-- Example: {"skill_name": "oi-hello"} works for both implementations

COMMIT;

