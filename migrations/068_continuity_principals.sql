-- Migration 068: Continuity primitive — Phase 0 schema
-- (PLAN-CONTINUITY-PRIMITIVE.md §4.1, §11; resolved §9 dated 2026-05-08)
--
-- Adds the `principal` primitive: identity that follows a real user across every
-- surface (web chat, channels, IDE hooks, voice, subagents). Includes the
-- `tenant_id` hedge per §11 — single-tenant 'self' today, multi-tenant ready
-- for SaaS without a refactor.
--
-- Additive, nullable, idempotent. Existing rows get `principal_id = '<self>'`
-- via backfill (separate Phase 0 step in Rust). Recall reads filter by
-- principal_id (Phase 2); writes go through `continuity::record_turn` (Phase 1).
--
-- Phase coverage in this migration:
--   1. tenants table (single 'self' row seeded)
--   2. principals table (no rows seeded — runtime seeds the install owner from
--      VODOU_USER_EMAIL + the assistant reserved row)
--   3. principal_aliases table (empty — populated as channels see new IDs)
--
-- Per plan §10 risk #7: principal_id is intentionally NOT added to FTS
-- triggers. Identity filtering happens in the SQL WHERE clause, NOT in the FTS
-- index. Do not add a column to the FTS doc without revisiting that decision.

CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO tenants (id, display_name) VALUES ('self', 'Self');

CREATE TABLE IF NOT EXISTS principals (
  id           TEXT PRIMARY KEY,                       -- ULID, stable forever
  tenant_id    TEXT NOT NULL DEFAULT 'self' REFERENCES tenants(id),
  display_name TEXT NOT NULL,
  email        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_self      INTEGER NOT NULL DEFAULT 0,
  -- Soft-delete merge target (per §10 risk #9). When set, queries should follow
  -- the chain to the canonical principal. `unmerge` admin command can split
  -- aliases back within the documented window.
  merged_into  TEXT REFERENCES principals(id)
);

CREATE INDEX IF NOT EXISTS idx_principals_tenant ON principals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_principals_self ON principals(is_self) WHERE is_self = 1;

CREATE TABLE IF NOT EXISTS principal_aliases (
  principal_id    TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  surface         TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  external_handle TEXT,
  -- NULL = auto-created from a public-facing surface, awaiting verification
  -- (per §10 risk #8). Recall queries opt-in via RecallQuery.include_unverified.
  verified_at     DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (surface, external_id)
);

CREATE INDEX IF NOT EXISTS idx_principal_aliases_pid ON principal_aliases(principal_id);

-- Reserved row: assistant-role turns carry this principal_id (per §10 risk #17).
-- Recall queries can scope `role = User` if user-only context is wanted.
INSERT OR IGNORE INTO principals (id, tenant_id, display_name, is_self)
  VALUES ('principal:assistant', 'self', 'Vodou Assistant', 0);
