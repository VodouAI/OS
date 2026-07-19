-- PLAN-ROUTER-LLM Phase 1 — router scaffold tables.
--
-- `router_cache` — keyed by (prompt_hash, context_hash); stores the JSON
--   decision plus the model that produced it. Lets us avoid re-routing the
--   same prompt+context combination during a session and across reboots.
-- `router_log` — one row per router decision. Drives the learning loop
--   (Phase 5: promoter folds stable patterns into intent_mappings).
--
-- Tables are created here and read/written by `src/router_llm.rs`. Phase 1
-- ships logging only; Phase 2 turns on execution paths.

CREATE TABLE IF NOT EXISTS router_cache (
  cache_key TEXT PRIMARY KEY,           -- sha256(prompt_norm || '|' || context_norm)
  prompt_hash TEXT NOT NULL,            -- sha256(prompt_norm), for analytics joins
  context_hash TEXT NOT NULL,           -- sha256(context_norm)
  decision_json TEXT NOT NULL,          -- the validated RouterDecision JSON
  model TEXT NOT NULL,                  -- which LLM produced it (auto/claude/haiku/...)
  created_at INTEGER NOT NULL,          -- unix ms
  hit_count INTEGER NOT NULL DEFAULT 0  -- bumped on every cache hit
);
CREATE INDEX IF NOT EXISTS idx_router_cache_prompt ON router_cache(prompt_hash);

CREATE TABLE IF NOT EXISTS router_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  prompt_preview TEXT,                  -- first ~80 chars of the prompt, for human-readable debugging
  decision_json TEXT NOT NULL,          -- the validated RouterDecision JSON
  action TEXT NOT NULL,                 -- intent | skill | tool | render_lens | lens_action | chat
  target TEXT,                          -- e.g. "cpu_status", "recipe.allrecipes"
  confidence INTEGER NOT NULL,          -- 0..100
  tier TEXT NOT NULL,                   -- "execute" | "nudge" | "discard"
  source TEXT NOT NULL,                 -- "llm" | "cache"
  accepted INTEGER,                     -- 1=user used the routed action, 0=ignored, NULL=unknown yet
  follow_up_correction TEXT,            -- captured if the user re-asks differently
  ts INTEGER NOT NULL                   -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_router_log_ts ON router_log(ts);
CREATE INDEX IF NOT EXISTS idx_router_log_prompt ON router_log(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_router_log_action ON router_log(action);
