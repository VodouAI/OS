---
name: vodou-memory
description: Use the user's Vodou memory — recall what they told any AI before, and save what matters now. Use when the user references something from a past session, asks "do you remember", states a preference/decision/fact worth keeping, or when a task would go better with personal context.
---

# Vodou memory

Vodou keeps one memory for every AI the user talks to. It lives in SQLite on their machine. This plugin exposes it as MCP tools; the session-start hook already injected the most relevant slice as context.

## Tools

| Tool | Use it when |
|---|---|
| `vc_memory_context` | You want a ready-to-paste block of what's relevant to the current task. Cheapest; call first. |
| `vc_memory_search` | You need a specific fact ("what did they say the API rate limit was"). Hybrid keyword + vector search. |
| `vc_remember` | The user states something durable: a preference, a decision, a fact about their setup, a correction. |

## Rules

1. **Recall before you ask.** If the user says "the usual", "like last time", "my project", "the dog's name" — search first, ask second.
2. **Save durable facts, not chatter.** Preferences ("never use dairy"), decisions ("we chose SQLite over Postgres for the vault"), corrections ("the staging bucket is in us-east-2, not us-east-1"), setup facts ("prod deploys via ec2-user"). Not tool output, not intermediate reasoning, not anything ephemeral.
3. **Write it so a stranger could use it.** Full sentences, names not pronouns, absolute dates not "yesterday".
4. **Corrections supersede.** If the user corrects something you recalled, save the correction — Vodou marks the old fact superseded.
5. **Say what you did.** "Saved to your Vodou memory: …" / "From your memory (2026-08-14): …" so the user knows where a fact came from and can fix it.

## Not here

Memory you save here is visible to every other AI attached to the same Vodou engine (Cursor, ChatGPT via the Vodou Bridge extension, Claude.ai, Codex…). That's the point — but don't save something the user said in confidence to *this* tool without saying so.
