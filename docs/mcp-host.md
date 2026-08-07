# Vodou as an MCP Host

Any MCP-capable client on your machine — Claude Desktop, Claude Code, Cursor, VS Code,
Windsurf, Zed, a local model runner, or a script you wrote this morning — can attach to
Vodou and adopt its brain: **memory, skills, and every tool Vodou has connected**.

You connect Gmail (or Slack, or Notion) once in Vodou, and every attached client can
reach it. No per-client setup, no second config, no restart of the client.

---

## Attach a client

```bash
vodou-core mcp install                  # see which clients are detected
vodou-core mcp install cursor           # write the entry for Cursor
vodou-core mcp install claude-desktop --profile memory --vault family
vodou-core mcp list                     # what's attached, and where
vodou-core mcp clients                  # registered HTTP clients + their scopes
vodou-core mcp revoke cursor            # cut one client off, leaving the rest
vodou-core mcp uninstall cursor
```

Then restart the client. That's the whole setup.

`install` **merges** into the existing config — other MCP servers and unrelated settings
are preserved, and the file is backed up to `.vodou/backups/` first. Re-running updates
the entry in place rather than duplicating it. If a config can't be parsed, Vodou
refuses to write rather than overwriting a file it didn't understand.

### A client we don't know about

That's a supported case, not a failure:

```bash
vodou-core mcp install --print
```

It prints ready-to-paste config for both transports — copy the one your client wants.

Attaching more than one unknown client? Name each:

```bash
vodou-core mcp install --print --http --client-id zed --label Zed
```

Without a name they all register as `custom`, and attaching the second rotates the
first one's key out from under it.

---

## Two transports, one catalog

| | **stdio** (default) | **loopback HTTP** |
|---|---|---|
| Setup | Client launches `vodou-core mcp-server` | You run the server; client connects by URL |
| Ports / auth | None | `127.0.0.1:8787`, bearer token |
| Process model | **One Vodou per client** | **One Vodou for all clients** |
| Use when | Simplest; works everywhere | Several clients open at once |

Both serve the **same catalog from the same dispatcher**, so a tool is never available
on one transport and missing from the other.

### stdio

What `mcp install` writes by default. Nothing to start — the client spawns Vodou itself.

```json
{
  "mcpServers": {
    "vodou": {
      "command": "/absolute/path/to/vodou-core",
      "args": ["mcp-server"]
    }
  }
}
```

Profiles and `--vault` apply here too, carried on the command line — a stdio client gets
its own process, so its scope lives in argv rather than in a key.

### Loopback HTTP

Every stdio client spawns its **own** `vodou-core`, and each one stands up its own
connection pool across all configured MCP servers. Four editors open means four complete
pools. HTTP collapses that to one:

```bash
vodou-core mcp-server --http                      # 127.0.0.1:8787, profile: full
vodou-core mcp-server --http --port 9000 --profile dev
```

```bash
vodou-core mcp install cursor --http              # writes the URL + token entry
```

The address is **always** `127.0.0.1` — there is no setting that exposes it to your
network. Because any local process can reach loopback, every request needs a bearer token,
which `mcp install` puts in the client config for you.

### One token per client

Attaching a client over HTTP mints a token for that client alone, recorded with the
profile and vault it was attached under. Only the SHA-256 digest is stored — the token
itself is written into the client's config and never kept here, so this registry cannot
hand back a credential.

```bash
vodou-core mcp clients          # who is attached, under what scope, last seen
vodou-core mcp revoke cursor    # kill one client's access; everything else keeps working
```

The same view lives in the web console under **Settings → Clients**, with a Revoke button
per client. `--json` on `mcp clients` and `mcp list` is what that page reads, so the two
surfaces cannot disagree.

Re-running `mcp install` for a client rotates its token and clears any revocation. A
revoked client stays listed rather than disappearing, so you can see that it was cut off
rather than never attached.

Your `.vodou/console.token` still works and carries the server's launch profile and vault
— it is the owner's key, not a client's. Configs written before per-client tokens keep
working unchanged.

---

## Profiles — what a client may reach

A profile can only ever **subtract** from what you already have. There is no profile
that grants a client something you don't have yourself.

| Profile | Exposes | Use for |
|---|---|---|
| `full` *(default)* | All `vc_*` tools including the `vc_server_tool` router | Your own editor — it's you, on your own machine |
| `dev` | `full` minus shell and file writes | A client you're still evaluating |
| `memory` | Memory + skills lookup, **read-only** (4 tools) | Small-context runners; the default for anything remote |
| `custom:a,b` | Exactly the tools you name | Anything specific |

```bash
vodou-core mcp-server --http --profile memory
vodou-core mcp install cursor --profile dev
```

Profiles do three jobs, and it's worth knowing which one you're after:

- **Fit** — a large catalog is unusable for a client with a small context window.
  Shrinking it here is tuning, not hardening.
- **Authority** — `memory` for something you don't fully trust. This one is a real
  control: a withheld tool is refused when *called*, not merely hidden from the list.
- **Envelope** — under any profile but `full`, tool results are reduced to the MCP-spec
  fields. Vodou attaches a `context` block to its own results (working directory, git
  branch, recent memory, a workspace summary); withholding a tool would mean little if a
  permitted one carried the same material out in the envelope.

### The vault, and why it is not a tool argument

`vc_memory_search` and `vc_memory_context` disclose exactly one vault, chosen when the
server starts:

```bash
vodou-core mcp-server --http --profile memory --vault family
```

Default is `portable`. The tool schemas have **no** `vault` property — not one that gets
ignored, none at all — so a client that has been talked into asking for your bank vault
has nowhere to ask. Whoever launched the process picked the vault, and that is the end of
it.

Each HTTP client carries its own vault, so one server on one port can serve Cursor from
`portable` and Claude Desktop from `family` at the same time. stdio needs no registry —
the vault rides on argv, because a stdio client gets its own process.

### Writing back

`vc_remember` hands a note to the capture lane, where it is distilled and ranked like any
other capture. It is never a direct write into the memory store.

`memory` is read-only by default and `dev` withholds it, because a profile you hand to
something you are still evaluating should not gain a write channel by accident. Opt in
explicitly:

```bash
vodou-core mcp-server --http --profile memory --allow-remember
```

---

## Available tools

All prefixed `vc_`, exposed automatically once connected.

| Tool | Description |
|------|-------------|
| `vc_intelligent_query` | Natural language query → parallel MCP execution |
| `vc_system_analysis` | CPU, memory, disk analysis in parallel |
| `vc_code_analysis` | Codebase structure, issues, research — simultaneously |
| `vc_error_debugging` | Error → parallel system state + solution search |
| `vc_comprehensive_analysis` | Full system + code + research in one call |
| `vc_server_tool` | Direct access to any tool on any connected MCP server |
| `vc_server_status` | Status of all connected MCP servers |
| `vc_load_skill` | Load a Vodou skill by name or file path |
| `vc_list_skills` | List all available Vodou skills |
| `vc_search_skills` | Search skills by keyword |
| `vc_skills_create` | Create a **Skill Console** (gateway tab + optional cron); see [skill-console.md](skill-console.md) |
| `vc_schedule_add` | Schedule a task (cron, every Nh, at HH:MM, in Nh) |
| `vc_schedule_list` | List all scheduled tasks |
| `vc_workspace_read_file` | Read a workspace file |
| `vc_workspace_write_file` | Write a workspace file |
| `vc_workspace_append_file` | Append to a workspace file |
| `vc_workspace_run_command` | Run a shell command in the workspace |
| `vc_workspace_list_dir` | List a workspace directory |
| `vc_memory_search` | Ranked snippets from the pinned memory vault |
| `vc_memory_context` | A ready-to-use context block for a topic, from the pinned vault |
| `vc_remember` | Hand a fact to the capture lane (reviewed, never a direct write) |

> Start with `vc_intelligent_query` for general use, `vc_comprehensive_analysis` for deep dives.

To expose exactly one tool (lightweight integrations), stdio also takes `--tool`:

```json
{ "command": "/absolute/path/to/vodou-core", "args": ["mcp-server", "--tool", "vc_intelligent_query"] }
```

---

## Verify

```bash
vodou-core mcp list        # is the client attached, and on which transport?
```

From the client:

```
vc_list_skills    → your installed skills
vc_memory_search  → facts from your vault ("what is my dog's name?")
vc_server_status  → every MCP server Vodou has connected
```

For HTTP, check the endpoint directly:

```bash
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $(cat .vodou/console.token)" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request without the token returns **401** — that's the token working, not a fault.

---

## Remote clients (claude.ai, ChatGPT)

**Not supported yet.** Hosted clients require a public HTTPS endpoint, because *their*
servers make the call and cannot reach your `127.0.0.1`. That needs a relay, and it is
deliberately deferred — see `PLANS/0.6.22/PLAN-MCP-EGRESS.md` §9, including two problems
left unresolved on purpose: a device-anchored connector is offline whenever your laptop
sleeps, and a relay able to read your memory frames undercuts the reason Vodou is
local-first in the first place.

For those two surfaces today, use the browser extension instead —
see [browser-extension-installation.md](browser-extension-installation.md).

---

## Ports

| Port | Service |
|------|---------|
| 8765 | Gateway / web console |
| 8766 | Core HTTP API |
| 8767 | Brain console |
| 8787 | **MCP egress** (`mcp-server --http`) |

---

## Not to be confused with

**Settings → Servers** in the web UI manages which MCP servers Vodou connects **to**
(Vodou as client). This page is the other direction: external clients connecting **to
Vodou** (Vodou as host).

See [mcp-protocol.md](mcp-protocol.md) for the client-side implementation.
