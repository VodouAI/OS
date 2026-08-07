#!/usr/bin/env python3
"""
dogfood-mcp-host.py — exercise MCP host mode the way a real client does.

Everything MCP egress had been verified with until 2026-08-05 was curl against a
server we started ourselves. That is not a client session: it never does the
`initialize` handshake, never holds a connection open, never interleaves calls, and
never lives long enough to hit a process-level timer. Which is precisely how a
90-second watchdog managed to be killing stdio host mode since the day it shipped
without anyone noticing.

So this speaks the protocol properly: full handshake, a session held open across
calls, two clients at once on one port, and — with --real-client — an actual Claude
Code process attaching to Vodou and being asked a question only memory can answer.

    python3 scripts/dogfood-mcp-host.py                 # ~30s, core lanes
    python3 scripts/dogfood-mcp-host.py --long          # + the 90s watchdog window
    python3 scripts/dogfood-mcp-host.py --real-client   # + a live Claude Code attach
    python3 scripts/dogfood-mcp-host.py --all

Exits non-zero if anything fails. FLAGs are findings that are not failures — a
documented gap, or behaviour worth a human deciding about.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

# The memory assertions check answers from the OPERATOR'S live vault, so the
# expected token is operator data (e.g. a pet's name) — supplied via env so no
# personal literal ships in public source.
import os as _os
EXPECT = _os.environ.get("VODOU_DOGFOOD_EXPECT") or ""
if not EXPECT:
    raise SystemExit("set VODOU_DOGFOOD_EXPECT to a word from a vault fact (e.g. your pet's name)")


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "vodou-core")
TOKEN_FILE = os.path.join(ROOT, ".vodou", "console.token")

PASS, FAIL, FLAG = [], [], []


def ok(name, detail=""):
    PASS.append(name)
    print(f"  \033[32mPASS\033[0m  {name}{('  — ' + detail) if detail else ''}")


def bad(name, detail=""):
    FAIL.append(name)
    print(f"  \033[31mFAIL\033[0m  {name}{('  — ' + detail) if detail else ''}")


def flag(name, detail=""):
    FLAG.append((name, detail))
    print(f"  \033[33mFLAG\033[0m  {name}{('  — ' + detail) if detail else ''}")


def check(name, cond, detail=""):
    (ok if cond else bad)(name, detail)
    return cond


def section(title):
    print(f"\n\033[1m{title}\033[0m")


# ── stdio: a client session, not a one-shot pipe ─────────────────────────────


class StdioClient:
    """An MCP client over stdio, holding the process open like Cursor does."""

    def __init__(self, args):
        self.p = subprocess.Popen(
            [CORE, "mcp-server"] + args,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd="/tmp",  # a real client runs from its own directory, never ours
            text=True, bufsize=1,
        )
        self._id = 0
        self.noise = []  # non-protocol lines seen on stdout

    def call(self, method, params=None, timeout=60):
        """Send a request and return its reply.

        Skips — and RECORDS — any non-JSON line. stdout is the protocol channel on
        stdio, so anything else on it is a bug: a debug print, a warning, a safety
        valve writing prose. A tolerant client survives it; a strict one desynchronises.
        We tolerate so the run continues, and report it at the end so it is not lost.
        """
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            out = {}

            def rd():
                out["line"] = self.p.stdout.readline()

            t = threading.Thread(target=rd, daemon=True)
            t.start()
            t.join(max(1, deadline - time.time()))
            line = out.get("line")
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            if not line.startswith("{"):
                self.noise.append(line[:200])
                continue
            return json.loads(line)
        raise TimeoutError(f"no reply to {method} within {timeout}s")

    def notify(self, method):
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.p.stdin.flush()

    def alive(self):
        return self.p.poll() is None

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


def text_of(resp):
    try:
        return resp["result"]["content"][0]["text"]
    except Exception:
        return ""


def stdio_lane():
    section("stdio — the transport every MCP client supports")
    c = StdioClient(["--vault", "portable"])
    try:
        r = c.call("initialize", {"protocolVersion": "2024-11-05",
                                  "capabilities": {},
                                  "clientInfo": {"name": "dogfood", "version": "1"}})
        check("initialize returns a protocol version",
              "result" in r and "protocolVersion" in r.get("result", {}),
              r.get("result", {}).get("protocolVersion", ""))
        c.notify("notifications/initialized")

        r = c.call("tools/list")
        names = [t["name"] for t in r["result"]["tools"]]
        check("tools/list after handshake", len(names) > 0, f"{len(names)} tools")
        check("memory tools present", "vc_memory_search" in names and "vc_memory_context" in names)

        # The question the whole feature exists to answer.
        r = c.call("tools/call", {"name": "vc_memory_search",
                                  "arguments": {"query": "what is my dog's name", "top_k": 3}})
        body = text_of(r)
        check("vc_memory_search answers from the vault", EXPECT in body, body.split("\n")[0][:70])

        r = c.call("tools/call", {"name": "vc_memory_context", "arguments": {"topic": "coffee"}})
        check("vc_memory_context returns a context block", "vodou:context" in text_of(r))

        # Same session, several calls — a client does not reconnect per tool call.
        for i in range(3):
            r = c.call("tools/call", {"name": "vc_list_skills", "arguments": {}})
            if not text_of(r):
                bad(f"repeat call {i + 1} on one session")
                break
        else:
            ok("session serves repeated calls without reconnecting")

        r = c.call("ping")
        check("ping", "result" in r)

        # stdio ignores --profile. Documented in mcp_install.rs, invisible in the docs.
        c2 = StdioClient(["--profile", "memory"])
        try:
            c2.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "d", "version": "1"}})
            r = c2.call("tools/call", {"name": "vc_workspace_run_command",
                                       "arguments": {"command": "echo dogfood"}})
            check("stdio enforces --profile (a withheld tool is refused when called)",
                  "error" in r or "not available" in json.dumps(r))
            names = [t["name"] for t in c2.call("tools/list")["result"]["tools"]]
            check("stdio filters tools/list to the profile",
                  "vc_workspace_run_command" not in names and "vc_memory_search" in names,
                  f"{len(names)} tools")
        finally:
            noise = c2.noise
            c2.close()
    finally:
        noise = getattr(c, "noise", []) + (noise if "noise" in dir() else [])
        c.close()
    check("stdout carried only JSON-RPC (nothing else belongs on it)",
          not noise, ("first stray line: " + noise[0]) if noise else "")


def watchdog_lane():
    section("stdio — surviving the 90s process watchdog (the bug found 2026-08-05)")
    c = StdioClient(["--vault", "portable"])
    try:
        c.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "dogfood", "version": "1"}})
        c.notify("notifications/initialized")
        c.call("tools/list")
        print("       holding the session open past 90s, as an attached editor would…")
        deadline = time.time() + 100
        while time.time() < deadline:
            time.sleep(10)
            if not c.alive():
                bad("session survives past 90s", f"process died after ~{int(100 - (deadline - time.time()))}s")
                return
        r = c.call("tools/call", {"name": "vc_memory_search",
                                  "arguments": {"query": "dog", "top_k": 1}})
        check("session still serving after 100s idle", EXPECT in text_of(r))
    finally:
        c.close()


# ── HTTP: several clients, one core ──────────────────────────────────────────


def http_call(port, token, method, params=None, timeout=60):
    msg = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        msg["params"] = params
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/mcp", data=json.dumps(msg).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def mint(client_id, label, profile, vault):
    """Register a client without writing into anyone's real config file."""
    r = subprocess.run([CORE, "mcp", "install", "--print", "--http",
                        "--profile", profile, "--vault", vault,
                        "--client-id", client_id, "--label", label],
                       cwd=ROOT, capture_output=True, text=True, timeout=120)
    for line in r.stdout.splitlines():
        if "Bearer" in line:
            return line.split("Bearer ")[1].strip().strip('"').strip("'").rstrip(",").strip('"')
    raise RuntimeError(f"could not mint a client token: {(r.stdout + r.stderr).strip()[:200]}")


def http_lane(port):
    section("loopback HTTP — two clients, one core, different scopes")
    editor = mint("dogfood-editor", "Dogfood Editor", "full", "portable")
    partner = mint("dogfood-partner", "Dogfood Partner", "memory", "demo")

    srv = subprocess.Popen([CORE, "mcp-server", "--http", "--port", str(port),
                            "--profile", "memory", "--vault", "portable"],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3).read()
                break
            except Exception:
                time.sleep(0.5)
        else:
            bad("http server came up")
            return

        for tok, who in ((editor, "editor"), (partner, "partner")):
            r = http_call(port, tok, "initialize", {"protocolVersion": "2024-11-05",
                                                    "capabilities": {},
                                                    "clientInfo": {"name": who, "version": "1"}})
            check(f"{who}: initialize", "result" in r)

        e_tools = [t["name"] for t in http_call(port, editor, "tools/list")["result"]["tools"]]
        p_tools = [t["name"] for t in http_call(port, partner, "tools/list")["result"]["tools"]]
        check("editor (full) sees the whole catalog", "vc_server_tool" in e_tools, f"{len(e_tools)} tools")
        check("partner (memory) sees a reduced catalog",
              "vc_server_tool" not in p_tools and len(p_tools) < len(e_tools), f"{len(p_tools)} tools")

        # The claim T2 exists to make: same port, same instant, different vaults.
        e_ans = text_of(http_call(port, editor, "tools/call",
                                  {"name": "vc_memory_search",
                                   "arguments": {"query": "what is my dog's name", "top_k": 2}}))
        p_ans = text_of(http_call(port, partner, "tools/call",
                                  {"name": "vc_memory_search",
                                   "arguments": {"query": "what is my dog's name", "top_k": 2}}))
        check("editor reads its own vault (portable)", EXPECT in e_ans)
        check("partner is confined to its vault (demo)", EXPECT not in p_ans and "demo" in p_ans,
              p_ans[:60])

        r = http_call(port, partner, "tools/call",
                      {"name": "vc_workspace_run_command", "arguments": {"command": "echo x"}})
        check("partner refused a shell", "error" in r)

        r = http_call(port, partner, "tools/call",
                      {"name": "vc_memory_search", "arguments": {"query": "coffee", "vault": "portable"}})
        check("a vault named in the arguments is ignored", "demo" in text_of(r))

        r = http_call(port, partner, "tools/call", {"name": "vc_list_skills", "arguments": {}})
        env = r.get("result", {})
        check("no context envelope for a non-full profile", list(env.keys()) == ["content"],
              ",".join(env.keys()))

        # Concurrency, as two attached editors would generate.
        res = {}

        def hit(i):
            try:
                t0 = time.time()
                http_call(port, editor, "tools/call",
                          {"name": "vc_memory_search", "arguments": {"query": "coffee", "top_k": 4}})
                res[i] = time.time() - t0
            except Exception as e:
                res[i] = f"FAIL {type(e).__name__}"

        ts = [threading.Thread(target=hit, args=(i,)) for i in range(4)]
        t0 = time.time()
        for t in ts:
            t.start()
        for t in ts:
            t.join(timeout=90)
        wall = time.time() - t0
        good = [v for v in res.values() if isinstance(v, float)]
        check("4 concurrent calls all complete", len(good) == 4, f"{wall * 1000:.0f} ms wall")

        # Rate ceiling: a client minted with --rate-limit 3 gets exactly 3 calls a
        # minute; the 4th is 429; the editor beside it never notices. Cheap tool so
        # the three allowed calls don't drag the lane.
        limited = subprocess.run(
            [CORE, "mcp", "install", "--print", "--http", "--profile", "memory",
             "--vault", "demo", "--client-id", "dogfood-limited",
             "--label", "Dogfood Limited", "--rate-limit", "3"],
            cwd=ROOT, capture_output=True, text=True, timeout=120)
        ltok = None
        for line in limited.stdout.splitlines():
            if "Bearer" in line:
                ltok = line.split("Bearer ")[1].strip().strip('"').strip("'").rstrip(",").strip('"')
        if not ltok:
            bad("minted a rate-limited client")
        else:
            def limited_rows():
                r2 = subprocess.run([CORE, "mcp", "audit", "--json",
                                     "--client", "dogfood-limited", "--limit", "500"],
                                    cwd=ROOT, capture_output=True, text=True, timeout=60)
                try:
                    return [c for c in json.loads(r2.stdout).get("calls", [])
                            if c.get("outcome") == "limited"]
                except Exception:
                    return None

            before = limited_rows()
            statuses = []
            for _ in range(5):
                try:
                    http_call(port, ltok, "tools/call", {"name": "vc_list_skills", "arguments": {}})
                    statuses.append(200)
                except urllib.error.HTTPError as e:
                    statuses.append(e.code)
            check("a limited client is stopped at its ceiling",
                  statuses[:3] == [200, 200, 200] and statuses[3:] == [429, 429],
                  ",".join(map(str, statuses)))
            after = limited_rows()
            if before is None or after is None:
                bad("the breach reached the audit log", "mcp audit --json unreadable")
            else:
                # Two rejected calls, ONE new row: the log records the transition into
                # the limited state, so a hammering client cannot flood its own log.
                check("the breach is one audit row, not one per rejected retry",
                      len(after) - len(before) == 1,
                      f"+{len(after) - len(before)} limited row(s) for 2 rejections")
            # The ceiling is per client, not per port.
            try:
                r = http_call(port, editor, "tools/list")
                check("the client beside it is not slowed or stopped", "result" in r)
            except Exception as e:
                bad("the client beside it is not slowed or stopped", str(e)[:80])

        # Revoke one client mid-session; the other must not notice.
        subprocess.run([CORE, "mcp", "revoke", "dogfood-partner", "--json"],
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
        try:
            http_call(port, partner, "tools/list")
            bad("revoked client is refused mid-session")
        except urllib.error.HTTPError as e:
            check("revoked client is refused mid-session", e.code == 401, f"HTTP {e.code}")
        try:
            r = http_call(port, editor, "tools/list")
            check("the other client keeps working", "result" in r)
        except Exception as e:
            bad("the other client keeps working", str(e))

        section("protocol robustness — what a buggy or hostile client sends")
        cases = [
            ("unknown method", {"method": "tools/frobnicate"}, None),
            ("unknown tool", {"method": "tools/call"}, {"name": "vc_nope", "arguments": {}}),
            ("tools/call with no params", {"method": "tools/call"}, None),
            ("missing required argument", {"method": "tools/call"}, {"name": "vc_memory_search", "arguments": {}}),
            ("wrong argument type", {"method": "tools/call"},
             {"name": "vc_memory_search", "arguments": {"query": 12345}}),
            ("huge argument", {"method": "tools/call"},
             {"name": "vc_memory_search", "arguments": {"query": "x" * 50000}}),
        ]
        for label, base, params in cases:
            try:
                r = http_call(port, editor, base["method"], params, timeout=90)
                served = "error" in r or "result" in r
                check(f"{label} → answered, not crashed", served)
            except Exception as e:
                bad(f"{label} → answered, not crashed", f"{type(e).__name__}")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10).read()
            ok("server healthy after the abuse")
        except Exception as e:
            bad("server healthy after the abuse", str(e))
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=10)
        except Exception:
            srv.kill()
        for cid in ("dogfood-editor", "dogfood-partner"):
            subprocess.run([CORE, "mcp", "revoke", cid, "--json"],
                           cwd=ROOT, capture_output=True, text=True, timeout=60)


# ── a real frontier client ───────────────────────────────────────────────────


def real_client_lane():
    section("a real client — Claude Code attaching to Vodou over stdio")
    workdir = os.path.join("/tmp", f"vodou-dogfood-{os.getpid()}")
    os.makedirs(workdir, exist_ok=True)
    with open(os.path.join(workdir, ".mcp.json"), "w") as f:
        json.dump({"mcpServers": {"vodou": {"command": CORE,
                                            "args": ["mcp-server", "--vault", "portable"]}}}, f)
    prompt = ("Use the vodou MCP server's vc_memory_search tool to look up what the user's "
              "dog is named, then reply with ONLY the dog's name and nothing else.")
    try:
        r = subprocess.run(
            ["claude", "-p", prompt, "--permission-mode", "bypassPermissions"],
            cwd=workdir, capture_output=True, text=True, timeout=300)
        out = (r.stdout or "").strip()
        check("Claude Code attached and answered from Vodou memory",
              EXPECT in out, (out[:120] or r.stderr[:120]).replace("\n", " "))
    except subprocess.TimeoutExpired:
        bad("Claude Code attached and answered from Vodou memory", "timed out after 300s")
    except FileNotFoundError:
        flag("Claude Code not installed", "skipped the real-client lane")
    finally:
        try:
            os.remove(os.path.join(workdir, ".mcp.json"))
            os.rmdir(workdir)
        except Exception:
            pass


def audit_json(args):
    """Read the egress audit log through the CLI the Console also reads."""
    r = subprocess.run([CORE, "mcp", "audit", "--json"] + args,
                       cwd=ROOT, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def audit_lane():
    """The egress audit log — what an attached client actually did.

    Runs LAST, so the calls the earlier lanes made are what it inspects. Everything
    here is checked through `mcp audit --json` rather than by opening the DB, because
    that CLI is what the Console reads: verifying the table directly would pass even if
    the surface a user actually looks at were broken.
    """
    section("egress audit — what an attached client actually did")

    # A stdio client that names itself, the way `mcp install` writes it.
    marker = "dogfood-audit-stdio"
    c = StdioClient(["--profile", "memory", "--client-id", marker])
    secret = "sekrit-dogfood-query-payload"
    try:
        c.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "d", "version": "1"}})
        c.notify("notifications/initialized")
        c.call("tools/call", {"name": "vc_memory_search",
                              "arguments": {"query": secret, "top_k": 1}})
        # A refused call — the row most worth having.
        c.call("tools/call", {"name": "vc_workspace_run_command",
                              "arguments": {"command": "echo nope"}})
        c.call("tools/list")   # protocol chatter: must NOT be logged
        c.call("ping")         # ditto
    finally:
        c.close()

    # A tool that does not exist, from a client whose profile does NOT withhold it.
    # This has to be `full`: under `memory` the allowlist denies an unknown name before
    # dispatch (correctly), so the row is `denied` and never exercises the mapping. Only
    # a profile that lets the name through reaches the dispatcher, which answers
    # Ok(<json-rpc error>) — the shape that was being logged as `ok`, making a tool-name
    # enumeration sweep read as ordinary traffic.
    probe = "dogfood-audit-full"
    cf = StdioClient(["--profile", "full", "--client-id", probe])
    try:
        cf.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "d", "version": "1"}})
        cf.notify("notifications/initialized")
        cf.call("tools/call", {"name": "vc_definitely_not_a_tool", "arguments": {}})
    finally:
        cf.close()

    doc = audit_json(["--limit", "200"])
    if doc is None:
        bad("mcp audit --json returns a readable log")
        return
    ok("mcp audit --json returns a readable log")
    calls = doc.get("calls", [])

    mine = [r for r in calls if r.get("client_id") == marker]
    check("a stdio client's calls are recorded under its own id", len(mine) >= 2,
          f"{len(mine)} rows as {marker}")

    tools = [r.get("tool") for r in mine]
    check("the successful call was recorded", "vc_memory_search" in tools)
    denied = [r for r in mine if r.get("outcome") == "denied"]
    check("a refused call is recorded AS refused", len(denied) >= 1,
          denied[0]["tool"] if denied else "no denied row")

    # Handshake and catalog listing are not calls; logging them would bury the rows
    # that matter under protocol chatter.
    check("tools/list and ping are not audited",
          not any(t in ("tools/list", "ping", "initialize") for t in tools))

    # ≥1 and ALL — rows accumulate across harness runs (30-day retention), so an exact
    # count of 1 only passes on a fresh table.
    unknown = [r for r in calls
               if r.get("client_id") == probe and r.get("tool") == "vc_definitely_not_a_tool"]
    check("an unknown tool a profile ALLOWED is recorded as error, not success",
          len(unknown) >= 1 and all(r.get("outcome") == "error" for r in unknown),
          ",".join(sorted({r.get("outcome", "?") for r in unknown})) or "no row")

    # The other half: under a profile that withholds it, the same name is refused before
    # dispatch. Same call, different profile, genuinely different row.
    withheld = [r for r in mine if r.get("tool") == "vc_workspace_run_command"]
    check("the same probe under a restrictive profile is denied, not errored",
          len(withheld) >= 1 and withheld[0].get("outcome") == "denied",
          withheld[0]["outcome"] if withheld else "no row")

    # The promise the table makes.
    blob = json.dumps(doc)
    check("argument text is NOT in the log", secret not in blob)
    digests = [r.get("args_digest") for r in mine if r.get("args_digest")]
    check("arguments are reduced to a digest", len(digests) >= 1,
          (digests[0][:16] + "…") if digests else "none")
    check("the digest is not a bare sha256 of the argument",
          not any(d == __import__("hashlib").sha256(
              json.dumps({"query": secret, "top_k": 1}, separators=(",", ":")).encode()
          ).hexdigest() for d in digests),
          "salted")
    check("argument size is recorded even though content is not",
          any((r.get("arg_bytes") or 0) > 0 for r in mine))

    # Both transports reach the same log — the HTTP lane ran before this one.
    transports = {r.get("transport") for r in calls}
    check("both transports write to one log", {"stdio", "http"} <= transports,
          ",".join(sorted(t for t in transports if t)))

    # The filters the CLI advertises.
    only_denied = audit_json(["--denied", "--limit", "200"])
    check("--denied filters to refusals",
          only_denied is not None
          and all(r.get("outcome") == "denied" for r in only_denied.get("calls", []))
          and len(only_denied.get("calls", [])) >= 1)
    one = audit_json(["--client", marker, "--limit", "200"])
    check("--client filters to one subject",
          one is not None
          and all(r.get("client_id") == marker for r in one.get("calls", []))
          and len(one.get("calls", [])) >= 2)
    summ = audit_json(["--summary"])
    check("--summary counts by client and outcome",
          summ is not None and any(s.get("client_id") == marker
                                   for s in summ.get("summary", [])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--long", action="store_true", help="include the 100s watchdog window")
    ap.add_argument("--real-client", action="store_true", help="attach a live Claude Code process")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--port", type=int, default=8831)
    a = ap.parse_args()

    if not os.path.exists(CORE):
        print(f"vodou-core not found at {CORE}", file=sys.stderr)
        return 2
    print(f"\033[1mMCP host dogfood\033[0m — {CORE}")

    stdio_lane()
    http_lane(a.port)
    if a.long or a.all:
        watchdog_lane()
    if a.real_client or a.all:
        real_client_lane()
    # Last: it inspects what every lane above it did.
    audit_lane()

    print(f"\n\033[1m{len(PASS)} passed, {len(FAIL)} failed, {len(FLAG)} flagged\033[0m")
    for n in FAIL:
        print(f"  \033[31mFAILED\033[0m {n}")
    for n, d in FLAG:
        print(f"  \033[33mFLAG\033[0m {n}: {d}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
