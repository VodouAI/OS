-- Migration 073 — Skill-Learning Loop (PLAN-SKILL-LEARNING-LOOP, v0.5.103 Phase 0)
--
-- Foundation for the autonomous PROPOSE → VERIFY → PROMOTE skill loop. Adds the
-- telemetry + lifecycle substrate the later phases consume. The skills_registry
-- lifecycle/provenance COLUMNS are added in Rust (run_migration_073) as
-- individual .ok()-guarded ALTERs so fresh installs — which create
-- skills_registry inline with the columns already present — don't abort on a
-- duplicate-column error. This file holds only the NEW tables (idempotent via
-- IF NOT EXISTS); the schema_version bump is done in Rust like migration 072.
--
-- Cross-plan note: lives in the CORE migration sequence (vodou-core.db). The
-- sibling PLAN-BOARD-HERMES-PARITY uses its own board.db migration runner
-- (src/board/migrate.rs) — no collision.
--
-- Outcome-capture note: the per-turn trajectory table lives in gateway.db
-- (gateway_tool_trajectories, created by MCP-servers/Vodou-Console/src/db.ts),
-- NOT here. Decided 2026-05-31: the only capturable interactive surface is the
-- gateway BYOK SDK chat loop (llm.ts) — tool calls in claude-CLI/board
-- subprocesses are invisible to us — and the gateway natively owns gateway.db,
-- so capture writes there with zero process spawns. The Rust skill_proposer
-- reads gateway.db (as memory extraction already does). The three tables below
-- belong with skills_registry and stay in core.

-- 1. Skill embeddings — mirrors intent_embeddings (migration 050). 384 x f32
--    (AllMiniLML6V2Q) packed little-endian as a BLOB. content_hash tracks the
--    skills_registry row's hash at embed time so staleness can be detected.
CREATE TABLE IF NOT EXISTS skill_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_name TEXT NOT NULL,
    source_type TEXT NOT NULL,           -- description|title|synthetic
    source_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    content_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_skill_emb_name ON skill_embeddings(skill_name);

-- 2. Skill effectiveness metrics — drives routing self-optimization (Phase 3)
--    and the candidate->trusted auto-promotion policy (Phase 1D).
CREATE TABLE IF NOT EXISTS skill_metrics (
    skill_name TEXT PRIMARY KEY,
    invocations INTEGER DEFAULT 0,
    successes INTEGER DEFAULT 0,
    failures INTEGER DEFAULT 0,
    last_used DATETIME,
    avg_step_count REAL,
    rolling_success_rate REAL            -- EWMA
);

-- 3. Governance audit log — append-only record of every lifecycle transition
--    (beats Hermes weakness #4: no audit trail for auto-created skills).
CREATE TABLE IF NOT EXISTS skill_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at DATETIME DEFAULT CURRENT_TIMESTAMP,
    skill_name TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    actor TEXT,                          -- autonomous|scheduler|user:<email>|janitor
    reason TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_audit_name ON skill_audit_log(skill_name);
