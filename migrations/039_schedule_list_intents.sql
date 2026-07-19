-- Migration 039: Schedule list intents (bt4_schedule_list) with priority 20 so "scheduled tasks" / "schedule list" list instead of add.
-- Fixes: "oi scheduled_tasks" and "schedule list" previously matched "schedule" -> bt4_schedule_add and added a task.

INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('scheduled tasks', 'brain-trust4', 'bt4_schedule_list', 20),
  ('scheduled_tasks', 'brain-trust4', 'bt4_schedule_list', 20),
  ('schedule list', 'brain-trust4', 'bt4_schedule_list', 20),
  ('list scheduled tasks', 'brain-trust4', 'bt4_schedule_list', 20),
  ('list scheduled', 'brain-trust4', 'bt4_schedule_list', 20);
