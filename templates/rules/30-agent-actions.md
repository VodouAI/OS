## Agent Instructions & AGENT_ACTIONS

Skills can embed executable tool sequences as `<!-- AGENT_ACTIONS_N: {...} -->` HTML comments. Full spec (template variables, `loop`, `capture`, `stream_progress`) lives in `AGENTS.md` §6. Short form:

1. **Vodou-Console web chat**: the gateway's workflow driver handles execution automatically — you just format results.
2. **Any coding agent (this file)**: parse the AGENT_ACTIONS JSON and execute each step via `./vodou-core call <server> <tool> '<args>'`.

If Vodou output contains `## Agent instructions` (human-readable) or `AGENT_ACTIONS:` (inline JSON), execute those steps before replying. If `.vodou/workspace/agent_next_steps.json` exists at turn start, run those actions, then respond.

### MCP Tool Calls Are Mandatory — Never Fake Data

When AGENT_ACTIONS or a skill says to call MCP tools, you MUST execute ALL of them via `./vodou-core call <server> <tool>` BEFORE responding. Never substitute LLM knowledge for live data. Users need real numbers, not approximations.
