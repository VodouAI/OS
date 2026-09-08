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

**Exception:** a hint containing `— hook: not auto-run` was surfaced for you to judge, not executed. `.claude/hooks/intent_executor.py` emits three of them and the rules used to quote two strings it never wrote (SW-10), so match on that substring, not on a whole parenthetical:

- `(matched inside prose — hook: not auto-run; …)` — a registered keyword happened to appear in a sentence, e.g. "screenshot" in *"tell me what to do for each screenshot"*. **Not** a request to call the tool.
- `(side-effecting — hook: not auto-run; …)` — the same judgement with higher stakes; the hook refuses to auto-fire anything that sends, writes or spends.
- `(skill route — hook: not auto-run; …)` — the keyword maps to a skill, and Layer 1 decides, not the hook.

All three end `; the daemon router may still fire this independently` — the hint says only that *this hook* did not.

**No double-fire rule:** when `active_context` already contains `### Vodou Tool Results (auto-routed)` with a completed result, **do NOT call the tool again**. Present what is there. Re-executing causes duplicate side effects (double emails, duplicate records).
