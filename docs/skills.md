# Skills System

## What Are Skills?

Skills are expert workflow guides that provide curated knowledge, proven patterns, and interactive guidance for specific tasks. They are markdown files with YAML frontmatter that define structured workflows with stopping points for user control.

### Skill Consoles (LLM-created, gateway tabs)

Separate from this page’s **file-based** skills: **Skill Consoles** live in **`gateway.db`** (`skills_meta`, `skill_console_bindings`) and are created via the MCP tool **`vc_skills_create`**. Each gets a pinned-style chat tab (`workbench:skill-console:<name>`), optional cron, slash self-service (`/refine`, `/cron`, …), and the same continuity surface tagging as other chat. Full operator guide: **[skill-console.md](skill-console.md)**.

## Skills Architecture

### File Structure

Skills are stored in the `skills/` directory with the following structure:

```
skills/
  vodou-core/          # Core Vodou skills
    hello/       # Skill directory
      SKILL.md      # Main skill file (required)
      references/   # Supporting documentation
      assets/       # Additional resources
  community/        # Community-contributed skills
    skill-name/
      SKILL.md
```

### Skill File Format

Each skill is a markdown file (`SKILL.md`) with YAML frontmatter:

```yaml
---
name: hello
description: Comprehensive help center and user guide for Vodou
version: 1.0.0
trigger_phrases:
  - "hello"
  - "hello world"
  - "what is vodou"
required_tools: []
---
```

### Skill Metadata (v0.5.46+ canonical schema)

The full canonical frontmatter schema lives at `schemas/skill.schema.json` (Draft-07). Every SKILL.md is validated against it via `python3 scripts/validate-skills.py` (and, post-Phase 1, `vodou-core skill validate`). The validator runs stdlib-only by default (structural required-key/type checks); for **full Draft-07 validation** create the optional tool venv once — `python3 -m venv .venv-tools && .venv-tools/bin/pip install jsonschema pyyaml` — which the script auto-discovers.

**Required:**
- `name` — kebab-case slug, MUST match parent directory name. Pattern: `^[a-z][a-z0-9-]{1,63}$`.
- `description` — 10-200 chars, no period at end. Rendered in catalog lists, slash menus, `skill list`.

**Required for `kind: workflow` (the default):**
- `version` — semver. Required for catalog upgrade tracking.
- `trigger_phrases` — array of strings (1-80 chars each). Auto-populates `intent_mappings` via `skill sync` at priority 40 (source: `auto-skill-trigger`).
- `stopping_points` — `required` | `optional` | `none`. `required` = must hit at least one numbered menu; the gateway workflow-driver enforces this.
- `actions` — `actions.json` | `inline` | `none`. Declares whether the skill HAS structured workflow JSON (not which file is "official"; see "Workflow JSON" section below).

**Optional but recommended:**
- `kind` — `workflow` (default) | `subagent`. Subagents live under `skills/agents/` and are invoked by name (Task tool), not via intent matching. They can OPTIONALLY have actions.json.
- `when_to_use` — natural-language routing hint ("use this when the user wants to …"). Where `description` says **what** the skill is, `when_to_use` says **when** to reach for it, in the language users phrase queries in. Surfaced in the skill index + loaded-skill output so the LLM/router can match paraphrases that contain no registered trigger keyword (#7 Item 4). Accepts the kebab `when-to-use` spelling.
- `required_tools` — array of `<server>` or `<server>.<tool>` strings. Empty `[]` = pure markdown skill.
- `allowed_tools` / `disallowed_tools` — array of tool names that scope which tools a worker running this skill may use (#7 Item 2). `allowed_tools` is a strict allow-list; `disallowed_tools` is a deny-list. **Deny wins** when both name a tool. In web chat these layer on top of the permission engine; for board tasks they become `claude -p --allowed-tools/--disallowed-tools`. OFF by default — and an allow-list MUST include the kernel callbacks (`board_complete`, etc.) or a board worker can't close itself. See [managed-chat-tools.md](managed-chat-tools.md) and [kanban-board.md](kanban-board.md). (Both accept the kebab `allowed-tools` / `disallowed-tools` spelling.)
- `imported_from` — provenance tracking (`source: hand-written | hermes | claude-code | catalog | url`, plus optional `upstream_id`, `upstream_version`, `upstream_sha`, `upstream_url`).

**Optional metadata block** (`metadata.vodou.*` is open-ended):
- `metadata.vodou.config` — gateway_settings keys to inject at load (e.g., `[api_endpoint, default_model]`)
- `metadata.vodou.platforms` — `[macos, linux, windows]` compat filter
- `metadata.vodou.related_skills`, `metadata.vodou.deprecated`, `metadata.vodou.deprecated_by`, `metadata.vodou.preservation_reason`, `metadata.vodou.persona_role`, `metadata.vodou.preferred_tools`, `metadata.vodou.preferred_model`

### Workflow JSON (actions.json + inline AGENT_ACTIONS)

> **Since 0.6.29 you rarely write this by hand.** A skill's shape can be authored
> as a **recipe** — four lines of plain words — and the compiler emits the JSON
> below. `actions.json` is NOT deprecated: it remains the only thing the engines
> run, and `vodou-core recipe show` converts back. What changed is who writes it.
> See [workflows.md](workflows.md).

Skills with structured workflows can declare their stopping_points + steps in two equivalent forms. Both feed the same gateway engine code path at `MCP-servers/Vodou-Console/src/workflow-driver.ts:551-595`. Schema for both: `schemas/actions.schema.json`.

**Inline `<!-- AGENT_ACTIONS: {...} -->` in SKILL.md body — canonical source of truth.** Single-file authoring, sharing, versioning. Email/share/`git show` the SKILL.md and you have everything.

**`actions.json` sidecar — auto-generated cache.** Lives next to SKILL.md. Engine reads from it for fast loading; tooling reads it for JSON Schema validation/autocomplete. Regenerated from inline AGENT_ACTIONS when SKILL.md changes (via `skill validate` or `skill sync`).

When both forms exist and they MATCH, that's fine. When they MISMATCH, **inline is the source of truth** — the cache is regenerated. When SKILL.md has no inline AGENT_ACTIONS but a sidecar exists (e.g., imported skills, legacy skills), the sidecar IS the source until/unless an editor injects an inline form.

**Workflow JSON shape** (abbreviated — see `schemas/actions.schema.json` for full spec):

```json
{
  "schema_version": "1.0",
  "initial_steps": [
    { "server": "vodou-mac-control", "tool": "screenshot", "args": { "app_name": "Google Chrome" } }
  ],
  "stopping_points": [
    {
      "id": 1,
      "title": "What scope?",
      "type": "menu",
      "options": {
        "1": {
          "label": "Full sweep",
          "vars": { "SCOPE": "full" },
          "steps": [
            { "server": "vodou-mac-control", "tool": "traverse", "args": { "app_name": "Google Chrome" } }
          ]
        },
        "2": { "label": "Quick check", "vars": { "SCOPE": "quick" }, "steps": [] }
      }
    },
    {
      "id": 2,
      "title": "Describe what to track",
      "type": "text_input",
      "capture_as": "DESCRIPTION",
      "options": {}
    }
  ],
  "completion": { "summary_template": "Done. SCOPE={{SCOPE}}, DESCRIPTION={{DESCRIPTION}}" }
}
```

**Stopping point types:** `menu` (numbered choices, default), `text_input` (free-text into `capture_as`), `multi_select`, `confirm`, `file_upload` (the last three reserved for future engine work).

**Step properties:** `server`, `tool`, `args` (with `{{VAR}}` template substitution), `loop` (repeat N times — `{{i}}` is the loop counter), `capture` (`{VAR_NAME: "field_name"}` extracts a field from the step's output into a variable), `stream_progress` (UI feedback during long steps).

**Template variables** available in `args` and `summary_template`:
- `{{TOPIC}}` — extracted from the user's original query
- `{{i}}` — current loop iteration (1-based, only inside loops)
- `{{VAR_NAME}}` — any variable captured from a previous step or `vars` block

### Skill Lifecycle (`vodou-core skill` subcommand)

All skill lifecycle ops live under `vodou-core skill`. The full command surface (v0.5.46+):

| Command | What it does |
|---|---|
| `skill list` | List locally-installed skills (alias for `list-skills`). Add `--detailed` for frontmatter; `--filter <kw>`. |
| `skill list --catalog` | Fetch and list the remote `vodou-skills-catalog`. Add `--filter <kw>` (matches id/name/summary/tags) or `--tag <name>` (exact match). Marks already-installed skills with `✓ installed`. |
| `skill show <name>` | Frontmatter + supporting files + content preview. |
| `skill validate [<name>] [--all]` | Structural schema check on SKILL.md frontmatter + actions.json. |
| `skill sync [--dry-run]` | Reconcile `intent_mappings` with on-disk skills. Inserts auto-trigger rows at priority 40 for every `trigger_phrases` entry; deletes orphan auto-rows whose skill is no longer on disk. **Never touches priority ≥ 80** (user-curated rows). Dry-run safe to preview. |
| `skill install <source>` | `<source>` is either a catalog id (`vodou.foo`) or a local directory path. Catalog ids fetch from `VODOU_SKILLS_CATALOG_URL` (default GH raw), sha256-verify, and write to `skills/catalog/<name>/`. Local paths copy to `skills/installed/<name>/`. Runs `sync` after. |
| `skill uninstall <name>` | Move `skills/<dir>/` → `archive/disabled-skills/<name>/` (soft delete; recoverable) and **delete every** `intent_mappings` row pointing at this skill, regardless of priority. (Earlier versions preserved priority ≥ 80 rows; that left zombie pointers and was reverted in v0.5.46 — see "Lifecycle policy" below.) |
| `skill import <path-or-url>` | Detects format (Vodou-native / Hermes / Claude Code command / Claude Code agent / raw markdown / URL fetch) and adapts to canonical SKILL.md. Lands in `skills/imported/<name>/`, syncs triggers. |
| `skill cache-actions [--apply]` | Generate `actions.json` sidecars from inline `<!-- AGENT_ACTIONS: {...} -->` comments in SKILL.md. Skips skills on the §0.1 preservation list. Default dry-run. |
| `skill audit` | Read-only health audit: `validate --all` + `sync --dry-run` + `cache-actions` dry-run, in one report. |
| `skill fork <name>` | Copy an installed catalog skill into `skills/forks/<name>/` for local edits. Snapshots the upstream baseline at `.fork-base/` for future 3-way merge, writes `.fork.json` manifest, archives the catalog copy, runs sync. |
| `skill update <name>` | Pull upstream catalog changes into a forked skill via `git merge-file --marker-size=10` (3-way merge). Conflicts get standard `<<<<<<<<<<` markers in the file. |
| `skill diff <name>` | `diff -u` between a fork and its upstream baseline. |

#### Lifecycle policy: uninstall vs sync (intent_mappings)

The two operations have **explicitly different defaults**:

- **`skill uninstall`** = explicit user intent to remove the skill. Deletes **all** `intent_mappings` rows pointing at the skill, regardless of priority. The skill is leaving disk; preserving any pointers (auto or curated) just creates dead routes.
- **`skill sync`** = automated reconciliation. Prunes orphan auto-trigger rows (priority < 80, `tool_name='vc_load_skill'`) but **preserves priority ≥ 80** user-curated rows under the assumption the skill might re-appear (re-install, re-sync from catalog).

**Never edit `intent_mappings` directly.** Add `trigger_phrases:` to SKILL.md frontmatter and run `skill sync`. Want a higher priority? Update the row in the Routing Rules UI or set it post-sync — sync will leave it alone.

### Catalog (`vodou-skills-catalog`)

Skills can be published to and installed from the public catalog at https://github.com/VodouAI/vodou-skills-catalog.

**Index format** (`index.json`):
```json
{
  "catalog_version": 1,
  "updated_at": "2026-04-27T00:00:00Z",
  "entries": [
    {
      "id": "vodou.calendar-quick-status",
      "tier": "curated",
      "version": "1.0.1",
      "sha256": "<sha256 of SKILL.md + actions.json bytes>",
      "skill_name": "calendar-quick-status",
      "summary": "Show what's on the user's Google Calendar — today, this week, next meeting, or by keyword",
      "source": {
        "type": "git",
        "url": "https://github.com/VodouAI/vodou-skills-catalog",
        "ref": "main",
        "path_in_repo": "skills/calendar-quick-status"
      },
      "requires_mcp": ["google-calendar.list-events", "google-calendar.get-current-time"],
      "min_oi_version": "0.5.46",
      "tags": ["productivity", "google-calendar"]
    }
  ]
}
```

**Hash ordering for `sha256`:** SKILL.md bytes followed by actions.json bytes (if present). Both `bt4 skill install` and the catalog repo's `scripts/validate-catalog.mjs` validator follow this contract.

**Override the catalog source** by setting `VODOU_SKILLS_CATALOG_URL` to a different `index.json` URL.

**Cache-buster:** `bt4` always appends `?_=<unix-ts>` to the index URL — `raw.githubusercontent.com` edge-caches multi-minute, which made fresh catalog updates appear stale. Same for `skill list --catalog`.

### Imported skills + Forks

Any skill with `imported_from.source != "hand-written"` may carry local edits relative to its upstream. The `upstream_sha` in frontmatter is the content hash AT IMPORT TIME — check it before assuming an upgrade is safe.

**Forking a catalog skill:**
1. `bt4 skill install vodou.<id>` — install from catalog
2. `bt4 skill fork <name>` — copies to `skills/forks/<name>/`, snapshots baseline at `.fork-base/`, archives the catalog copy
3. Edit the fork freely
4. `bt4 skill diff <name>` — show what's changed
5. `bt4 skill update <name>` — fetch upstream, run 3-way merge. Clean merges auto-apply; conflicts get standard `<<<<<<<<<<` markers in the file.

**Never silently overwrite local edits.** The 3-way merge always has the upstream pre-fork sha as BASE so your edits are honored.

## How Skills Work

### 1. Skill Registration

Skills are automatically discovered and registered in the database:

- Skills are scanned from the `skills/` directory on startup
- Each `SKILL.md` file is parsed for metadata
- Content hash is calculated to detect changes
- Skills are stored in the local database registry (synced from disk)

### 2. Intent-Based Loading

Skills are loaded via the intent system:

```bash
./do "hello"              # Loads hello skill
./do "vodou mastery"         # Loads mastery skill
./do "security audit"     # Loads vodou-security-audit skill
```

The intent system matches trigger phrases to skills; the CLI and gateway load the matching skill content when you run those phrases.

### 3. Skill Execution

When a skill is loaded:

1. Skill content is retrieved from database or filesystem
2. Content is formatted and displayed to the user
3. Stopping points pause execution for user input
4. User choices determine the next workflow step

### 4. Stopping Points

Stopping points are numbered menus that pause skill execution and wait for user input. They enforce user control by preventing AI agents from making assumptions and automatically proceeding.

#### How Stopping Points Work

1. **Skill displays content** up to the stopping point
2. **Execution pauses** at the stopping point menu
3. **User selects an option** (1-9) from the numbered menu
4. **Skill continues** with the selected path

#### Stopping Point Format

Stopping points use a specific markdown format:

```markdown
## 🎯 **STOPPING POINT 1: What Would You Like to Learn More About?**

Now that you understand what Vodou is, what would you like to explore in detail?

**Choose a topic:**

1. **Quick Start Guide** - Get up and running in 5 minutes
2. **MCP Servers Deep Dive** - Learn everything about MCP servers
3. **Skills System Guide** - Understand Vodou's skills system
4. **Scripts & Background Jobs** - Learn about script execution
...
```

#### Stopping Point Requirements

- **Must be numbered** (1-9) for clarity and consistency
- **Must include context** before presenting options
- **Should be mutually exclusive** when possible
- **Can include "back" or "exit"** options when appropriate

#### User Interaction

When a stopping point is reached:
- AI agents **MUST stop** and wait for user input
- AI agents **MUST display** all numbered options
- AI agents **MUST NOT** skip or summarize the menu
- Users can reply with: a number (1-9), a clickable button ("1. Quick Start"), "yes", "no", "all", "y", "n"
- All valid replies stay in the skill — further automatic tool routing is skipped for that continuation
- Skill content is re-injected into the LLM system prompt on each continuation
- Skill state persists for 30 minutes (sliding window) and survives gateway restarts (DB-backed)

#### Multiple Stopping Points

Skills can have multiple stopping points throughout the workflow:
- Each stopping point pauses execution
- Users make decisions at each point
- Workflow branches based on user choices
- Skills guide users through complex multi-step processes

## Skills System Components

### Registry

Each skill is registered in the local SQLite database from its on-disk `SKILL.md` (name, path, content hash for change detection, optional metadata). You normally do not edit the DB by hand.

### Runtime

The **`vodou-core`** binary exposes tools to **list**, **search**, and **load** skills; `./do "hello"` and similar phrases use the same intent layer as other MCP tools. Caching and exact module layout are implementation details.

### Intent mappings

Trigger phrases are tied to skill-load actions via rows in the intent database. Inspect or extend them with **`./do intent list`**, **`./do intent add`**, etc. (see **[cli-reference.md](cli-reference.md)**). Exact SQL layouts live in internal docs if you need them.

## Using Skills

### Loading a Skill

```bash
# Via intent system (recommended)
./do "hello"
./do "vodou mastery"
./do "security audit"

# Direct tool call
./vodou-core call vodou-core vc_load_skill '{"skill_name": "hello"}'
```

### Listing Available Skills

```bash
# Via intent system
./do "list skills"
./do "available skills"

# Direct tool call
./vodou-core call vodou-core vc_list_skills
```

### Searching Skills

```bash
# Via intent system
./do "search skills"

# Direct tool call
./vodou-core call vodou-core vc_search_skills '{"keyword": "security"}'
```

## Gateway UI (Skills page)

Open `http://localhost:8765/#/capabilities?tab=skills` for the visual surface.

### Top-level taxonomy (kind-first)

The page splits skills into three tabs based on their `kind` (and `directory_path` for legacy rows without one):

| Tab | What lives here | Sub-grouping |
|---|---|---|
| **SubAgent Personas** | `kind: subagent` (delegate-able specialists; everything under `skills/agents/*` ships as a persona) | by department (Engineering, Marketing, Fundraising, Product, …) |
| **Workflows** | `kind: workflow` (interactive guided skills with stopping points) | by source (Vodou Core / Catalog (installed) / Imported / Forked / Templates / Community) |
| **My Skills** | anything under `skills/my-skills/` | flat list |

A skill lands in exactly one tab. Counts in the tab labels reflect the live `skills_registry`.

### Per-row badges

Every row shows up to three badges next to the skill name:
- **Kind:** `subagent` (purple) or `workflow` (blue).
- **Source:** `built-in` / `catalog` / `imported` / `forked` / `mine` (color-coded). Derived from the top dir under `skills/`.
- **`⚡actions`:** present when the skill has an `actions.json` (executable via `/api/skills/run-steps`).

### Per-row actions

| Button | What it does |
|---|---|
| Toggle | activate / deactivate (sets `is_active`). Skill stays on disk; intent rows untouched. |
| ▶ Run | sends the skill's first trigger phrase via main chat — same as typing it yourself. |
| Panel | opens the floating `SkillRunner` panel: deterministic stopping-point execution against `/api/skills/run-steps`, then LLM summarizes the results. |
| Run as agent | (subagent rows only) opens SkillRunner in **persona mode** — no actions menu, free-form chat scoped to the persona's SKILL.md as system prompt. |
| Edit | textarea editor for SKILL.md. |
| Build | opens the visual workflow builder at `#/builder/<name>` for editing actions.json graphically. |
| Delete | confirmation modal → `POST /api/skills/uninstall` → archive dir + drop `skills_registry` row + delete every `intent_mappings` row pointing at this skill (all priorities). Built-in skills get a stronger warning copy. |

### Browse Catalog modal

`Browse Catalog` button opens a modal that fetches `index.json` from the live catalog. Per-card actions:
- **Details** — expands to show frontmatter, `requires_mcp`, sha256, body preview.
- **Install / Uninstall** — wraps the bt4 commands. Successful install marks the row `✓ installed`.
- **Fork** (after install) — clones to `skills/forks/<name>/` for local edits.
- **Check for updates** (after install) — runs the 3-way merge against the current upstream.

Footer link goes to the catalog repo on GitHub.

### Import modal

`Import…` button accepts a URL or local path. Auto-detects format (Vodou-native / Hermes / Claude Code command / Claude Code agent / raw markdown). Shows the bt4 stdout on completion (Detected format, Imported path, sync result).

## Skill Panel — deterministic execution (v0.5.46+)

The floating `SkillRunner` panel runs skills with deterministic tool execution and LLM-summarized presentation. Architecture:

1. On open, `SkillRunner` fetches both `SKILL.md` and `actions.json`. If actions.json has stopping points, the **first menu renders client-side from JSON** — no LLM call. Skills without actions.json fall back to an LLM-driven opener.
2. User replies with a number matching a stopping-point option → panel posts to `POST /api/skills/run-steps` with the option's `steps` array.
3. The endpoint runs each step via the worker socket (`runBrainTrust(server, tool, args)` in executor.ts) — bypassing the `bt4 call` parameter generator that injects empty defaults.
4. After each step, captured fields are extracted from the JSON result. ISO-8601 timestamps auto-derive `{{<VAR>_NAIVE}}` (no millis, no tz) for tools that require naive ISO.
5. Tool-level errors (`isError: true` in the wrapped MCP content) abort the chain and surface inline in the panel.
6. On success, raw results are sent to the LLM via `chatWithSkill` with a "summarize this in the skill's voice" prompt. The LLM streams a conversational reply formatted per the SKILL.md guidance (bullets, timezone-aware, etc.) — same pattern as `BrainLoader → chatWithSkill` in main chat.
7. After the LLM stream completes, the next stopping-point menu renders client-side and the cycle continues.

**Free-text replies** (e.g. option 4 = "Search by keyword" with `{{TOPIC}}`) bypass the deterministic path and go straight to the LLM.

## Creating Skills

### Quick Start: Use the Skill Development Skill

The easiest way to create a skill is using the built-in `skill-development` skill:

```bash
./do "create vodou skill"
./do "develop skill"
./do "skill development"
./do "new skill wizard"
./do "help me create a skill"
./do "build a skill"
```

This loads the **skill-development** skill (`skills/vodou-core/skill-development/SKILL.md`) which provides:
- Interactive wizard for creating skills
- Templates and examples
- Best practices guidance
- Step-by-step instructions with stopping points
- Validation and testing tips
- Complete workflow from concept to deployment

The skill guides you through:
1. Defining skill purpose and scope
2. Choosing trigger phrases
3. Structuring content with stopping points
4. Creating intent mappings
5. Testing and validation

### Manual Creation

If you prefer to create skills manually:

#### 1. Create Skill Directory

```bash
mkdir -p skills/community/my-skill
cd skills/community/my-skill
```

#### 2. Create SKILL.md

```markdown
---
name: my-skill
description: Brief description of what this skill does
version: 1.0.0
trigger_phrases:
  - "my skill"
  - "do my task"
required_tools: []
---

# My Skill

## Overview

What this skill does...

## Workflow

Step-by-step guidance...

## 🎯 **STOPPING POINT 1: Choose an Option**

1. Option 1
2. Option 2
3. Option 3
```

### 3. Register Intent Mappings

Create `install-my-skill.sh`:

```bash
#!/bin/bash
sqlite3 vodou-core.db <<EOF
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, tool_parameters, priority)
VALUES 
  ('my skill', 'vodou-core', 'vc_load_skill', '{"skill_name": "my-skill"}', 10),
  ('do my task', 'vodou-core', 'vc_load_skill', '{"skill_name": "my-skill"}', 10);
EOF
```

### 4. Install Intent Mappings

```bash
chmod +x install-my-skill.sh
./install-my-skill.sh
```

### 5. Test the Skill

```bash
./do "my skill"
```

## Skill Best Practices

### Content Structure

1. **Overview Section**: What the skill does and when to use it
2. **Prerequisites**: What users need before starting
3. **Workflow Steps**: Clear, numbered steps
4. **Stopping Points**: Numbered menus (1-9) for user choices
5. **Examples**: Real-world usage examples
6. **Troubleshooting**: Common issues and solutions

### Stopping Points

**Format Requirements:**
- Use numbered lists (1-9) for clarity
- Always include the `## 🎯 **STOPPING POINT N:**` header format
- Present options after providing context (don't skip to menu)
- Make choices mutually exclusive when possible
- Include "back" or "exit" options when appropriate

**Content Guidelines:**
- Provide context before the menu (what the user needs to know)
- Use descriptive option text (not just numbers)
- Limit to 9 options maximum (for clarity)
- Use consistent formatting across all stopping points

**User Control:**
- Stopping points enforce user control over workflow direction
- AI agents must wait for user selection before proceeding
- Never auto-select or skip stopping points
- Always display the complete menu with all options

### Trigger Phrases

- Use 3-10 trigger phrases per skill
- Include common variations and synonyms
- Test trigger phrases don't conflict with other skills
- Use descriptive phrases that match user intent

### Required Tools

- List MCP tools the skill depends on
- Check tool availability before execution
- Provide fallback guidance if tools unavailable
- Document tool requirements in skill overview

## Skills vs MCP Tools

### Skills
- **Purpose**: Expert workflow guidance
- **Format**: Markdown with YAML frontmatter
- **Execution**: Content display with stopping points
- **Control**: User-driven via numbered choices
- **Scope**: High-level workflows and guidance

### MCP Tools
- **Purpose**: Direct tool execution
- **Format**: JSON-RPC tool definitions
- **Execution**: Direct function calls
- **Control**: Parameter-based
- **Scope**: Low-level operations

### Relationship

Skills can orchestrate MCP tools:
- Skills provide workflow guidance
- Skills can reference MCP tools in their content
- Users select tools through skill stopping points
- Skills guide users to appropriate tools for their needs

## Available Skills

### Core Skills (vodou-core/)

- **hello**: Primary help center and user guide
  - `./do "hello"` or `./do "what is vodou"`
- **mastery**: Advanced Vodou techniques and best practices
  - `./do "vodou mastery"` or `./do "learn vodou"`
- **skill-development**: Interactive wizard for creating skills
  - `./do "create vodou skill"` or `./do "develop skill"` or `./do "skill development"` or `./do "new skill wizard"`
  - Location: `skills/vodou-core/skill-development/SKILL.md`
  - Provides complete workflow from concept to deployment with stopping points
- **tdd-workflow**: Test-Driven Development workflow
  - `./do "tdd workflow"` or `./do "test driven development"`
- **user-flow-control**: Guidelines for building skills with stopping points
  - `./do "user flow control"`
- **systematic-debugging**: Systematic debugging workflows
  - `./do "debug"` or `./do "systematic debugging"`
- **system-monitor**: System monitoring and diagnostics
  - `./do "system monitor"`

### Community Skills (community/)

- **docker-compose-dev**: Docker Compose development workflow automation

### Finding Skills

```bash
# List all skills
./do "list skills"

# Search skills
./do "search skills security"

# Load specific skills
./do "vodou mastery"              # Advanced techniques
./do "create vodou skill"         # Skill development wizard (skill-development)
./do "develop skill"            # Alternative trigger for skill development
./do "hello"                   # Help center
./do "tdd workflow"            # Test-driven development
./do "debug"                   # Systematic debugging
```

**Note**: The `skill-development` skill is the recommended way to create new skills. It provides an interactive wizard with stopping points that guides you through the entire process.

## Technical Details

### Content Hash Calculation

Skills use content hashes to detect changes:

- Hash is calculated from markdown content only (frontmatter excluded)
- Hash is stored in `skills_registry.content_hash`
- Changes trigger skill re-registration
- Hash algorithm: SHA-256

### Skill Loading Priority

1. **In-memory cache**: Fastest, used for recently loaded skills
2. **Database**: Fast, used for registered skills
3. **Filesystem**: Slower, used for new or changed skills

### Performance

- Skill loading: < 100ms (cached)
- Skill scanning: ~1-2 seconds (on startup, lazy-loaded)
- Intent matching: < 10ms (database lookup)

## Database Operations

### Skill Registration

Skills are automatically registered when:
- System starts up (lazy loading)
- Skills are scanned from filesystem
- Skills are explicitly loaded

### Skill Updates

Skills are updated when:
- Content hash changes
- Skill is re-scanned from filesystem
- `upsert_skill()` is called

### Skill Deactivation

Skills can be deactivated without deletion:

```sql
UPDATE skills_registry SET is_active = 0 WHERE name = 'skill-name';
```

## API Reference

### Tools

**vc_load_skill**
- **Parameters**: `{"skill_name": "string"}` or `{"file_path": "string"}`
- **Returns**: Formatted skill content
- **Example**: `./vodou-core call vodou-core vc_load_skill '{"skill_name": "hello"}'`

**vc_list_skills**
- **Parameters**: None
- **Returns**: JSON array of all active skills
- **Example**: `./vodou-core call vodou-core vc_list_skills`

**vc_search_skills**
- **Parameters**: `{"keyword": "string"}`
- **Returns**: JSON array of matching skills
- **Example**: `./vodou-core call vodou-core vc_search_skills '{"keyword": "security"}'`

## Troubleshooting

### Skill Not Loading

1. Check skill exists: `./do "list skills"`
2. Verify intent mapping: `./vodou-core intent show "keyword"`
3. Check skill file: `ls skills/**/SKILL.md`
4. Verify database: `sqlite3 vodou-core.db "SELECT * FROM skills_registry WHERE name='skill-name';"`

### Intent Not Found

1. Check intent mapping exists: `./vodou-core intent list | grep keyword`
2. Verify server name: Should be `vodou-core` (not `OI-skills-executor`)
3. Check tool name: Should be `vc_load_skill` (not `load_skill`)
4. Re-run install script if needed

### Skill Content Not Displaying

1. Check skill file format (YAML frontmatter required)
2. Verify markdown syntax is valid
3. Check for encoding issues (UTF-8 required)
4. Review skill file permissions

## AGENT_ACTIONS — Executable Skill Workflows

Skills can embed executable tool sequences as HTML comments. When a user picks a stopping point option, the Vodou-Console workflow driver (or CLI agents) executes the corresponding tool calls automatically.

### Format

Add `<!-- AGENT_ACTIONS_N: {...} -->` after each stopping point menu option:

```markdown
<!-- AGENT_ACTIONS_1: {"label":"Quick Analysis","vars":{"DEPTH":"5"},"steps":[
  {"server":"MCP-server","tool":"tool_name","args":{"param":"{{TOPIC}}"},"capture":{"VAR":"field"}},
  {"server":"MCP-server","tool":"other_tool","args":{"id":"{{VAR}}"},"loop":5,"stream_progress":true}
]} -->
```

### Step properties

- `server` / `tool` — MCP server and tool to call
- `args` — Tool arguments with `{{VAR}}` template support
- `loop` — Repeat N times (`{{i}}` = counter)
- `capture` — `{"VAR_NAME": "response_field"}` — chain results between steps
- `stream_progress` — Show progress in the UI

### How it works (author view)

1. The user’s message loads the skill markdown (including optional HTML comment blocks).
2. In **web chat**, when a stopping point offers numbered choices, embedded workflow blocks can run **MCP tool** steps in sequence (with templated arguments and optional loops).
3. Results are shown in the UI; no core code changes are required to add these blocks to a skill.

Authoring detail and operational notes: **`MCP-servers/Vodou-Console/README.md`** (repository). Deep routing and schema docs are **not** in this public tree—see **[INTERNAL-DEVELOPER-DOCS.md](INTERNAL-DEVELOPER-DOCS.md)**.

See `skills/vodou-core/deep-thinking/SKILL.md` for a complete example.

## Related Documentation

- **MCP protocol**: `docs/mcp-protocol.md`
- **Gateway workflow driver**: `MCP-servers/Vodou-Console/README.md`
- **Intent system, schema, routing, architecture** (internal): `docs-DEV/` — see [INTERNAL-DEVELOPER-DOCS.md](INTERNAL-DEVELOPER-DOCS.md)

