# CLI entrypoints (`do`, `vodou`)

## Canonical name: `./do`

Use **`./do`** in documentation and tutorials. It is the short launcher for **Vodou** (orchestration — “do things”).

## Launcher files, same bytes (no symlinks)

The repo ships **`do`** as the script you edit. Additional launchers are **plain-file copies** of **`do`** (not symlinks) so zip/tar and Windows installs behave reliably.

| File | Role |
|------|------|
| **`do`** | **Source of truth** — edit this file when changing launcher behavior. |
| **`vodou`** | Usual copy of `do` — same bytes; convenient when you want the product name on the command line. ⚠️ Distinct from the **global `vodou`** on your `PATH` (`~/.local/bin/vodou` → `bin/vodou-cli`), which is the interactive agentic TUI — see [vodou-cli.md](vodou-cli.md). |
| **`oi`** | Legacy-named copy of **`do`** (same bytes). Prefer **`./do`** in new docs; keep **`oi`** on disk for older scripts and muscle memory. |
| *(other filenames)* | Some bundles ship extra byte-identical copies for backward compatibility; treat them like **`vodou`**. |

After changing **`do`**, refresh copies:

```bash
bash scripts/sync-cli-launchers.sh
```

## Project root discovery

The script walks up from **`$PWD`** for a directory containing **`vodou-core`** (or **`vodou-core.exe`**) **and** at least one launcher script (**`do`**, **`vodou`**, or another shipped copy from the table above).

## Direct binary

**`./vodou-core …`** bypasses the launcher (no worker fast-path / brain sugar unless you replicate it).

## Hook binary (IDE) — not a launcher

**`./vodou-hook-bin`** is a **separate** small binary for **Cursor / Claude Code hooks** and socket diagnostics (`cursor-session`, `sock prompt`, `sock flush`, `ensure`, `context`, etc.). It is **not** a substitute for **`./do`**: you do not migrate hook configs from **`oi`** to **`do`** here — hooks call **`vodou-hook-bin`** directly.

For setup and behavior, see [claude-code-hooks.md](claude-code-hooks.md) and [cli-reference.md](cli-reference.md) (hook / flush sections).

## Related

- [PLAN-DO-CLI-ENTRYPOINT-DOCS.md](../PLANS/0.5.73/PLAN-DO-CLI-ENTRYPOINT-DOCS.md) — doc sweep + release rules  
- [cli-reference.md](cli-reference.md) — prefer **`./do`** in examples  
