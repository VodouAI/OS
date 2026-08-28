#!/usr/bin/env bash
# Does the smoke detector detect smoke?
#
# A guard nobody tests is a guard that quietly stops firing after a refactor,
# and the first evidence is the defect it was meant to prevent shipping again.
# Each case below stages real content in a THROWAWAY repo and asserts the exit
# code, so this never touches the working tree's index.
#
# Run: scripts/test-coherence-guard.sh
set -u
GUARD="$(cd "$(dirname "$0")" && pwd)/coherence-guard.py"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
pass=0; fail=0

# The sandbox is hermetic: GIT_DIR points at it, so the guard's `git grep` for
# a column's schema and its writers searches ONLY what this case stages. That
# is deliberate — a Rule 9 case has to control both halves ("this column is
# ours" and "nothing writes it") and cannot if it inherits the real repo.
#
# run_case NAME EXIT PATH CONTENT [PATH CONTENT ...]
run_case() {  # name  expected_exit  then path/content pairs
  local name="$1" want="$2"; shift 2
  local tmp; tmp="$(mktemp -d)"
  git -C "$tmp" init -q 2>/dev/null
  while [ "$#" -ge 2 ]; do
    mkdir -p "$tmp/$(dirname "$1")"
    printf '%s\n' "$2" > "$tmp/$1"
    git -C "$tmp" add -f "$1" 2>/dev/null
    shift 2
  done
  # Run from the real repo so the schema/writer greps see real code, but read
  # the staged diff from the sandbox.
  local out rc
  out="$(cd "$REPO" && GIT_DIR="$tmp/.git" GIT_WORK_TREE="$tmp" python3 "$GUARD" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then
    printf '  ok    %s\n' "$name"; pass=$((pass+1))
  else
    printf '  FAIL  %s (exit %s, wanted %s)\n%s\n' "$name" "$rc" "$want" "$out"; fail=$((fail+1))
  fi
  rm -rf "$tmp"
}

echo "coherence-guard:"

run_case "Rule 7 blocks a raw scope reaching the eye" 1 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "el.textContent = chunk.chunk_scope;"

run_case "Rule 7 allows the sanctioned scope_label path" 0 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "el.textContent = chunk.scope_label;"

run_case "Rule 7 allows a comparison that renders human words" 0 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "el.textContent = data.scope === 'memory' ? 'Memory' : 'The web';"

# F10 itself: a column in OUR schema, displayed, that no code maintains.
run_case "Rule 7 allows a scope used as a ternary CONDITION" 0 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "el.textContent = state.scope ? \`from \${V.scopeLabel(state.scope)}\` : '';"

run_case "Rule 7 still catches a leak on a line that also translates" 1 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "el.textContent = V.scopeLabel(a.scope) + ' (' + b.chunk_scope + ')';"

run_case "Rule 9 blocks a counter in our schema that nothing writes" 1 \
  "migrations/090_widgets.sql" "CREATE TABLE widgets (id INTEGER, widget_count INTEGER DEFAULT 0);" \
  "MCP-servers/Vodou-Console/public/js/views/x.js" "el.textContent = \`\${row.widget_count} runs\`;"

run_case "Rule 9 allows the same counter once something writes it" 0 \
  "migrations/090_widgets.sql" "CREATE TABLE widgets (id INTEGER, widget_count INTEGER DEFAULT 0);" \
  "src/widgets.rs" "conn.execute(\"UPDATE widgets SET widget_count = widget_count + 1\", [])?;" \
  "MCP-servers/Vodou-Console/public/js/views/x.js" "el.textContent = \`\${row.widget_count} runs\`;"

run_case "Rule 9 ignores a number off someone else's payload" 0 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" "el.textContent = \`\${model.comment_count} comments\`;"

# NOTE the directory. `contract_nearby()` reads the WORKING TREE, not the
# staged content, because that is where a sibling module actually lives — so
# this case must name a directory that genuinely has no contract. Pointing it
# at public/two/ tests nothing: two.js declares PANEL_MAX right there, which is
# the whole reason F43 was a false finding.
run_case "Rule 5 blocks framing our own surface with no width contract" 1 \
  "MCP-servers/Vodou-Console/public/nowidth/x.html" \
  "<iframe id=\"pane-frame\" title=\"Vodou console\"></iframe>"

run_case "Rule 5 allows a frame that declares one" 0 \
  "MCP-servers/Vodou-Console/public/two/x.html" \
  "<style>#pane-frame { min-width: 720px; }</style>
<iframe id=\"pane-frame\" title=\"Vodou console\"></iframe>"

# F43, as a test: the contract lived in a sibling module and the rule could not
# see it, so a correct frame was reported as a defect and filed as a finding.
run_case "Rule 5 sees a width contract in a sibling module" 0 \
  "MCP-servers/Vodou-Console/public/two/x.js" "const PANEL_MAX = 560; const framesPanes = () => window.innerWidth > PANEL_MAX;" \
  "MCP-servers/Vodou-Console/public/two/x.html" "<iframe id=\"pane-frame\" title=\"Vodou console\"></iframe>"

run_case "Rule 5 still fires when NO sibling declares one" 1 \
  "MCP-servers/Vodou-Console/public/lonely/x.js" "const nothing = 1;" \
  "MCP-servers/Vodou-Console/public/lonely/x.html" "<iframe id=\"pane-frame\" title=\"Vodou console\"></iframe>"

run_case "Rule 5 ignores an API blob — a PDF is not a surface" 0 \
  "MCP-servers/Vodou-Console/public/library/x.html" \
  "<iframe class=\"pdf\" src=\"/api/library/3/raw\"></iframe>"

run_case "the escape hatch is honoured" 0 \
  "MCP-servers/Vodou-Console/public/js/views/x.js" \
  "// COHERENCE-INTENTIONAL: the atlas debug view exists to show raw taxonomy
el.textContent = chunk.chunk_scope;"

run_case "an unguarded tree is not policed" 0 \
  "MCP-servers/ExecDesk-Console/public/js/x.js" \
  "el.textContent = chunk.chunk_scope;"

printf '\n  %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
