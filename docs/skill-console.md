# Skill Console (LLM-created skills)

Skill Consoles are **runtime skills** stored in **`gateway.db`** (not under `skills/*/SKILL.md`). An agent calls the MCP tool **`vc_skills_create`**; Vodou mints a **dedicated chat tab**, optional **cron** via **`vodou-core.db`** `scheduled_tasks`, and routes user messages in that tab through the skill’s **prompt template** instead of generic chat.

Design reference: `PLANS/0.5.73/PLAN-SKILL-CONSOLE-LOOP.md`.

## How it differs from file-based skills

| | File skills (`skills/…/SKILL.md`) | Skill Console |
|---|--------------------------------|---------------|
| Storage | Git-tracked markdown + optional `actions.json` | `skills_meta` + `skill_console_bindings` in **gateway.db** |
| Creation | You or `skill sync` | MCP **`vc_skills_create`** (any connected LLM) |
| Chat surface | Routed by intent / loader | Fixed tab `workbench:skill-console:<name>` |
| Schedule | Separate automation / cron | Optional **`schedule_cron`** on create or slash **`/cron`** |
| Self-edit | Edit files or skills tooling | Slash **`/refine`**, **`/cron`**, **`/disable`**, etc. |

Both can coexist. File skills stay the source of truth for curated workflows; Skill Consoles are for **recurring, user-refinable** prompts with a **stable conversation scope**.

## End-user flow

### From the web gateway (no MCP client)

1. **Left sidebar → Automated skill** (opens the create wizard; from another route it switches to **`#/chat`** first). Optionally in chat: empty-state **Create an automated skill** (only when you have no Skill Console tabs yet), or type **`/new-skill`** in the composer.
2. Fill the wizard (display name, kebab **name**, prompt template with **`{{user_message}}`**, optional schedule in NL or cron). **Draft with AI** calls **`POST /api/skill-console/draft`** (needs a configured gateway LLM). **Create** calls **`POST /api/skill-console/create`**, which runs **`vodou-core` `vc_skills_create`** — same validation as MCP.
3. Within a few seconds the existing poller emits **`skill_console_created`** and the new tab appears.

> **Also from the Scheduler view:** a plain scheduled task (Activity → Scheduled → **+ Add Scheduled Task**) with the **"Show as dock tab"** checkbox on becomes a Skill Console too — `POST /api/scheduler` routes `query` tasks through `vc_skills_create`. See [vodou-scheduler.md → Surfacing a task as a dock tab](./vodou-scheduler.md#surfacing-a-task-as-a-dock-tab).

### From MCP / CLI

1. Invoke **`vc_skills_create`** with at least **`name`**, **`display_name`**, **`prompt_template`** (20–8000 chars; typically includes `{{user_message}}`).
2. The gateway opens or lists a tab for **`workbench:skill-console:<name>`**. Replies there use the skill template, **`prepareSkillConsoleForLlm`**, and optional **Layer B** stopping points (`stopping_points` in the tool args → `skills_meta.stopping_points_json`).
3. Optional **schedule**: pass **`schedule_cron`** on create or run **`/cron …`** in the tab. The worker/scheduler runs tasks with **`payload_type = skill_run`** and POSTs to the gateway (**`POST /chat/skill-fire`**).

## Operator setup

### Continuity / principal

**`vc_skills_create`** requires a seeded **self principal** in **`vodou-core.db`** (same as other continuity-aware paths). If you see `no self-principal seeded`, run:

```bash
./vodou-core continuity init
```

### Scheduler secret (production)

**`POST /chat/skill-fire`** accepts JSON **`{ skillId, conversationId }`** and runs the skill turn with an empty **`{{user_message}}`**. When **`VODOU_GATEWAY_SCHEDULER_SECRET`** (or legacy **`OI_GATEWAY_SCHEDULER_SECRET`**) is set in the **gateway** environment, callers must send header **`X-Scheduler-Secret`** with the same value. If the secret is **unset**, the route is open (convenient for local dev; **do not expose** the gateway untrusted).

Align with the worker/scheduler base URL via **`VODOU_GATEWAY_URL`** / **`OI_GATEWAY_URL`** (default `http://localhost:8765`).

### Soft cap

**`VODOU_SKILLS_SOFT_CAP`** (default **20**) limits active rows in **`skills_meta`** with **`is_active = 1`**. Legacy alias: **`VODOU_SKILL_CONSOLE_MAX_ACTIVE`** when the soft cap env is unset.

### Optional gateway DB override (Rust / tests)

For **`vc_skills_create`** only, **`VODOU_GATEWAY_DB_PATH`** forces the SQLite file used for gateway-side inserts. Default: **`MCP-servers/Vodou-Console/gateway.db`** under **`VODOU_PROJECT_PATH`** / workspace resolution. The Node gateway uses **`GATEWAY_DB_PATH`**; in production these should refer to the **same file** if you override.

## Prompt template features

Documented in tool schema and gateway **`/help`** where applicable:

- **`{{user_message}}`**, **`{{now}}`**, **`{{conversation_id}}`**, **`{{history}}`** (with **`history_window`**).
- **`{{invoke_tool:server::tool|args}}`**, **`{{invoke_recall:query|k=N}}`**, **`{{invoke_script:server::script|params}}`** (pre-LLM expansion; caps apply).
- **`{{invoke_skill:name|k=v}}`**, **`{{param:name}}`**, **`/run`**, **`/set-param`**, completion hooks (**`on_complete_hook`**).

## Slash commands (in the skill tab)

Includes **`/help`**, **`/refine`**, **`/cron`** (with natural language resolution in the gateway), **`/disable`** / **`/enable`**, **`/clone`**, **`/snapshot`**, **`/history`**, **`/model`**, Layer B **`/menu`**, **`/phase`**, parameter and hook commands per plan.

## HTTP surface (testing and integrations)

| Route | Role |
|-------|------|
| **`POST /chat`** | Normal user turn; if **`conversationId`** is skill-bound, runs skill pipeline. |
| **`POST /chat/skill-fire`** | Scheduler-only scheduled fire; empty user message; requires secret when configured. |
| **`POST /api/skill-console/create`** | Gateway UI / API — body matches **`vc_skills_create`**; spawns **`vodou-core call vodou-core vc_skills_create`**. |
| **`POST /api/skill-console/draft`** | Optional “Draft with AI” — JSON `{ display_name, name, prompt_template, schedule_cron? }`; requires configured LLM. |

Automated tests (Vodou-Console): **`tests/chat-post-http.test.ts`**, **`tests/chat-skill-fire-http.test.ts`**, **`tests/skill-console-handler.test.ts`**, **`tests/skill-console-layer-b.test.ts`**, **`tests/chat-pipeline-skill-console.test.ts`**, plus template/NLP tests.

Rust: **`scheduler::parse_skill_run_payload`**, and **`mcp_server::tests::vc_skills_create_uses_gateway_path_override_and_validates_gates`** (isolated **`vodou-core.db`** + **`VODOU_GATEWAY_DB_PATH`**).

## Manual verification

```bash
bash MCP-servers/Vodou-Console/scripts/manual-skill-console-layer-b-verify.sh
# optional live POST /chat (needs LLM configured on gateway):
bash MCP-servers/Vodou-Console/scripts/manual-skill-console-layer-b-verify.sh --curl-chat
```

## Closed the skill tab (×) and it disappeared?

Closing a tab in the gateway runs a **soft-delete** on that `gateway_conversations` row (`deleted_at` is set). The chat list and tab hydration only show conversations with **`deleted_at IS NULL`**, so the skill tab **does not come back** on refresh the way a hidden tab would.

**Recovery (pick one):**

1. **Call `vc_skills_create` again** with the same or a new `name` (if the old name is still reserved in `skills_meta`, use a new name or clean up the old row in `gateway.db` / `vodou-core.db` per your comfort level).
2. **Un-delete the conversation** (same machine, same `gateway.db` the UI uses):

   ```bash
   sqlite3 MCP-servers/Vodou-Console/gateway.db \
     "UPDATE gateway_conversations SET deleted_at = NULL WHERE id = 'workbench:skill-console:YOUR-NAME';"
   ```

   Then hard-refresh `http://localhost:8765/#/chat` so the WebSocket sends `conversations_list` again.

## Related docs

- **[skills.md](skills.md)** — file-based skills, schema, `skill sync`.
- **[vodou-scheduler.md](vodou-scheduler.md)** — scheduled tasks and worker behavior.
- **[core-http-api.md](core-http-api.md)** — continuity / recall (`Surface::SkillConsole` turns flow through **`record_turn`**).
- **[mcp-host.md](mcp-host.md)** — exposing **`vc_skills_create`** to IDEs.
