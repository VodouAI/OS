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
STATES=(healthy daemon-down empty-account unreadable-db no-memory cycle-stall)
# `graph-kill` and `route-storm` are NOT in the default sweep: they are the only
# scenarios that boot a Node gateway, and the sweep above is deliberately
# Rust-only and fast. Run them by name — `scripts/broken-lab.sh route-storm`.
EXTRA_STATES=(graph-kill route-storm bridge-rogue file-access capture-drift revoked-bearer)

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
    cycle-stall)
      # PLAN-LOOPS-THAT-READ-THE-RECEIPTS P0b — the two exits nobody else has.
      #
      # A bounded cycle can end five ways and two of them are the point: NO
      # PROGRESS (the check failed and the lap produced byte-identical output,
      # so another lap cannot help) and BLIND (the check answered `unknown`
      # twice, which is not a failure and must never be reported as one).
      #
      # This state seeds a skill whose loop cannot converge, so a person can
      # read what each surface says about a loop that gave up. The assertion
      # the plan asks for: the no-progress exit writes `blocked` with reason
      # `stalled`, and the blind exit writes `partial` with `unknown` — never
      # laundered into a verdict.
      say "a bounded cycle that cannot converge: the loop gives up and must SAY which way."
      say "no-progress ends blocked/stalled; blind ends partial/unknown. Two words, two meanings."
      mkdir -p "$LAB/skills/my-skills/cycle-stall-lab"
      cat > "$LAB/skills/my-skills/cycle-stall-lab/actions.json" <<'STALL'
{
  "schema_version": "1.2",
  "initial_steps": [
    {
      "id": "cycle",
      "kind": "cycle",
      "until": { "rule": "the draft cites a source that does not exist", "check": "has_source" },
      "max_laps": 4,
      "budget": { "runtime_seconds": 60 },
      "body": [
        { "id": "draft", "prompt": "Reply with exactly the word STALL and nothing else." }
      ]
    }
  ],
  "stopping_points": [{ "type": "terminal", "title": "Run complete" }]
}
STALL
      say "seeded skills/my-skills/cycle-stall-lab — run it and read the exit."
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
  # Use the PINNED runtime, the way the real launcher does
  # (`start-vodou-services.sh:754` → `$VODOU_DIR/.node/node`). The gateway
  # hard-refuses any major but 24, and a developer shell very often has
  # something else first on PATH — this machine has v22.22.3 — so a bare `node`
  # made the lab's only gateway-booting scenario die on the version gate before
  # it ever reached the thing under test. Fall back to PATH so the lab still
  # runs on an install with no bundled runtime.
  local GW_NODE="$ROOT/.node/node"
  [ -x "$GW_NODE" ] || GW_NODE="node"
  say "node: $("$GW_NODE" --version 2>/dev/null || echo unknown) ($GW_NODE)"
  # LAB_EXTRA_ENV lets a walk vary one setting and boot again — the only honest
  # way to prove a surface REPORTS its configuration rather than restating a
  # default it was written next to.
  ( set -m
    cd "$GW_SRC" && env VODOU_PROJECT_PATH="$LAB" WEB_PORT="$PORT" \
      VODOU_MAX_PROCESSES="${LAB_MAX_PROCESSES:-24}" \
      VODOU_NO_OPEN_BROWSER=1 ${LAB_EXTRA_ENV:-} "$GW_NODE" dist/index.js >>"$LAB/gateway.log" 2>&1 &
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


# ── route-storm ─────────────────────────────────────────────────────────────
# ALPHA-READINESS §9.2 row 11 — the GW-11 / CO-2 proof.
#
# The claim: with `.vodou/` read-only, hitting the async Express routes with bad
# input answers the caller and leaves the gateway serving. Both halves matter
# and they were fixed separately:
#
#   GW-11  `unhandledRejection` no longer calls `process.exit(1)`. Before, ONE
#          EACCES from ONE route took down chat, memory, channels, the
#          scheduler and every WebSocket client.
#   CO-2   `catchAsyncRouteFaults` turns the rejection into `next(err)` so the
#          terminal middleware answers 500. Without it the server survives and
#          the CALLER HANGS — the socket stays open until the client gives up,
#          which is a different bug wearing the same "server is up" costume.
#
# So a pass is not "the process is alive". A pass is: every request got an
# answer, no request hung, and the process is alive afterwards. A hang is
# reported as a FAILURE of this walk, not as a slow pass.
#
# `POST /api/vaults/:name/export` is the route that originally proved GW-11:
# `memory-vaults.ts:205` calls `fs.mkdirSync(.vodou/exports)` with no try/catch,
# inside an `async` handler. Read-only `.vodou/` makes that throw EACCES for
# real, rather than simulating one.
route_storm_walk() {
  if port_is_taken; then
    say "ABORTED — something is already serving :$PORT, and it is not ours."
    return 1
  fi
  say "booting an ISOLATED gateway on :${PORT} ..."
  if ! lab_gateway_start; then
    say "gateway did not come up; last lines of $LAB/gateway.log:"
    tail -5 "$LAB/gateway.log" 2>/dev/null | sed 's/^/      /'
    lab_gateway_kill
    return 1
  fi
  local pid; pid="$(cat "$LAB/gw.pid")"
  say "up (pid $pid)"

  # The CO-2 guard announces itself. If this line is absent the walk still runs,
  # but say so — otherwise a pass proves only that GW-11's half is in place.
  local guard; guard="$(grep -o 'async route guard active on [0-9]* handlers' "$LAB/gateway.log" | tail -1)"
  if [ -n "$guard" ]; then say "guard: $guard"; else say "guard: NOT ANNOUNCED — this build may predate CO-2"; fi

  # Make .vodou/ read-only. This is the induced fault; everything else is input.
  mkdir -p "$LAB/.vodou"
  chmod a-w "$LAB/.vodou"
  say "induced: $LAB/.vodou is now read-only ($(stat -f '%Sp' "$LAB/.vodou" 2>/dev/null || stat -c '%A' "$LAB/.vodou"))"

  # Each row: METHOD PATH BODY. Chosen to reach async handlers with input that
  # is wrong in a different way each time — a write into the read-only dir, a
  # malformed body, a missing field, a bad id, a hostile string.
  local -a SHOTS=(
    "POST|/api/vaults/lab/export|{}"
    "POST|/api/graph/plan|{\"recipe\":\"@@@ not a recipe @@@\"}"
    "POST|/api/graph/save|{}"
    "POST|/api/graph/run|{\"conversationId\":null,\"recipe\":123}"
    "POST|/api/graph/runs/does-not-exist/answer|{\"answer\":\"x\"}"
    "POST|/api/skills/cleanup-context|{\"skill\":\"../../etc/passwd\"}"
    "POST|/api/board/tasks/999999/skill-choice|{\"choice\":-1}"
    "POST|/api/heartbeat/run|{\"conversationId\":\"\"}"
    "POST|/api/vbb/tool|{\"tool\":null,\"args\":\"not-an-object\"}"
    "POST|/api/capture/pair/require|{\"required\":\"yes-please\"}"
    "GET|/api/logs?limit=-1||"
    "GET|/api/timeline?days=notanumber&limit=99999||"
  )

  local fired=0 answered=0 hung=0 died_at=""
  printf '\n  %-6s %-46s %-8s %s\n' "method" "path" "status" "note"
  printf '  %s\n' "$(printf '─%.0s' $(seq 1 78))"

  for shot in "${SHOTS[@]}"; do
    local m p b code
    m="${shot%%|*}"; local rest="${shot#*|}"; p="${rest%%|*}"; b="${rest#*|}"
    fired=$((fired + 1))

    # -m 15: an answered route returns in well under a second. Anything at the
    # ceiling is the CO-2 hang, and is recorded as such rather than retried.
    if [ "$m" = "GET" ]; then
      code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "http://127.0.0.1:$PORT$p" 2>/dev/null)"
    else
      code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST \
                -H 'Content-Type: application/json' -d "$b" \
                "http://127.0.0.1:$PORT$p" 2>/dev/null)"
    fi

    local note=""
    if [ "$code" = "000" ]; then
      hung=$((hung + 1)); note="NO ANSWER — hung or connection refused"
    else
      answered=$((answered + 1))
    fi

    # The process must still be alive after EVERY shot, so the report can name
    # the exact request that killed it rather than "something did".
    if ! kill -0 "$pid" 2>/dev/null; then
      [ -z "$died_at" ] && died_at="$m $p"
      note="$note  ← GATEWAY DIED HERE"
    fi
    printf '  %-6s %-46s %-8s %s\n' "$m" "${p:0:46}" "$code" "$note"
  done

  # Restore write permission before anything else touches the lab.
  chmod u+w "$LAB/.vodou" 2>/dev/null || true

  say ""
  # `grep -c` EXITS 1 when the count is zero, so `|| echo 0` appended a second
  # line to a value that was already "0" and the summary printed "0\n0".
  local rejections exits
  rejections="$(grep -c 'unhandledRejection (server STAYS UP)' "$LAB/gateway.log" 2>/dev/null | head -1)"
  exits="$(grep -c 'uncaughtException' "$LAB/gateway.log" 2>/dev/null | head -1)"
  say "fired $fired · answered $answered · no-answer $hung · rejections logged ${rejections:-0} · uncaught ${exits:-0}"
  if [ "${rejections:-0}" = "0" ] && [ "$hung" = "0" ]; then
    say "  (zero rejections LOGGED is the CO-2 guard doing its job: it converted"
    say "   each one to next(err) at the route layer, so GW-11's stay-up fallback"
    say "   was never the thing keeping the process alive.)"
  fi

  # Still serving? Ask a route that has nothing to do with the storm.
  local health; health="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$PORT/api/system" 2>/dev/null)"

  if [ -n "$died_at" ] || ! kill -0 "$pid" 2>/dev/null; then
    say "FAIL — the gateway is gone. First request that killed it: ${died_at:-unknown}"
    say "  This is the GW-11 regression: one bad request takes down every surface."
    tail -20 "$LAB/gateway.log" 2>/dev/null | sed 's/^/      /'
  elif [ "$hung" -gt 0 ]; then
    say "FAIL — the process survived but $hung request(s) were never answered."
    say "  That is the CO-2 half: the rejection escaped, nothing called next(err),"
    say "  and the caller sits on an open socket until its own timeout."
  elif [ "$health" != "200" ]; then
    say "FAIL — process alive but /api/system answered $health, so it is not serving."
  else
    say "PASS — every request answered, none hung, and /api/system still returns 200"
    say "  after $fired bad requests against a read-only .vodou/."
  fi

  lab_gateway_kill
}


# ── bridge-rogue ────────────────────────────────────────────────────────────
# ALPHA-READINESS §9.2 row 12 — the SEC-3 proof.
#
# Run in the lab, never against the live gateway: proving the pinned case means
# switching `bridge_require_token` ON, and doing that on the live install would
# disconnect the operator's own browser extension mid-session.
#
# Three cases, and only two of them are rejections. Reporting the third as one
# would misdescribe what actually ships.
bridge_rogue_walk() {
  if port_is_taken; then
    say "ABORTED — something is already serving :$PORT, and it is not ours."
    return 1
  fi
  say "booting an ISOLATED gateway on :${PORT} ..."
  if ! lab_gateway_start; then
    say "gateway did not come up; last lines of $LAB/gateway.log:"
    tail -5 "$LAB/gateway.log" 2>/dev/null | sed 's/^/      /'
    lab_gateway_kill
    return 1
  fi
  local pid; pid="$(cat "$LAB/gw.pid")"
  say "up (pid $pid)"

  local NODE="$ROOT/.node/node"; [ -x "$NODE" ] || NODE="node"
  local CLIENT="$ROOT/scripts/qa/rogue-bridge-client.mjs"
  local GW_DB="$LAB/MCP-servers/Vodou-Console/gateway.db"

  local r_empty r_foreign r_pinned
  r_empty="$("$NODE" "$CLIENT" "$PORT" empty 2>&1 | tail -1)"
  say "no Origin at all        → $r_empty"

  r_foreign="$("$NODE" "$CLIENT" "$PORT" foreign 2>&1 | tail -1)"
  say "foreign ext, pairing off → $r_foreign"

  # Turn pairing ON and pin the gateway to a DIFFERENT origin, then retry the
  # same foreign client. Writing gateway_settings directly is deliberate: the
  # HTTP toggle would also disconnect and re-arm the bridge, and this walk is
  # about the upgrade check, not about that route.
  sqlite3 "$GW_DB" \
    "INSERT INTO gateway_settings(key,value) VALUES('bridge_require_token','1')
       ON CONFLICT(key) DO UPDATE SET value='1';
     INSERT INTO gateway_settings(key,value) VALUES('bridge_ext_origin','chrome-extension://theonewetrustaaaaaaaaaaaaaaaaaa')
       ON CONFLICT(key) DO UPDATE SET value='chrome-extension://theonewetrustaaaaaaaaaaaaaaaaaa';" 2>/dev/null \
    || { say "could not write lab gateway_settings — cannot test the pinned case"; lab_gateway_kill; return 1; }
  say "induced: pairing ON, pinned to chrome-extension://theonewetrust..."

  r_pinned="$("$NODE" "$CLIENT" "$PORT" pinned 2>&1 | tail -1)"
  say "foreign ext, pairing ON  → $r_pinned"

  say ""
  local ok=1
  case "$r_empty"   in *'"verdict":"REJECTED"'*) ;; *) ok=0; say "FAIL — an Origin-less client was NOT rejected. That is the widest hole: any local script can reach chat_request.";; esac
  case "$r_pinned"  in *'"verdict":"REJECTED"'*) ;; *) ok=0; say "FAIL — a foreign extension was accepted while pairing was ON and the gateway was pinned elsewhere.";; esac
  case "$r_pinned"  in *4404*) ;; *) say "NOTE — rejected, but not with close 4404; the panel will render a bare network failure rather than a reason.";; esac
  case "$r_foreign" in
    *'"verdict":"ACCEPTED"'*)
      say "EXPECTED — with pairing OFF (the shipped default) any extension origin is accepted."
      say "  This is the documented open-by-default, not a regression. It is what"
      say "  Settings → Memory → Browser bridge → Require pairing code closes." ;;
    *) say "NOTE — pairing off did not accept either; the default may have changed." ;;
  esac
  [ "$ok" = "1" ] && say "PASS — rejected without an Origin, and rejected when pinned to another browser."

  lab_gateway_kill
}


# ── capture-drift ───────────────────────────────────────────────────────────
# PLAN-CAPTURE-GRADED-PER-SITE P3 gate. Two proofs, neither needs a browser:
#
#   1. The page shim REPORTS a miss (the extension's own Node tests drive a
#      chat-looking request that no adapter matches through the tap and assert a
#      `vodou-netcap-miss` message is posted — the console line became a count).
#   2. The grader turns those counts into the right words. A lab gateway.db gets
#      three heartbeat rows: a site that captured before and now stores nothing
#      (must be `broken`, must exit 2), a site whose adapter no longer matches
#      (`broken (adapter drift)`), and a site never opened (`unknown`, never red).
#
# No gateway process: `vodou-core capture` reads gateway.db read-only.
capture_drift_walk() {
  local NODE="$ROOT/.node/node"; [ -x "$NODE" ] || NODE="node"
  local T="$ROOT/extension/Store-vodou-bridge/test/capture-heartbeat.test.mjs"
  local ok=1

  say "1/2 — the page shim posts a miss (node --test, no browser)"
  # node ≥ 20 picks the spec reporter on a TTY and (v24) even in a pipe; ask for TAP so the pass/fail lines are stable.
  local tout; tout="$("$NODE" --test --test-reporter=tap "$T" 2>&1)"
  local passl; passl="$(printf '%s\n' "$tout" | grep -E '^# pass' | head -1)"
  local faill; faill="$(printf '%s\n' "$tout" | grep -E '^# fail' | head -1)"
  say "  $passl · $faill"
  case "$faill" in '# fail 0') ;; *) ok=0; say "FAIL — a miss in the tap did not become a message; the drift cell can never light up.";; esac

  say "2/2 — the grader on three induced rows"
  mkdir -p "$LAB/extension" "$LAB/MCP-servers/Vodou-Console"
  cp "$ROOT/extension/sites.json" "$LAB/extension/sites.json" 2>/dev/null \
    || { say "FAIL — no extension/sites.json to grade against (render it: node extension/Store-vodou-bridge/test/gen-sites-json.mjs)"; return 1; }
  local GW_DB="$LAB/MCP-servers/Vodou-Console/gateway.db"
  local today; today="$(date +%Y-%m-%d)"
  sqlite3 "$GW_DB" "
    CREATE TABLE IF NOT EXISTS gateway_messages (id INTEGER PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS capture_site_heartbeat (site TEXT NOT NULL, day TEXT NOT NULL, ext_build TEXT,
      visited INTEGER NOT NULL DEFAULT 0, turns_seen INTEGER NOT NULL DEFAULT 0, turns_stored INTEGER NOT NULL DEFAULT 0,
      miss_unmatched INTEGER NOT NULL DEFAULT 0, miss_empty INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
      matched_sig TEXT, miss_sig TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (site, day));
    DELETE FROM capture_site_heartbeat;
    -- chatgpt captured before (history) and now: visited, 3 sent, 0 stored → broken, red
    INSERT OR IGNORE INTO gateway_messages(conversation_id, role, content, created_at) VALUES ('webcap:chatgpt:lab', 'user', 'earlier', '2026-08-20 12:00:00');
    INSERT INTO capture_site_heartbeat(site, day, ext_build, visited, turns_seen, turns_stored, updated_at) VALUES ('chatgpt', '$today', 'store@lab#deadbeef', 1, 3, 0, strftime('%Y-%m-%d %H:%M:%S','now'));
    -- perplexity visited, nothing parsed, two chat-looking requests no adapter claimed → adapter drift
    INSERT INTO capture_site_heartbeat(site, day, ext_build, visited, miss_unmatched, miss_sig, updated_at) VALUES ('perplexity', '$today', 'store@lab#deadbeef', 1, 2, '/rest/sse/renamed', strftime('%Y-%m-%d %H:%M:%S','now'));
    -- grok: never opened → unknown
  " 2>/dev/null || { say "FAIL — could not seed the lab gateway.db"; return 1; }
  say "induced: chatgpt sent 3 / stored 0 (has history), perplexity 2 unmatched requests, grok never visited"

  local out rc
  out="$(lab capture --json --days 7)"; rc=$?
  local v_chatgpt v_pplx v_grok
  v_chatgpt="$(printf '%s' "$out" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1));const f=k=>(r.rows.find(x=>x.capture===k)||{}).verdict;console.log([f("chatgpt"),f("perplexity"),f("grok")].join("|"))})' 2>/dev/null)"
  IFS='|' read -r v_chatgpt v_pplx v_grok <<< "$v_chatgpt"
  say "  chatgpt → ${v_chatgpt:-?}   perplexity → ${v_pplx:-?}   grok → ${v_grok:-?}   exit=$rc"
  [ "$v_chatgpt" = "broken" ] || { ok=0; say "FAIL — sent 3, stored 0, with history, must read 'broken' (got '${v_chatgpt:-?}')"; }
  [ "$v_pplx" = "broken (adapter drift)" ] || { ok=0; say "FAIL — unmatched requests with nothing parsed must read 'broken (adapter drift)' (got '${v_pplx:-?}')"; }
  [ "$v_grok" = "unknown" ] || { ok=0; say "FAIL — a site never opened must read 'unknown', never broken (got '${v_grok:-?}')"; }
  [ "$rc" = "2" ] || { ok=0; say "FAIL — a broken site with history must exit 2 (got $rc)"; }
  [ "$ok" = "1" ] && say "PASS — the tap reports drift, and the grader names it without calling an unvisited site broken."
  [ "$ok" = "1" ]
}

# ── revoked-bearer ──────────────────────────────────────────────────────────
# PLAN-CONNECTIONS-THAT-STAY-ALIVE P3/P0 gate. A bearer token with no expiry can
# be revoked server-side; nothing expires, no call fails, and `idle` would read
# as fine forever. The weekly probe is the only evidence, so this proves the
# grader turns each probe verdict into the right word — including the two that
# must NOT condemn a credential.
#
# Four induced rows, no network: the probe's OUTCOME is the input here (the
# prober itself is covered by its own fixtures and ran live on 2026-09-10).
revoked_bearer_walk() {
  mkdir -p "$LAB"
  local DB="$LAB/vodou-core.db"
  rm -f "$DB"
  local now; now=$(date +%s)
  sqlite3 "$DB" "
    CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, name TEXT, connection_type TEXT, health_status TEXT, active INTEGER DEFAULT 1, connection_config TEXT, command TEXT);
    CREATE TABLE server_credentials (id INTEGER PRIMARY KEY, server_id INTEGER, credential_type TEXT, credential_value TEXT, expires_at TEXT, refresh_failures INTEGER DEFAULT 0, refresh_last_error TEXT, needs_reauth INTEGER DEFAULT 0, needs_reauth_reason TEXT);
    CREATE TABLE oauth_configs (id INTEGER PRIMARY KEY, server_id INTEGER, client_id TEXT);
    CREATE TABLE turn_events (id INTEGER PRIMARY KEY, conversation_id TEXT, at TEXT, kind TEXT, lane TEXT, chars INTEGER, meta TEXT);
    CREATE TABLE connection_health (server_id INTEGER PRIMARY KEY, state TEXT, reason TEXT, cred_expires_at TEXT, cred_lifetime_s INTEGER, refresh_outcome TEXT, last_ok_call_at TEXT, last_err_call_at TEXT, probe_outcome TEXT, probe_at TEXT, computed_at TEXT NOT NULL);
    -- health_status matters: a revoked credential the worker ALSO calls unhealthy
    -- is `expired-reconnect`; one the worker still calls healthy is
    -- `contradicted` (two records of one connector disagreeing). `liar` is that
    -- second case, and it is the only row allowed to go red.
    INSERT INTO mcp_servers (id,name,connection_type,health_status) VALUES
      (1,'revoked','http','unhealthy'),(2,'offline','http','healthy'),(3,'quiet','http','healthy'),(4,'liar','http','healthy');
    INSERT INTO server_credentials (server_id,credential_type,credential_value) VALUES
      (1,'bearer_token','x'),(2,'bearer_token','x'),(3,'bearer_token','x');
    -- liar: an OAuth token expired and unrefreshable, while health_status says healthy
    INSERT INTO server_credentials (server_id,credential_type,credential_value,expires_at,needs_reauth,needs_reauth_reason) VALUES
      (4,'oauth_access_token','x','$((now - 86400))',1,'key rotated');
    INSERT INTO connection_health (server_id,state,probe_outcome,probe_at,computed_at) VALUES
      (1,'idle','401','2026-09-10 00:00:00','2026-09-10 00:00:00'),
      (2,'idle','unreachable','2026-09-10 00:00:00','2026-09-10 00:00:00'),
      (3,'idle','ok','2026-09-10 00:00:00','2026-09-10 00:00:00'),
      (4,'unknown',NULL,NULL,'2026-09-10 00:00:00');
  " 2>/dev/null || { say "FAIL — could not seed the lab vodou-core.db"; return 1; }
  say "induced: revoked(401) · offline(unreachable) · quiet(ok) · liar(healthy over a dead OAuth token)"

  local out rc v_rev v_off v_quiet v_liar
  out="$(lab connections --json)"; rc=$?
  local NODE="$ROOT/.node/node"; [ -x "$NODE" ] || NODE="node"
  local parsed
  parsed="$(printf '%s' "$out" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1));const f=n=>(r.rows.find(x=>x.name===n)||{}).state;console.log([f("revoked"),f("offline"),f("quiet"),f("liar")].join("|"))})' 2>/dev/null)"
  IFS='|' read -r v_rev v_off v_quiet v_liar <<< "$parsed"
  say "  revoked → ${v_rev:-?}   offline → ${v_off:-?}   quiet → ${v_quiet:-?}   liar → ${v_liar:-?}   exit=$rc"
  local ok=1
  [ "$v_rev" = "expired-reconnect" ] || { ok=0; say "FAIL — a probe 401 on a bearer token must read 'expired-reconnect' (got '${v_rev:-?}')"; }
  [ "$v_off" = "idle" ] || { ok=0; say "FAIL — 'unreachable' must NOT condemn a credential; expected 'idle' (got '${v_off:-?}')"; }
  [ "$v_quiet" = "idle-verified" ] || { ok=0; say "FAIL — a probe that answered ok must read 'idle-verified' (got '${v_quiet:-?}')"; }
  [ "$v_liar" = "contradicted" ] || { ok=0; say "FAIL — healthy over a dead unrefreshable token is 'contradicted' (got '${v_liar:-?}')"; }
  [ "$rc" = "2" ] || { ok=0; say "FAIL — a contradicted row must exit 2 (got $rc)"; }
  [ "$ok" = "1" ] && say "PASS — each probe verdict becomes the right word, and only the self-contradicting row goes red."
  [ "$ok" = "1" ]
}

# ── file-access ─────────────────────────────────────────────────────────────
# CD-1 — the onboarding disclosure must describe the install it is running on.
#
# Vodou ships whole-machine file access in the main web chat. That is the chosen
# default; what was missing is that nobody was told. The wizard now fetches
# `/api/onboarding/file-access` instead of carrying a sentence, and the ONLY way
# to know that actually works is to boot with each setting and read what comes
# back. A hardcoded sentence would pass a code review and lie to the one user
# who changed the flag.
file_access_walk() {
  if port_is_taken; then
    say "ABORTED — something is already serving :$PORT, and it is not ours."
    return 1
  fi

  probe() {                                # $1 = label, $2 = env, $3 = expected `reach`
    LAB_EXTRA_ENV="$2"
    if ! lab_gateway_start >/dev/null 2>&1; then
      say "$1: gateway did not come up"; tail -3 "$LAB/gateway.log" | sed 's/^/      /'; return 1
    fi
    local body; body="$(curl -s -m 10 "http://127.0.0.1:$PORT/api/onboarding/file-access")"
    local reach summary
    reach="$(printf '%s' "$body" | sed -n 's/.*"reach":"\([^"]*\)".*/\1/p')"
    summary="$(printf '%s' "$body" | sed -n 's/.*"summary":"\([^"]*\)".*/\1/p')"
    lab_gateway_kill
    if [ "$reach" != "$3" ]; then
      say "FAIL $1 — reach=\"$reach\", expected \"$3\""
      say "      body: $(printf '%s' "$body" | head -c 200)"
      return 1
    fi
    say "$1"
    say "   reach: $reach"
    say "   says:  $summary"
    return 0
  }

  local ok=0
  probe "shipped default (ENABLED=1, UNSANDBOXED=1)" \
        "VODOU_FS_TOOLS_ENABLED=1 VODOU_FS_TOOLS_UNSANDBOXED=1" machine || ok=1
  probe "confined (UNSANDBOXED=0)" \
        "VODOU_FS_TOOLS_ENABLED=1 VODOU_FS_TOOLS_UNSANDBOXED=0" per-chat-folder || ok=1
  probe "tools off (ENABLED=0)" \
        "VODOU_FS_TOOLS_ENABLED=0 VODOU_FS_TOOLS_UNSANDBOXED=1" none || ok=1
  probe "no protected-file list (ALLOW_PROTECTED=1)" \
        "VODOU_FS_TOOLS_ENABLED=1 VODOU_FS_TOOLS_UNSANDBOXED=1 VODOU_FS_TOOLS_UNSANDBOXED_ALLOW_PROTECTED=1" machine || ok=1

  unset LAB_EXTRA_ENV
  say ""
  [ "$ok" = "0" ] && say "PASS — the disclosure tracks the install, in all four postures." \
                  || say "FAIL — the disclosure does not describe what is configured."
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
  if [ "$st" = "file-access" ]; then
    file_access_walk
    restore
    continue
  fi
  if [ "$st" = "capture-drift" ]; then
    capture_drift_walk
    restore
    continue
  fi
  if [ "$st" = "revoked-bearer" ]; then
    revoked_bearer_walk
    restore
    continue
  fi
  if [ "$st" = "bridge-rogue" ]; then
    bridge_rogue_walk
    restore
    continue
  fi
  if [ "$st" = "route-storm" ]; then
    route_storm_walk
    restore
    continue
  fi
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
