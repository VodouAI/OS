#!/usr/bin/env bash
# vodou-doctor.sh — full Vodou health audit + structured report.
#
# Run when something feels off, before reporting an issue, or after a fresh
# install to confirm everything is wired up. Captures every check + raw
# output to a single timestamped markdown file under .vodou/doctor/, and
# prints a one-line summary to stdout.
#
# Pure bash + tools that ship with macOS (perl, sqlite3, curl). The bundled
# Node at .node/node is preferred for JSON parsing; python3 is never required.
#
# Usage:
#   bash scripts/vodou-doctor.sh           # run all checks, write report
#   bash scripts/vodou-doctor.sh --quick   # skip slow checks (memory loop, MCP roundtrip)
#   VODOU_DOCTOR_NO_REPORT=1 bash scripts/vodou-doctor.sh   # stdout only

set -u

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT" || { echo "ERROR: cannot cd to $PROJECT_ROOT" >&2; exit 1; }

VODOU_DIR="$PROJECT_ROOT/.vodou"
DOCTOR_DIR="$VODOU_DIR/doctor"
mkdir -p "$DOCTOR_DIR" 2>/dev/null || true

TS=$(date -u +'%Y-%m-%dT%H-%M-%SZ')
REPORT="$DOCTOR_DIR/vodou-doctor-$TS.md"
[ -n "${VODOU_DOCTOR_NO_REPORT:-}" ] && REPORT=/dev/null

PASS_COUNT=0; WARN_COUNT=0; FAIL_COUNT=0
SECTION_NAME=""

# Bundled-runtime preference. Bundled Node ships with every release; bundled
# sqlite3 + perl come with macOS. Fall through gracefully if absent.
NODE_BIN="${NODE_BIN:-$PROJECT_ROOT/.node/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"

VODOU_BIN="$PROJECT_ROOT/vodou-core"
HOOK_BIN="$PROJECT_ROOT/vodou-hook-bin"

# ─────────────────────────────────────────────────────────────────────────────
# Report helpers — every check writes one line + optional collapsible detail
# ─────────────────────────────────────────────────────────────────────────────

# Initialize the report
{
  echo "# Vodou Doctor Report"
  echo ""
  echo "_Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')_  "
  echo "_Project: \`$PROJECT_ROOT\`_  "
  echo "_Mode: $([ $QUICK -eq 1 ] && echo 'quick' || echo 'full')_"
  echo ""
  echo "**If something is broken, paste this entire file when reporting the issue.**"
  echo ""
  echo "---"
  echo ""
} > "$REPORT" 2>/dev/null || true

section() {
  SECTION_NAME="$1"
  {
    echo ""
    echo "## $1"
    echo ""
  } >> "$REPORT" 2>/dev/null || true
  printf "\n\033[1m▸ %s\033[0m\n" "$1" >&2
}

# pass/warn/fail report a single check + write a markdown row.
# Args: status="pass|warn|fail"  label="..."  detail="..." (optional, multi-line OK)
record() {
  local status="$1" label="$2" detail="${3:-}"
  local icon
  case "$status" in
    pass) icon="✅"; PASS_COUNT=$((PASS_COUNT+1));;
    warn) icon="⚠️ "; WARN_COUNT=$((WARN_COUNT+1));;
    fail) icon="❌"; FAIL_COUNT=$((FAIL_COUNT+1));;
    *)    icon="•"; ;;
  esac
  printf "  %s %s\n" "$icon" "$label" >&2
  {
    echo "- $icon **$label**"
    if [ -n "$detail" ]; then
      echo "  <details><summary>output</summary>"
      echo ""
      echo '  ```'
      printf '%s\n' "$detail" | sed 's/^/  /'
      echo '  ```'
      echo "  </details>"
    fi
  } >> "$REPORT" 2>/dev/null || true
}

pass() { record pass "$1" "${2:-}"; }
warn() { record warn "$1" "${2:-}"; }
fail() { record fail "$1" "${2:-}"; }

# Run a command with timeout, capture combined output, return exit code.
run_capture() {
  local timeout_s="$1"; shift
  local out
  if command -v timeout >/dev/null 2>&1; then
    out=$(timeout "$timeout_s" "$@" 2>&1); local rc=$?
  elif command -v gtimeout >/dev/null 2>&1; then
    out=$(gtimeout "$timeout_s" "$@" 2>&1); local rc=$?
  else
    out=$("$@" 2>&1); local rc=$?
  fi
  printf '%s' "$out"
  return $rc
}

# JSON read helper: prefer bundled Node, fall back to grep/sed regex.
json_field() {
  local json="$1" path="$2" default="${3:-}"
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
    printf '%s' "$json" | "$NODE_BIN" -e "
let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
  try { let o=JSON.parse(s); for (const k of '$path'.split('.')) o = o?.[k];
        process.stdout.write(o == null ? '$default' : String(o)); }
  catch { process.stdout.write('$default'); }
});" 2>/dev/null
  else
    printf '%s' "$json" | sed -n "s/.*\"$(basename "$path")\"[[:space:]]*:[[:space:]]*\"\\?\\([^,\"}]*\\).*/\\1/p" | head -1 | sed "s/^$/$default/"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Checks
# ─────────────────────────────────────────────────────────────────────────────

# ── 1. ENVIRONMENT SNAPSHOT ─────────────────────────────────────────────────
check_environment() {
  section "1. Environment"
  pass "OS" "$(uname -srm)"
  pass "Project root" "$PROJECT_ROOT"
  pass "Bundled Node" "${NODE_BIN:-not found}: $($NODE_BIN --version 2>/dev/null || echo 'n/a')"
  if command -v sqlite3 >/dev/null 2>&1; then
    pass "sqlite3" "$(sqlite3 --version | head -1)"
  else
    fail "sqlite3 missing — required for DB checks"
  fi
  if command -v perl >/dev/null 2>&1; then
    pass "perl" "$(perl -v 2>/dev/null | grep -m1 'This is perl' || echo present)"
  else
    warn "perl missing — millisecond timing falls back to seconds"
  fi
  command -v python3 >/dev/null 2>&1 && pass "python3 (optional)" "$(python3 --version)" || warn "python3 not present (optional — graceful fallbacks active)"

  # Resource snapshot — best-effort, never fails the report
  if command -v vm_stat >/dev/null 2>&1; then
    local mem; mem=$(vm_stat 2>/dev/null | head -5 | tr '\n' ' ')
    pass "Memory snapshot" "$mem"
  fi
  if command -v df >/dev/null 2>&1; then
    pass "Disk usage" "$(df -h "$PROJECT_ROOT" 2>/dev/null | tail -1)"
  fi

  # Fail fast: this combo breaks per-prompt Cursor context refresh.
  # - VODOU_GATEWAY_AUTO_ENSURE=0 disables daemon/worker ensure loops.
  # - VODOU_HOOK_SKIP_ENSURE=1 prevents hooks from ensuring daemon on submit.
  # Together, .cursor_context.json can go stale between prompts.
  local env_file="$PROJECT_ROOT/.env"
  local gw_auto="(unset)" hook_skip="(unset)"
  if [ -f "$env_file" ]; then
    gw_auto=$(grep -m1 '^VODOU_GATEWAY_AUTO_ENSURE=' "$env_file" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
    hook_skip=$(grep -m1 '^VODOU_HOOK_SKIP_ENSURE=' "$env_file" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
    [ -z "$gw_auto" ] && gw_auto="(unset)"
    [ -z "$hook_skip" ] && hook_skip="(unset)"
  fi
  if [ "$gw_auto" = "0" ] && [ "$hook_skip" = "1" ]; then
    fail "Env safety gate: VODOU_GATEWAY_AUTO_ENSURE=0 + VODOU_HOOK_SKIP_ENSURE=1" \
         "This disables both daemon auto-ensure paths and causes stale .vodou/workspace/.cursor_context.json on prompt submit. Fix: set VODOU_GATEWAY_AUTO_ENSURE=1 and/or VODOU_HOOK_SKIP_ENSURE=0."
  else
    pass "Env safety gate (hook/daemon ensure combo)" \
         "VODOU_GATEWAY_AUTO_ENSURE=$gw_auto, VODOU_HOOK_SKIP_ENSURE=$hook_skip"
  fi
}

# ── 2. BINARIES & ARCH ──────────────────────────────────────────────────────
check_binaries() {
  section "2. Binaries"
  for bin in "$VODOU_BIN" "$HOOK_BIN" "$PROJECT_ROOT/oi"; do
    local name; name=$(basename "$bin")
    if [ -x "$bin" ]; then
      pass "$name present + executable" "$(file "$bin" 2>/dev/null | head -1)"
    else
      fail "$name missing or not executable" "looked at $bin"
    fi
  done
  if [ -x "$VODOU_BIN" ]; then
    local v; v=$("$VODOU_BIN" version 2>/dev/null | head -1)
    [ -n "$v" ] && pass "vodou-core version" "$v" || fail "vodou-core version produced no output"
  fi
}

# Resolve canonical DB path: prefer .vodou/, fall back to project root.
resolve_db() {
  local name="$1"
  # Pick the largest non-empty match — leftover 0-byte stub files in .vodou/
  # from prior installs would otherwise shadow the real DB at project root.
  local best="" best_size=0
  for p in "$VODOU_DIR/$name" "$PROJECT_ROOT/$name"; do
    if [ -f "$p" ]; then
      local sz; sz=$(wc -c < "$p" | tr -d ' ')
      if [ "$sz" -gt "$best_size" ] 2>/dev/null; then
        best="$p"; best_size="$sz"
      fi
    fi
  done
  [ -n "$best" ] && { echo "$best"; return 0; }
  return 1
}

# ── 3. DAEMON HEALTH ────────────────────────────────────────────────────────
check_daemon() {
  section "3. Daemon"
  local sock="$VODOU_DIR/daemon.sock"
  if [ -S "$sock" ]; then
    pass "Daemon socket present" "$sock"
  else
    fail "Daemon socket missing" "expected at $sock — run: ./vodou-hook-bin ensure"
  fi
  local lock="$VODOU_DIR/daemon.lock"
  if [ -f "$lock" ]; then
    local age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || echo 0) ))
    pass "Daemon lock age" "${age}s old"
  fi
  # Pid via lsof on the socket — best-effort
  if command -v lsof >/dev/null 2>&1 && [ -S "$sock" ]; then
    local pid; pid=$(lsof -t "$sock" 2>/dev/null | head -1)
    [ -n "$pid" ] && pass "Daemon PID listening on socket" "$pid" || warn "No PID found on socket (cleanup pending?)"
  fi
  # System log tail
  if [ -f "$VODOU_DIR/system.log" ]; then
    local tail; tail=$(tail -20 "$VODOU_DIR/system.log" 2>/dev/null)
    pass "system.log readable (last 20 lines captured)" "$tail"
  fi
}

# ── 4. DATABASES ────────────────────────────────────────────────────────────
check_databases() {
  section "4. Databases"
  command -v sqlite3 >/dev/null 2>&1 || { warn "sqlite3 missing — skipping DB checks"; return; }
  CORE_DB="$(resolve_db vodou-core.db)" || true
  MEM_DB="$(resolve_db memory.db)" || true
  GW_DB=""
  for p in "$PROJECT_ROOT/MCP-servers/Vodou-Console/gateway.db" "$VODOU_DIR/gateway.db"; do
    [ -f "$p" ] && { GW_DB="$p"; break; }
  done

  for entry in "vodou-core.db|$CORE_DB" "memory.db|$MEM_DB" "gateway.db|$GW_DB"; do
    local db_name="${entry%%|*}" db_path="${entry##*|}"
    if [ -z "$db_path" ] || [ ! -f "$db_path" ]; then
      warn "$db_name not found" "checked .vodou/ and project root (created on first daemon run)"
      continue
    fi
    local integ; integ=$(sqlite3 "$db_path" "PRAGMA integrity_check;" 2>&1 | head -1)
    if [ "$integ" = "ok" ]; then
      pass "$db_name integrity ok ($db_path)"
    else
      fail "$db_name integrity FAILED" "$integ"
    fi
  done

  if [ -n "$CORE_DB" ] && [ -f "$CORE_DB" ]; then
    local tables; tables=$(sqlite3 "$CORE_DB" ".tables" 2>/dev/null)
    for t in mcp_servers tools intent_mappings scheduled_tasks; do
      printf '%s' "$tables" | grep -qw "$t" && pass "table: $t" || fail "table missing: $t"
    done
    local cols; cols=$(sqlite3 "$CORE_DB" "PRAGMA table_info(mcp_servers);" 2>/dev/null | cut -d'|' -f2 | tr '\n' ' ')
    printf '%s' "$cols" | grep -qw "lifecycle_type" \
      && pass "mcp_servers.lifecycle_type column" \
      || fail "mcp_servers.lifecycle_type missing — gateway /api/servers will 500"
  fi
}

# ── 5. GATEWAY ──────────────────────────────────────────────────────────────
check_gateway() {
  section "5. Gateway"
  local port="${WEB_PORT:-8765}"
  if ! command -v lsof >/dev/null 2>&1 || ! lsof -ti ":$port" >/dev/null 2>&1; then
    fail "Gateway not listening on $port" "run: bash start-vodou-services.sh"
    return
  fi
  pass "Gateway port $port listening"
  local health; health=$(curl -s --max-time 5 "http://localhost:$port/health" 2>&1)
  printf '%s' "$health" | grep -qE '"?status"?' && pass "/health responds" "$health" || fail "/health no status field" "$health"
  local sys; sys=$(curl -s --max-time 5 "http://localhost:$port/api/system" 2>&1)
  if [ -n "$sys" ]; then
    # /api/system uses "version" (canonical); legacy shells used "oiVersion"
    local ver; ver=$(json_field "$sys" "version" "")
    if [ -z "$ver" ] || [ "$ver" = "unknown" ] || [ "$ver" = "null" ]; then
      ver=$(json_field "$sys" "oiVersion" "unknown")
    fi
    case "$ver" in
      v0.0.0-unknown|unknown|""|null)
        fail "/api/system reports version=$ver — vodou-core version timed out or failed (run ./vodou-core version from project root), or gateway dist is stale (re-run install-prebuilt.sh)." "$ver" ;;
      *)
        pass "/api/system reports version" "$ver" ;;
    esac
  else
    fail "/api/system no response"
  fi
  local tools; tools=$(curl -s --max-time 5 "http://localhost:$port/api/tools" 2>&1)
  if [ -n "$tools" ]; then
    local count; count=$(json_field "$tools" "count" "0")
    [ "$count" -ge 50 ] 2>/dev/null && pass "/api/tools count" "$count" || warn "/api/tools low count" "$count"
  else
    fail "/api/tools no response"
  fi
  local servers; servers=$(curl -s --max-time 5 "http://localhost:$port/api/servers" 2>&1)
  # Check for an `"error":` PROPERTY (key followed by colon), not the literal
  # substring — `worst_server_health` is allowed to take "error" as a value.
  if printf '%s' "$servers" | grep -qE '"error"[[:space:]]*:'; then
    fail "/api/servers errored" "$servers"
  elif [ -n "$servers" ]; then
    pass "/api/servers responds"
  else
    fail "/api/servers no response"
  fi
}

# ── 6. MCP SERVERS ──────────────────────────────────────────────────────────
check_mcp_servers() {
  section "6. MCP Servers"
  command -v sqlite3 >/dev/null 2>&1 || { warn "sqlite3 missing — skipping"; return; }
  local db; db="$(resolve_db vodou-core.db)" || { warn "vodou-core.db missing"; return; }
  # QA-B8 (2026-08-27): a never-configured connector is not a critical failure.
  # 12 catalog servers (asana, linear, notion, stripe, zoho, …) answered
  # `unhealthy` and drowned the report — every one of them a REMOTE server
  # (connection_config carries a url) with no credential: headers null and no
  # server_credentials row. That is "not set up", a warn. `active=0` is
  # "switched off", also a warn. `fail` is reserved for a server that IS
  # configured and still does not answer — the only case a person must act on.
  local rows; rows=$(sqlite3 "$db" \
    "SELECT s.name, COALESCE(s.health_status,'unknown'), COALESCE(s.active,1),
            CASE WHEN COALESCE(s.connection_config,'') LIKE '%\"url\"%' THEN 1 ELSE 0 END,
            CASE WHEN COALESCE(s.connection_config,'') LIKE '%\"headers\":null%' THEN 0 ELSE 1 END,
            (SELECT COUNT(*) FROM server_credentials c WHERE c.server_id = s.id),
            COALESCE((SELECT MAX(CAST(c.expires_at AS INTEGER)) FROM server_credentials c
                       WHERE c.server_id = s.id AND c.credential_type = 'oauth_access_token'), 0),
            COALESCE((SELECT c.refresh_last_error FROM server_credentials c
                       WHERE c.server_id = s.id AND c.credential_type = 'oauth_access_token'
                         AND c.refresh_last_error IS NOT NULL AND c.refresh_last_error != ''
                       LIMIT 1), '')
       FROM mcp_servers s ORDER By s.name;" 2>/dev/null)
  local now_epoch; now_epoch=$(date +%s)
  local expired_list="" expired_detail=""
  local total; total=$(printf '%s' "$rows" | grep -c .)
  pass "Registered MCP servers" "$total"
  # Use process substitution (not a pipe) so pass/warn/fail run in the
  # current shell and update PASS_COUNT/WARN_COUNT/FAIL_COUNT correctly.
  while IFS='|' read -r name status active remote has_headers creds exp refresh_err; do
    [ -z "$name" ] && continue
    case "$status" in
      ok|healthy|connected) pass "  $name" "status=$status";;
      unhealthy|error|failed)
        if [ "${active:-1}" = "0" ]; then
          warn "  $name" "status=$status — disabled (active=0), not graded"
        elif [ "${remote:-0}" = "1" ] && [ "${has_headers:-1}" = "0" ] && [ "${creds:-0}" = "0" ]; then
          warn "  $name" "status=$status — remote server with no credential configured; connect it in Settings → Integrations or ignore"
        elif [ "${exp:-0}" -gt 0 ] && [ "${exp}" -lt "$now_epoch" ]; then
          # One condition, one action, one row (below) — nine of these in a
          # row is what buried the report. The 2026-08-27 read: every
          # configured-but-unhealthy connector held an OAuth token that expired
          # between May and June and was never refreshed.
          expired_list="${expired_list:+$expired_list, }$name"
          expired_detail="${expired_detail}${name}: ${refresh_err:-no auto-renew attempt recorded (missing refresh token or client_id)}"$'\n'
        else
          fail "  $name" "status=$status"
        fi;;
      *) warn "  $name" "status=$status";;
    esac
  done < <(printf '%s\n' "$rows")
  if [ -n "$expired_list" ]; then
    # The web console renders only this label (it runs with
    # VODOU_DOCTOR_NO_REPORT=1), so the names go on the line — a person
    # reading "re-authorize in Settings" needs to know WHICH tiles to click.
    # The per-server reason (daemon oauth-sweep's refresh_last_error) is the
    # detail: on 2026-09-02 all six were "refresh token encrypted with a key
    # this install no longer has", i.e. reconnect is the only remedy.
    fail "OAuth access token EXPIRED, auto-renew failed: $expired_list — reconnect each in Settings → Integrations" "$expired_detail"
  fi
}

# ── 7. WORKSPACE & TEMPLATES ────────────────────────────────────────────────
check_workspace() {
  section "7. Workspace & Templates"
  local ws="$VODOU_DIR/workspace"
  for f in MEMORY.md USER.md IDENTITY.md AGENTS.md SOUL.md TOOLS.md; do
    if [ -f "$ws/$f" ]; then
      local sz; sz=$(wc -c < "$ws/$f" | tr -d ' ')
      pass "$f present (${sz}b)"
    else
      warn "$f missing at $ws/$f"
    fi
  done
  # memory.toml
  if [ -f "$PROJECT_ROOT/memory.toml" ]; then
    local provider; provider=$(grep -m1 '^provider' "$PROJECT_ROOT/memory.toml" | sed 's/.*= *"\([^"]*\)".*/\1/')
    pass "memory.toml provider" "$provider"
  else
    warn "memory.toml missing at project root"
  fi
}

# ── 8. HOOK ROUNDTRIP ───────────────────────────────────────────────────────
check_hook_roundtrip() {
  section "8. Hook Roundtrip"
  [ -x "$HOOK_BIN" ] || { fail "vodou-hook-bin missing"; return; }
  local resp
  resp=$(printf '{"prompt":"vodou doctor synthetic probe"}' | run_capture 5 "$HOOK_BIN" sock prompt)
  local rc=$?
  if [ $rc -eq 0 ] && [ -n "$resp" ]; then
    local len=${#resp}
    pass "vodou-hook-bin sock prompt" "rc=$rc, ${len} bytes returned"
  else
    fail "vodou-hook-bin sock prompt failed" "rc=$rc, output: $resp"
  fi
  # Also exercise context. v0.5.64 invalidates the cache when it claims
  # [missing] for files that exist; if the report STILL shows [missing] for
  # files we know are on disk, the hook binary itself is stale (auto-updater
  # didn't swap it) — guide the user to a full reinstall.
  local ctx; ctx=$(run_capture 5 "$HOOK_BIN" context 2>&1)
  if printf '%s' "$ctx" | grep -q '\[MEMORY\.md: missing\]' \
     && [ -f "$VODOU_DIR/workspace/MEMORY.md" ]; then
    fail "vodou-hook-bin context still reports [missing] for files that exist — hook binary is older than v0.5.64. Reinstall: ./install-prebuilt.sh from a fresh archive extract." \
         "first 300 chars: $(printf '%s' "$ctx" | head -c 300)"
  elif printf '%s' "$ctx" | grep -q '\[missing\]'; then
    warn "vodou-hook-bin context shows [missing] for some files — workspace seed may be incomplete" \
         "first 300 chars: $(printf '%s' "$ctx" | head -c 300)"
  elif [ -n "$ctx" ]; then
    pass "vodou-hook-bin context returns content" "$(printf '%s' "$ctx" | head -c 200)..."
  else
    fail "vodou-hook-bin context produced no output"
  fi
}

# Detect whether the daemon is running in FTS-only mode (vector pipeline
# disabled). Returns "vector", "fts-only", or "unknown" via stdout.
#
# Three signals, in order of authority:
#   1. .env: ORT_DYLIB_PATH unset → search.rs:256 forces FTS-only
#   2. system.log: explicit "embeddings warmup failed" since the last
#      "model warmup complete" line means the warmup never succeeded
#   3. system.log: explicit "model warmup complete" with no failure markers
#      after it → vector path is live
#   4. system.log: the newest "[mem-search] … used_fts_only=…" stat line, when
#      it is newer than both warmup markers (they rotate out; it doesn't)
detect_recall_mode() {
  if [ -f "$PROJECT_ROOT/.env" ]; then
    if ! grep -qE '^ORT_DYLIB_PATH=.+' "$PROJECT_ROOT/.env"; then
      echo "fts-only"; return
    fi
  fi
  local log="$VODOU_DIR/system.log"
  if [ -f "$log" ]; then
    # Find the line numbers of the most recent warmup-failure vs the most
    # recent warmup-complete in the whole file. Whichever has the higher
    # line number reflects the current daemon's state.
    local last_fail; last_fail=$(grep -nE 'embeddings warmup failed|reranker warmup failed|mutex lock failed' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
    local last_ok;   last_ok=$(grep -nE 'model warmup complete' "$log" 2>/dev/null | tail -1 | cut -d: -f1)
    # 4. system.log: the per-query stat line (search.rs log_search_stats) is
    #    written on EVERY search and says which path ran: used_fts_only=false
    #    means the embed + vector path actually executed. It outlives the
    #    warmup line — system.log rotates at ~5MB keeping the last ~1MB, so on
    #    a daemon that has been up for days the warmup outcome is gone and
    #    this check answered "unknown (recent restart?)" for a healthy vector
    #    pipeline (seen 2026-09-02). Newest evidence wins.
    local last_search; last_search=$(grep -nE '^\[mem-search\] .*used_fts_only=' "$log" 2>/dev/null | tail -1)
    local last_search_ln="${last_search%%:*}"
    if [ -n "$last_search_ln" ] && [ "${last_fail:-0}" -lt "$last_search_ln" ] && [ "${last_ok:-0}" -lt "$last_search_ln" ]; then
      case "$last_search" in
        *used_fts_only=false*) echo "vector"; return;;
        *used_fts_only=true*)  echo "fts-only"; return;;
      esac
    fi
    if [ -n "$last_fail" ] && { [ -z "$last_ok" ] || [ "$last_fail" -gt "$last_ok" ]; }; then
      echo "fts-only"; return
    fi
    if [ -n "$last_ok" ]; then
      echo "vector"; return
    fi
  fi
  echo "unknown"
}

# ── 9. MEMORY PIPELINE ──────────────────────────────────────────────────────
check_memory_pipeline() {
  section "9. Memory Pipeline"
  if [ $QUICK -eq 1 ]; then
    warn "Skipped (--quick mode)"
    return
  fi
  # If the daemon socket isn't there, recall has zero chance of working.
  # Fail with a clear pointer instead of running 10 doomed queries.
  if [ ! -S "$VODOU_DIR/daemon.sock" ]; then
    fail "Memory pipeline skipped — daemon socket missing. Run: ./vodou-hook-bin ensure  (then restart this doctor)"
    return
  fi

  # Detect recall mode and adjust pass thresholds. FTS-only mode legitimately
  # scores lower on conceptual queries than the vector + RRF + reranker path,
  # so the same 80%/50% thresholds would produce false fails on memory-
  # constrained VMs where ONNX warmup couldn't initialize.
  local mode; mode=$(detect_recall_mode)
  local pass_threshold=80 warn_threshold=50 mode_note=""
  case "$mode" in
    fts-only)
      pass_threshold=40; warn_threshold=20
      mode_note=" (FTS-only mode — vector pipeline disabled; thresholds relaxed)"
      warn "Recall mode: FTS-only" "Vector embeddings unavailable. Likely causes: ONNX warmup failed (memory pressure on small VMs?), or ORT_DYLIB_PATH not set in .env. Conceptual/paraphrased queries will recall worse than keyword-overlap queries. Check .vodou/system.log for 'embeddings warmup failed'." ;;
    vector)
      pass "Recall mode: vector + reranker (full pipeline)" ;;
    unknown)
      warn "Recall mode: unknown — system.log shows neither a warmup outcome nor a [mem-search] stat line yet (recent restart, or no query since?)" ;;
  esac

  if [ -x "scripts/smoke-memory.sh" ] || [ -f "scripts/smoke-memory.sh" ]; then
    local out; out=$(run_capture 90 bash scripts/smoke-memory.sh 2>&1)
    local hit_line; hit_line=$(printf '%s' "$out" | grep -m1 "with >=1 memory")
    local pct; pct=$(printf '%s' "$hit_line" | sed -n 's/.*(\([0-9]*\)%).*/\1/p')
    if [ -n "$pct" ] && [ "$pct" -ge "$pass_threshold" ] 2>/dev/null; then
      pass "Memory recall ${pct}% hit rate${mode_note}" "$out"
    elif [ -n "$pct" ] && [ "$pct" -ge "$warn_threshold" ] 2>/dev/null; then
      warn "Memory recall low (${pct}%, threshold ${pass_threshold}%${mode_note})" "$out"
    else
      fail "Memory recall under ${warn_threshold}% — extraction or recall is broken${mode_note}" "$out"
    fi

  # Gateway extractor health — read .vodou/extractor.log JSONL tail
  local ext_log="$VODOU_DIR/extractor.log"
  if [ -f "$ext_log" ]; then
    local cycles_24h; cycles_24h=$(wc -l < "$ext_log" | tr -d ' ')
    local last_line; last_line=$(tail -1 "$ext_log" 2>/dev/null)
    if [ -n "$last_line" ]; then
      pass "Gateway extractor cycles logged" "total=$cycles_24h, last=$last_line"
    fi
  else
    warn "Gateway extractor log empty — daemon not yet run a cycle, or extraction not triggered"
  fi
  else
    warn "smoke-memory.sh not found — pipeline check skipped"
  fi
}

# ── 10. CHANNELS ────────────────────────────────────────────────────────────
check_channels() {
  section "10. Channels"
  # There is no `channels` table in gateway.db — nothing in the tree creates
  # one, so the old check reported "none configured yet" while Slack and
  # Telegram were answering inbound (2026-09-02). Channel state belongs to the
  # Vodou-channels server; the gateway serves it at /api/channels/status
  # (connected = the adapter is live, standalone PID liveness overlaid). When
  # the gateway is down, the standalone supervisor's state file plus a PID
  # liveness probe is the same evidence the gateway would have used.
  local port="${WEB_PORT:-8765}"
  local json; json=$(curl -s --max-time 8 "http://localhost:$port/api/channels/status" 2>/dev/null)
  if printf '%s' "$json" | grep -q '"statuses"' && command -v perl >/dev/null 2>&1; then
    local connected="" configured_down=""
    while IFS='|' read -r ch conn has_token; do
      [ -z "$ch" ] && continue
      if [ "$conn" = "true" ]; then
        connected="${connected:+$connected, }$ch"
      elif [ "$has_token" = "1" ]; then
        configured_down="${configured_down:+$configured_down, }$ch"
      fi
    done < <(printf '%s' "$json" | perl -ne 'while (/\{"channel":"([^"]+)","connected":(true|false)(.*?)(?=\{"channel":|\]\})/g) { my ($n,$c,$m) = ($1,$2,$3); my $t = ($m =~ /"hasToken":true/) ? 1 : 0; print "$n|$c|$t\n"; }')
    if [ -n "$connected" ]; then
      pass "Channels connected: $connected" "$json"
    else
      warn "No channel connected (none configured yet, or every adapter is down)" "$json"
    fi
    [ -n "$configured_down" ] && warn "  configured but not connected: $configured_down" "$json"
    return
  fi
  # Gateway unreachable (or perl missing): grade the standalone supervisor's
  # state file by PID liveness instead of guessing.
  local state="$VODOU_DIR/workspace/channels-standalone.json"
  if [ ! -f "$state" ]; then
    warn "Channel status unavailable — gateway /api/channels/status did not answer and no standalone state at $state"
    return
  fi
  local alive="" dead=""
  while IFS='|' read -r ch pid; do
    [ -z "$ch" ] && continue
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      alive="${alive:+$alive, }$ch (pid $pid)"
    else
      dead="${dead:+$dead, }$ch (pid ${pid:-?} gone)"
    fi
  done < <(perl -ne 'while (/"([a-z0-9_-]+)":\{"pid":(\d+)/g) { print "$1|$2\n"; }' "$state" 2>/dev/null)
  [ -n "$alive" ] && pass "Standalone channels alive: $alive" "$(cat "$state")"
  [ -n "$dead" ]  && warn "Standalone channels with a dead PID: $dead — restart via Channels → Standalone" "$(cat "$state")"
  [ -z "$alive$dead" ] && warn "No standalone channels recorded in $state (none configured yet)"
}

# ── 11. UPDATE API REACHABILITY ─────────────────────────────────────────────
check_update_api() {
  section "11. Update API"
  local cur_ver="0.0.0"
  if [ -x "$VODOU_BIN" ]; then
    # Use `version` subcommand — clap default --version is disabled.
    local raw; raw=$("$VODOU_BIN" version 2>/dev/null | head -1)
    cur_ver=$(printf '%s' "$raw" | sed -n 's/.*v\?\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1)
    [ -z "$cur_ver" ] && cur_ver="0.0.0"
  fi
  local r; r=$(curl -s --max-time 8 \
    "https://app.vodou.ai/api/version/check?version=$cur_ver&platform=macos-arm64&architecture=arm64&user_id=doctor" 2>&1)
  if [ -z "$r" ]; then
    fail "Update API unreachable" "no response from app.vodou.ai"
  elif printf '%s' "$r" | grep -q '"latest_version"'; then
    local latest; latest=$(json_field "$r" "data.latest_version" "?")
    pass "Update API reachable" "current=$cur_ver, latest=$latest"
  else
    fail "Update API returned unexpected payload" "$r"
  fi
}

# ── 12. IDE HOOKS ───────────────────────────────────────────────────────────
check_ide_hooks() {
  section "12. IDE Hooks"
  if [ -f "$PROJECT_ROOT/.claude/settings.json" ]; then
    grep -q "vodou-hook-bin" "$PROJECT_ROOT/.claude/settings.json" 2>/dev/null \
      && pass ".claude/settings.json wired to vodou-hook-bin" \
      || warn ".claude/settings.json present but missing vodou-hook-bin"
  else
    warn ".claude/settings.json not configured"
  fi
  if [ -f "$PROJECT_ROOT/.cursor/hooks.json" ]; then
    grep -q "vodou-hook-bin" "$PROJECT_ROOT/.cursor/hooks.json" 2>/dev/null \
      && pass ".cursor/hooks.json wired to vodou-hook-bin" \
      || warn ".cursor/hooks.json present but missing vodou-hook-bin"
  else
    warn ".cursor/hooks.json not configured"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Run all
# ─────────────────────────────────────────────────────────────────────────────

START=$(date +%s)
check_environment
check_binaries
check_daemon
check_databases
check_gateway
check_mcp_servers
check_workspace
check_hook_roundtrip
check_memory_pipeline
check_channels
check_update_api
check_ide_hooks
END=$(date +%s)
DURATION=$((END-START))

# Summary
{
  echo ""
  echo "---"
  echo ""
  echo "## Summary"
  echo ""
  echo "| Status | Count |"
  echo "|--------|-------|"
  echo "| ✅ Pass | $PASS_COUNT |"
  echo "| ⚠️ Warn | $WARN_COUNT |"
  echo "| ❌ Fail | $FAIL_COUNT |"
  echo "| ⏱  Duration | ${DURATION}s |"
  echo ""
  if [ $FAIL_COUNT -gt 0 ]; then
    echo "**❌ $FAIL_COUNT critical failure(s) — paste this report when reporting the issue.**"
  elif [ $WARN_COUNT -gt 0 ]; then
    echo "_⚠️ $WARN_COUNT warning(s) — usually safe but worth noting._"
  else
    echo "_✅ All checks green._"
  fi
} >> "$REPORT" 2>/dev/null || true

# Stdout summary
echo ""
printf "Doctor: \033[32m%d ✅\033[0m · \033[33m%d ⚠️\033[0m · \033[31m%d ❌\033[0m  (%ds)\n" \
  "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$DURATION"
[ "$REPORT" != "/dev/null" ] && echo "Report: $REPORT"

# Exit non-zero if anything failed (so CI / scheduled runs flag regressions)
[ $FAIL_COUNT -eq 0 ]
