-- ─────────────────────────────────────────────────────────────────────────────
-- vodou-core.db — migration 071 — automations circuit breaker
-- Adds consecutive_failures + auto_disabled_at to the automations table so the
-- runner can auto-quarantine an automation that keeps failing.
--
-- Motivation: PLAN-SILENT-ISSUES-AUDIT.md §2.2 — automation #5 (linear) racked
-- up 931 consecutive failed runs and #7 (asana) 513, both still enabled,
-- spamming `.vodou/system.log` with the same OAuth error every interval. No
-- code path noticed.
--
-- Behavior (implemented in src/automations.rs):
--   - On each failed trigger: increment consecutive_failures.
--   - When it reaches AUTOMATION_BREAKER_LIMIT (default 10): set enabled=0,
--     stamp auto_disabled_at, eprintln one "auto-disabled" line, stop scheduling.
--   - On each success: reset consecutive_failures to 0 in advance_automation.
--
-- Single-run safety comes from the schema_version gate in
-- src/database.rs::ensure_migrations (`if current_version < 71`).
-- SQLite's ALTER TABLE ADD COLUMN is not idempotent on its own — re-running
-- on a column that already exists raises "duplicate column name".
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN TRANSACTION;

-- consecutive_failures: bumped on every failed run, reset on every success.
ALTER TABLE automations ADD COLUMN consecutive_failures INTEGER DEFAULT 0;

-- auto_disabled_at: ISO timestamp set the instant the breaker trips.
-- NULL means the automation has never been auto-disabled (was either
-- never tripped, or was manually re-enabled after a trip).
ALTER TABLE automations ADD COLUMN auto_disabled_at TEXT;

COMMIT;
