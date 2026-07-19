# Gateway Projects — multi-workspace, one brain

**Projects** let one Vodou install hold many working directories — each with its own chats, file root, and instructions — while the expensive "brain" (connected MCP servers + credentials, the daemon/worker, memory, the tool catalog) stays **shared**. It is "VS Code / Claude Code workspaces for Vodou."

Pointing a project at an existing directory is the primary use case: adding a project writes **nothing** into that directory — it just bookmarks it. The agent then reads and edits the real files in place.

> Plan of record: `PLANS/0.6.9/PLAN-GATEWAY-PROJECTS.md`.

---

## What a project scopes (and what it doesn't)

A project is `{ id, name, root_path, instructions, color }`. It scopes exactly three things:

| Scoped per project | Stays global / shared |
| --- | --- |
| **Conversations** — each chat belongs to a project (`project_id`) | MCP servers + credentials (one Gmail/Slack auth for all projects) |
| **File-tool root** — relative paths resolve under `root_path` | daemon + worker (one brain), `vodou-core.db` tool/skill/intent catalog |
| **Instructions** — injected into the system prompt every turn | Scheduler, heartbeat, channels (project-agnostic surfaces) |
| _(future)_ Memory scope | Memory (today shared across projects) |

"Project" is orthogonal to "scope" (skills/workbench): scope = *which skill* a conversation runs; project = *which directory/context* it runs in. A conversation can have both.

There is always a built-in **Default** project rooted at the install directory. Existing/legacy conversations (no project) render under Default. The Default project cannot be archived.

---

## Using projects in the web UI

- **Sidebar → Projects** group. "New / manage" opens the management page; active projects are listed beneath it and link straight into a scoped chat.
- **Management page (`#/projects`)** — cards per project (name, color chip, directory, chat count). Create / edit / archive here.
- **Chat header → project switcher chip** (e.g. `🟦 Project A ▾`, left of the model selector). It sets the active project for **new** chats and is remembered across reloads (`localStorage: vodou.activeProject`).
- **Tabs** carry a small color chip for non-Default projects, so cross-project tabs are visually distinct.

### Creating a project

1. Projects → **New project**.
2. **Name** — anything (e.g. "Client A").
3. **Directory** — an absolute path to an **existing** folder (browsers can't show a native folder picker, so paste/type the path). It's validated server-side; the field shows ✓/✗.
4. **Instructions** — optional, like a per-directory `CLAUDE.md`, injected every turn. If the directory already contains `.vodou/project.md`, `CLAUDE.md`, or `AGENTS.md`, the form **auto-fills** from it (you can edit before saving).
5. **Color** — a chip color for the UI.

Nothing is written into the directory on create.

---

## How per-project file access works

When you chat inside a project, the agent's file operations are rooted at that project's `root_path`:

- With the **Claude CLI** provider (the gateway default), the `claude` subprocess for that conversation is spawned with `cwd = root_path`, so its native Read/Write/Edit/Bash tools operate there.
- With **API providers** (Anthropic/OpenAI-compatible) using the built-in fs tools, the unsandboxed file root resolves relative paths under `root_path`.

Concretely, in a project rooted at `~/work/client-a`, `read_file src/index.ts` reads `~/work/client-a/src/index.ts`. Absolute paths and `..` still reach the rest of the machine; the **denylist** (`.env`, `*.key`, `*.pem`, `*.db`, `.ssh`, `vodou-core`, …) is enforced over the full absolute path regardless of the active root, so secrets stay protected.

The per-turn root flows through an async-local context (`src/project-context.ts`), so concurrent turns in different projects never bleed file roots into each other.

> File-root scoping for the fs-tools path applies in unsandboxed mode (`VODOU_FS_TOOLS_UNSANDBOXED=1`, the local default). In sandboxed mode files stay confined to the agent-files area as usual.

---

## Instructions: storage policy & precedence

A project's instructions can live in the gateway DB or on disk. Policy:

1. **Default — DB storage, write nothing.** Instructions are stored in the `projects` row; the directory stays pristine.
2. **Read an existing on-disk doc.** If the directory has `.vodou/project.md`, `CLAUDE.md`, or `AGENTS.md` (first match wins), that file is the **source of truth** for the turn (read live, mtime-cached).
3. **Opt-in disk-sync — "Save to project."** In the project editor, this writes the current instructions to disk so the CLI / Claude Code and other machines share them. It writes back to the **existing** `CLAUDE.md`/`AGENTS.md`/`.vodou/project.md` if present, otherwise creates `.vodou/project.md`. This is the only action that ever writes into a project directory, and it's always explicit.

**Precedence per turn:** an on-disk doc, if present, wins; otherwise the DB `instructions` field; otherwise none. The editor shows which source is active ("stored in Vodou" vs "loaded from `CLAUDE.md`").

The **Default** project emits no directive at all (so the system prompt — and the model's prompt cache — is byte-identical to pre-projects behavior).

---

## REST API

All routes are localhost and covered by the gateway's CSRF/Host guards (same as `/chat`). Mutating verbs need a same-origin `Origin` header.

| Method | Route | Body / notes |
| --- | --- | --- |
| `GET` | `/api/projects` | `?archived=1` to include archived → `{ projects: [...] }` |
| `GET` | `/api/projects/detect?root_path=…` | validate a dir + read an existing instructions doc → `{ valid, isDir, resolved, instructionsSource?, instructions? }` |
| `POST` | `/api/projects` | `{ name, root_path, instructions?, color? }` → `{ project }` (400 on bad dir / missing name). Omitting `instructions` auto-detects from a doc in the dir. |
| `PUT` | `/api/projects/:id` | partial `{ name?, root_path?, instructions?, color? }` → `{ project }` |
| `DELETE` | `/api/projects/:id` | soft-archive → `{ ok: true }` (Default → 400) |
| `GET` | `/api/projects/:id/conversations` | conversations scoped to the project |
| `POST` | `/api/projects/:id/save-instructions` | disk-sync → `{ written: "<relpath>" }` |

A chat turn binds to a project via `project_id`:
- **REST** `POST /chat` — include `project_id` in the body.
- **WebSocket** `type:"message"` — include `project_id`. A conversation's project is fixed at first message; the stored project always wins thereafter.

```bash
# Example: a scoped turn over REST
curl -s -X POST http://127.0.0.1:8765/chat \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8765' \
  -d '{"conversationId":"demo","project_id":"proj_abc123",
       "message":"create notes.md in the current directory and summarize the README"}'
```

---

## Configuration (env)

Both are optional knobs — projects work without setting either. Full descriptions live in `.env.example`.

| Var | Default | Purpose |
| --- | --- | --- |
| `VODOU_PROJECT_SPAWN_SETTLE_MS` | `1200` | Settle window held between simultaneous fresh non-Default project claude-cli spawns, to avoid a claude-cli startup race (see Limitations). `0` disables the delay (serialization still applies). |
| `VODOU_PROJ_CWD_DIAG` | `0` | `1` emits `[proj-cwd DIAG]` lines per claude-cli spawn (computed cwd, warm-pool decisions) for debugging file routing. Verbose. |

Related (pre-existing): `VODOU_FS_TOOLS_UNSANDBOXED` gates whether the fs-tools path honors a project file root at all.

---

## Data model

In the gateway DB (`db.ts` `initGatewaySchema`, additive + idempotent):

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,          -- 'proj_' + 8 hex; the built-in is 'proj_default'
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,      -- absolute, validated on write
  instructions TEXT,
  color TEXT,
  archived_at INTEGER,
  created_at INTEGER, updated_at INTEGER
);
ALTER TABLE gateway_conversations ADD COLUMN project_id TEXT;  -- NULL = Default
```

`proj_default` is seeded at the install root on first migration, so `NULL`/legacy conversations need no backfill.

---

## Security notes

- Adding a project performs **no writes** to its directory; only "Save to project" does, explicitly.
- The fs **denylist** applies over the full absolute path under any project root — `.env`, keys, `*.db`, `vodou-core`, etc. remain refused.
- Per-project credentials are **not** a thing yet — all projects share one connected-app credential set. (Per-client credential isolation is a future item.)
- Unsandboxed file access is local/single-user only; it hard-reverts to full confinement the moment a real per-request tenant is supplied (cloud/multi-tenant).

---

## Limitations & notes

- **Memory is project-scoped** (Phase 3, PLAN-PROJECT-SCOPED-MEMORY): memories extracted inside a project carry its `project_id` and are **hard-filtered out of every other project's recall** by default. Chunks with no project (`project_id IS NULL` — all pre-Phase-3 memories, Default-project conversations, and `[PREF]` identity/preference bullets) are **global** and surface everywhere. Knobs: `VODOU_MEMORY_PROJECT_HARD_FILTER=0` reverts to a soft 2× in-project boost (`VODOU_MEMORY_PROJECT_BOOST`); not passing a project reverts to fully shared. Debug with `./vodou-core mem search "<q>" --project <id>`. Details: `docs/vodou-memory.md` §"Project axis".
- **Conversation-list filtering** is visual (color chips) rather than a hard hide-filter; an "All projects vs this project" toggle is a future polish.
- **CLI-provider warm pool:** non-Default project turns spawn a fresh `claude` subprocess (the warm pool only serves the Default/install root), so a project's *first* turn pays a cold start.
- **Concurrent multi-project writes:** Claude Code can intermittently resolve a *relative* write against the install root when two `claude` instances start at the same instant into directories lacking a `.claude/` marker. Vodou mitigates this two ways — the per-project directive instructs absolute paths under the root, and non-Default project spawns are **serialized** with a settle window (`VODOU_PROJECT_SPAWN_SETTLE_MS`). With these, concurrent two-project writes route correctly. Sequential use (one project at a time — the normal pattern) is unaffected.

---

## Troubleshooting

- **"directory does not exist / not a directory" on create** — `root_path` must be an existing absolute directory on this machine.
- **A new chat isn't scoped** — the project is set when the conversation is *created*. Switch the header chip (or open via `#/chat?project=<id>`) before sending the first message; existing conversations keep their original project.
- **Files landing in the wrong directory** — set `VODOU_PROJ_CWD_DIAG=1` and watch `logs/gateway-stderr.log` for `[proj-cwd DIAG]`; it shows the cwd computed per spawn. If you see an occasional stray file in the install root under heavy simultaneous multi-project use, raise `VODOU_PROJECT_SPAWN_SETTLE_MS`.
- **Instructions not taking effect** — if the directory has a `CLAUDE.md`/`AGENTS.md`, it overrides the DB field (by design). Edit the file, or use "Save to project" to push DB edits to disk.
- **Changes not visible after editing source** — the gateway must be restarted to load `index.ts`/`llm.ts` changes; `public/` assets are served fresh.
</content>
