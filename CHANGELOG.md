# Changelog

All notable changes to the open Vodou client are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the engine release tags.

<!-- Maintained as part of the release playbook (Step 6b). Every published version gets
     an entry BEFORE the open tree syncs, written in user-facing language: what someone
     can now do, not which module changed. Do not write `@doc:` or any bare @word outside
     backticks — GitHub renders it as a user mention and attaches a Contributors block. -->

## [Unreleased]

## [0.6.31] - 2026-09-18 — Alpha

Vodou now knows *when* something was true, not just that it was. You can ask what
the plan was in August and get August's answer. A note that has been replaced stays
findable instead of vanishing. Nothing you have told Vodou is ever deleted behind
your back. And what you work out in your coding sessions now reaches the other AIs
you use, with anything that looks like a password or key held back.

### Added — memory that understands time

- **Ask about the past and get the past.** "What was the plan in August?" is
  answered as of August, not with today's plan, and history questions also pull
  in dated lines from your past conversations and work logs. From the command
  line: `vodou-core mem search --as-of 2026-08-15`.
- **A weekly summary you can search.** `vodou-core mem digest --week` writes a
  few short notes about the week — what shipped, what was decided, what is still
  open — each citing the notes it came from. Your originals are never changed.
- **Notes say how old they are.** A status note handed to an AI carries its age,
  and so does a fact the browser extension inserts into a chat, so an AI can tell
  a plan from last week apart from one from last spring.

### Changed — nothing you told Vodou is thrown away

- **The nightly cleanup no longer deletes or hides anything.** It used to merge
  notes it thought were duplicates and delete the rest, which could collapse a
  plan and its outcome into one line and lose the dates. It now only archives:
  an archived note is no longer offered to an AI automatically, but you can
  still find it with `vodou-core mem search --include-archived`.
- **Replaced is not the same as wrong.** When a newer note replaces an older
  one, the older one stays recallable at reduced weight, so "where did I live
  before?" has an answer. Notes hidden because they were *wrong* stay out.
- **Every hidden note records why it was hidden.**
- **Facts stay strong as they age; status notes fade.** Who you are, your
  preferences and your decisions keep full weight however old they are. "Planned
  …" and "done …" notes give way over time, so an old plan stops crowding out
  what is true now. Marking a plan `[DONE]` retires the older version of it.

### Changed — your memory reaches the other AIs you use

- **What you learn in coding sessions now reaches ChatGPT and the rest.** Facts
  from Claude Code and Cursor sessions were searchable in Vodou but never
  offered to other AIs. They are now, with the ranking fixes that keep coding
  chatter from crowding out real facts. (Browser extension 0.5.97.86.)
- **Nothing that looks like a credential ever leaves.** Coding sessions are
  where keys get pasted, so any note shaped like a key, token or private key is
  dropped before it can be offered to an outside AI — whatever its scope.
- **Plainer about what leaves your machine.** The extension and docs no longer
  say "nothing leaves your machine"; they say what does. The first-run welcome
  card links to a real download. (0.5.97.87, 0.5.97.88.)
- **The extension panel follows Vodou's light/dark setting** by default again.

### Changed — bringing your data in

- **OpenClaw and Hermes imports accept a `.zip`**, read the current
  `~/.hermes/memories` layout and every Hermes profile, treat one OpenClaw
  install as one workspace instead of two, and no longer report success when
  they imported nothing.
- **Imported skills keep their names.** A standard `SKILL.md` is named from its
  frontmatter or folder, never literally "SKILL".

### Changed — the console

- **A full API explorer.** Help → API explorer documents every gateway route,
  generated from the code, with a realistic example request and response for
  each, and Try It no longer answers 400. Help also links to the documentation.
- **Long jobs report back.** A command a chat reply starts in the background
  now posts its result to the chat when it finishes, instead of being lost.
- **Coming back to a chat mid-reply shows the reply in progress**, not a
  stopped chat.
- **"Add to memory" saves properly.** The button on a chat message now stores it
  the same way the browser extension stores a captured block, and tells you if
  it failed instead of always saying "Saved!".
- **A quieter chat.** Link previews appear only when a reply is actually about a
  link, and never as an empty card; images are no longer added to replies that
  did not ask for one; the memory counter and "recalled · see why" chip are gone.
- **The memory Review tab responds to clicks.**

### Fixed

- **Settings no longer send secrets back to the browser.** Board configuration,
  OAuth status and saved webhooks returned stored credentials in their responses.
  Board and OAuth now say only whether a secret is set; webhooks show the last
  four characters. A saved OAuth client secret is no longer pre-filled into the
  form — leave the field blank to keep it.
- **Turning off "Send usage analytics" now also stops token-usage records** for
  your own API keys.
- **A weekday schedule runs on the day it names**, not the day before.
- **"Today" is today on your clock**, and History labels Today and Yesterday.
- **A scheduled skill that ran is shown as having run**, not "never ran"; a run
  with nothing to report no longer lands in the extension inbox.
- **Signing in during setup can no longer leave you with no name.**
- **Session logs follow your project**, not the folder you launched from.
- **A colour palette you pick is saved to your shared appearance settings**
  again, and chat titles line up beside the cross-project indicator.

### Known issues

- **The Windows build is not code-signed yet**, so Windows SmartScreen will warn
  before it runs.
- **The Linux arm64 and Windows builds are checked but not run** by any
  automated test — their contents and checksums are verified, the programs
  themselves are not started. The macOS and Linux x64 builds are.

## [0.6.30] - 2026-09-13 — Alpha

Vodou starts noticing things for you. Promises you made in a conversation become
a list with due dates, the people you talk about get their own pages, the daily
briefing is about your day instead of Vodou's, and every schedule finally runs on
your clock rather than the server's.

### Added — Vodou keeps track so you do not have to

- **Commitments.** When you say you will do something — "I'll send Sam the deck
  Friday" — Vodou records it as a commitment with a due time, reminds you when it
  is actually due, and closes it when the conversation shows it is done. They live
  under Activity → Loops, where you can also clear them.
- **People pages.** A Names tab lists the people and organisations that come up in
  your conversations, one page each: what Vodou remembers about them, the
  commitments involving them, a place to add a memory by hand, and a meeting brief
  that cites where every line came from. A first name alone now finds the right
  page.
- **Proactive loops.** Background checks that look for things going quiet — a
  capture source that stopped sending, a connection that expired, a promise
  that slipped — and raise one finding addressed to the right person instead of
  a log line nobody reads. Each loop is tested against a quiet day, so it does not
  cry wolf.
- **An interview instead of a form.** Setup asks you about yourself one question
  at a time, and every answer becomes a pinned memory you can edit later.
- **Automations can watch what Vodou already knows.** Your own feeds — new
  memories, a script's output file, a learned chain of tool calls — can trigger an
  automation, a skill can be the action, and a runaway automation trips a breaker
  and tells you so.
- **Desktop agents are found automatically.** Cursor, Codex, Hermes, OpenClaw,
  Cowork and other agents on your machine are detected, their sessions can be
  brought into memory, and each can be switched on or off.

### Changed — schedules run on your clock

- **Your timezone is required, and asked for.** A fresh install takes it from the
  browser; if the browser cannot say, setup asks, using the same list as
  Settings → Profile. Picking from a list replaces the free-text box, where one
  typo silently put the whole system on the machine's clock.
- **"Every day at 9am" means 9am where you are** — and stays 9am across daylight
  saving. Schedules follow your timezone (shown as `@user`) unless you pin one to
  a place on purpose, such as "9am London", which you can now choose from the
  screen as well as the command line.
- **Changing your timezone moves the schedules that follow you, and only those.**
  A schedule pinned to a place stays put.
- **Every time on screen is on your clock**, not the browser's, and every place
  that shows a schedule says which clock it is on. `vodou-core schedule audit`
  lists any schedule whose clock looks wrong.
- **One-off reminders ("at 3pm Friday") land at 3pm your time**, not 3pm UTC.

### Changed — the briefing and your context

- **The daily briefing is about you** — what you were doing, what you promised,
  who you are meeting — and a new user gets a welcome instead of a status report.
  It can be pulled on demand, and a quiet day no longer pages a channel to say
  nothing happened.
- **Your sessions start with who you actually are.** The context a session
  receives is generated from your profile, pins and recent work — including where
  you left off — rather than from hand-edited files that drifted out of date. You
  can correct anything it generated from the Pinned tab, and a pin that has gone
  stale says so.
- **Long conversations carry their decisions forward**, not their whole
  transcript, and the message you are sending is no longer counted twice.

### Changed — the chat list reads in the order you use it

- **Three groups instead of one pile.** The column beside Chat now splits into
  Vodou (Heartbeat, Board, your hand-driven skill consoles), Scheduled (everything
  on a timer, soonest first, with its next run at the right edge of the row —
  `9:05 AM`, `30m`, `overdue`, `paused`) and Chats. A title that starts with an
  emoji uses it as the row icon instead of showing a broken avatar.
- **Scheduled opens when something ran.** If a scheduled console fired since you
  last looked, the group opens with a `2 new` count and those rows read like
  unread until you open them. Nothing new, and it stays folded out of the way.
- **New chat is the first row of Chats**, Recently closed is the ↺ on the group
  header, and your chats list newest first. Empty "New Chat" placeholders no
  longer pile up across reloads.
- **Find a chat** appears above the list once you have twenty or more chats.

### Changed — also in this release

- **Scheduled tasks and automations share one table** with one "New task" button.
- **Health you can read.** `vodou-core connections` explains why a connector is
  unhealthy (expired and refreshing, or needs you to reconnect), `vodou-core
  capture` grades browser capture per site, and `vodou-core flows` checks that
  generated context files are still being regenerated.
- **The DALL·E image server is removed.** It is no longer installed or started.
- **One `AGENTS.md` at the install root**, shipped and refreshed with the engine.

### Fixed

- **The nightly contradiction scan finishes** — 323 seconds down to 8 — and runs
  inside the scheduler instead of being killed partway through.
- **Heartbeat runs that returned nothing were timeouts**, not failures; the limit
  is raised and a scheduled run reads current state instead of its own transcript.
- **Three self-repairing database upgrades never ran** on the databases they were
  written to repair. They run now.
- **A fresh gateway database can build its schema again.**

### Known issues

- **Linux and Windows remain untested on real hardware**, and Windows builds are
  unsigned — SmartScreen will warn on first run.

## [0.6.29] - 2026-09-07 — Alpha

A 139-finding readiness audit of the whole codebase, worked to the end. Not a
feature release: this is the one where things that were written but never called,
documented but never true, or measured but never checked got fixed.

### Fixed — things that silently did not work

- **Signal and Teams could not save a conversation at all.** Both appear in the
  channel list and both have working adapters, but the endpoint that records a
  turn rejected them outright, so nothing either one said ever reached your
  memory. They record now.
- **The token meter in chat was permanently hidden.** It asked the wrong address
  for your usage and got nothing back, every time — and an empty meter looks
  exactly like "you have no plan". It reads your real usage now.
- **"Connect messaging" in the setup checklist could never tick.** It checked an
  address that does not exist, so the item stayed unfinished no matter how many
  channels you had connected.
- **The daily database backup could be skipped without telling you.** It gave up
  the instant another part of Vodou was mid-write, and "someone was writing" and
  "the database is damaged" produced the same silent result. It now waits its
  turn.
- **One of the databases grew without limit unless Vodou shut down cleanly.**
  A crash, a forced quit or a power cut left its write-ahead log untrimmed. It is
  now tidied on the same ten-minute cycle as the other one.
- **`clear-progress` did nothing.** It checked that the server existed, then
  printed "not yet implemented" — while the documentation described it as a
  working command. It clears.
- **Memories rebuilt from history lost track of where they came from**, which
  meant they could not be traced back to the conversation that produced them.

### Fixed — safety features that were switched on but not connected

- **Recovering from an interrupted restore.** If the machine died part-way
  through restoring a backup, the routine that finishes the job on the next start
  existed, was documented, and was never called. It runs now, before anything
  opens a database.
- **Cleaning up background processes.** The mechanism that stops Vodou leaving
  orphaned processes behind was built after a real incident and then wired to
  nothing. It is connected, and `/api/system/cli-pool` will now tell you what is
  running and for how long.

### Added

- **See what was captured, read it, and delete it.** Settings → Memory now lists
  the conversations the browser bridge and your imports actually saved, opens any
  one of them, and lets you forget individual memories it produced. The ability
  existed on the server and had no screen.
- **Setup tells you what the assistant can reach on your disk.** Vodou ships with
  whole-machine file access in the main web chat — deliberately, because the
  alternative is an assistant that cannot read your own notes — and nothing had
  ever said so. The wizard now says it plainly, reads it from your actual
  configuration, and tells you the two settings that change it.
- **`mem import openclaw` finds your workspace.** It knew where to look and was
  never asked; it used to demand a path for a folder sitting in the default
  location.

### Changed

- **Error messages stopped blocking the page.** 35 failures that interrupted you
  with a modal dialog are now dismissible notifications.
- **Vodou is more honest about what it has not checked.** Status output separates
  "this is not running" from "this cannot be observed"; a scheduled task that used
  a different tool than it declared now says which one, instead of claiming
  nothing ran; and host integrations that claim to work without evidence are
  labelled unproven rather than stable.
- **All 14 high-severity dependency advisories cleared**, modern API-key formats
  are recognised by the pre-release secret scan, and oversized WebSocket frames
  are rejected.

### Known issues

- **Linux and Windows remain untested on real hardware.** The installers, the
  updater and the release checks are complete in code and have never been run on
  those platforms by anyone. Treat a non-macOS install as unverified rather than
  as working or broken.
- **Windows builds are unsigned** — SmartScreen will warn on first run.
- 434 older chat timestamps are stored in a legacy format. Correcting them is
  blocked on an unrelated database investigation and is deliberately not attempted
  in this release.

## [0.6.28] - 2026-09-04 — Alpha

This release is about the parts of Vodou you meet before you meet Vodou: the
installers, the defaults you get handed, and the checks that decide whether a
build is fit to ship.

### Fixed — installing on Linux and Windows

- **Windows: the one-line installer now works.** It was fetching a setup script
  from May that ended on `pause`, pointed at a file no release has shipped since
  0.5.x, and never registered the service — and even the right script could not
  have worked, because the sources it downloaded carry no Node runtime. The
  PowerShell installer now fetches the complete Windows bundle, checks its
  SHA-256, and refuses to run if the download cannot be verified.
- **Linux: semantic memory was silently off.** The installer wrote a macOS
  library path into your `.env` on every platform, so on Linux the ONNX runtime
  that shipped in your own download was never found. Memory quietly fell back to
  keyword-only search and said so in one word you had to be looking for. It now
  finds the right library on macOS, Linux and Windows, and pins an absolute path
  so the background services can load it too.
- **Installing on a machine without Perl no longer kills the install.** The Node
  download check used a Perl tool that minimal Linux images do not have, and it
  failed the whole install rather than the check.
- **macOS: no more invisible restart loop.** Installing into Desktop, Documents
  or Downloads registered a login item macOS refuses to run, which then retried
  every five seconds forever while the installer printed a checkmark. It now
  explains the situation instead, and verifies the login item actually started.
- **Starting Vodou no longer kills someone else's server.** If something that is
  not Vodou holds port 8765, it is reported and left alone rather than being
  shut down.

### Changed — safer defaults for new installs

- **Messaging channels start closed.** Connecting Telegram, Slack or Discord
  without a sender list used to mean anyone who could reach the bot was treated
  as you, with your tools. New installs now deny unlisted senders by default,
  the console refuses to start a channel that is open to everyone, and the setup
  steps show you how to find your own ID with the door shut. Existing installs
  are unchanged — the default applies to fresh ones only.
- **Only your paired browser extension can drive Vodou.** The local bridge
  accepted a connection from any installed extension. Once you have paired one,
  it is the only one accepted.
- **A damaged database now tells you.** If Vodou's conversation store reports
  corruption, a banner says so immediately instead of messages quietly not being
  saved. Your memory files on disk are a separate store and are not affected.
- **The Vodou-hosted model can no longer be selected on installs that do not
  have it.** It used to accept the choice and fail one message later.

### Fixed — first run

- **No more silent stall on your first search.** The reranking model is fetched
  the first time it is needed, and that download used to happen inside your
  query with nothing on screen — a first search that simply appeared to hang for
  minutes. Vodou now says it is fetching the model, once, and tells you search
  keeps working (keyword and vector) while it does. It also names the two ways
  to avoid the download entirely: a ~150 MB model instead of ~1 GB, or turning
  reranking off.
- **A wrong library path no longer stops indexing entirely.** If the ONNX path
  pointed at a missing file, nothing was indexed at all — not even keyword
  search. It now degrades to keyword search and says why, once.
- **Setup instructions show your actual address.** The in-app integration guides
  hardcoded port 8765 even when your install had moved.
- **One bad request no longer takes down the server.** An error in a single
  route could end the whole gateway, disconnecting chat, memory, channels and
  the scheduler. A failing request now fails by itself.

### Fixed — updates

- **Unsupported platforms are told so.** Asking for an update from a platform
  Vodou does not publish for returned the macOS Intel build; you found out after
  downloading it.

### Security

- Ad-hoc signing and Gatekeeper are now documented, including what to do when
  macOS refuses to open a hand-extracted download. Notarization is planned
  before beta.


### Changed — the console has a new shape
The web console was redesigned around six places instead of twenty-six menu entries.
It is what opens at `http://127.0.0.1:8765/` now. The console you knew is still there
for this one release at `/classic/`, unchanged, on the same gateway and the same data;
it goes away in the next release. If the old look ever seems stuck in your browser after
updating, open `http://127.0.0.1:8765/?reset-sw` once.

- **One navigation that never changes shape.** A rail on the left with Chat, Memory,
  Activity, Skills, Connect, and Settings. It looks the same on every page. Everything
  else is a search away: press ⌘K and type the name of any page, skill, or tool.
- **Your conversations live inside Chat.** The strip of two-letter tabs that used to sit
  above every page is now a list beside the conversation, grouped into Vodou's own runs,
  your chats, and anything you have connected.
- **One status dot.** Bottom of the rail. Green means nothing needs you. Amber or red
  means something does, and clicking it shows what.
- **Connect** brings messaging channels, apps, and MCP servers together. Connected things
  carry a green edge; things waiting to be set up are quiet.
- **Activity opens on History**, so "what did it do while I was away" is the first thing
  you see. The board moved in as a tab.
- **Every screen stretches** to the width of your window. Blue is the default accent; the
  palette you chose still applies, and dark and light both work.
- **Old links keep working.** Every bookmark redirects to the new home of that page. If
  you want the old sidebar back for a while, it is one switch under Settings → Appearance.

### Fixed
- **A brand-new chat no longer opens as a blank column.** It showed nothing until the
  server answered, and for a fresh conversation it never did. Now the starter prompts
  appear at once.
- **Pages load when they are ready, not when every image has.** The console waited for
  the browser's load event before drawing any page but Chat, which on a busy start could
  be fourteen seconds. Pages now draw as soon as the script is ready.
- **The gateway no longer freezes for a second or two every time you switch to a
  conversation it has not warmed up.** It was checking your Claude login synchronously on
  each switch; the answer is now remembered for a minute. Takes effect after a gateway
  restart.
- **Memory days with many extraction runs** showed one chip per run — dozens of identical
  "Run log" pills. They collapse into one chip with a count.
- **Skills rendered white cards on the dark theme.** Several pages referred to colour
  names that no theme defined; they are defined now, so this cannot recur on any page.

### Removed
- **The visual workflow Builder (demo)** is gone from the preview console. Its links land
  on Skills. Building graphs from a sentence is coming through the Skills work instead.


## [0.6.27] - 2026-09-02 — Alpha

A repair release. If you installed 0.6.26 and every command answered
`Not connected to Vodou`, this is the fix — and it was our bug, not yours.

### Fixed
- **A fresh install now actually starts.** 0.6.26 installed cleanly and then refused
  every command, because the published source tree was missing its `.env.example` and
  the installer created your `.env` from it without saying anything when it wasn't
  there. No `.env` meant no account keys — hence `Not connected to Vodou` — and also no
  path to the memory engine's native library, which crashed semantic search with an
  ONNX error that looked like a completely separate problem. One missing file, two
  unrelated-looking symptoms.
- **The installer no longer depends on that file arriving.** It writes a working `.env`
  either way, and tells you plainly if it had to fall back, so a packaging mistake can
  never again be silent.
- **Every bundled app gets set up, not just the ten on a list.** The installer walked a
  hardcoded list of servers that had drifted out of date, so the Kanban board's
  connector shipped without its dependencies and failed on first use — while the
  install reported "0 need attention". It now sets up everything that ships.
- **Windows had the same hole for a different reason** — its installer never created a
  `.env` at all. It does now.
- **A mismatched memory library is replaced instead of trusted.** The installer checked
  only that the file existed, not that it could run on your machine; the wrong build for
  your processor was reported as fine and then crashed. It now checks and re-downloads.

### Changed
- Release packaging verifies that required files are actually **present** in what gets
  published, not only that forbidden ones are absent — the gap that let this ship.
- Recorded test fixtures are no longer published, and the one that existed has been
  scrubbed: it captured a real session and carried personal details with it.

### Known issues
- The Windows package is unsigned, so SmartScreen will warn on first run.


## [0.6.26] - 2026-08-28 — Alpha

### Added
- **Say what you want; see the plan before it runs.** Type a sentence like "research three competitors and put the summary in a doc" and Vodou now shows you a **plan card** — the actual steps, in order, with what runs in parallel — before anything happens. Run it once, edit it, save it as a reusable skill, or schedule it. If the plan misread you, **"Just answer it"** drops the whole thing and answers the question directly.
- **Runs that can stop and ask you something.** A plan can now pause on a real question — an approval, a choice, a missing detail — and wait, instead of guessing and carrying on. The question appears wherever you are: the console, the browser panel, or a chat channel. Answering it resumes the run.
- **A finished run leaves a trace you can search**, phases of one job are grouped as one run rather than four, and the Skill Console shows a skill's own run history.
- **Memory and the brain are one thing now.** The memory graph moved into the console as a single Memory section — one process, one place, no second window on another port.
- **The browser panel can save what you are looking at**, using the same form and the same endpoint as everything else, and it now tells you honestly whether the brain link is connected rather than reporting "no" when it means "don't know".
- **One rules file per AI host, from one source.** Vodou generates the rules file each coding agent reads — Claude, Cursor, Gemini, Copilot, Codex — from a single manual, with a guard that stops them drifting apart.

### Fixed
- **A background job that finishes after the reply now reports back.** When Vodou said "I'll report the exit code when it lands", nothing was left running to do it — the reply ended and the job finished alone. Long jobs now post their result into the conversation on their own, and Vodou no longer promises a follow-up it cannot keep.
- **A plan sent to a chat channel arrived twice**, and the second copy was wrong. A reply meant for an approval gate could reach the model as if it were a new question. Both fixed.
- **One failed branch of a parallel step no longer erases its siblings' results**, and a step that could not start fails on its own instead of taking the whole run down.
- **A declined approval no longer leaves the run marked "running" forever.**
- **Scheduled skills say where their output went.** A run delivered to the console reported "delivered nowhere" — 157 of 191 runs read as lost work that was not lost.
- **An expired login now says it is expired.** A credential that could not be renewed reported itself healthy, and a renewal that kept failing said nothing about why.
- **A scheduled run whose engine went away is finished, and says so** instead of sitting as "running" indefinitely.
- **Memory searches no longer send a whole document where a query belongs** — about fifteen places handed the search engine far more text than it can use.
- **The context a turn actually used survives a page reload**, with a per-turn budget that names anything it had to drop rather than silently dropping it.
- **Two Vodou sessions editing the same files now warn each other.**

### Changed
- The account requirement has a single switch with one definition, enforced at the door every memory route passes, and it is **off** by default.
- Model lists for every provider are current as of this build.

### Known issues
- The Windows build is unsigned — SmartScreen will warn — and is download-only: Windows installs do not auto-update.
- The browser extension updates on the Chrome Web Store's schedule, not this release's.


## [0.6.25] - 2026-08-15 — Alpha

### Fixed
- **Updates finish what they start.** A bundled tool whose folder contained a linked package — the channels integration for Slack, Telegram, WhatsApp and the rest — failed to copy during every update since 0.6.15, and the half-copied folder was left in place. If your channels stopped connecting weeks ago and never recovered, this is why, and this update repairs it.
- **A failed part of an update no longer damages what was already working.** Previously an interrupted copy left that tool broken with no way back. It now restores the previous copy and carries on.
- **The update tells you which part failed.** It used to say only "1 component failed" — the same seven words for seven releases running, naming nothing.
- **Updates stopped claiming to have crashed while they were still working.** Past the ten-minute mark, a perfectly healthy update printed "a previous update may have crashed — consider rolling back" every thirty seconds until it finished. A full update legitimately takes half an hour, so most of one looked like a failure. It now reports what is actually happening.
- **The download shows progress.** It used to pull ~350 MB in total silence with no way to tell a slow connection from a hung one, which is exactly when people interrupt an update that was working. You now see how much has arrived, how fast, and how long is left — and a genuinely stalled download says so instead of waiting forever.
- **The memory-graph brain updates with everything else.** It was excluded from every automatic update since it shipped, so an install that lost it could never get it back.
- **Update fixes now apply to the update that delivers them**, instead of taking effect one release later.
- **Two copies of the app no longer share one database file**, and writes are no longer lost when the database is busy.
- **Database corruption is noticed in minutes rather than days**, and the automatic repair now acts on what it diagnosed instead of discarding it.
- **A scheduled task that never actually runs now says so**, instead of appearing healthy.
- **Switching projects picks up a project you just created** — the switcher used to keep showing the old list.
- **Two Vodou sessions running at once no longer scramble each other's activity log.**

### Added
- **Create or pick a project folder from a browser**, including folders that do not exist yet.
- **The Document Library finds documents by meaning**, not just by name — ask for the thing you remember about a document and it finds it without the title.
- **Add documents by dropping in a whole folder**, and browse anywhere on the filesystem rather than only your home directory.

### Changed
- Model lists for every provider are current as of this build.

### Known issues
- The Windows build is unsigned — SmartScreen will warn — and is download-only: Windows installs do not auto-update.
- Updating **to** this version still runs the previous version's downloader, so that one last update is quiet and may still show the stale "may have crashed" notice. Updates after this one show progress.


## [0.6.24] - 2026-08-14 — Alpha

### Fixed
- **Several bundled tools were installed but invisible.** The task board, the memory-graph brain, the IDE memory server, Gmail and Microsoft 365 all shipped with Vodou but were never registered, so the app could not connect to them, they never appeared under Capabilities, and nothing could call them. They are registered now — on fresh installs *and* when you update an existing one. Gmail and Microsoft 365 arrive switched off until you connect an account.
- **Board tasks that ran forever.** A dispatched task did its work and then had no way to report finishing, so it was reclaimed and started over, indefinitely. Workers can now close out their own tasks.
- **Updates take effect immediately.** Newly registered tools used to stay invisible for up to five minutes after an update while the app was still reading its old list. The list is now refreshed before anything reads it.
- **The Chrome DevTools tool could never start.** It was packaged one directory deeper than the app looked for it — in every release that included it — so it failed on first connection and retried in a loop.
- **Your account token was written to the log in plain text** every time your licence was checked, and stayed there. Tokens are now masked wherever they are logged.
- **Bundled tools now always run on the Node that ships with Vodou**, instead of whatever happened to be on the system. On machines with an older Node, or none, several tools simply failed to start.

### Known issues
- Model lists for Groq, DeepSeek, xAI, Mistral, Together and Kimi are three weeks old in this build; other providers are current.
- The Windows build is unsigned — SmartScreen will warn — and is download-only: Windows installs do not auto-update to this version.


## [0.6.23] - 2026-08-11 — Alpha

### Added
- **The Document Library — your documents become memory.** Add a PDF, Word doc, spreadsheet, slide deck, ebook, CSV or note and Vodou reads it, remembers it, and can hand it to any model on request. Add from a file, a whole folder, a URL, or the page you are looking at in your browser.
- **A library you can actually browse** at `/library` — search, filter by state (broken, un-carded, watched), read the extracted text, open the original, and add new documents with a paste-a-path box that shows live progress on a folder import.
- **Attach a document to any chat with `@doc:<name>`** — in the Vodou console, Slack, Telegram, anywhere. A typo suggests the right document rather than failing silently, and a document too large to attach whole says so and points at the section you want.
- **Vodou knows which document answers a question.** Each document gets a routing card — what it is, what it answers, and what it is *not* about — so "what is our liability cap?" reaches the contract instead of a guess. Documents also surface in ordinary memory search for the first time.
- **The panel tells you when a page relates to something you saved.** Reading a contract template? It points at your own agreement. On an unrelated page it stays quiet — deliberately, because a chip that lights up on everything gets ignored.
- **"Add to Vodou Library" in the browser** — right-click any page, or use the keyboard shortcut for pages that own their right-click menu (Google Docs, Notion). Requires Vodou Bridge 0.5.97.73 or later.

### Changed
- **Documents are chunked as documents.** A bullet in a personal note is a standalone fact; a bullet in a plan is prose. Treating them alike split one plan into 181 fragments; it now produces 50 coherent passages with nothing lost.
- **Document matching is fast.** Looking up which document is relevant went from ~10s to under a second by asking the already-running memory service instead of starting a new one for every question.
- **Contradiction detection reads across documents** — a governing-law clause is compared against other governing-law clauses, not the whole corpus.

### Fixed
- **Two silent text-loss bugs in document import**, both found by reading a stored document rather than trusting a success message: a paragraph-splitting bug dropped 940 bytes of a 9,199-byte passage mid-word, and an oversized first paragraph was never split at all.
- **One reranker per install.** The background service and the command line were quietly using different relevance models, so the same question could score differently depending on which answered it.
- **Pasting a document reference no longer confuses the router.** A message containing only `@doc:something` was being treated as a search query and could trigger unrelated tools.
- Browser capture of Notion and similar pages no longer welds every block into one run-on line, and no longer eats words inside links and buttons.

### Known issues
- Windows remains unsigned — SmartScreen will warn. Treat it as a preview.
- Model lists for six providers (groq, deepseek, xai, mistral, together, kimi) are ~3 weeks old in this build.

## [0.6.21] - 2026-08-07 — Alpha

### Added
- **Attach other apps to your Vodou memory** — each connected client gets its own identity, scope and kill switch, with an audit log of what it actually did and per-client rate limits. Settings → Clients shows every attachment and lets you revoke one.
- **Memory arrives before you finish typing** — the inject lane prefetches while you type.
- Every "install the Bridge" surface in the console now points at the live Chrome Web Store listing.

### Changed
- **Memory injection got quieter and more accurate**: a calibrated relevance floor, paraphrase de-duplication that keeps the richest wording, recency tie-breaks, and silence when Vodou genuinely does not know.

### Fixed
- Operator personal details were scrubbed from shipped surfaces, with a PII gate added to the store packaging step.
- Conflict resolution returned blank HTTP 500s in some cases.
- The Linux and Windows release archives can now actually pass verification.

## [0.6.20] - 2026-08-03 — Alpha
### Added
- **Save your chats on 22 AI sites, not 2.** The in-page Save button worked on ChatGPT and Claude only; it now works on all 22 supported sites (Gemini, AI Studio, Grok, Perplexity, DeepSeek, Copilot, Le Chat, Qwen, Kimi, Z.ai, T3 Chat, OpenRouter, Poe, Meta AI, Manus, You.com, Duck.ai, NotebookLM, HuggingChat, Character.AI). Each was verified against a real conversation by reading the stored text back — words and speakers, not turn counts.
- **Auto-attach memory on send** — opt-in, off by default, per site. Pressing send appends relevant memory to your message and sends it as one prompt. With it on, Vodou acts on your behalf; the panel and privacy policy say so. Your message is never lost if the lookup fails.
- **The Brain** — the memory graph made visible: the stars and how they connect, a Latest view showing the newest memory in context, and a Chronicle that opens a day and what it connects to. Relations now say *how* two names relate, and entities are typed rather than guessed.
- **The capture feed** — every captured conversation across every provider on one wall, with the model that answered and a link back to the original thread.
- **Multi-platform bundles** — macOS (Apple Silicon + Intel), Linux (x64 + arm64) and Windows x64.

### Changed
- **The extension is a side panel, not a popup.** The toolbar icon opens a panel holding the memory picker, activity log and every setting, with per-site toggles for both capture and insert across all 22 sites.
- **One in-page control** instead of two floating buttons — a single mark that fans open into the actions available on that site, reporting progress and results on the button itself.
- Onboarding's browser lane can be acted on: install path, live detection when the extension connects, and proof it captured something.

### Fixed
- Capture quality across every site: seven sites leaked the model's private reasoning into the stored answer (one by 1,045 characters — twice the length of the reply); six stored interface text as speech; three had broken conversation identity, including one where every chat shared an id and each save overwrote the last; four dropped, duplicated or invented turns.
- Imports no longer re-extract the same fact once per monthly file.
- Pasted console output is no longer stored as durable memory.
- Guest memory is scoped to the room's vault, closing a bootstrap leak.

### Known issues
- **Windows is unsigned and untested at runtime.** SmartScreen will warn. Treat it as a preview.
- The Save button reads the messages currently rendered on the page — on very long threads that is what is loaded, not the whole history. Provider exports and the paginating backfill still cover the rest.

## [0.6.18] - 2026-07-15
### Fixed
- Fresh-install Brain console: ship a complete `memory.db` schema template so all views work on a brand-new install.

## [0.6.16] - 2026-07-14
### Added
- **Memory Follows You** — your memory travels into ChatGPT, Claude, and 22+ AI surfaces via the browser extension, plus the `vodou-memory` MCP server for Cursor / VS Code / Claude Desktop.
- **Universal Memory** — capture, import, and export across surfaces; provenance-weighted ranking, contradiction queue, fact-group dedup.
- **Memory Vaults** — segmented sharing with per-chunk overrides.

<!-- Older entries: summarize the user-facing highlights per tag as you publish them. -->
