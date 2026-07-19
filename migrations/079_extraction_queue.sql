-- Migration 079: extraction_queue — PLAN-EXTRACTION-ROBUSTNESS P1a (2026-07-17).
-- Ledger of per-conversation extraction outcomes: every span attempt lands as a
-- row with explicit state instead of vanishing into watermark arithmetic.
-- Granularity: one row per (source, conversation) — span_start/span_end record
-- the most recent attempted span (§8 Q1 decided: per-conversation span).
-- P1a scope: ledger + failure backoff + observability for the live gateway
-- lane. P1b evolves this into the claim-based work queue (import/capture lanes).
CREATE TABLE IF NOT EXISTS extraction_queue (
  source          TEXT NOT NULL,              -- 'gateway' | 'import' | 'capture:<lane>'
  conversation_id TEXT NOT NULL,
  span_start      INTEGER NOT NULL DEFAULT 0, -- first gateway_messages id of last attempt
  span_end        INTEGER NOT NULL DEFAULT 0, -- last gateway_messages id of last attempt
  state           TEXT NOT NULL DEFAULT 'pending',
                   -- 'done' | 'failed' | 'skipped' (P1b adds 'pending'/'extracting' claims)
  attempts        INTEGER NOT NULL DEFAULT 0, -- consecutive failures; reset on success
  last_error      TEXT,                       -- full error chain, or skip reason
  facts_written   INTEGER NOT NULL DEFAULT 0, -- cumulative bullets written for this conversation
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_extraction_queue_state ON extraction_queue(state);
