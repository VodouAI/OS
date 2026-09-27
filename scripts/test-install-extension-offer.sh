#!/usr/bin/env bash
# Proves the installers' "offer the Vodou Bridge to Chrome" step does what it
# says and nothing more. Runs the REAL block from install-prebuilt.sh (extracted,
# not copied) against throwaway HOME folders, so it never touches a real Chrome
# profile. The Windows block cannot run here; its shape is checked statically.
#
#   bash scripts/test-install-extension-offer.sh     # exit 0 = all cases pass
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH="$ROOT/install-prebuilt.sh"
BAT="$ROOT/.build/windows/install.bat"
ID="ehlanbbiaeelnimkakfffehoahimkjjf"
URL="https://clients2.google.com/service/update2/crx"
fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1"; fail=1; }

# The block: from the `_BRIDGE_OFFERED=0` line to the `fi` that closes the
# registration `if`. Extracted from the file so the test drives the shipped code.
BLOCK="$(awk '/^  _BRIDGE_OFFERED=0$/{on=1} on{print} on && /^  fi$/{exit}' "$SH")"
[ -n "$BLOCK" ] || { echo "❌ could not find the offer block in install-prebuilt.sh"; exit 1; }

run_case() { # $1=fake HOME, extra env as further args
  local home="$1"; shift
  env -i PATH="$PATH" HOME="$home" "$@" bash -c "set -e; $BLOCK
echo \"OFFERED=\$_BRIDGE_OFFERED\""
}

echo "── install-prebuilt.sh (runs here: $(uname -s))"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "  (not macOS — the block must do nothing)"
  H="$(mktemp -d)"; mkdir -p "$H/Library/Application Support/Google/Chrome"
  out="$(run_case "$H")"
  [ "$out" = "OFFERED=0" ] && ok "non-macOS: not offered" || bad "non-macOS offered: $out"
  [ ! -e "$H/Library/Application Support/Google/Chrome/External Extensions" ] && ok "non-macOS: nothing written" || bad "non-macOS wrote files"
else
  # 1. A Chrome user: the file appears, with exactly the documented content.
  H="$(mktemp -d)"; mkdir -p "$H/Library/Application Support/Google/Chrome"
  out="$(run_case "$H")"
  F="$H/Library/Application Support/Google/Chrome/External Extensions/$ID.json"
  [ "$out" = "OFFERED=1" ] && ok "Chrome user: offered" || bad "Chrome user not offered: $out"
  if [ -f "$F" ] && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d=={'external_update_url': sys.argv[2]} else 1)" "$F" "$URL"; then
    ok "file is valid JSON with only external_update_url = the Web Store URL"
  else
    bad "file missing or wrong: $(cat "$F" 2>/dev/null)"
  fi
  # 2. Re-running is harmless: same single file, same content.
  run_case "$H" >/dev/null
  n="$(ls "$H/Library/Application Support/Google/Chrome/External Extensions" | wc -l | tr -d ' ')"
  [ "$n" = "1" ] && ok "re-run leaves exactly one file" || bad "re-run left $n files"

  # 3. No Chrome: nothing created — not even Chrome's own folders.
  H="$(mktemp -d)"
  out="$(run_case "$H")"
  [ "$out" = "OFFERED=0" ] && ok "no Chrome: not offered" || bad "no Chrome offered: $out"
  [ ! -e "$H/Library/Application Support/Google" ] && ok "no Chrome: no Chrome folders created" || bad "created Chrome folders for a non-Chrome user"

  # 4. Opt-out is honoured.
  H="$(mktemp -d)"; mkdir -p "$H/Library/Application Support/Google/Chrome"
  out="$(run_case "$H" VODOU_NO_EXTENSION_OFFER=1)"
  [ "$out" = "OFFERED=0" ] && ok "opt-out: not offered" || bad "opt-out ignored: $out"
  [ ! -e "$H/Library/Application Support/Google/Chrome/External Extensions" ] && ok "opt-out: nothing written" || bad "opt-out still wrote"

  # 5. An unwritable Chrome folder must not abort the install (set -e in the installer).
  H="$(mktemp -d)"; mkdir -p "$H/Library/Application Support/Google/Chrome"; chmod 500 "$H/Library/Application Support/Google/Chrome"
  out="$(run_case "$H" 2>&1)"; rc=$?
  chmod 700 "$H/Library/Application Support/Google/Chrome"
  [ $rc -eq 0 ] && [ "$out" = "OFFERED=0" ] && ok "unwritable: install continues, not offered" || bad "unwritable: rc=$rc out=$out"
fi

echo "── .build/windows/install.bat (static)"
grep -q "reg add \"HKCU\\\\Software\\\\Google\\\\Chrome\\\\Extensions\\\\$ID\" /v update_url /t REG_SZ /d \"$URL\"" "$BAT" \
  && ok "per-user key with the Web Store update_url" || bad "reg add line missing or wrong"
grep -q 'if not "%VODOU_NO_EXTENSION_OFFER%"=="1" (' "$BAT" && ok "opt-out guards it" || bad "no opt-out guard"
grep -q 'reg query "HKCU\\Software\\Google\\Chrome" >nul 2>&1' "$BAT" && ok "only when this user has Chrome" || bad "no Chrome-present check"
# Comments may NAME HKLM (explaining Chrome's lookup order); executable lines must not use it.
if grep -vE '^[[:space:]]*REM' "$BAT" | grep -qE 'HKLM|HKEY_LOCAL_MACHINE'; then
  bad "writes machine-wide keys (needs admin)"
else
  ok "never writes machine-wide (admin) keys"
fi

echo
[ $fail -eq 0 ] && echo "✅ extension offer: all cases pass" || echo "❌ extension offer: FAILED"
exit $fail
