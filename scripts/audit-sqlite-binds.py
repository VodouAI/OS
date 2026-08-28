#!/usr/bin/env python3
"""
CONSOLE §7 S-3 — find `node:sqlite` binds that can receive `undefined`.

`DatabaseSync` accepts string | number | bigint | null | Buffer and REJECTS
`undefined` with:

    TypeError: Provided value cannot be bound to SQLite parameter N.

That message names a POSITIONAL INDEX, not a column, which is why `add_thought`
stayed 100% broken for months before anyone traced it (§7.1). A TypeScript cast
(`args.x as number`) is erased at runtime, so the type system cannot catch it
either.

This flags the shape that produces it: a `.run()/.get()/.all()` argument that is
a bare property access with no `??`, no `||`, and no literal default — i.e. a
value that is `undefined` whenever the caller omitted the field.

It is a LINTER, not a prover: it reports candidates ranked by how reachable the
value is from untrusted input. Verify before changing anything.

Usage:  audit-sqlite-binds.py [--json]
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "MCP-servers")
SERVERS = [
    "brain",
    "Vodou-Board",
    "Vodou-channels",
    "ExecDesk-Console",
    "Vodou-Console",
    "Vodou-Enhanced-Thinking",
]

CALL_RE = re.compile(r"\.(run|get|all)\s*\(", re.S)
# A bare `a.b` / `a.b.c` / `a[0].b` with no defaulting operator anywhere in it.
BARE_PROP_RE = re.compile(r"^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])+$")
GUARDED = ("??", "||", "?.", "JSON.stringify", "String(", "Number(", "Boolean(")


def split_args(s: str):
    """Split a call's argument list on top-level commas."""
    out, depth, cur, instr, q = [], 0, "", False, ""
    i = 0
    while i < len(s):
        c = s[i]
        if instr:
            if c == "\\":
                cur += c + (s[i + 1] if i + 1 < len(s) else "")
                i += 2
                continue
            if c == q:
                instr = False
            cur += c
        elif c in "\"'`":
            instr, q = True, c
            cur += c
        elif c in "([{":
            depth += 1
            cur += c
        elif c in ")]}":
            if depth == 0:
                out.append(cur)
                return out, i
            depth -= 1
            cur += c
        elif c == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out, len(s)


def scan(path):
    src = open(path, encoding="utf-8", errors="replace").read()
    findings = []
    for m in CALL_RE.finditer(src):
        args, _ = split_args(src[m.end():])
        for idx, raw in enumerate(args, start=1):
            a = raw.strip()
            if not a or any(g in a for g in GUARDED):
                continue
            if not BARE_PROP_RE.match(a):
                continue
            line = src[: m.start()].count("\n") + 1
            findings.append(
                {
                    "file": os.path.relpath(path, ROOT),
                    "line": line,
                    "param": idx,
                    "expr": a,
                    "method": m.group(1),
                }
            )
    return findings


def main():
    all_f = []
    for srv in SERVERS:
        base = os.path.join(ROOT, srv, "src")
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "dist", "__tests__")]
            for fn in filenames:
                if fn.endswith((".ts", ".js")) and not fn.endswith(".d.ts"):
                    all_f.extend(scan(os.path.join(dirpath, fn)))

    if "--json" in sys.argv:
        print(json.dumps(all_f, indent=1))
        return

    print(f"unguarded bind candidates: {len(all_f)}\n")
    by_file = {}
    for f in all_f:
        by_file.setdefault(f["file"], []).append(f)
    for fl in sorted(by_file, key=lambda k: -len(by_file[k])):
        print(f"  {fl}  ({len(by_file[fl])})")
        for f in by_file[fl][:8]:
            print(f"      :{f['line']}  .{f['method']}()  param {f['param']}  {f['expr']}")


if __name__ == "__main__":
    main()
