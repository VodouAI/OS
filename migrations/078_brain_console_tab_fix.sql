-- Migration 078: stop the Brain console tab storm (2026-07-12 incident).
-- open_brain_console used to `open http://127.0.0.1:8767` unconditionally, and
-- the daemon prompt-hook auto-router calls semantically-matched tools with
-- generated {} args on ANY prompt event (including background task
-- notifications) — so brain-adjacent dev chatter opened new 8767 tabs in pairs
-- all day. Two-part fix:
--   1. The tool now opens a browser tab ONLY with open:true (brain server code).
--   2. Intents: drop the fuzzy phrases that matched ambient text; the kept
--      explicit phrases pass open:true so "show my brain" in chat still pops
--      the console. (077 is fixed the same way for fresh installs; this
--      migration is the cleanup for installs that already ran 077.)
-- Idempotent: DELETE + INSERT OR REPLACE.

BEGIN TRANSACTION;

DELETE FROM intent_mappings
 WHERE server_name = 'brain'
   AND tool_name = 'open_brain_console'
   AND keyword IN ('brain map', 'memory map', 'memory graph');

INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, tool_parameters) VALUES
  ('open brain', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('show my brain', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('brain console', 'brain', 'open_brain_console', 10, '{"open": true}'),
  ('memory constellation', 'brain', 'open_brain_console', 10, '{"open": true}');

COMMIT;
