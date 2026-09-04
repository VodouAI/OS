## Running Vodou from a coding agent

**The right primitive is `./vodou-core call <server> <tool> '<json-args>'`** — deterministic, single-spawn, no subprocess tree, returns clean JSON. Use this for every tool execution you would otherwise reach for brain/do.

`./do "<text>"`, `./oi`, `./vodou` and `./vodou-core brain "..."` DO work headlessly (no TTY gate triggers in current code, verified 2026-05-15), but **they spawn the full BrainLoader subprocess tree**, and in rapid loops have historically built up to 100s of orphan processes requiring a reboot (the 425-process incident). So:

- ✅ One-shot brain/do calls are fine.
- ❌ Don't loop them, don't poll them, don't use them inside retry logic.
- ❌ Don't run `--version` to check the binary — read `Cargo.toml` `[package].version` instead.
- ❌ Don't poke the worker from here — ask the user to run it interactively.
- For a question *about* a command (not a request to run it): just answer.

If the user types `do "<text>"` expecting the launcher: for a known tool, `./vodou-core call` — same effect, no spawn hazard; for an ambiguous query needing BrainLoader routing, one `./do` is fine. Three or more in a turn: stop and use targeted `vodou-core call`.

(The `AGENTS.md` §6.5 mid-turn shell-out guidance with its 3-call cap is for the LLM running *inside the gateway chat* — a different, supervised process. Same shape of rule, applied here in spirit.)

## Helper scripts you should know about

- `./do "<query>"` — primary entry point for any task.
- `./vodou-core call <server> <tool> '<json-args>'` — direct MCP tool call, headless.
- `./vodou-core mem search "<query>" [--top-k N] [--json]` — hybrid FTS5+vector search over `memory.db` via the daemon socket (same pipeline BrainLoader uses). Use this instead of raw `sqlite3 memory.db "... MATCH ..."` — raw FTS5 skips the reranker and scope boost. Distinct from Vodou-Recall (which searches chat turns).
- `./vodou-core builds` — which build is which: engine binary, console dist, every extension folder, plus what the daemon and worker are actually running. Run it when a fix "didn't work" before assuming the code is wrong.
- `./vodou-core flows` — is the product still telling itself the truth? Four flows graded from LIVE evidence. `--json` for CI, exit 2 on a red row. A grader with no evidence answers **`unknown`, never `ok`**.
- `./vodou-core hosts` — which host adapters have real evidence of working, graded from `gateway.db` rows (not a rotating log — that was the bug).
- `scripts/broken-lab.sh` — break Vodou on purpose in an isolated instance and see what every surface says. Use it before claiming what a user "would see" in a failure.
- `./vodou-core intent-signal "<prompt>"` — what the keyword router would do with a prompt, and why. `--file <path>` for a distribution.
- `./vodou-core mem hygiene [--examples]` — do stored facts stand alone for a stranger? A ranking number, not a tidiness one.
- `./vodou-core rules render [--check]` — regenerate this file and its siblings from `templates/rules/`. **This file is generated; edit the source.**
- `./open-gateway.sh` — re-open the web UI without restarting services.
- `./start-vodou-services.sh` / `./stop-vodou-services.sh` — boot / tear down daemon + worker + console. `VODOU_NO_OPEN_BROWSER=1` suppresses the browser.
