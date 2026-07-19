---
name: self-improve
description: LLM-driven self-improvement of the Vodou codebase — one small change at a time, fully tested, project-only, with backups. Can be scheduled to run continuously until stopped.
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "self improve"
  - "oi self improve"
  - "vodou self improve"
  - "improve the codebase"
  - "steward Vodou"
  - "self improvement run"
  - "clean up and harden Vodou"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# Vodou Self-Improve — Steward the Codebase to Release Quality

## Mission

You are improving the **Vodou project in this directory only**. Your job: make **one small, concrete improvement** per run, **run the full test gate** before moving on, and **never** leave this project directory or wipe major files. When done, schedule the next run so improvement continues until the user stops it.

---

## Guardrails (MANDATORY)

1. **Project directory only** — All edits, creates, deletes, and command execution (e.g. `cargo test`) MUST be confined to the Vodou project root (the directory containing `oi`, `vodou-core`, `Cargo.toml`, `.vodou/`). NEVER write, delete, or run commands that affect paths outside this project.
2. **No major file wipes** — Do NOT delete or overwrite in-place major files (e.g. `Cargo.toml`, `src/main.rs`, `README.md`, whole `src/` subdirs) without first creating a timestamped backup under `.vodou/backups/` (e.g. `.vodou/backups/2026-02-16_main.rs.bak`). When in doubt, backup first.
3. **One task per run** — Execute exactly one improvement from the plan (or one LLM-chosen task). Do not start the next task in the same run.
4. **Test gate** — Before considering the task complete, run the project test suite (e.g. `cargo test` from project root). If any test fails after your change, **revert the change** (or restore from backup), log the failure, and do not mark the task done. You may schedule a retry later or skip to another task.
5. **Stop signal** — At the start of each run, check for `.vodou/self_improve_stop`. If that file exists, do nothing and do not schedule a follow-up. Tell the user "Self-improve stopped (remove .vodou/self_improve_stop to allow again)."

---

## Plan and Planning

- **Plan file**: `.vodou/workspace/self-improve-plan.md` (or the path in `.env`: `VODOU_SELF_IMPROVE_PLAN_PATH`). It contains phases and small tasks (e.g. "Add unit test for X", "Fix one clippy warning in Y").
- **When run by the scheduler**: The daemon’s planning step (Claude CLI or configured LLM) already ran and chose a **TASK**. Your run is that TASK. Execute it with the guardrails above, then the scheduler will add the next run (e.g. in 10m) automatically if the LLM returned a SCHEDULE.
- **When run manually** (e.g. user said "self improve"): Read `.vodou/workspace/self-improve-plan.md` and recent memory. Use **Claude CLI** to pick one next task if available: e.g. `echo "Plan: <plan content>; Memory: <recent>. What is the ONE next small improvement? Reply: TASK: <task>." | claude` (or equivalent). Then execute that TASK with the guardrails above. After success and passing tests, schedule the next run: `./do schedule add self-improve-next "in 10m" "oi 'self improve'" --one-shot`.

---

## Steps (each run)

1. **Check stop** — If `.vodou/self_improve_stop` exists, exit without scheduling. Otherwise continue.
2. **Get task** — If the scheduler already provided a TASK (you were invoked with a specific instruction from the planner), use it. Else read the plan and memory and use Claude CLI (or your judgment) to pick ONE small task.
3. **Backup if needed** — If the task touches a major/critical file, copy it to `.vodou/backups/<date>_<filename>.bak` first.
4. **Execute** — Make the single change. Stay inside the project directory.
5. **Test** — Run `cargo test` (or the project’s test command). If failures: revert/restore, log, and optionally schedule a retry in 1h or skip; do not schedule the usual next run.
6. **Log** — Run `./do "log: ..."` with what you did (e.g. `./do "log: refactor: One clippy fix in scheduler.rs | component: scheduler | files_changed: 1"`).
7. **Schedule next** — If you ran manually (not from scheduler), add the next run: `./do schedule add self-improve-next "in 10m" "oi 'self improve'" --one-shot`. If you were run by the scheduler, the daemon will have already scheduled the next run when the LLM returned SCHEDULE.

---

## How to run continuously (daemon)

1. Set in `.env`: `VODOU_SELF_IMPROVE_PLAN_PATH=.vodou/workspace/self-improve-plan.md` (and keep an LLM provider set for planning, e.g. Claude CLI).
2. `./do schedule approve-autonomous` (autonomous tasks include "self improve").
3. Start the chain: `./do schedule add self-improve "in 5m" "oi 'self improve'" --one-shot`, or run `./do "self improve"` once and have it schedule the next.
4. Run the daemon: `./do daemon start` (or install and load for 24/7). Each due run: planner picks next task from the plan → you execute it (with guardrails and test) → scheduler adds follow-up "oi 'self improve'" in 10m (or whatever the LLM returned).

---

## How to stop

- **Temporary stop**: Create the stop file: `touch .vodou/self_improve_stop`. The skill will exit without scheduling when it sees this. Remove it to allow again.
- **Remove next run**: `./do schedule list` then `./do schedule remove <id>` for any `self-improve-next` or `self-improve` task.

---

## Stopping Point 1

**What do you want to do?**

1. **Run one self-improve task now** — Follow the steps above: check stop, get task from plan (or Claude CLI), backup if needed, execute, test, log, schedule next if manual.
2. **Show the plan** — Read and summarize `.vodou/workspace/self-improve-plan.md` and the next suggested task.
3. **Set up continuous runs** — Confirm plan path in .env, approve autonomous, add first scheduled "oi 'self improve'" and remind to start daemon.
4. **Stop / don’t run** — Do nothing; optionally create `.vodou/self_improve_stop` to block future runs until removed.

Reply with 1, 2, 3, or 4.
