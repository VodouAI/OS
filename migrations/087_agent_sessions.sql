-- 087 — agent_sessions: one row per LIVE agent session, so a session can be told
-- when a peer is editing the same files.
--
-- PLAN-SESSION-CONTRACT P1. The measured problem: nine live `claude` processes,
-- one worktree, one `.git/index`, 91 dirty files — and a new session's entire
-- situational awareness was a single line, `GIT@CWD: <branch> · <n> dirty`. Two
-- sessions have already swept each other's work in this repo.
--
-- Identity is `transcript_path`: unique per session, and the daemon already
-- derives the host from its shape (/.claude/, /.cursor/, /.codex/ …). There is no
-- pid available here — the hook is a separate short-lived process — and the
-- transcript is the stabler key anyway: it survives the hook, the pid does not.
--
-- `touched` is a JSON array from the V2-C extractor, which reads Read/Edit/Write
-- tool_use blocks already present in the hook payload. It costs nothing extra.
-- Deliberately NOT `git status`: that shells out, and the prototype that computed
-- situation at boot cost 1.39s against a 5s hook timeout on Gemini, where the
-- fail-safe is a silent no-op — the feature would vanish exactly on the busiest
-- machine.
--
-- Naive UTC per PLANS/PLAN-TIME-CANON.md; compared with datetime().
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_key TEXT PRIMARY KEY,
    host        TEXT NOT NULL DEFAULT 'unknown',
    cwd         TEXT,
    branch      TEXT,
    touched     TEXT,
    turns       INTEGER NOT NULL DEFAULT 0,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The read is "who else is live in my cwd", every prompt, on the hook's latency
-- budget. It must never table-scan.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_live ON agent_sessions(last_seen DESC, cwd);
