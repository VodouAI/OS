@echo off
REM Vodou Windows installer — delegates to the Rust service runner.
REM Everything ships prebuilt; this just wires auto-start and boots the stack.
setlocal
set "VODOU_PROJECT_PATH=%~dp0"
REM strip trailing backslash
if "%VODOU_PROJECT_PATH:~-1%"=="\" set "VODOU_PROJECT_PATH=%VODOU_PROJECT_PATH:~0,-1%"
cd /d "%VODOU_PROJECT_PATH%"

echo == Vodou install (%VODOU_PROJECT_PATH%) ==
if not exist "vodou-core.exe" (
  echo ERROR: vodou-core.exe not found. Extract the full release zip first.
  exit /b 1
)

REM -- configuration -------------------------------------------------------
REM Windows had the same hole that broke v0.6.26 on macOS: nothing here created
REM .env, and the engine only writes one during an UPDATE, never a fresh install.
REM No .env means no VODOU_TOKEN (the account gate refuses every command) and no
REM ORT_DYLIB_PATH (ort dlopens a bare onnxruntime.dll and PANICS). The bash
REM installer was fixed for this; the Windows lane runs install.bat instead, so
REM it needs the same guarantee rather than inheriting it.
set "VODOU_FRESH_INSTALL=0"
if not exist ".env" set "VODOU_FRESH_INSTALL=1"
if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo    Created .env from .env.example
  ) else (
    echo VODOU_TOKEN=> ".env"
    echo VODOU_USER_ID=>> ".env"
    echo VODOU_PROJECT_PATH=%VODOU_PROJECT_PATH%>> ".env"
    for /r "%VODOU_PROJECT_PATH%\onnxruntime" %%D in (onnxruntime.dll) do (
      if exist "%%D" echo ORT_DYLIB_PATH=%%D>> ".env"
    )
    echo    WARNING: .env.example missing from this package - wrote a minimal .env.
    echo             This is a packaging bug, not something you did. Add your
    echo             VODOU_TOKEN and VODOU_USER_ID to .env - get them at
    echo             https://app.vodou.ai
  )
)

REM SEC-5 (ALPHA-READINESS §9 A) — a fresh install is fail-CLOSED on channels.
REM Unset, an unconfigured channel treats every sender as the owner; on Telegram
REM that is anyone on the internet. Matches install-prebuilt.sh: new installs
REM only, so nothing live changes posture underneath its operator.
if "%VODOU_FRESH_INSTALL%"=="1" (
  findstr /B /C:"VODOU_CHANNEL_ALLOWLIST_ENFORCE=" .env >nul 2>&1
  if errorlevel 1 (
    echo.>> .env
    echo # Fresh install: channels are fail-CLOSED. Remove to restore allow-all.>> .env
    echo VODOU_CHANNEL_ALLOWLIST_ENFORCE=1>> .env
    echo    Channels fail-closed ^(new install^)
  )
)

echo -- registering auto-start (scheduled task, runs at logon) --
vodou-core.exe service install

echo -- starting services --
vodou-core.exe service start

echo.
echo Done. Web UI: http://localhost:8765
echo Commands:  do.cmd "hello"    vodou-core.exe service ^<start^|stop^|status^>
endlocal
