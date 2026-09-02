#!/usr/bin/env bash
# Does the smoke detector detect smoke?
#
# entrypoint-guard's whole value is precision. SEAMS §45 measured why: of the
# thirteen files containing the word `nohup`, FOUR are prose. A guard that
# fires on an echo, a docstring or a comment gets VODOU_SKIP_-ed within a week,
# and a skipped guard enforces nothing. So the negative cases below matter as
# much as the positive ones — arguably more.
#
# Each case stages real content in a THROWAWAY repo and asserts the exit code,
# so this never touches the working tree's index.
#
# Run: scripts/test-entrypoint-guard.sh
set -u
GUARD="$(cd "$(dirname "$0")" && pwd)/entrypoint-guard.py"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0

# run_case NAME EXIT PATH CONTENT   (the file is staged executable when .sh)
run_case() {
  local name="$1" want="$2" path="$3" content="$4"
  local tmp; tmp="$(mktemp -d)"
  git -C "$tmp" init -q 2>/dev/null
  mkdir -p "$tmp/$(dirname "$path")"
  printf '%s\n' "$content" > "$tmp/$path"
  # Executable ONLY when it really would be: a .sh, or a file with a shebang.
  # The first draft chmod +x'd everything, which made a plain .ts module look
  # like an entrypoint and failed a case the guard had answered correctly.
  # A harness that lies about the world tests the harness, not the guard.
  case "$path" in *.sh|*.bash|*.command) chmod +x "$tmp/$path" ;; esac
  head -c 2 "$tmp/$path" | grep -q '#!' && chmod +x "$tmp/$path"
  git -C "$tmp" add -f "$path" 2>/dev/null
  local out rc
  # From the real repo, so stacks.toml is the REAL registry; diff from sandbox.
  out="$(cd "$REPO" && GIT_DIR="$tmp/.git" GIT_WORK_TREE="$tmp" python3 "$GUARD" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then
    printf '  ok    %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL  %s (exit %s, wanted %s)\n%s\n' "$name" "$rc" "$want" "$out"; fail=$((fail+1))
  fi
  rm -rf "$tmp"
}

echo "entrypoint-guard:"

# ── it fires ────────────────────────────────────────────────────────────────
run_case "blocks a new undeclared nohup launcher" 1 \
  "scripts/start-thing.sh" '#!/bin/bash
nohup node thing.js > /tmp/thing.log 2>&1 &'

run_case "blocks an undeclared launchd registration" 1 \
  "scripts/install-thing.sh" '#!/bin/bash
launchctl bootstrap "gui/$(id -u)" "$PLIST"'

run_case "blocks an undeclared detached spawn" 1 \
  "scripts/spawn-thing.sh" '#!/usr/bin/env node
spawn(bin, args, { detached: true, stdio: "ignore" }).unref();'

# ── it stays quiet, which is the harder half ────────────────────────────────
# All four of these are REAL shapes from the tree (SEAMS §45). Every one would
# have been a false positive for a guard that grepped the word.
run_case "allows nohup ECHOED as an instruction to a human" 0 \
  "scripts/advice.sh" '#!/bin/bash
echo "    scp probe.sh ec2:  &&  nohup ./probe.sh &"'

run_case "allows nohup inside a python docstring" 0 \
  "scripts/gate.py" '#!/usr/bin/env python3
"""Steps:
   3. nohup ./vodou-hook-bin sock flush >/dev/null 2>&1 &
"""'

run_case "allows nohup in a TS comment" 0 \
  "MCP-servers/Vodou-Console/src/thing.ts" '// for any still-alive pid the reply named (`nohup ... &`, a detached build).'

run_case "allows nohup in a shell comment" 0 \
  "scripts/noted.sh" '#!/bin/bash
# which launches daemon/worker via `nohup ... &`. These run in the foreground'

# ── the declared path is the point ──────────────────────────────────────────
run_case "allows a launcher that IS declared in stacks.toml" 0 \
  "scripts/swap-binary.sh" '#!/bin/bash
nohup ./vodou-core daemon ensure </dev/null >/dev/null 2>&1 & disown'

# ── module code is governed by processes.toml, not this guard ───────────────
run_case "ignores a spawn inside module code of a declared process" 0 \
  "MCP-servers/Vodou-Console/src/api/llamacpp.ts" \
  'const child = spawn(bin, args, { detached: true, stdio: "ignore" });'

run_case "ignores documentation" 0 \
  "integrations/channel-email/README.md" 'Run `nohup ./server.js &` to start it.'

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
