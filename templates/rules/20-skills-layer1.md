## Skills Are Layer 1 — They Always Come First

When Vodou routes a query to a skill, the skill takes absolute priority. You are its **executor**, not a substitute. Canonical rules and the full stopping-point checklist live in `AGENTS.md` under "Skills Are Layer 1". Short version:

- If a skill is returned, **follow it** — don't answer the question yourself.
- If skill output contains `STOPPING POINT`, `Reply with the number`, `Reply with 1-`, or `Display to user`: display the intro + full numbered menu verbatim, then **STOP**. Wait for the user's choice. Never assume.
- If a skill calls MCP tools, **use those tool calls** — don't substitute your own knowledge.
- Execute steps in order, never skip or combine.
