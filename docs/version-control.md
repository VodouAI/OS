# Updating Vodou

Vodou has a safe update system that keeps your installation current without ever touching your data. Your memories, conversations, credentials, custom skills, and workspace are protected — updates only replace application code.

## Quick Start

```bash
# Check if an update is available (no changes made)
./do update --check

# Install the latest binary update
./do update

# Update MCP servers, skills, docs, scripts (interactive menu)
./do update --components

# Go back to the previous version
./do update --rollback
```

---

## How Updates Work

Vodou has two kinds of updates, and your data is protected through both:

### 1. Binary Updates (automatic or manual)
The **`vodou-core`** and **`vodou-hook-bin`** binaries, plus the **`do`** launcher script and its **`oi`**/**`vodou`** symlinks (symlinks, not copies, since P4 — edit **`do`**; nothing needs re-syncing, and a `cp` over the links would recreate the divergent copies they replaced). These are safe to auto-update because shipped bits are replaced as a unit — you do not hand-patch binaries or launchers in place.

### 2. Component Updates (interactive)
MCP servers, skills, docs, scripts. These might contain your customizations, so Vodou downloads the new release and lets **you** pick what to update.

### 3. User Data (never touched)
Your databases, `.env`, custom skills, memory, and `.vodou/` workspace are **never** touched by any update. These are protected by hardcoded safety rules that refuse to overwrite them.

---

## What's Protected

These files are **never** modified by any update:

- **All databases** (`vodou-core.db`, `memory.db`, `gateway.db`, `thinking.db`, `skills_registry.db`)
- **Your `.env`** (API keys, credentials, config)
- **`memory.toml`** (workspace settings)
- **`extractors.toml`** (parameter extraction rules)
- **`skills/my-skills/`** (skills you created)
- **`skills/community/`** (skills you installed)
- **`.vodou/workspace/`** (MEMORY.md, daily memory files, workspace state)
- **`.vodou/agent/`** (autonomous agent inbox)
- **`.vodou/whatsapp-auth/`** (WhatsApp session tokens)

If Vodou ever appears to touch any of these, that's a bug — please report it immediately.

---

## Configuring Auto-Update Behavior

Set `VODOU_AUTO_UPDATE` in your `.env` file to control when updates happen:

```bash
# Never check for updates (fully manual)
VODOU_AUTO_UPDATE=off

# Check every 12h, print banner, but don't install (DEFAULT)
VODOU_AUTO_UPDATE=notify

# Check every 12h, auto-install available updates
VODOU_AUTO_UPDATE=on

# Only auto-install critical security updates
VODOU_AUTO_UPDATE=forced-only
```

Even with `VODOU_AUTO_UPDATE=off`, you can still manually run `./do update` anytime.

---

## CLI Commands

### Check for updates
```bash
./do update --check
```
Checks the update server without installing. Shows current version, latest version, and release notes.

### Install binary updates
```bash
./do update
```
Downloads and installs the latest binary. Takes a full DB snapshot first so you can rollback if anything goes wrong.

**What happens:**
1. Snapshot taken — all 5 DBs backed up to `backups/pre-update-{from}-to-{to}-{timestamp}/`
2. New archive downloaded from GitHub releases
3. SHA256 checksum verified
4. Services stopped in order (gateway → thinking server → daemon)
5. Binaries replaced atomically
6. macOS quarantine attributes stripped
7. Services restarted
8. New binary opens your existing DB and runs any schema migrations (adds new columns to existing rows — never deletes)

### Update MCP servers, skills, docs, scripts

#### From the Gateway (recommended)

The **System → Updates** section on `/#/system` is now the first thing you see on the page. Workflow:

1. **Check Components** button — downloads the latest release archive into `update_staging/` and shows you what's changed
2. **Click any component row** to expand and see the actual file list that will change (not just the count)
3. **Apply Selected** — runs the update with a live progress panel: spinner + elapsed counter + streaming log tail from `.vodou/update.log`
4. On success the page auto-reloads against the freshly-restarted gateway. On failure the panel shows the real error.

Safety nets baked in:

- **Version-skew gate.** The gateway refuses to apply components whose archive version differs from the running binary version. If the archive is newer than your binary, you'll see *"Install the binary update first."* This prevents `v0.5.X+1` `dist/JS` landing on a `v0.5.X` Rust core. (Auto-updater bypasses the gate — it ships matched binary + components from the same archive by definition.)
- **Defensive pre-rsync backups.** Each apply tarballs the current installed state of every selected component to `backups/pre-component-update-{timestamp}/<component>.tar.gz`. Manual restore via `tar -xzf` over the install dir.
- **Auto-restart of impacted services.** After rsync, `start-vodou-services.sh` is spawned in a detached process group to kill + respawn the gateway and any other long-running Node processes. Without this, the gateway runs stale `dist/` from memory until the daemon's self-heal kicks in 5 min later.

#### From the CLI

```bash
./do update --components
```
Opens an interactive menu showing which components have changed. You pick what to update:

```
Component Update — v0.5.37 → v0.5.38

MCP Servers:
  1. [UPDATE]  Vodou-Console      — 47 files changed
  2. [UPDATE]  Vodou-LLM-router      — 12 files changed
  3. [  OK  ]  mcp-monitor         — no changes

Skills:
  4. [UPDATE]  vodou-core (14 skills) — 6 updated, 2 new

Other:
  5. [UPDATE]  docs/               — 4 files changed

Protected (never updated):
  ✓ databases  ✓ .env  ✓ .vodou/  ✓ my-skills  ✓ memory

Select components to update (comma-separated, 'all', or 'none'):
> 1,2,4
```

For scripting, use `--all` (update everything) or `--select=1,2,3` (specific components):

```bash
./do update --components --all
./do update --components --select=1,2
```

### Dry run (see what would change)
```bash
./do update --dry-run
./do update --components --dry-run
```
Simulates the entire update and prints what would change. Writes nothing.

### Rollback
```bash
# Full rollback (binaries + databases)
./do update --rollback

# Only restore databases (keep new binaries)
./do update --rollback-db

# Only restore binaries (keep new databases)
./do update --rollback-binaries

# Rollback to a specific backup
./do update --rollback-from pre-update-0.5.36-to-0.5.37-20260405T120000
```

### Manage backups
```bash
# List all backups with versions and sizes
./do update --list-backups

# Prevent a backup from being auto-pruned
./do update --pin-backup pre-update-0.5.36-to-0.5.37-20260405T120000

# Delete unpinned backups (keep last 1)
./do update --clean-backups
```

### Show version
```bash
./do version
# vodou-core v0.5.38
```

---

## Updates in the Gateway UI

Updates are available in the gateway at **System → Updates** (http://localhost:8765/#/system).

When an update is available, a teal banner appears in the sidebar:

```
● Update v0.5.38 available   Install →
```

The Updates section in System has:
- **Status dot** — green (up-to-date) or amber (update available)
- **[Check Now]** — runs a fresh version check
- **[Install Update]** or **[Install Security Update]** — one-click update with DB snapshot
- **[Rollback]** — restore from most recent backup
- **[Check Components]** — compare installed vs release archive, shows checkbox list
- **[Apply Selected]** — replace only checked components

---

## Backup Retention

Vodou keeps the **last 3 successful** pre-update backups in `backups/`. Older ones are auto-pruned when you run another update.

Each backup contains:
- All 5 databases (`vodou-core.db`, `memory.db`, `gateway.db`, `thinking.db`, `skills_registry.db`)
- **`vodou-core`**, **`vodou-hook-bin`**, and the **`do`** / **`vodou`** launcher scripts (and any other shipped launcher copies) as they were before the update
- `manifest.json` with versions, schema versions, and SHA256 checksums

### Disk usage tips

For users with large memory databases (500+ MB), Vodou automatically uses hardlinks to deduplicate unchanged DBs across snapshots — disk usage only grows when memory actually changes.

If backup size becomes an issue:
```bash
# Check backup size
du -sh backups/

# Clean unpinned backups
./do update --clean-backups

# Or opt out of vector backups (memory.db schema still backed up)
echo "VODOU_BACKUP_MEMORY_VECTORS=false" >> .env
```

---

## FAQ

### Will an update lose my memories?
No. Your memories live in `memory.db` which is never touched by file copy operations. The new binary opens your existing DB and runs schema migrations which only ADD columns — never drop them. All your existing memories remain intact.

### Will an update lose my custom skills?
No. `skills/my-skills/` and `skills/community/` are never touched. Only `skills/vodou-core/`, `skills/agents/`, and `skills/templates/` (which ship with Vodou) can be updated.

### What if an update fails mid-way?
Vodou uses atomic file operations. If an update crashes, the next time you start Vodou, it detects the failed update via a sentinel file and automatically rolls back. Your data is never in a partial state.

### Can I rollback if I don't like the new version?
Yes. Run `./do update --rollback` to restore everything (binaries + databases) to the state before the last update. Your data added since the update will be lost — rollback restores the exact snapshot taken before the update.

### What if I want to keep the new binary but restore my database?
```bash
./do update --rollback-db
```
Restores only the databases, keeps the new binaries. Useful if a new version corrupts data but the new code is otherwise good.

### Do schema migrations break anything?
Migrations in Vodou are **additive only** — they only add new tables and columns, never delete. Existing data gets new columns with default values. Your rows are preserved exactly.

### Can the update process be disabled entirely?
Yes. Set `VODOU_AUTO_UPDATE=off` in `.env`. Background checks will stop. You can still manually run `./do update` anytime.

### What if `app.vodou.ai` is down?
The update check will fail silently (logged but not shown to you). Your current version keeps working. When the server comes back, the next scheduled check will succeed.

### Can I update offline (download the archive manually)?
Yes. Download the latest release from https://github.com/VodouAI/OS/releases, extract it, and run `./install-prebuilt.sh` from the extracted directory. This does a fresh install in the current directory.

### What if I customize an MCP server source file?
Vodou detects user customizations in MCP servers and protects them during component updates. Specifically:
- `config/*.toml` files in MCP servers are rescued and restored after replacement
- Per-server `.env` files are preserved
- User-added MCP server directories (anything not in the release archive) are never deleted

If you're running a heavily customized fork, use `./do update --components` and **skip** that server from the update menu.

### How are binaries verified?
Every downloaded archive has its SHA256 checksum verified against the value returned by the update API. On macOS, quarantine attributes are stripped after download so Gatekeeper doesn't block execution.

### Is the update secure?
The update URL is pinned to `github.com/VodouAI/` — the updater refuses download URLs from any other domain. Archives are SHA256-verified. Code signing for macOS is planned as a future hardening step.

---

## Troubleshooting

### "Another update is already in progress"
Another Vodou process is holding the update lock. Check for stale state:
```bash
ls .update-lock
# If no Vodou process is running but the lock exists:
rm .update-lock
```

### Update check never fires
The 12-hour throttle may not have elapsed. Force a check:
```bash
./do update --check
```

### Update succeeds but gateway doesn't restart
```bash
./start-vodou-services.sh
# Or from the gateway UI: Settings → Environment → Restart gateway, worker & daemon
```

### "Rollback refused: schema version mismatch"
The backup is from a version with a newer DB schema than the target binary can handle. This happens if you manually downgraded the binary beyond the backup's compatibility. Use `./do update --list-backups` to find a compatible one.

### Update appears to hang on a slow connection
Downloads are 250MB. On slow connections this can take several minutes. Set `DEBUG=1` to see progress:
```bash
DEBUG=1 ./do update
```

### "Permission denied" during update
The installation directory isn't writable by your user. Common if you installed via DMG to `/Applications/Vodou/`. Either:
- Reinstall to a user-writable location like `~/vodou`
- Run the update with sudo (not recommended — sudo creates root-owned files which cause problems later)

---

## What Gets Updated

| Path | Updated by |
|---|---|
| `vodou-core` | `./do update` (binary update) |
| `vodou-hook-bin` | `./do update` (binary update) |
| `do`, `vodou`, … (launchers; same bytes) | `./do update` (ships refreshed copies) |
| `MCP-servers/Vodou-Console/` (excluding `.db`) | `./do update --components` |
| `MCP-servers/*/` (all shipped servers) | `./do update --components` |
| `skills/vodou-core/` | `./do update --components` |
| `skills/agents/` | `./do update --components` |
| `skills/templates/` | `./do update --components` |
| `docs/` | `./do update --components` |
| `scripts/` (shipped ones) | `./do update --components` |
| `.claude/settings.json`, `.cursor/` | `./do update --components` |

## What Never Gets Updated

| Path | Why |
|---|---|
| `*.db`, `*.db-wal`, `*.db-shm` | Your data |
| `.env` | Your API keys and config |
| `memory.toml` | Your workspace settings |
| `extractors.toml` | Your parameter rules |
| `skills/my-skills/` | Skills you created |
| `skills/community/` | Skills you installed |
| `.vodou/workspace/` | Your memory, agents, workspace state |
| `.vodou/agent/` | Autonomous agent queue |
| `.vodou/whatsapp-auth/` | WhatsApp session tokens |
| User-added MCP servers not in the release | Your custom integrations |
| `backups/` | Your snapshots |

---

## Related Documents

- `docs/cli-reference.md` — Complete CLI reference
- `docs-DEV/auto-update-system.md` — Technical details for developers
- `docs-DEV/RELEASE-PROCESS.md` — How new releases are cut (developer guide)
