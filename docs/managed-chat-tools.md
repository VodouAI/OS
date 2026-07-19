# Managed Web-Chat Tools (filesystem + permissions)

**Give the web-chat assistant Claude-Code-style filesystem tools — `read_file`, `write_file`, `edit_file`, and friends — confined to a per-conversation workspace, with a category-based permission engine in front of every write.**

Added in the 0.6.4 release lane (`PLAN 0.6.4` §4/§6 + #8 Bet-1/Bet-2). **Off by default** — the tool surface is byte-identical until you set `VODOU_FS_TOOLS_ENABLED`.

---

## What this is

When you chat through the bundled **web gateway** with an **API-provider model** (the Vodou managed LLM, DeepSeek, Qwen, Fireworks, etc.), the assistant can now read, write, search, and edit files the way Claude Code does — inside a sandboxed workspace scoped to that conversation. This lights up real agentic coding/authoring from the browser without the model touching anything outside its workspace.

It is **not** the same surface as the CLI tool-approval gate (`docs/commands/approval-policy.md`) — that governs MCP tools invoked from `./do`. This page is the **web-chat** filesystem surface and its permission engine.

### Where it applies

The tools are offered **only** when all of these hold (see `MCP-servers/Vodou-Console/src/tools.ts` `fsToolsActive()`):

1. `VODOU_FS_TOOLS_ENABLED` is `1`/`true`.
2. The chat is a real **web** chat (`source` is `web` or null) — channels, scheduler/heartbeat, and board workers all set a non-web source and are excluded.
3. It is the **main interactive web chat** — `workbench:*` conversations (skill-console panels, scheduled skill-fire runs, integration workbenches) are excluded in Phase 1.

When any gate fails, the model sees the unchanged `VODOU_TOOLS` surface — provably byte-identical to flag-off.

---

## The tools

All paths are **relative to the per-conversation workspace**; any path that escapes it is refused. `path` (not `file_path`) is the parameter name so the gateway's `detectFileChanges()` auto-tracks writes.

| Tool | Purpose | Key params |
|---|---|---|
| **`read_file`** | Read a text file, returned **line-numbered** (`<num>\t<text>`). Window large files with `offset`/`limit` and page using the returned `endLine`/`totalLines`/`truncated`. | `path`, `offset` (1-based, default 1), `limit` (default 2000), `max_bytes` |
| **`write_file`** | Create or write a file; parent folders auto-created. | `path`, `content`, `mode` = `create` (default, fails if exists) \| `overwrite` \| `append` |
| **`edit_file`** | String-replacement edit. `old_string` must match a **unique** location (whitespace-tolerant) unless `replace_all`. No write if not found/ambiguous. | `path`, `old_string`, `new_string`, `replace_all` |
| **`multi_edit`** | Several edits to **one** file, **atomically** (all-or-nothing; order-independent; nothing written if any edit fails or two overlap). | `path`, `edits[]` (each like `edit_file`) |
| **`list_dir`** | List files/folders for orientation before reading/editing. | `path` (default `.`) |
| **`search_files`** | Locate text across many files cheaply — returns the **files that match** (path + first matching line + line number), not their full content. Skips hidden/binary/huge files; caps at 100 files (`truncated=true` ⇒ narrow the query). | `query`, `path`, `regex` (default false), `max_results` (cap 100) |
| **`grep`** | Inspect **every** matching line (path + line number + text), optionally with N lines of surrounding context and a filename `glob` filter — unlike `search_files`' one-line-per-file summary. Use to see all occurrences (e.g. every call site) before editing. | `query`, `path`, `regex`, `glob`, `context` (0–10), `max_results` (cap 200), `max_per_file` (cap 20) |
| **`glob`** | Find files by **name/path pattern** (`**/*.test.ts`, `src/**/index.*`). `**` crosses directories; `*`/`?` don't cross `/`. Returns paths + size + mtime; reads no file bodies. | `pattern`, `path`, `max_results` (cap 500) |
| **`file_stat`** | Metadata for one path without reading it: exists / type / size / mtime / line count (text files). Check before a read or write. | `path` |
| **`directory_tree`** | Nested folder/file structure to depth N — orient in an unfamiliar workspace. Returns entries with path/type/depth. | `path`, `depth` (1–10, default 3), `max_entries` (cap 500) |

The windowed line-numbered `read_file`, summarized `search_files`, and `grep`/`glob` are the **ACI (Agent-Computer Interface) tools**: they let a model navigate a large workspace by paging, locating, and inspecting rather than slurping whole files into context. `read_file`/`search_files` shipped with #8 Bet-1.6; `grep`/`glob`/`file_stat`/`directory_tree` were added in the Bundle-1 expansion (see `PLANS/0.6.4/PLAN-FS-TOOLS-EXPANSION.md`).

### Model-aware edit surface

A model listed in `VODOU_WHOLE_FILE_MODELS` is offered `write_file`/`read_file`/`list_dir`/`search_files` but **not** `edit_file`/`multi_edit` — weak models that can't reliably produce a matchable `old_string` rewrite the whole file instead (#8 §1.3). Everything else gets the targeted-edit tools; the forgiving applier already tolerates most whitespace/indentation imprecision.

---

## The permission engine (Bet #2)

A category-based, **fail-closed** gate sits in front of every gated tool at the `executeOITool` sink (`MCP-servers/Vodou-Console/src/permissions.ts`). It separates **what** may be touched from **when to ask**.

### Categories and modes

Sensitive actions are bucketed into **categories**, each resolving to one **mode**:

| Mode | Effect |
|---|---|
| `auto` | Run it. |
| `ask` | Park the call, emit an approval request, wait for the user's Approve/Deny. |
| `deny` | Reject without running. |

**Categories:** `file_write` (`write_file`/`edit_file`/`multi_edit`), `bash` (reserved, see below), `messaging_send`, `calendar_write`, `mcp_mutation`, `schedule_create`. **Reads are ungated** — `read_file`/`list_dir`/`search_files` never prompt.

### Profiles — a one-word autonomy dial

Set `perm_profile` in `gateway_settings` to flip many categories at once:

| Profile | Behavior |
|---|---|
| `full` / `danger-full-access` | Everything `auto`. **This is the default — zero behavior change.** |
| `workspace` | Workspace stays writable; everything outward-facing or executing (`bash`, `messaging_send`, `calendar_write`, `schedule_create`, `mcp_mutation`) → `ask`. |
| `read-only` | Look, don't touch — `file_write` + all outward/executing categories → `deny`. |

### Resolution order

Most specific wins (`resolvePermissionMode`):

```
perm.<scope.raw>.<category>   (per-scope override)
  → perm_<category>           (global override)
    → active profile (perm_profile)
      → default: auto
```

An explicitly-set **invalid** value resolves to `deny`, never silently to `auto` (fail-closed).

### Approval flow

When a category resolves to `ask`, the gated call is **not executed**: the gateway creates a pending approval token, emits an `approval_requested` event, and returns a tool result telling the model the action needs approval and not to retry. The web chat renders an **Approve / Deny card**; the buttons `POST /chat/approve`. On approve, the parked call runs; on deny, it's dropped. This whole path is **dormant under the default `full` profile** — it only activates once an operator sets a category or profile to `ask`.

---

## Per-skill / per-task tool allowlists (#7 Item 2)

Independently of the permission engine, a **skill or board task can scope which tools its worker may use** via SKILL.md frontmatter:

```yaml
allowed_tools: [read_file, search_files, list_dir]   # only these
disallowed_tools: [write_file, edit_file]            # never these (deny wins)
```

- **Web chat:** the active skill's `Allowed-Tools`/`Disallowed-Tools` are layered on top of the Bet #2 category gate — **deny wins** if either layer refuses.
- **Board workers:** a task's persona (resolved `skills_registry` → SKILL.md → frontmatter) is UNION-composed with the board-worker baseline and passed to `claude -p` as `--allowed-tools`/`--disallowed-tools`. OFF by default; the allow-list must include the kernel callbacks (`board_complete`, etc.) or the worker can't close itself. See [kanban-board.md](kanban-board.md).

---

## Configuration

All set in `.env` (see `.env.example` for the canonical block):

| Var | Default | What it does |
|---|---|---|
| `VODOU_FS_TOOLS_ENABLED` | `0` | `1`/`true` exposes the FS tools. Off = tool surface byte-identical. |
| `VODOU_FS_TOOLS_ROOT` | `<project>/.vodou/workspace/agent-files` | Base for per-conversation workspaces. Final path: `<root>/<tenant>/<conversationId>/`. |
| `VODOU_FS_TOOLS_FLAT_ROOT` | `0` | `1` points the tools at `VODOU_FS_TOOLS_ROOT` directly (no per-conversation nesting). Still fully confined to that root. |
| `VODOU_FS_TOOLS_UNSANDBOXED` | `0` | `1` turns OFF confinement (absolute paths anywhere) — **local/single-user only**, see below. |
| `VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED` | `0` | When unsandboxed, also lift the denylist. True no-guards dev box. |
| `VODOU_FS_TOOLS_MAX_BYTES` | `2000000` (2 MB) | Per-operation byte cap. Oversized writes refused; oversized reads truncated. |
| `VODOU_WHOLE_FILE_MODELS` | (empty) | Comma/space-separated model-id substrings that get whole-file rewrites (no `edit_file`/`multi_edit`). |
| `VODOU_FS_BASH_ENABLED` | `0` | **Reserved** — see below. Keep off. |
| `perm_profile` *(gateway_settings)* | `full` | Permission profile. `full` \| `workspace` \| `read-only`. |
| `perm_<category>` / `perm.<scope>.<category>` *(gateway_settings)* | — | Per-category / per-scope mode overrides. |

The workspace root carries a **`tenantId` seam** (`<root>/<tenant>/<conversationId>/`) so the same sandbox model becomes per-tenant isolation in a future multi-tenant cloud deployment — a config flip, not a rewrite.

### Sandbox modes

Every tool funnels through one confinement chokepoint, so *where files live* and *whether confinement applies* are config, not code:

| Mode | Flag | Behavior |
|---|---|---|
| **sandboxed** (default) | — | `<root>/<tenant>/<conversationId>/`, fully confined. |
| **flat** | `VODOU_FS_TOOLS_FLAT_ROOT=1` | `<root>` directly, no per-conversation nesting, **still confined**. Aim the tools at one fixed directory. |
| **unsandboxed** | `VODOU_FS_TOOLS_UNSANDBOXED=1` | Absolute paths anywhere (real filesystem). "Claude Code on your own machine." |

**Unsandboxed is a security-posture change, not a convenience toggle:**

- **Local / single-user ONLY.** It is **hard-ignored the instant a real per-request tenant is supplied** (multi-tenant/cloud) — confinement is restored automatically. The `tenantId` seam is the kill-switch.
- The sandbox **is** the boundary. With it off, the denylist (`.env`, `.ssh`, `*.key`/`*.pem`, `*.db`, the `vodou-core` binary) is the only remaining guard, and it was never designed to stand alone (it stays on unless you also set `VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED=1`).
- **Pair it with the permission engine.** Set `perm_profile=workspace` (file_write → `ask`) so the approval card guards writes once the sandbox is off.

---

## `bash` is not here yet

The FS tools are **read/write/edit/search only**. A `bash` execution tool ships later behind `VODOU_FS_BASH_ENABLED` + an OS-level sandbox ([`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime): macOS Seatbelt / Linux bubblewrap; Windows unsupported) + the `bash` permission category's approval gate. The `bash` category and flag already exist in the engine so the policy surface is stable; the executor is deferred (`PLAN 0.6.4` §6 Phase 2/3).

---

## Related Documentation

- **CLI tool-approval gate** (a different surface — MCP tools from `./do`): [commands/approval-policy.md](commands/approval-policy.md), [commands/approvals.md](commands/approvals.md), [commands/auto-approve.md](commands/auto-approve.md)
- **Skills + frontmatter allowlists**: [skills.md](skills.md)
- **Board worker tool scoping**: [kanban-board.md](kanban-board.md)
- **Web gateway / setup**: [setup.md](setup.md)
- **OpenAI-compatible API** (the same models via HTTP, no FS tools): [openai-compatible-api.md](openai-compatible-api.md)
