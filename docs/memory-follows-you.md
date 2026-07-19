# Memory Follows You

Your Vodou memory, available inside every AI tool you use — ChatGPT, Claude, Gemini, Cursor, VS Code, Claude Desktop, and more. So you never re-explain yourself to an AI again.

There are **two delivery paths, with two different governance models** — this is the key thing to understand:

| Path | What it searches | Governance |
|---|---|---|
| **Browser auto-inject** (🧠 button, hotkeys) | **All** your memory | A config **policy** — permissive by default + a deny-list you control |
| **MCP tools & rules files** (IDEs, desktop) | One **vault** you designate | Hard-scoped — the vault is fixed in launch config, an agent can't widen it |

> The older "only the `portable` vault ever leaves" rule still governs the MCP/rules path. The **browser path now searches all memory** so it can answer *however you naturally ask* — governed instead by the leak policy in [§4](#4-governance--the-leak-policy). This was a deliberate change: basic facts (your dog, your kids) are tagged `IDENTITY`/`RESEARCH`, not `PREF`, so a PREF-only vault hid them.

---

## 1. Browser chats — auto-inject

With the Vodou Bridge extension installed, every supported AI chat page gets a **🧠 My context** button plus keyboard shortcuts:

| Trigger | What it does |
|---|---|
| **Ctrl+B** | Site default — invisible network attach on ChatGPT, visible composer insert on Claude |
| **Ctrl+Shift+B** | Force a **visible** composer insert on any site |
| **Alt+V** / 🧠 button | Open the picker (search all memory, tick what to include) |

**How it works** (say you're on chatgpt.com and type *"gift ideas for my kids"*):
1. Your draft goes to your **local** gateway (`127.0.0.1`) — never anywhere else until you hit send.
2. The gateway searches **all** your memory and selects the facts that actually answer the prompt.
3. Those facts are attached (invisibly on the network path, or as a visible block on the composer path). You hit send; the AI answers knowing your context.

**No echo loops:** injected blocks are marker-fenced (`⟦vodou:context⟧`) or registered so Vodou's capture lanes strip them before anything is persisted — your memory never re-learns its own output.

---

## 2. Why it finds the right fact (retrieval quality)

The hard part isn't storing facts — it's surfacing the right one *however you phrase the prompt*. The lookup combines several signals ([`inject_selected_facts`](../src/main.rs)):

- **All-memory hybrid search** — vector similarity + FTS keyword + a cross-encoder reranker.
- **Question keys** — each fact is pre-indexed with the natural *questions it answers* (first-person: "how many kids do I have?"), so a question matches a question (easy) instead of a question matching a statement (hard).
- **Topic-cluster matching** — imperative task prompts ("gift ideas for **my kids**", "plan a weekend for **my family**", "draft a message about **my dog**") are dominated by the task verb, so the personal noun barely registers in the embedding. These are matched by a **synonym cluster** (kids/children/sons/family → *child*; dog/pet → *pet*), gated to a "my/our …" possessive and to personal facts, so they land without depending on exact wording.
- **Multi-question decomposition** — a compound prompt ("am I married? what's my dog's name? how do I take my coffee?", or the one-sentence "where do I live, who's my dog's vet, and what am I interviewing for?") is split into sub-questions and each is retrieved separately, so all the answers come back instead of just the first.
- **`IDENTITY` tag + ranking bias** — personal/identity facts (name, family, pets, home) are tagged `IDENTITY` and get a durability bias so they win for self-referential prompts.
- **Bio blend** — for identity/bio prompts ("write my bio", "about myself") your durable profile **supplements** the specific facts. Pointed questions stay tight (facts only).
- **Precision floor** — a prompt Vodou can't answer ("what's my blood type") injects **nothing** rather than noise.

You can measure all of this with the release gate — see [§5](#5-measuring-quality).

---

## 3. IDEs & desktop apps (MCP) — vault-scoped

The `vodou-memory` MCP server gives any MCP client three tools, **hard-scoped to a vault** (launch config, not a tool argument — an agent can't ask for more):

- `memory_search {query}` — ranked memory snippets
- `memory_context {topic}` — a fenced context block
- `remember {text}` — saves a fact into Vodou's **capture lane** (reviewed + distilled, never a direct write)

Setup — replace `<VODOU_DIR>` with your install path:

| Tool | Where | Snippet |
|---|---|---|
| **Cursor** | `~/.cursor/mcp.json` | `{"mcpServers":{"vodou-memory":{"command":"node","args":["<VODOU_DIR>/MCP-servers/vodou-memory/index.js","--vault","portable"]}}}` |
| **VS Code** (Copilot agent) | `.vscode/mcp.json` | `{"servers":{"vodou-memory":{"type":"stdio","command":"node","args":["<VODOU_DIR>/MCP-servers/vodou-memory/index.js","--vault","portable"]}}}` |
| **Claude Desktop** | Settings → Developer → `claude_desktop_config.json` | same `mcpServers` block as Cursor |
| **JetBrains / Windsurf / Zed** | each tool's MCP config | same stdio command |

**Claude Code needs none of this** — the SessionStart hook already injects memory. **ChatGPT desktop connectors** need a remote HTTPS server (arrives with the pocket-access relay).

**Passive rules files** (always-on, no tool calls) — bake a vault digest into a tool's native rules file:
```bash
./vodou-core mem rules --vault portable --format cursor  --out .cursor/rules/vodou.mdc
./vodou-core mem rules --vault portable --format windsurf --out .windsurfrules
./vodou-core mem rules --vault portable --format copilot --out .github/copilot-instructions.md
```
Output lives inside a `<!-- vodou:rules:begin/end -->` fence — re-running replaces only Vodou's block.

---

## 4. Governance & the leak policy

Because the browser path searches all memory, its governance is a **policy file** — `.vodou/inject-config.json` — read fresh on every request, so edits take effect with **no rebuild or restart**. Delete the file to fall back to built-in defaults.

```jsonc
{
  "floor": 0.72,          // min confidence to inject a fact
  "gap": 0.15,            // keep only facts within this band of the top hit
  "max_items": 4,         // cap for a single-question prompt
  "max_per_sub": 2,       // cap per sub-question of a compound prompt
  "max_total": 8,         // overall cap

  // Scopes that never travel to a third-party AI (our own dev/telemetry captures)
  "scope_deny": ["capture:ide:", "skill", "workbench:"],

  // LEAK POLICY — case-insensitive substrings that must NEVER leave the machine.
  // EMPTY = permissive (personal default). Your "block, don't release" knob:
  "deny_patterns": [],                       // e.g. ["equity","salary","cap table","83(b)"]

  // Extraction reasoning-leak guard (drop the model's own deliberation if stored)
  "leak_needles": ["not in this conversation", "but that's a personal fact", "..."],

  // Personal-noun synonym clusters (topic matching)
  "synonyms": [
    {"canonical":"child","words":["kid","kids","children","son","sons","family","..."]},
    {"canonical":"pet","words":["dog","dogs","puppy","pet","cat"]},
    {"canonical":"spouse","words":["wife","husband","spouse","partner"]}
  ],
  "topic_tags": ["IDENTITY","PREF","USER"], // only these tags topic-match
  "profile_triggers": ["about me","write my bio","..."] // prompts that blend the profile
}
```

**The leak policy in one line:** everything travels *except* what you deny. Add a word or phrase to `deny_patterns` and any fact containing it will never be injected into a third-party AI — verified live, no restart.

**Personal vs. enterprise.** For personal use — your data going to your own ChatGPT — permissive-with-a-deny-list is the right default. A **team/enterprise multi-tenant** version (deny-by-default mode, tag-class blocking, per-tenant policy, an audit log of what traveled) is the planned inverse; see `PLANS/0.6.18/PLAN-INJECT-QUALITY.md`.

**Other privacy invariants (unchanged):**

| Question | Answer |
|---|---|
| When does memory leave? | Only when you trigger inject — and on browsers, only when you then hit send |
| Can a hostile prompt widen scope? | No — the MCP/rules vault is fixed in config; the browser path is bounded by `scope_deny` + `deny_patterns` |
| Does injected context pollute my memory? | No — marker-fenced/registered blocks are stripped by every capture lane and at extraction |
| Does `remember` write directly to memory? | No — it lands in the capture trust tier and is distilled like any capture |

---

## 5. Measuring quality

The inject path has a release gate that tests the **real** selection (not just raw retrieval):

```bash
./vodou-core mem inject-bench            # grade against .vodou/inject-golden.json
./vodou-core mem inject-bench --init     # seed a starter golden file
```

It grades three classes and exits non-zero unless all pass:
- **must_inject** — the right fact is in the block (recall ≥ bar)
- **must_be_silent** — a prompt you can't answer injects *nothing*
- **must_not_leak** — sensitive facts never travel

Add your own real prompts to the golden as you find misses — every one becomes a regression guard.

---

## Troubleshooting

- **Auto-inject returns nothing for a task prompt** ("gift ideas for my …") → the fact may not be tagged personal (`topic_tags`) or the cluster word isn't mapped; add it under `synonyms` in `.vodou/inject-config.json` (no rebuild).
- **A fact you don't want to share keeps showing up** → add a distinctive word from it to `deny_patterns`.
- **Button inserts nothing / toast says copied** → the site changed its composer DOM; paste from clipboard and report the site.
- **IDE doesn't list the MCP tools** → check the `mcp.json` path; run `node <VODOU_DIR>/MCP-servers/vodou-memory/index.js` manually — it should sit silently on stdin.
- **`vault 'portable' doesn't exist`** (MCP/rules only) → `./vodou-core mem vault create portable --tags PREF`, then curate in the Brain console.

## Related docs
- [`memory-extraction-pipeline.md`](memory-extraction-pipeline.md) — how facts are extracted, tagged (`IDENTITY`), and keyed (question + topic keys)
- [`vodou-memory.md`](vodou-memory.md) — the memory store, vaults, capture lanes, provenance
- `PLANS/0.6.18/PLAN-INJECT-QUALITY.md` — the full design + open items (enterprise leak policy, read-time LLM fallback)
