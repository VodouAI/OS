#!/usr/bin/env bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-lab}"
# =============================================================================
# broken-lab.sh — the sanctioned place to break Vodou on purpose.
#
# COHERENCE Phase 0. The plan requires every flow walked BROKEN as well as
# healthy, and says where:
#
#   "The broken walks happen in the broken-lab... the sanctioned place where
#    daemon-down, empty-account and expired-auth states are induced on purpose,
#    so nobody yanks power on the live stack."
#
# Without it, every broken-state finding in the register is REASONED — someone
# read the code and concluded what a user would see. That is exactly the habit
# the audit exists to break: F30 was filed because everyone reasoned from
# source instead of watching the wire, and F28's two silent failure paths were
# only confirmed by inducing them.
#
# It also matters that this is not the live stack. Mid-turn kills have caused
# real damage here twice (`gateway-midturn-kill-guard`), and a WAL tear from an
# exit(124) once discarded another session's committed rows. Breaking things to
# learn from them is right; breaking the machine someone is working on is not.
#
# ISOLATION: a temp project root via VODOU_PROJECT_PATH, its own DBs, its own
# socket, a non-default port. The live daemon, worker, gateway and databases are
# never touched — this script contains no call to start/stop-vodou-services.sh
# and never kills a pid it did not spawn.
#
# Usage:
#   scripts/broken-lab.sh                 # every state, one after another
#   scripts/broken-lab.sh daemon-down     # just one
#   scripts/broken-lab.sh --list
#   KEEP=1 scripts/broken-lab.sh          # leave the lab dir for poking at
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/vodou-core"
[ -x "$BIN" ] || BIN="$ROOT/vodou-core"
LAB="${LAB_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/vodou-broken-lab-XXXXXX")}"
PORT="${LAB_PORT:-8791}"
STATES=(healthy daemon-down empty-account unreadable-db no-memory)
# `graph-kill` is NOT in the default sweep: it is the only scenario that boots a
# Node gateway, and the sweep above is deliberately Rust-only and fast. Run it
# by name — `scripts/broken-lab.sh graph-kill`.
EXTRA_STATES=(graph-kill)

hdr() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${STATES[@]}" "${EXTRA_STATES[@]}"; exit 0
fi

# ── The lab ─────────────────────────────────────────────────────────────────
# Hardlink the binary rather than copy: same bytes, no 40MB per run, and the
# build-identity check still reports the file it was loaded from (F14).
# The lab needs REAL MCP servers to stage a real fan — a branch is a tool call —
# but it must keep its own Vodou-Console (that is where gateway.db lives). So
# every server EXCEPT Vodou-Console is symlinked in read-only, and Vodou-Console
# stays the lab's own directory.
link_mcp_servers() {
  mkdir -p "$LAB/MCP-servers/Vodou-Console"
  for d in "$ROOT/MCP-servers"/*/; do
    local name; name="$(basename "$d")"
    [ "$name" = "Vodou-Console" ] && continue
    [ -e "$LAB/MCP-servers/$name" ] || ln -sfn "$d" "$LAB/MCP-servers/$name"
  done
}

setup_lab() {
  mkdir -p "$LAB/.vodou"
  ln "$BIN" "$LAB/vodou-core" 2>/dev/null || cp "$BIN" "$LAB/vodou-core"
  chmod +x "$LAB/vodou-core"
  # The embedder lives beside the binary; without it every memory lane reports
  # a model failure and the broken state under test is not the one induced.
  [ -e "$ROOT/onnxruntime" ] && ln -sfn "$ROOT/onnxruntime" "$LAB/onnxruntime"
  [ -e "$ROOT/models" ] && ln -sfn "$ROOT/models" "$LAB/models"
}

# Every probe runs with the lab as its root. `env -i`-style narrowing is
# deliberate: inheriting VODOU_* from the caller's shell is how a "clean" lab
# silently talks to the live daemon.
lab() {
  env -u VODOU_DAEMON_SOCKET -u VODOU_MEMORY_DB -u VODOU_DB \
      VODOU_PROJECT_PATH="$LAB" WEB_PORT="$PORT" \
      "$LAB/vodou-core" "$@" 2>&1
}

# ── What a person sees, per surface ─────────────────────────────────────────
# The question every broken walk asks is not "did it fail" but "does every
# surface tell me the SAME next step?" — F18/F19's question, and the one three
# surfaces answered three different ways.
probe() {
  local label="$1"; shift
  local out rc
  out="$("$@" </dev/null)"; rc=$?
  printf '  %-22s exit=%-3s %s\n' "$label" "$rc" "$(printf '%s' "$out" | head -2 | tr '\n' ' ' | cut -c1-104)"
}

walk_surfaces() {
  probe "runtime-status"  lab runtime-status
  # The canary: this query has a right answer in every state except no-memory.
  probe "mem search"      lab mem search "flat white" --top-k 2
  probe "flows"           lab flows
  probe "vocab (pure fn)" lab vocab web
  probe "builds"          lab builds
}

# ── The states ──────────────────────────────────────────────────────────────
# EVERY state starts from a known baseline. Without this, the first state that
# stops the daemon leaves it stopped, and every state after it silently reports
# "daemon down" while claiming to test something else — four identical rows that
# look like a finding and are an artefact of the harness. Caught on the first
# real run of this script.
baseline() {
  lab daemon ensure >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8; do
    [ -S "$LAB/.vodou/daemon.sock" ] && break
    sleep 1
  done
  seed_one_memory
}

# ONE known memory, so "I cannot read your memory" and "you have no memory
# about that" stop rendering identically.
#
# Without it, an empty lab answers "No results for 'coffee'" in EVERY state and
# the unreadable-db walk proves nothing — the true answer and the lie are the
# same sentence. This is F27's shape ("saved, nothing worth keeping" vs "saved,
# extraction failed") pointed at the read path, and a lab that cannot tell them
# apart cannot find it.
seed_one_memory() {
  [ -f "$LAB/.vodou/.seeded" ] && return 0
  lab mem store "The lab canary drinks a flat white with oat milk" >/dev/null 2>&1 \
    && touch "$LAB/.vodou/.seeded"
}

stop_daemon() {
  pkill -f "$LAB/vodou-core daemon" 2>/dev/null || true
  sleep 1
  rm -f "$LAB/.vodou/daemon.sock"
}

induce() {
  # daemon-down is the one state whose whole point is the absence of a daemon.
  case "$1" in
    daemon-down) stop_daemon ;;
    *)           baseline ;;
  esac
  case "$1" in
    healthy)
      say "baseline: a working lab. Read the messages below as the CONTROL —"
      say "a broken-state message is only good if it differs from this one."
      ;;
    daemon-down)
      say "no daemon is running, and none is started."
      say "F19's case: three surfaces once gave three different next steps."
      ;;
    empty-account)
      say "no account is configured — the state a stranger is in at minute one."
      rm -f "$LAB/.vodou/account.json" "$LAB/.vodou/auth.json" 2>/dev/null || true
      ;;
    unreadable-db)
      say "the databases exist and cannot be read (permissions, not corruption)."
      say "Distinct from missing: a surface that says 'no memories' here is lying."
      # The daemon must be stopped FIRST, or it answers from a handle it opened
      # while the file was still readable and the permission change is invisible.
      stop_daemon
      for f in memory.db vodou-core.db; do
        [ -f "$LAB/$f" ] && chmod 000 "$LAB/$f" 2>/dev/null || true
      done
      ;;
    no-memory)
      say "a fresh install: everything works, there is simply nothing stored yet."
      say "The state F38 was filed about — 'no memories' must not read as 'broken'."
      stop_daemon
      rm -f "$LAB/memory.db" "$LAB/memory.db-wal" "$LAB/memory.db-shm" "$LAB/.vodou/.seeded"
      baseline
      ;;
  esac
}

# ── H20: does a run survive the gateway being KILLED mid-fan? ───────────────
# PLAN-GRAPH-FRONTEND item 18. `graph-runs.test.ts` covers boot reconcile by
# CONSTRUCTING an interrupted row; that proves the function works, not that a
# real process leaves a row it can read. This kills a live gateway with SIGKILL
# — no drain, no handler, the way a crash actually happens — and then asks the
# NEXT process what it found.
#
# Isolation is the whole point: VODOU_PROJECT_PATH puts gateway.db under the lab
# (db.ts resolves it as PROJECT_ROOT/MCP-servers/Vodou-Console/gateway.db), the
# port is the lab's, and the only pid killed is the one this function spawned.
# Mid-turn kills have damaged the live stack here twice.
GW_SRC="$ROOT/MCP-servers/Vodou-Console"

# Is something ALREADY answering on our port that we did not start?
#
# This cost a whole debugging cycle. `lab_gateway_start` waited for
# /api/health to answer 200 and called that success — but a leftover gateway
# from an EARLIER lab was still holding :8791, so the new one logged "Refusing
# to start a second instance", exited, and the health probe cheerfully passed
# against the stranger. Every request then went to another lab's database, the
# new lab's gateway.db was never created, and the kill test killed a pid that
# had already died. A port probe cannot tell my process from anyone else's —
# the same lesson as `curl-is-not-a-client`.
port_is_taken() {
  curl -sf -m 2 -H "Host: localhost:$PORT" "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
}

lab_gateway_start() {
  mkdir -p "$LAB/MCP-servers/Vodou-Console"
  # The gateway trusts VODOU_PROJECT_PATH **only if that directory already
  # contains vodou-core.db** (db.ts), and it resolves PROJECT_ROOT once at module
  # load. Skipping `baseline` for this walk meant the lab had no vodou-core.db
  # when the gateway booted, so it silently fell back to the REPO root and wrote
  # three graph runs into the LIVE gateway.db — the one thing this script
  # promises never to touch. Seed the file first, and verify afterwards.
  link_mcp_servers
  if [ ! -f "$LAB/vodou-core.db" ]; then
    lab daemon ensure >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8; do [ -f "$LAB/vodou-core.db" ] && break; sleep 1; done
  fi
  if [ ! -f "$LAB/vodou-core.db" ]; then
    say "cannot isolate: no $LAB/vodou-core.db, so the gateway would use the LIVE databases."
    return 1
  fi
  # VODOU_MAX_PROCESSES is raised for the LAB only.
  #
  # The valve counts vodou-core processes MACHINE-WIDE, and the default of 5
  # leaves ~4 usable. The live daemon and worker take two before the lab starts,
  # and the lab's own daemon and worker take two more — so a lab fan was refused
  # before it opened a single branch ("6 vodou-core processes are already
  # running (limit 5)"), and the kill test reported INCONCLUSIVE for a reason
  # that had nothing to do with durability. Raising it here changes nothing
  # about the live stack's own limit.
  # `set -m` puts the gateway in its OWN process group, so its children can be
  # killed as a group.
  #
  # Without it the lab leaked daemons and workers on every run. The lab gateway
  # runs with cwd = the REAL Console directory (it needs node_modules), so the
  # `vodou-core` processes it spawns carry the REPO path in argv, not the lab's
  # — `pkill -f "$LAB/vodou-core"` could never match them, and they were
  # indistinguishable from the live stack's own processes. Five orphans
  # accumulated that way, and the machine-wide process valve then refused the
  # very fan this test exists to interrupt.
  ( set -m
    cd "$GW_SRC" && env VODOU_PROJECT_PATH="$LAB" WEB_PORT="$PORT" \
      VODOU_MAX_PROCESSES="${LAB_MAX_PROCESSES:-24}" \
      VODOU_NO_OPEN_BROWSER=1 node dist/index.js >>"$LAB/gateway.log" 2>&1 &
    echo $! > "$LAB/gw.pid" )
  local pid; pid="$(cat "$LAB/gw.pid" 2>/dev/null || true)"
  for _ in $(seq 1 30); do
    # Our own pid must still be alive. A healthy port with a dead pid means the
    # 200 is coming from somebody else's gateway.
    if ! kill -0 "$pid" 2>/dev/null; then
      if grep -q "Refusing to start a second instance" "$LAB/gateway.log" 2>/dev/null; then
        say "port $PORT is held by a gateway this script did not start."
        say "  Free it (or set LAB_PORT=<other>) — talking to it would test the WRONG database."
      fi
      return 1
    fi
    if port_is_taken; then
      # Isolation is asserted, never assumed. If the gateway created its DB
      # anywhere but the lab, every later reading describes the live system.
      if [ ! -f "$LAB/MCP-servers/Vodou-Console/gateway.db" ]; then
        say "ISOLATION FAILED — the lab gateway did not create $LAB/MCP-servers/Vodou-Console/gateway.db."
        say "  It is writing to the LIVE databases. Stopping before anything else runs."
        lab_gateway_kill
        return 1
      fi
      return 0
    fi
    sleep 1
  done
  return 1
}

lab_gateway_kill() {
  local pid; pid="$(cat "$LAB/gw.pid" 2>/dev/null || true)"
  [ -n "${pid:-}" ] || return 0
  # The GROUP, so the vodou-core children the gateway spawned die with it. The
  # negative pid is the process group started by `set -m` above — still only
  # pids this script created.
  kill -9 -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$LAB/gw.pid"
}

lab_graph_rows() {
  sqlite3 "$LAB/MCP-servers/Vodou-Console/gateway.db" "$1" 2>/dev/null || echo "(query failed)"
}

graph_kill_walk() {
  if [ ! -f "$GW_SRC/dist/index.js" ]; then
    say "SKIPPED — no gateway build at dist/index.js. Run \`npm run build\` in the Console."
    return 0
  fi
  if ! command -v sqlite3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    say "SKIPPED — needs sqlite3 and curl."
    return 0
  fi

  # Precondition: is there room in the machine-wide process valve?
  #
  # `VODOU_MAX_PROCESSES` counts vodou-core processes across the WHOLE machine,
  # and `.env` wins over this script's environment — the gateway rebuilds a fresh
  # env from that file for every child it spawns, so the lab cannot raise its own
  # ceiling. The arithmetic on a normal machine: live daemon + live worker (2),
  # the lab's own daemon + worker (2), a `reconnect-all` (1) — the default limit
  # of 5 is already spent before the fan asks for anything, and even `recipe
  # compile` is refused. Said HERE, once, instead of arriving as a truncated HTTP
  # error that reads like a graph bug.
  local limit have
  limit="$(grep -m1 '^VODOU_MAX_PROCESSES=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
  limit="${limit:-5}"
  have="$(pgrep -f 'vodou-core (daemon|worker) start' 2>/dev/null | wc -l | tr -d ' ')"
  # The lab needs room for its own daemon+worker, a reconnect, a compile and two
  # branches before anything it measures can happen.
  if [ "$((have + 5))" -gt "$limit" ]; then
    say "SKIPPED — not enough process headroom to stage a fan."
    say "  VODOU_MAX_PROCESSES=$limit (from .env, which overrides this script's env)"
    say "  already running: $have   needed for the lab: ~5 more"
    say "  This is a precondition, not a durability result. To run it:"
    say "    · raise VODOU_MAX_PROCESSES in .env (e.g. 24) and restart the daemon, or"
    say "    · run this on a machine where the live stack is not up."
    return 0
  fi

  if port_is_taken; then
    say "ABORTED — something is already serving :$PORT, and it is not ours."
    say "  Proceeding would run the whole test against another instance's database"
    say "  and report its result as this lab's. Free the port or set LAB_PORT."
    return 1
  fi
  say "booting an ISOLATED gateway on :$PORT with its own gateway.db…"
  if ! lab_gateway_start; then
    say "gateway did not come up; last lines of $LAB/gateway.log:"
    tail -5 "$LAB/gateway.log" 2>/dev/null | sed 's/^/      /'
    lab_gateway_kill
    return 1
  fi
  say "up (pid $(cat "$LAB/gw.pid"))"

  # Fire the run, then kill the INSTANT one is in flight.
  #
  # A fixed sleep does not work and hides the failure: the first attempt slept
  # 2s, by which time the fan had finished and the kill landed on a terminal
  # run — the harness reported success having proved nothing. That is the
  # `dead-server-passes-noise-fixtures` shape, so the poll below is the test,
  # and NOT catching a run in flight is a loud INCONCLUSIVE, never a pass.
  # TWO branches, not three. `.env` pins VODOU_MAX_PROCESSES=5 and that file wins
  # over this script's environment, so the lab cannot raise its own ceiling. The
  # live daemon and worker hold two slots; a three-wide fan asked for a sixth and
  # every branch was refused before it started. Two is what fits, and two is
  # enough — H20 is about branches RECORDED before the fan runs, not about width.
  # TOOL branches. Synthesis steps were tried and cannot fan at all: a
  # `together:` block of free text compiles cleanly and then dies in the
  # executor with `call-group together — 0 branches … group spec has no steps`,
  # because the group executor only carries TOOL steps. Worth knowing on its own
  # — the compiler accepts a shape the runner refuses — and it means a real fan
  # needs real servers, which is why `link_mcp_servers` exists above.
  local recipe='together:\n  a: mcp-monitor.get_cpu_info\n  b: mcp-monitor.get_memory_info\n'
  curl -s -m 30 -X POST -H "Host: localhost:$PORT" -H 'Content-Type: application/json' \
    -d "{\"conversationId\":\"lab-graph-kill\",\"recipe\":\"$recipe\"}" \
    "http://127.0.0.1:$PORT/api/graph/run" >"$LAB/run-post.json" 2>&1 &
  local poster=$!

  # Wait for a run that is running AND has BRANCHES REGISTERED (expected > 0).
  #
  # Catching merely `running` fires the instant the row is inserted, before the
  # fan opens — a real interrupted run, but not a mid-FAN one, and H20's claim is
  # specifically that branches recorded before the fan starts survive the crash.
  # `expected > 0` is the moment those records exist and nothing has settled.
  local caught=0 snapshot="" fallback=""
  for _ in $(seq 1 300); do          # up to ~15s, checked every 50ms
    # A string test, not json_extract: the `$` in a JSON path does not survive
    # the trip through this shell intact, and the predicate silently never
    # matched while the run it was looking for sat right there.
    snapshot="$(lab_graph_rows "SELECT outcome || ' ' || counts_json FROM graph_runs WHERE outcome='running' AND instr(counts_json, '\"expected\":0') = 0 LIMIT 1;")"
    if [ -n "$snapshot" ] && [ "$snapshot" != "(query failed)" ]; then caught=1; break; fi
    # Remember that we at least saw a run open, so the message can say which
    # half of the window we missed.
    [ -z "$fallback" ] && fallback="$(lab_graph_rows "SELECT outcome || ' ' || counts_json FROM graph_runs WHERE outcome='running' LIMIT 1;")"
    sleep 0.05
  done

  if [ "$caught" != "1" ]; then
    say "INCONCLUSIVE — never caught a run in flight, so nothing was killed mid-fan."
    say "  This is NOT a pass. The fan finished faster than the poll, or the run"
    say "  never started. POST said: $(head -c 200 "$LAB/run-post.json" 2>/dev/null)"
    [ -n "$fallback" ] && say "  (a run DID open — $fallback — but its branches never registered in the window)"
    if [ ! -f "$LAB/MCP-servers/Vodou-Console/gateway.db" ] \
       || ! lab_graph_rows "SELECT 1 FROM graph_runs LIMIT 1;" >/dev/null 2>&1; then
      say "  (no graph_runs table — it is created on the FIRST run, so none ever started)"
    fi
    kill "$poster" 2>/dev/null || true
    lab_gateway_kill
    return 1
  fi

  say "caught a run in flight: $snapshot"
  say "SIGKILL — no drain, no handler, the way a crash happens"
  lab_gateway_kill
  kill "$poster" 2>/dev/null || true

  say "what the dead process left behind:"
  lab_graph_rows "SELECT outcome, counts_json FROM graph_runs ORDER BY started_at DESC LIMIT 3;" | sed 's/^/      /'
  local orphaned; orphaned="$(lab_graph_rows "SELECT COUNT(*) FROM graph_runs WHERE outcome='running';")"
  say "rows still marked running with no process behind them: $orphaned"

  say "restarting — boot reconcile now has to read that wreckage"
  if ! lab_gateway_start; then
    say "restart FAILED — a crash you cannot restart from is itself the finding."
    tail -5 "$LAB/gateway.log" 2>/dev/null | sed 's/^/      /'
    return 1
  fi
  sleep 1

  say "after reconcile:"
  lab_graph_rows "SELECT outcome, counts_json FROM graph_runs ORDER BY started_at DESC LIMIT 3;" | sed 's/^/      /'
  local still; still="$(lab_graph_rows "SELECT COUNT(*) FROM graph_runs WHERE outcome='running';")"
  grep -i "reconcil\|interrupted" "$LAB/gateway.log" 2>/dev/null | tail -3 | sed 's/^/      /'

  lab_gateway_kill
  if [ "$still" = "0" ]; then
    say "VERDICT: PASS — no run claims to be running after the process that ran it died."
    return 0
  fi
  say "VERDICT: FAIL — $still run(s) still marked running. A run outlived its own process."
  return 1
}

restore() {
  chmod 644 "$LAB/memory.db" "$LAB/vodou-core.db" 2>/dev/null || true
}

# ── Run ─────────────────────────────────────────────────────────────────────
echo "════════════════════════════════════════════════════════════"
echo "  broken-lab → $LAB   (port $PORT)"
echo "  the live stack is NOT touched: no start/stop script runs,"
echo "  no pid this script did not spawn is killed."
echo "════════════════════════════════════════════════════════════"
setup_lab

TARGETS=("${STATES[@]}")
[ "$#" -gt 0 ] && TARGETS=("$@")

for st in "${TARGETS[@]}"; do
  hdr "STATE: $st"
  if [ "$st" = "graph-kill" ]; then
    # No `baseline` here: this walk needs a GATEWAY, not a seeded memory daemon,
    # and starting one spends two of the machine-wide process budget the fan
    # itself needs.
    graph_kill_walk
    restore
    continue
  fi
  induce "$st"
  walk_surfaces
  restore
done

hdr "read the table above like this"
cat <<'NOTE'
  Every row is what a PERSON sees in that state, verbatim.

    · Do two surfaces describe one condition differently?      → a finding.
    · Does a surface exit 0 while reporting a failure?          → F19's class.
    · Does "cannot read" render the same as "nothing stored"?   → a lie.
    · Does a pure function (vocab) break when a DB is down?     → a coupling bug.
NOTE

# Processes are ALWAYS reaped, KEEP or not.
#
# KEEP=1 means "leave the files so I can poke at them" — it never meant "leave a
# daemon and a worker running forever". It did, and the cost is not academic:
# the process valve counts vodou-core processes MACHINE-WIDE, so each kept lab
# permanently spends part of a budget the LIVE stack shares. Three kept labs
# were enough to push the count past the limit, at which point the next run was
# refused with "6 vodou-core processes are already running (limit 5)" — the lab
# had started starving the machine it promises not to touch.
reap_lab_processes() {
  stop_daemon
  lab_gateway_kill
  pkill -f "$LAB/vodou-core" 2>/dev/null || true
  sleep 1
  pkill -9 -f "$LAB/vodou-core" 2>/dev/null || true

  # …and the ones argv cannot identify.
  #
  # The lab gateway spawns its daemon and worker DETACHED (so they outlive a
  # gateway restart), which puts them outside the process group `set -m` created,
  # and it spawns them from the REPO binary — so neither `kill -9 -PGID` nor
  # `pkill -f "$LAB/vodou-core"` matches, and they are indistinguishable from the
  # live stack's own processes in `ps`. Eight of them accumulated across one
  # afternoon's runs. The environment is the only place the lab's identity
  # survives, so that is what is matched here — still only processes carrying
  # THIS lab's path.
  local pid
  for pid in $(ps -E -o pid=,command= 2>/dev/null \
                 | grep -F "VODOU_PROJECT_PATH=$LAB" \
                 | awk '{print $1}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
}
# Also on Ctrl-C or an early `exit`, or an interrupted run leaks the same way.
trap reap_lab_processes EXIT INT TERM

reap_lab_processes
if [ "${KEEP:-}" = "1" ]; then
  echo "  lab files kept at $LAB (its daemon/worker were stopped)"
else
  chmod -R u+w "$LAB" 2>/dev/null || true
  rm -rf "$LAB"
  echo "  lab torn down (KEEP=1 to keep the files)"
fi
