-- Migration 049: Data-driven session configs for generic brain_loader routing
-- Removes need for hardcoded server names in brain_loader.rs

-- Vodou-Enhanced-Thinking: session lifecycle for two-step orchestration
UPDATE mcp_servers SET session_config = '{"requires_session": false, "has_session_lifecycle": true, "session_start_tool": "start_thinking_session", "session_complete_tool": "complete_thinking_session"}'
WHERE name = 'Vodou-Enhanced-Thinking' AND (session_config IS NULL OR session_config = '' OR session_config = '{"requires_session": false}');

-- Vodou-LLM-router: fallback for unmatched queries
UPDATE mcp_servers SET session_config = '{"requires_session": false, "is_fallback": true, "fallback_tool": "chat", "fallback_param": "message"}'
WHERE name = 'Vodou-LLM-router' AND (session_config IS NULL OR session_config = '' OR session_config = '{"requires_session": false}');
