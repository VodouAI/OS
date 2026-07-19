# Vodou CLI — the interactive agentic terminal

`vodou` is Vodou's interactive agentic terminal — a Claude-Code-style TUI you launch from **any directory** that drops you into the full Vodou agentic loop (your configured LLM, memory injection, BrainLoader intent routing, skills, tools, streaming) and can read/write files in the directory you launched it from.

It is **not** the `./do` orchestration launcher. It embeds the same `chat()` loop the web console uses, in-process — no gateway required, no web UI.

**Pre-req:** built CLI (`bin/vodou-cli` present) and an LLM configured (the Claude CLI installed, or `ANTHROPIC_API_KEY` set). Install wiring symlinks `~/.local/bin/vodou → bin/vodou-cli`, so `vodou` works from anywhere on your `PATH`.

---

## A note on the name `vodou`

There are two things called `vodou` — they do different jobs:

| Command | What it is |
|---------|-----------|
| **`vodou`** (on `PATH`, = `~/.local/bin/vodou` → `bin/vodou-cli`) | **This tool** — the interactive agentic TUI. |
| **`./vodou`** (in the repo root, a copy of `./do`) | The orchestration launcher — single tool calls, `brain`, board, etc. See [cli-entrypoints.md](cli-entrypoints.md). |

Type **`vodou`** (no `./`) from any directory to get the agentic terminal. The shell resolves it via `PATH`.

---

## Launch

### Interactive (default — full-screen TUI)

```bash
vodou
```

Drops you into the TUI in whatever directory you're standing in. Type at the `›` prompt, Enter to send. The agent can read/write files in **that** directory.

### One-shot / scriptable

```bash
vodou -p "list the files here and summarize the README"
vodou "same thing — positional words work too"
echo "summarize this" | vodou            # piped stdin
```

One-shot prints the answer and exits (always uses the streaming-print renderer).

### Streaming-print REPL (no full-screen)

```bash
vodou --plain
```

`--plain` forces the line-by-line streaming renderer instead of the full-screen TUI. Use it over SSH-without-a-TTY, in CI, or if you prefer a plain transcript. (Pipes and `-p` already fall back to this automatically.)

---

## File access

The agent's file tools are anchored to the directory you launched from:

- **Relative paths** (`read_file src/foo.ts`) resolve against your **launch directory**, not the install dir.
- **Absolute / `..` paths** reach anywhere on the machine.
- **Secrets are always denied** by a denylist applied over the full absolute path: `.env*`, `*.key`, `*.pem`, `*.db`/`*.sqlite`, `.ssh`, `.aws`, `vodou-core`, etc. — refused even when the model reaches outside the launch dir.

This is the same posture as Claude Code: local, single-user, full machine access minus secrets. Suitable for the local alpha.

---

## Slash commands

Type `/help` in a session for the live list. All commands:

| Command | Does |
|---------|------|
| `/help` (`/?`) | List commands. |
| `/skills [filter]` | List active skills (optionally filtered). |
| `/skills <name>` | **Load and run** a skill by name through the agentic loop. |
| `/server` | List connected MCP servers — active state (`●`/`○`), tool counts, health. |
| `/server <name>` | List that server's tools. |
| `/server <name> <instruction>` | Run the instruction **directed at that server** (e.g. `/server gmail get my last 10 emails`). |
| `/tools [server]` | List available tools, grouped by server. |
| `/search <query>` | Recall earlier messages **in this conversation** (FTS). |
| `/compress` | Summarize the conversation, then continue in a **fresh context seeded with the summary** — frees the context window without losing the thread. |
| `/model` | Show the active model. |
| `/model <name>` | Switch the model live (e.g. `/model opus`); applies next turn. |
| `/usage` | Cumulative session tokens + cost. |
| `/clear` | Clear the screen. |
| `/new` | Reset the conversation (fresh context, history dropped). |
| `/exit` (`/quit`) | Quit. |

Any unrecognized `/command` returns `unknown command: … — type /help for the list` rather than being sent to the model.

### `/new` vs `/compress`

- **`/new`** throws the conversation away — clean slate.
- **`/compress`** keeps the thread: it summarizes what's happened, starts a fresh conversation, and seeds that summary back in. Use it on long sessions that are filling the context window.

---

## Output rendering (TUI)

The TUI renders assistant text as markdown:

- **Headers** → bold cyan, **`**bold**`**, *`*italic*`*, `` `inline code` `` → cyan
- **Bullets** (`-`/`*`/`+`) → `•`; **blockquotes** → a `▏` gutter
- **Fenced code blocks** → lightweight syntax coloring (strings green, comments dim, numbers yellow, keywords magenta). This is generic, not grammar-aware per language.
- **Links** — markdown `[label](url)` and bare `https://…` URLs render blue + underlined and are **clickable**.

**Clickable links need ⌘+Click** (Ctrl+Click on Windows/Linux) — terminals never open links on a plain click (that's text selection). Hover to see the underline. Support is detected per terminal: iTerm2, VS Code, WezTerm, Kitty, Hyper get OSC 8 hyperlinks; macOS **Terminal.app** lacks OSC 8 and falls back to a visible `label (url)`. Override with `FORCE_HYPERLINK=1` (force on) or `VODOU_TUI_NO_LINKS=1` (force off).

> Markdown renders on **complete lines** — the actively-streaming last line shows raw until it hits a newline, then snaps into formatting. This is required for native scrollback (below).

---

## Scrollback, scroll, copy/paste

The TUI commits each finished line into the terminal's **native scrollback** as it streams (only the in-progress line stays "live"). So scrolling up, mouse-wheel, and copy/paste all work exactly like ordinary terminal output — the app does not own the viewport.

---

## Session continuity

Conversations are keyed by your **launch directory** (a stable `cli:<cwd-hash>` id, no PID). Relaunch `vodou` from the same directory and it **resumes** the same conversation — history hydrates from the gateway DB. `/new` starts a fresh one.

---

## Model & provider

- The CLI uses your **configured model** (`cli_model` setting, default `sonnet`) — it never silently downgrades to a cheap model. Switch live with `/model <name>`.
- Smart-routing is **off** by default in the CLI (`VODOU_SMART_ROUTING=0`); set `=1` to enable.
- Works with any configured provider (claude-cli, anthropic, fireworks, openai, …) — same dispatch as the web console.

---

## Environment variables

| Var | Effect |
|-----|--------|
| `VODOU_SMART_ROUTING` | `0` (CLI default) disables smart model routing; `1` enables. |
| `VODOU_BRAINLOADER_TIMEOUT_MS` | Live intent-routing/memory timeout (CLI default `25000`; cold worker loads embedding models slowly). |
| `VODOU_FS_TOOLS_ROOT` | Override the launch-dir anchor for relative file paths. |
| `FORCE_HYPERLINK` | `1` forces OSC 8 clickable links on regardless of terminal detection. |
| `VODOU_TUI_NO_LINKS` | `1` disables OSC 8 links (always use the `label (url)` fallback). |
| `VODOU_CLI_DEBUG_DUP` | `1` writes `[dup]` stream-dedup traces to `.vodou/workspace/cli-<pid>.log` (diagnostics). |

---

## Troubleshooting

**A command "isn't recognized" / behaves like an old build.**
The running TUI is a **snapshot** — it keeps the code it launched with. After any update, `/exit` and relaunch. Confirm the intro line shows the current `[build YYYY-MM-DDx]` marker.

**First turn after a cold/restarted worker is slow (~25s+) and skips live routing.**
A cold `brain` call loads embedding models and can exceed the timeout once. It falls back to the static bootstrap and is warm afterward (the worker persists across runs). Steady state is fine.

**`/search` returns "no matches" for things you know you discussed.**
`/search` uses FTS5, which needs **Node 24**. On older Node it degrades to empty rather than erroring. It's also scoped to the **current** conversation only.

**Links won't open.**
Use **⌘+Click**, not a plain click. If your terminal is Terminal.app (no OSC 8), you'll see `label (url)` — copy the URL. Force behavior with `FORCE_HYPERLINK` / `VODOU_TUI_NO_LINKS`.

**The answer printed twice (historical).**
A double-output bug on `text → tools → text` turns was fixed (build `2026-06-21c`). If you see it, you're on an older build — relaunch (and restart the gateway for the web chat, which shares the same streaming path).

---

## Architecture (for maintainers)

- **Embedded loop, no web server.** The CLI imports `chat()` from `MCP-servers/Vodou-Console/src/llm.ts` directly (`bootstrapHeadless.ts` does auth + daemon/worker ensure without `setupExpress/createServer/setupWebSocket`).
- **One event stream, two renderers.** `CliSession` (`src/cli/session.ts`) forwards every `StreamEvent` to a `Renderer`. The TUI (`src/cli/renderers/tui.tsx`, Ink/React) is the default; `--plain` (`renderers/plain.ts`) is the streaming-print fallback. Markdown/links live in `renderers/markdown.tsx`; slash-command data in `cli/commands.ts`.
- **No Rust, no loop rewrite.** Heavy tool work still runs in Rust under the hood via the worker socket; the CLI is a terminal front-end over the existing TypeScript loop. Only cost is Node cold-start (~100–300 ms) per resident session.
- **QA:** `cd MCP-servers/Vodou-Console && npm run qa:cli` drives the real launcher through a headless terminal emulator (`@xterm/headless`) — output persistence, scrollback, slash commands, markdown/link parsing, and command formatters.

See the implementation plan: [`PLANS/0.6.9/PLAN-VODOU-CLI-AGENTIC-TERMINAL.md`](../PLANS/0.6.9/PLAN-VODOU-CLI-AGENTIC-TERMINAL.md).

---

## Related

- [cli-entrypoints.md](cli-entrypoints.md) — the `./do` / `./vodou` orchestration launchers (distinct from this tool)
- [cli-reference.md](cli-reference.md) — full `vodou-core` command reference
- [vodou-memory.md](vodou-memory.md) — the memory system the CLI injects each turn
- [skills.md](skills.md) — skills (Layer 1), surfaced via `/skills`
