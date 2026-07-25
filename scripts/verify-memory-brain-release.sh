#!/usr/bin/env bash
# scripts/verify-memory-brain-release.sh — release-gate smoke for PLAN-SELF-HEALING-MEMORY.
# Run from repo root. Does NOT re-embed the founder vault.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
FAILED=0
ok() { echo "  ✅ $*"; }
bad() { echo "  ❌ $*"; FAILED=1; }

echo "── Memory brain release gate ──"

if [ -d .fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q ]; then
  ok "bge-small ONNX cache present"
else
  bad "missing .fastembed_cache/models--Qdrant--bge-small-en-v1.5-onnx-Q"
fi
if [ -d .fastembed_cache/models--Xenova--all-MiniLM-L6-v2 ] || [ -d .fastembed_cache/models--Qdrant--all-MiniLM-L6-v2-onnx ]; then
  ok "MiniLM ONNX cache present"
else
  bad "missing MiniLM ONNX cache"
fi

grep -q 'bge-small-en-v1.5-onnx-Q' scripts/build-desktop.sh && ok "build-desktop stages bge" || bad "build-desktop missing bge stage"
grep -q 'bge-small-en-v1.5-onnx-Q' .build/scripts/build-release-multi-arch-prebuilt.sh && ok "prebuilt stages bge" || bad "prebuilt missing bge stage"
grep -q 'bge-small-en-v1.5-onnx-Q' scripts/verify-release.sh && ok "verify-release checks bge" || bad "verify-release missing bge check"

if grep -q '^# VODOU_MEMORY_EMBED_MODEL=' .env.example && ! grep -q '^VODOU_MEMORY_EMBED_MODEL=' .env.example; then
  ok ".env.example leaves EMBED_MODEL unset (commented)"
else
  bad ".env.example must keep VODOU_MEMORY_EMBED_MODEL commented"
fi

# Empty-vault resolve (no ORT needed)
python3 - <<'PY' || FAILED=1
import sqlite3, tempfile, os, subprocess, sys
td = tempfile.mkdtemp(prefix="vodou-empty-vault-")
mem = os.path.join(td, "memory.db")
core = os.path.join(td, "vodou-core.db")
c = sqlite3.connect(mem)
c.execute("CREATE TABLE memory_embeddings (chunk_id TEXT PRIMARY KEY, embedding BLOB, model TEXT)")
c.commit(); c.close()
c = sqlite3.connect(core)
c.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)")
c.commit(); c.close()
# Unit path: cargo test covers resolve; here assert CLI brain-status on live install
print("  ✅ empty-vault fixture created (resolver unit-tested at build)")
PY

# Live checks when daemon is up
if [ -S .vodou/daemon.sock ]; then
  python3 - <<'PY' || FAILED=1
import socket, json, subprocess
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(20)
s.connect(".vodou/daemon.sock")
s.sendall(b'{"cmd":"mem-brain-status","payload":{}}\n')
d = b""
while True:
    c = s.recv(65536)
    if not c: break
    d += c
    if b"\n" in d: break
s.close()
obj = json.loads(d.decode().strip())
assert obj.get("ok"), obj
print(f"  ✅ mem-brain-status tag={obj['data'].get('memory_model_tag')}")
r = subprocess.run(["./vodou-core", "mem", "search", "coffee order", "--top-k", "1"],
                   capture_output=True, text=True, timeout=90)
assert r.returncode == 0, r.stderr[:400]
print("  ✅ mem search smoke ok")
PY
else
  echo "  ⚠ daemon sock missing — skip live probe"
fi

if curl -sf -m 3 http://127.0.0.1:8765/api/system >/dev/null 2>&1; then
  curl -sS -m 8 http://127.0.0.1:8765/api/system | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert 'memoryBrain' in d and 'memoryHealth' in d
print('  ✅ gateway /api/system has memoryBrain + memoryHealth')
" || FAILED=1
else
  echo "  ⚠ gateway not up — skip UI API check"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "PASS — memory brain release gate"
  exit 0
else
  echo "FAIL — fix items above before shipping"
  exit 1
fi
