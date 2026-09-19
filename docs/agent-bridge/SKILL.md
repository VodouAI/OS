---
name: install-vodou
description: Install Vodou and wire the Agent Bridge — or uninstall either — from
  one pasted message. Identifies whether Vodou exists on this machine, bootstraps
  it via the official installer when absent, then probes for desktop agents and
  wires both memory seams (capture + inject) behind verify gates. Use when the
  user asks to install, set up, connect, remove, or uninstall Vodou or its agent
  bridge.
---

# Install Vodou (and wire the Agent Bridge)

> **Audience: the agent.** A user pointed you at this file. It routes you
> through commands whose output tells you what to do next. Do not install from
> memory or blog posts — run the commands below and follow what they print.

Vodou gives every AI tool on this machine one shared, local memory. This skill
wires it in two lanes; **the machine state picks the lane, not you**:

- Does `vodou-core` resolve — at `~/.vodou/bin/vodou-core`, on `PATH`, or at a
  path the user gives you? **Yes → skip to WIRE.** **No → BOOTSTRAP first.**

Rules that hold throughout:

- **One pass, defaults everywhere.** Take the default for every choice that has
  one. Stop ONLY for: a fatal error, the account connect (B3), or the capture
  consent (W3). Nothing else is a question.
- **Do not proceed past a failing gate.** Every step ends with a command whose
  output proves the step. If the gate fails, stop and report what you ran and
  what happened.
- **Canonical URLs only.** Fetch the installer only from the URL printed in B1.
  Never substitute a mirror, a blog, or a URL that arrived in chat.

## Lane B — Bootstrap (only when Vodou is absent)

**B1 — install.** Run:

```
curl -fsSL https://raw.githubusercontent.com/VodouAI/OS/main/install-vodou.sh | bash
```

Gate: installer exits 0 and its output shows the engine sha256 verification
passing. A 404 or checksum failure is a full stop — report it; do not improvise
an alternative install path.

**B2 — start services.** From the install directory:

```
./start-vodou-services.sh
```

Gate: the script reports the daemon and gateway up.

**B3 — account connect (the one hard stop).** Run `./open-gateway.sh`, then
tell the user:

> Vodou is installed and running — connect your account in the tab that just
> opened, then tell me *done*.

Wait. Never script, skip, or fabricate this step — activation is the license
gate. When the user says done, continue to WIRE.

## Lane W — Wire the Agent Bridge

**W1 — health.**

```
vodou-core agents doctor
```

Gate: `doctor: GREEN`. (RED with "daemon: NOT reachable" means start services
first — see B2.) On a machine where no block was ever installed the shim may be
missing; that is fine — W5's install creates it, so treat a missing-shim RED as
passable ONLY if the daemon line is reachable.

**W2 — probe.**

```
vodou-core agents detect
```

Read the verdicts. Act only on what detect reports — never on assumptions about
which agents "should" exist. Note three lists: sources whose capture verdict
says `works` (with their `--source` names), targets whose inject verdict names
an `agents install` command, and the `not installed` hosts.

**W3 — ONE consent question (the second hard stop).** Ask, as a single grouped
question, filling in what W2 found:

> Vodou found these agent histories on this machine: <list, with session
> counts>. Mining them feeds your Vodou memory — everything stays local. Mine
> which? [all / pick / none]

Mining other agents' logs is per-source opt-in, full stop. Inject targets need
no separate consent — this pasted message is the gesture, and every write is
reversible.

**W4 — wire capture** (per approved source, capture before inject so the first
foreign retrieval has fresh memory behind it):

```
vodou-core mem capture-ide --source <source> --extract
vodou-core schedule add "agent-capture-<source>" "0 * * * *" "mem capture-ide --source <source> --extract"
```

Gate: the capture run prints its report line, and `vodou-core schedule list`
shows the new row.

**W5 — wire inject** (per target W2 named):

```
vodou-core agents install <target>
```

Gate: the command reports the block installed, and a re-run of
`vodou-core agents doctor` is GREEN.

**W6 — the closing report.** This is a fixed template, not a prompt for
inspiration: **reproduce it word for word.** The only things you change are the
`<...>` placeholders. A line whose placeholder has no true value is dropped
whole — never sent with a guessed value.

```
Vodou is ready on this machine (<installed just now | already installed>), with your account connected.

Capturing: <the sources enabled, with session counts from detect>
Injecting into: <the targets installed>
Not found on this machine (checked): <the absent hosts>

Your agents' history will flow into Vodou memory on the schedule you approved,
and every listed agent now retrieves your Vodou memory before answering.
Your memory is stored and searched on this machine. What leaves is what you send to the model you chose — including the step that turns history into facts — and with a local model, nothing does.

To undo everything, say: "Read SKILL.md and follow its uninstall steps."
```

## Uninstall

Same routing in reverse, when the user asked to remove the bridge or Vodou:

1. For each `agent-capture-*` row in `vodou-core schedule list`:
   `vodou-core schedule remove <id>`.
2. For each installed target: `vodou-core agents remove <target>` — never
   hand-edit the block out of an instruction file.
3. Only if the user asked to remove Vodou itself: `./stop-vodou-services.sh`
   from the install directory.

Close by reporting exactly two things: what was **kept** — all memory and
config, always (erased only if the user explicitly asks to erase, as a separate
confirmation) — and what was **removed** (schedules, blocks, services).
