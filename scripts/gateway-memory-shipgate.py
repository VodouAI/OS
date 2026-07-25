#!/usr/bin/env python3
"""Gateway memory ship-gate — drives the REAL POST /chat API end to end.

Run after any memory-touching change:  python3 scripts/gateway-memory-shipgate.py

Rules learned building this (2026-07-23):
- Every recall test uses a FRESH conversationId. A correct answer must come
  from memory injection — chat history masks recall failures.
- The write-path canary must sound REAL. The extractor editorially drops
  fake-sounding facts ("my test project codename ..." was skipped while real
  facts from the same batch extracted). Phrase canaries as plausible business
  facts, and purge them after (see CANARY CLEANUP at the bottom).
- `vodou-hook-bin sock flush` BLOCKS until extraction completes — fire it
  detached and poll instead.
- Never purge chunks with direct sqlite UPDATE (memory_fts trigger rejects
  external writers). Purge = remove the bullet lines from the daily log under
  .vodou/workspace/memory/, then fire a detached flush (MemorySync reconciles).
"""
import json, subprocess, sys, threading, time, urllib.request, uuid

BASE = "http://localhost:8765"
BANNERS = ["memory degraded", "context pipeline timed out", "degraded ("]
CANARY_FACT = ("Heads up for planning: we picked Bluewater Provisions as the office "
               "coffee vendor for the Fenton office, and our account rep there is "
               "Tanya Merced. Their first delivery is August 4th.")
CANARY_RECALL_Q = "Who is our account rep at the office coffee vendor?"
CANARY_EXPECT = "tanya"
results = []


def chat(msg, timeout=180):
    conv = f"shipgate-{uuid.uuid4().hex[:8]}"
    t0 = time.time()
    req = urllib.request.Request(
        f"{BASE}/chat",
        data=json.dumps({"message": msg, "conversationId": conv}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.load(r)
    return body, int((time.time() - t0) * 1000)


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"{'PASS' if cond else 'FAIL'}: {name}" + (f" — {detail}" if detail else ""), flush=True)


def banner_free(text):
    low = text.lower()
    return not any(b in low for b in BANNERS)


# ── Lane 1: recall correctness (fresh conversations) ─────────────────
for name, q, expects in [
    ("recall: dog + address", "What's my dog's name and where do I live?", ["lucy", "fenton"]),
    ("recall: coffee order", "What's my usual coffee order?", ["oat", "flat white"]),
    ("recall: family", "How many kids do I have?", ["two"]),
    ("recall: paraphrase", "What pet is waiting for me at home?", ["lucy"]),
]:
    try:
        body, ms = chat(q)
        text = body.get("response", "")
        ok = all(e in text.lower() for e in expects) and banner_free(text) and "Raw Vodou Results" not in text
        check(name, ok, f"{ms}ms mem_used={body.get('memory', {}).get('used')}")
    except Exception as e:
        check(name, False, f"EXC {e}")

# ── Lane 2: action routing still works ───────────────────────────────
try:
    body, ms = chat("cpu memory disk")
    text = body.get("response", "")
    ok = any(k in text.lower() for k in ["cpu", "core", "usage"]) and any(c.isdigit() for c in text)
    check("action: cpu memory disk routes tools", ok, f"{ms}ms toolCalls={len(body.get('toolCalls', []))}")
except Exception as e:
    check("action: cpu memory disk routes tools", False, f"EXC {e}")

# ── Lane 3: write path — realistic canary round-trip ─────────────────
try:
    body, ms = chat(CANARY_FACT)
    check("write: canary accepted", True, f"{ms}ms")
except Exception as e:
    check("write: canary accepted", False, f"EXC {e}")

subprocess.Popen(["./vodou-hook-bin", "sock", "flush"],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
print("polling for extraction (gateway-extractor cycle, up to 10 min)...", flush=True)
found = False
for i in range(40):
    time.sleep(15)
    p = subprocess.run(["sqlite3", "file:memory.db?mode=ro",
                        "SELECT 1 FROM memory_chunks WHERE text LIKE '%Bluewater%' AND archived=0 LIMIT 1;"],
                       capture_output=True, text=True, timeout=30)
    if p.stdout.strip():
        found = True
        print(f"  canary extracted after ~{(i + 1) * 15}s", flush=True)
        break
check("write: canary extracted to memory.db", found)

if found:
    try:
        body, ms = chat(CANARY_RECALL_Q)
        text = body.get("response", "")
        check("write: canary recalled in fresh conversation",
              CANARY_EXPECT in text.lower() and banner_free(text), f"{ms}ms")
    except Exception as e:
        check("write: canary recalled in fresh conversation", False, f"EXC {e}")
else:
    check("write: canary recalled in fresh conversation", False, "skipped — not extracted")

# ── Lane 4: concurrency ──────────────────────────────────────────────
conc = {}
def cturn(key, q):
    try:
        body, ms = chat(q)
        conc[key] = (banner_free(body.get("response", "")), ms)
    except Exception as e:
        conc[key] = (False, str(e))
ts = [threading.Thread(target=cturn, args=(k, q)) for k, q in
      [("a", "What's my dog's name?"), ("b", "What city do I live in?")]]
[t.start() for t in ts]; [t.join() for t in ts]
check("concurrency: two simultaneous turns clean",
      conc.get("a", (False,))[0] and conc.get("b", (False,))[0], f"{conc}")

# ── Lane 5: health counters ──────────────────────────────────────────
try:
    with urllib.request.urlopen(f"{BASE}/health", timeout=10) as r:
        mr = json.load(r).get("memoryReliability", {})
    zero = all(mr.get(k, 1) == 0 for k in ["brainTimeouts", "memoryContextTimeouts", "memoryContextErrors"])
    check("health: zero degraded counters", zero, json.dumps(mr))
except Exception as e:
    check("health: zero degraded counters", False, f"EXC {e}")

p = sum(1 for _, ok in results if ok)
print(f"\n=== SHIP GATE: {p}/{len(results)} passed ===")
print("""
CANARY CLEANUP (manual, ~1 min):
  1. ./vodou-core call Vodou-Recall memory_reject '{"snippet":"Bluewater Provisions"}'
  2. Remove any 'Bluewater'/'Tanya Merced' bullet lines (and their indented
     'Q:' key lines) from .vodou/workspace/memory/<today>.md
  3. nohup ./vodou-hook-bin sock flush >/dev/null 2>&1 &   # MemorySync reconciles
  4. Verify: sqlite3 "file:memory.db?mode=ro" \\
       "SELECT COUNT(*) FROM memory_chunks WHERE text LIKE '%Bluewater%' AND archived=0;"  # -> 0
""")
sys.exit(0 if p == len(results) else 1)
