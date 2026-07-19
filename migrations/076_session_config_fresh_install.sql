-- Migration 076: session_config backfill for fresh installs (P0-5, PLAN-QA-SWEEP-FINDINGS)
-- Date: 2026-07-12
--
-- Migrations 019 (ALTER mcp_servers ADD session_config + defaults) and 049
-- (data-driven session configs) were never wired into the runner — the runner
-- jumped 018→021 and 048→050 — so fresh installs never got the column and the
-- session-manager routing path in brain_loader.rs (requires_session branch)
-- was dead code on any new machine. This migration supersedes both:
--   * the ALTER is done in Rust (run_migration_076) behind a pragma_table_info
--     guard, because SQLite has no ADD COLUMN IF NOT EXISTS;
--   * the UPDATEs below are 019's defaults + 049's per-server configs, with
--     049's original don't-overwrite-operator-edits WHERE guards.
-- 019/049 stay on the runner-guard skip-list as superseded; 020 (empty) and
-- 047 (targets the removed brain-trust4 server) are obsolete.

BEGIN TRANSACTION;

-- 019: chrome-devtools needs a persistent session.
UPDATE mcp_servers
SET session_config = '{"requires_session": true, "startup_timeout_ms": 3000, "launch_args": ["--channel=stable"]}'
WHERE name = 'chrome-devtools-mcp'
  AND (session_config IS NULL OR session_config = '');

-- 049: Vodou-Enhanced-Thinking — two-step session lifecycle.
UPDATE mcp_servers
SET session_config = '{"requires_session": false, "has_session_lifecycle": true, "session_start_tool": "start_thinking_session", "session_complete_tool": "complete_thinking_session"}'
WHERE name = 'Vodou-Enhanced-Thinking'
  AND (session_config IS NULL OR session_config = '' OR session_config = '{"requires_session": false}');

-- 049: Vodou-LLM-router — fallback for unmatched queries.
UPDATE mcp_servers
SET session_config = '{"requires_session": false, "is_fallback": true, "fallback_tool": "chat", "fallback_param": "message"}'
WHERE name = 'Vodou-LLM-router'
  AND (session_config IS NULL OR session_config = '' OR session_config = '{"requires_session": false}');

-- 019: everything else defaults to no session required.
UPDATE mcp_servers
SET session_config = '{"requires_session": false}'
WHERE session_config IS NULL OR session_config = '';

COMMIT;
