-- 088: PLAN-CONTEXT-COORDINATION P7-0 — the receipt survives a reload with its lanes.
-- The live receipt frame carries what every context lane contributed; the persisted
-- row carried memories only, so the same turn read "Memory 4 · tools 2 · 3.2s" live
-- and "Memory 4" after a reload. One JSON column, written by the assembler (llm.ts,
-- the single place that knows every lane), read by receiptsForTurns (index.ts).
-- P3 keeps the full one-row-per-block design behind the data gate.
ALTER TABLE turn_receipts ADD COLUMN lanes TEXT;   -- JSON array of {lane, chars}
