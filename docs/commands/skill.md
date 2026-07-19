# skill

Manage Vodou skills — list, install from catalog or import, fork, validate, audit.

## Syntax

```bash
vodou-core skill <subcommand> [OPTIONS]
```

## Subcommands

### `skill list [--detailed] [--filter <kw>] [--catalog] [--tag <name>]`

List skills. Default: locally-installed skills (alias for `list-skills`).

| Flag | Effect |
|---|---|
| `--detailed` | Print frontmatter for every row. |
| `--filter <kw>` | Substring match on id, name, summary, and tags (catalog) or name + description (local). |
| `--catalog` | Fetch and list the remote `vodou-skills-catalog` instead of local skills. Shows `✓ installed` next to entries already on disk. |
| `--tag <name>` | (with `--catalog`) Exact tag match. |

```bash
vodou-core skill list                          # local
vodou-core skill list --catalog                # remote catalog (12 entries)
vodou-core skill list --catalog --filter media # narrow to media skills
vodou-core skill list --catalog --tag ops      # all ops-tagged catalog skills
```

### `skill show <name>`

Print a single skill's metadata, supporting files, content preview, and actions.json sidecar status.

### `skill validate [<name>] [--all]`

Structural canonical-schema check for SKILL.md frontmatter + actions.json. Pass `--all` to sweep every skill under `skills/`. Returns non-zero on failure.

### `skill sync [--dry-run]`

Reconcile `intent_mappings` with on-disk skills. Walks every SKILL.md, reads `trigger_phrases`, inserts auto-trigger rows at priority 40 (`tool_name='vc_load_skill'`, `tool_parameters` carries `{"skill_name":"<name>"}`), and prunes orphan auto-rows whose skill is no longer on disk.

**Never touches priority ≥ 80** (user-curated rows). Idempotent.

### `skill install <source>`

Install a skill. `<source>` accepts:
- **Catalog id** (form `<namespace>.<name>`, e.g. `vodou.calendar-quick-status`) — fetches from the catalog index, sha256-verifies, writes to `skills/catalog/<skill_name>/`.
- **Local directory** (e.g. `./skills/my-new-skill`) — copies to `skills/installed/<name>/`.

Always runs `skill sync` after to register triggers.

```bash
vodou-core skill install vodou.brainstorm
vodou-core skill install /path/to/local-skill-dir
```

Override the catalog source with `VODOU_SKILLS_CATALOG_URL` env var. Default: `https://raw.githubusercontent.com/VodouAI/vodou-skills-catalog/main/index.json` (cache-busted on every fetch).

### `skill uninstall <name>`

Soft-delete a skill:
1. Move `skills/<dir>/` → `archive/disabled-skills/<name>/` (recoverable; `mv` it back to restore).
2. **Delete every** `intent_mappings` row pointing at this skill, **regardless of priority**. The skill is leaving disk; preserving any pointers (auto or curated) just creates dead routes.

This differs from `skill sync`'s priority-≥80 carve-out — `uninstall` is explicit user intent; `sync` is automated reconciliation.

```bash
vodou-core skill uninstall brainstorm
```

### `skill import <source>`

Import a skill from a path or URL. Auto-detects format and adapts to canonical SKILL.md:

| Format | Detection | Result |
|---|---|---|
| **VodouNative** | already canonical | passthrough copy |
| **Hermes** | `name` + (`prerequisites` / `platforms` / `related_skills` / `metadata.hermes`) | rewrites `${HERMES_SKILL_DIR}` → `${VODOU_SKILL_DIR}`; flags prose stopping points + shell snippets |
| **ClaudeCommand** | `description` + (`argument-hint` / `allowed-tools` / `model`) | maps to `kind: subagent` + metadata.vodou.{argument_hint,preferred_model} |
| **ClaudeAgent** | `name` + `tools` (no kind/triggers) | maps to `kind: subagent` + upstream_tools |
| **RawMarkdown** | no frontmatter | wraps in canonical, first-line title as description |

URL sources fetch to a temp file, then re-detect.

```bash
vodou-core skill import https://raw.githubusercontent.com/.../SKILL.md
vodou-core skill import ~/.claude/commands/morning-standup.md
vodou-core skill import ~/.hermes/skills/some-skill
```

Imports land in `skills/imported/<name>/`.

### `skill cache-actions [--apply]`

Generate `actions.json` sidecars from inline `<!-- AGENT_ACTIONS: {...} -->` comments in SKILL.md. Skips skills on the §0.1 preservation list (`mcp-builder`, `deep-thinking`, `skill-development`, `user-flow-control`, `new-user-walkthrough`, `install-mcp-server`, `create-a-skill`).

Default is dry-run; pass `--apply` to write.

### `skill audit`

Read-only health audit — runs `validate --all` + `sync --dry-run` + `cache-actions` (dry-run) and reports `OK | FAIL` per lane. Useful before committing or after pulling.

### `skill fork <name>`

Copy an installed catalog skill into `skills/forks/<name>/` for local edits. Mechanics:

1. Read upstream metadata from the catalog SKILL.md frontmatter (`imported_from.upstream_id`).
2. Copy `skills/catalog/<name>/` → `skills/forks/<name>/`.
3. Snapshot the upstream baseline at `skills/forks/<name>/.fork-base/` (used as BASE for future 3-way merges; never edited).
4. Write `.fork.json` manifest with `upstream_id`, `upstream_sha_at_fork`, `forked_at`.
5. Move the original catalog copy to `archive/disabled-skills/<name>.catalog-pre-fork/`.
6. Run `skill sync` so the fork's triggers register.

### `skill update <name>`

Pull upstream catalog changes into a forked skill via 3-way merge.

1. Fetch the current catalog entry by `upstream_id`.
2. If `upstream_sha` matches `.fork.json`'s `upstream_sha_at_fork` → exit "Already up to date".
3. Otherwise, for each file (SKILL.md + actions.json):
   - Run `git merge-file --marker-size=10 LOCAL BASE UPSTREAM`.
   - Clean merges auto-apply.
   - Conflicts get standard `<<<<<<<<<<` markers in the file — search and resolve.
4. Update `.fork-base/` and `.fork.json` to the new upstream sha.
5. Re-run `skill sync` if frontmatter triggers changed.

### `skill diff <name>`

Show `diff -u` between a forked skill and its `.fork-base/` baseline. Useful for previewing what your edits look like before running `update`.

## Lifecycle policy

| Operation | `intent_mappings` cleanup | Rationale |
|---|---|---|
| **`skill uninstall`** | DELETE all rows (any priority) | Skill is leaving disk; pointers become dead. |
| **`skill sync`** | DELETE auto-trigger rows (priority < 80, `tool='vc_load_skill'`); preserve priority ≥ 80 | Skill might re-appear (re-install, re-sync); user-curated overrides protected. |

**Never edit `intent_mappings` directly.** Add `trigger_phrases:` to SKILL.md and run `skill sync`.

## See also

- [`skills.md`](../skills.md) — full skills system overview, schema, gateway UI, panel architecture
- [`PLAN-SKILLS-V2.md`](../../PLANS/0.5.46/PLAN-SKILLS-V2.md) — execution-tracking source of truth (gitignored)
- [`schemas/skill.schema.json`](../../schemas/skill.schema.json) — canonical SKILL.md frontmatter schema
- [`schemas/actions.schema.json`](../../schemas/actions.schema.json) — actions.json schema
- Catalog repo: https://github.com/VodouAI/vodou-skills-catalog
