-- Migration 040: Raise priority for Vodou-Enhanced-Thinking "deep think" intents so they win when query contains both "deep think" and "memory".
-- "memory" has priority 90; without this, "oi deep think ... memory ..." ran get_memory_info instead of start_thinking_session.
-- 041 adds INSERT so the intents exist even if they were never seeded.

UPDATE intent_mappings
SET priority = 95
WHERE server_name = 'Vodou-Enhanced-Thinking' AND tool_name = 'start_thinking_session';
