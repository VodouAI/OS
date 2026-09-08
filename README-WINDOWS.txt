Vodou for Windows
=================

QUICK START
-----------
1. You've already extracted this folder (the "Vodou" folder).
2. Double-click  install.bat
   - Registers auto-start (a scheduled task that runs at logon)
   - Starts the daemon, worker, and web gateway
3. Your browser opens http://localhost:8765 with the setup wizard.
   Pick an AI provider there (Claude CLI recommended — the wizard shows the
   exact PowerShell install command).

DAILY USE
---------
  Web UI:            http://localhost:8765
  Ask something:     do.cmd "summarize my day"     (or vodou.cmd / oi.cmd)
  Service control:   vodou-core.exe service start
                     vodou-core.exe service stop
                     vodou-core.exe service status

CLAUDE CLI (recommended AI provider)
------------------------------------
In PowerShell:
    irm https://claude.ai/install.ps1 | iex
Then OPEN A NEW PowerShell window (so PATH refreshes) and run:
    claude
to sign in with your Claude Pro/Max account. The setup wizard walks you
through this too.

NOTES
-----
- This is an UNSIGNED beta. Windows SmartScreen may warn on first run —
  choose "More info" -> "Run anyway".
- iMessage and macOS screen control are not available on Windows (they're
  macOS-only features).
- Auto-update: the updater DOES run on Windows. This note used to say
  "download-only for now" (RC-14) and that was simply wrong — there is no
  Windows gate anywhere in the update path: it validates PE binaries, stops
  services with taskkill /T /F, swaps vodou-core.exe and vodou-hook-bin.exe,
  and replaces the bundled node.exe and the .cmd launchers.
  What is true is that NO ONE HAS EVER RUN IT ON WINDOWS. Every one of those
  paths was written and read, never executed on this platform. So until a
  Windows box has done it at least once, treat it as untested rather than
  broken or fine: copy this folder before you let it update, and if a swap
  goes wrong, re-extract a fresh release over the top from
  https://github.com/VodouAI/OS/releases — your data lives in .vodou\ and the
  .db files, which an extract does not touch.

TROUBLESHOOTING
---------------
- "no bundled Node" at logon: the fix is in this build; if you still see it,
  set a User environment variable VODOU_PROJECT_PATH to this folder's path.
- Services not healthy: run  vodou-core.exe service status  from this folder.
