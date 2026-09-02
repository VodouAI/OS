#!/usr/bin/env python3
"""Measure the brain arm under concurrency — PLAN-SEAMS §31.1e.

The question: when N brain requests arrive at once, does the second one WAIT?
§31.1c measured a 1,503 ms socket wait on a live turn and traced it to the
`brain` arm being the only worker arm of 14 that does not use `dispatch_db`,
while `BrainLoader` touches the DB 65× behind a `std::sync::Mutex`.

WHY THIS IS A REAL HARNESS AND NOT A SHELL LOOP
-----------------------------------------------
`measure-harness-before-code`: measuring MCP egress concurrency on 2026-08-05
produced "4 concurrent = 85 s" (the process watchdog was killing the server
mid-run), then two indefinite hangs (the daemon had wedged, and a shell `wait`
+ backgrounded-`curl` harness hid every per-request outcome). The real numbers
appeared only from a Python driver with per-request timeouts and a health probe
after the run. So: per-request timeout, per-request outcome, and a liveness
check afterwards — a harness that cannot tell a slow answer from a dead server
is measuring itself.

Usage:  bench-brain-concurrency.py [--levels 1,2,4,8] [--json]
"""
from __future__ import annotations
import argparse
import json
import os
import socket
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOCK = os.path.join(ROOT, ".vodou", "worker.sock")
TIMEOUT_S = 30.0


def one_request(query: str) -> dict:
    """One brain call over the worker socket. Returns its own outcome — never
    raises into the pool, because a harness that loses a request's fate reports
    the average of the ones that happened to survive."""
    t0 = time.perf_counter()
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT_S)
        s.connect(SOCK)
        payload = json.dumps({
            "cmd": "brain",
            "args": {"query": query, "clean": True, "skip_memory_prefetch": True},
            "timeout_ms": int(TIMEOUT_S * 1000),
        }) + "\n"
        s.sendall(payload.encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        ms = (time.perf_counter() - t0) * 1000
        try:
            reply = json.loads(buf.split(b"\n")[0] or b"{}")
        except ValueError:
            return {"ok": False, "ms": ms, "err": "unparseable reply"}
        t = reply.get("timing") or {}
        return {
            "ok": bool(reply.get("ok")), "ms": ms,
            "total_ms": t.get("total_ms"), "init_ms": t.get("init_ms"), "exec_ms": t.get("exec_ms"),
            # wall MINUS the worker's own total = what the request spent WAITING
            # to be served. That is the number this whole exercise is about.
            "wait_ms": round(ms - (t.get("total_ms") or 0), 1),
            "chars": len(reply.get("stdout") or ""),
        }
    except Exception as e:                                   # noqa: BLE001
        return {"ok": False, "ms": (time.perf_counter() - t0) * 1000, "err": f"{type(e).__name__}: {e}"}


def worker_alive() -> bool:
    """Liveness AFTER the run: a benchmark that wedged the thing it measured
    must say so rather than publish the numbers it got on the way down."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(SOCK)
        s.sendall(b'{"cmd":"ping"}\n')
        alive = bool(s.recv(4096))
        s.close()
        return alive
    except OSError:
        return False


def level(n: int, query: str) -> dict:
    with ThreadPoolExecutor(max_workers=n) as ex:
        results = list(ex.map(lambda _: one_request(query), range(n)))
    ok = [r for r in results if r.get("ok")]
    waits = [r["wait_ms"] for r in ok if r.get("wait_ms") is not None]
    walls = [r["ms"] for r in ok]
    return {
        "concurrency": n,
        "ok": len(ok), "failed": len(results) - len(ok),
        "wall_ms_median": round(statistics.median(walls), 1) if walls else None,
        "wall_ms_max": round(max(walls), 1) if walls else None,
        "wait_ms_median": round(statistics.median(waits), 1) if waits else None,
        "wait_ms_max": round(max(waits), 1) if waits else None,
        "errors": [r.get("err") for r in results if not r.get("ok")][:3],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--levels", default="1,2,4,8")
    ap.add_argument("--query", default="what is the capital of france")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if not os.path.exists(SOCK):
        print(f"no worker socket at {SOCK} — start the stack first", file=sys.stderr)
        return 2

    # WARM UP FIRST. The initial request after a restart pays cold costs — pool
    # construction, first DB open, model load — and reading that as the steady
    # state is how a fix looks like it did nothing. A 2,065 ms figure taken
    # straight after `swap-binary.sh` turned out to be 3.5 ms once warm; the
    # difference was entirely the harness, not the code.
    one_request(a.query)
    time.sleep(0.5)

    rows = []
    for n in [int(x) for x in a.levels.split(",")]:
        rows.append(level(n, a.query))
        time.sleep(1.0)                    # let the worker settle between levels

    alive = worker_alive()
    out = {"schema_version": 1, "worker_alive_after": alive, "levels": rows}
    if a.json:
        print(json.dumps(out, indent=2))
    else:
        print("brain arm under concurrency — wait_ms is time spent QUEUING, not working\n")
        print(f"  {'N':>3}  {'ok':>4} {'fail':>4}  {'wall med':>9} {'wall max':>9}  {'WAIT med':>9} {'WAIT max':>9}")
        for r in rows:
            print(f"  {r['concurrency']:>3}  {r['ok']:>4} {r['failed']:>4}  "
                  f"{str(r['wall_ms_median']):>9} {str(r['wall_ms_max']):>9}  "
                  f"{str(r['wait_ms_median']):>9} {str(r['wait_ms_max']):>9}")
            for e in r["errors"]:
                print(f"       ! {e}")
        print(f"\n  worker alive after the run: {alive}")
        if not alive:
            print("  ⚠️  the numbers above were taken while wedging it — do not trust them")
    return 0 if alive else 2


if __name__ == "__main__":
    sys.exit(main())
