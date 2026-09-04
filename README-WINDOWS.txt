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
- Auto-update: Windows is download-only for now; grab new releases from
  https://github.com/VodouAI/OS/releases

TROUBLESHOOTING
---------------
- "no bundled Node" at logon: the fix is in this build; if you still see it,
  set a User environment variable VODOU_PROJECT_PATH to this folder's path.
- Services not healthy: run  vodou-core.exe service status  from this folder.
