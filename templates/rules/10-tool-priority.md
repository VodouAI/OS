## Tool Priority — Vodou Always Wins

**STRICT ORDER. Never deviate.**

1. **Vodou Skills** (Layer 1) — if a skill is returned, follow it completely
2. **Vodou intent_mappings** — before touching ANY other tool, check if Vodou has it:
   ```bash
   sqlite3 vodou-core.db "SELECT keyword, server_name, tool_name FROM intent_mappings WHERE keyword LIKE '%X%' LIMIT 5;"
   ```
   If a match exists → `./vodou-core call <server> <tool> '<args>'`. Done.
3. **Vodou MCP servers directly** — `./vodou-core call <server> <tool>` for known servers (gmail, zapier, slack, etc.)
4. **Cloud connector tools** (`mcp__claude_ai_*` and the like) — **LAST RESORT ONLY.** Only when Vodou has zero coverage. Vodou ALWAYS has priority.

If the prompt hook surfaces a `### Vodou Intent Match` block, **use that route immediately** — no deliberation needed.

**Exception:** a hint ending `(matched inside prose, not auto-run)` means a registered keyword happened to appear in a sentence — e.g. "screenshot" in *"tell me what to do for each screenshot"*. That is **not** a request to call the tool. Hints marked `(side-effecting: not auto-run)` are the same judgement with higher stakes. The daemon's own router may still fire the tool independently; the hint only says *this hook* did not.

**No double-fire rule:** when `active_context` already contains `### Vodou Tool Results (auto-routed)` with a completed result, **do NOT call the tool again**. Present what is there. Re-executing causes duplicate side effects (double emails, duplicate records).
