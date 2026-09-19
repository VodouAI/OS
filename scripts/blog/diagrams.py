#!/usr/bin/env python3
"""vodou-diagram fences: one owner for validating, counting and inserting them.

The remark plugin THROWS on a malformed spec, and it runs inside `astro build`.
So one bad diagram does not damage one post, it fails the build, which kills
the deploy for every post. Everything that puts a diagram into a post therefore
comes through here and gets DOWNGRADED when it cannot be proven good: a dropped
diagram costs one image, a thrown build costs the site.

This used to be a heredoc inside write-feature-post.sh that ran on the first
draft only. The revision pass rewrites the whole body and its diagrams were
never re-validated, so a typo introduced by the reviser could reach the build.

  diagrams.py validate FILE        drop invalid specs in place; prints kept count
  diagrams.py count FILE           prints the number of vodou-diagram fences
  diagrams.py insert FILE RAW      insert valid specs from an LLM reply; prints count

RAW format for insert, one or more of:
  AFTER: <exact text of an H2 in the post>
  ```vodou-diagram
  {...}
  ```
"""
import json
import re
import sys

TYPES = {"flow", "bars", "timeline", "beforeafter"}
FENCE_BODY = re.compile(r'```vodou-diagram\s*\n(.*?)\n```', re.S)
FENCE_OPEN = re.compile(r'^```vodou-diagram\s*$', re.M)


def check(spec):
    if not isinstance(spec, dict):                   return "not an object"
    t = spec.get("type")
    if t not in TYPES:                               return f"unknown type {t!r}"
    if not isinstance(spec.get("alt"), str) or len(spec["alt"].strip()) < 8:
        return "missing or too-short alt"
    if t == "flow":
        nodes = spec.get("nodes"); edges = spec.get("edges", [])
        if not isinstance(nodes, list) or not nodes: return "flow has no nodes"
        ids = {n.get("id") for n in nodes if isinstance(n, dict)}
        if len(ids) != len(nodes):                   return "duplicate/missing node ids"
        for n in nodes:
            if not isinstance(n, dict) or not n.get("id") or not n.get("label"):
                return "node missing id/label"
        if not isinstance(edges, list):              return "edges not a list"
        for e in edges:
            if not isinstance(e, dict):              return "edge not an object"
            # The exact case that throws in the renderer: an edge to a ghost node.
            if e.get("from") not in ids or e.get("to") not in ids:
                return f"edge {e.get('from')}->{e.get('to')} references a missing node"
    elif t == "bars":
        bars = spec.get("bars")
        if not isinstance(bars, list) or not bars:   return "bars has no bars"
        for b in bars:
            if not isinstance(b, dict) or not b.get("label"): return "bar missing label"
            if not isinstance(b.get("value"), (int, float)):  return "bar value not a number"
    elif t == "timeline":
        ev = spec.get("events")
        if not isinstance(ev, list) or not ev:       return "timeline has no events"
        for e in ev:
            if not isinstance(e, dict) or not e.get("label"): return "event missing label"
    elif t == "beforeafter":
        for side in ("before", "after"):
            d = spec.get(side)
            if not isinstance(d, dict):              return f"{side} not an object"
            if not isinstance(d.get("lines"), list) or not d["lines"]:
                return f"{side} has no lines"
    return None


def canonical(spec):
    # The renderer seeds its jitter from a hash of the spec text, so a stable
    # serialization keeps rebuilds byte-identical and stops every deploy
    # re-uploading pages that did not change.
    return "```vodou-diagram\n" + json.dumps(spec, sort_keys=True, indent=1) + "\n```"


def parse_spec(raw):
    try:
        spec = json.loads(raw)
    except Exception as e:
        return None, f"invalid JSON ({e})"
    err = check(spec)
    return (None, err) if err else (spec, None)


def validate_text(s):
    kept = dropped = 0
    msgs = []

    def repl(m):
        nonlocal kept, dropped
        spec, err = parse_spec(m.group(1))
        if err:
            dropped += 1
            msgs.append(f"  dropped diagram: {err}")
            return ""
        kept += 1
        return canonical(spec)

    s2 = FENCE_BODY.sub(repl, s)
    s2 = re.sub(r'\n{3,}', '\n\n', s2)
    return s2, kept, dropped, msgs


def insert_block(body, block, after_heading=None):
    """Insert `block` after the first paragraph that follows an H2.

    `after_heading` picks the H2 (case/punctuation-insensitive); when it is not
    found, or not given, the first H2 is used, and with no H2 at all the first
    paragraph of the body. Never inserts inside a code fence. The paragraph is
    the anchor, not the heading line, so a figure lands under the sentence that
    introduces it instead of between a heading and its text.
    """
    def norm(h):
        return re.sub(r'[^a-z0-9]+', ' ', h.lower()).strip()

    lines = body.split('\n')
    in_fence = False
    h2 = []
    for i, l in enumerate(lines):
        if l.startswith('```'):
            in_fence = not in_fence
            continue
        if not in_fence and re.match(r'^##\s+\S', l):
            h2.append(i)
    start = 0
    if h2:
        start = h2[0] + 1
        if after_heading:
            want = norm(after_heading)
            for i in h2:
                if norm(lines[i][2:]) == want:
                    start = i + 1
                    break

    i = start
    in_fence = False
    para = False
    while i < len(lines):
        l = lines[i]
        if l.startswith('```'):
            in_fence = not in_fence
            i += 1
            continue
        if in_fence:
            i += 1
            continue
        if not para:
            if l.strip() and not l.startswith('#') and not l.startswith('!['):
                para = True
        elif not l.strip():
            break
        elif l.startswith('#'):
            break
        i += 1
    lines[i:i] = ['', block, '']
    out = '\n'.join(lines)
    return re.sub(r'\n{3,}', '\n\n', out)


def split_fm(raw):
    if raw.startswith('---'):
        parts = raw.split('---', 2)
        if len(parts) == 3:
            return '---' + parts[1] + '---', parts[2]
    return '', raw


def main(argv):
    if len(argv) < 3 or argv[1] not in ("validate", "count", "insert"):
        print(__doc__, file=sys.stderr)
        return 64
    cmd, path = argv[1], argv[2]
    s = open(path, encoding="utf-8").read()
    if cmd == "count":
        print(len(FENCE_OPEN.findall(s)))
        return 0
    if cmd == "validate":
        s2, kept, dropped, msgs = validate_text(s)
        for m in msgs:
            print(m, file=sys.stderr)
        open(path, "w", encoding="utf-8").write(s2)
        print(f"diagrams: {kept} kept, {dropped} dropped", file=sys.stderr)
        print(kept)
        return 0
    # insert
    if len(argv) < 4:
        print("insert needs FILE RAW", file=sys.stderr)
        return 64
    raw = open(argv[3], encoding="utf-8", errors="replace").read()
    fm, body = split_fm(s)
    added = 0
    for m in re.finditer(r'(?:AFTER:\s*(.+?)\s*\n)?\s*```vodou-diagram\s*\n(.*?)\n```', raw, re.S):
        spec, err = parse_spec(m.group(2))
        if err:
            print(f"  rejected added diagram: {err}", file=sys.stderr)
            continue
        body = insert_block(body, canonical(spec), (m.group(1) or '').lstrip('#').strip() or None)
        added += 1
        if added >= 2:
            break
    if added:
        open(path, "w", encoding="utf-8").write(fm + ('\n' if fm and not body.startswith('\n') else '') + body)
    print(added)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
