-- 089: PLAN-STATE-OF-THE-SYSTEM QA-B10 — a failing token renewal has to be visible and finite.
-- Nine connectors held access tokens that expired between 2026-05-02 and 2026-06-25 with a
-- refresh token beside each. The sweep ran every 5 minutes the whole time and failed every
-- time; the only record was a debug_print! (gated on DEBUG, so invisible on a normal install)
-- that printed the context and not the provider's reason. These two columns give the sweep a
-- memory: how many times a credential has failed in a row, and what the provider last said.
ALTER TABLE server_credentials ADD COLUMN refresh_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_credentials ADD COLUMN refresh_last_error TEXT;
