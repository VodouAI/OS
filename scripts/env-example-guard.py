#!/usr/bin/env python3
"""env-example-guard — the generator's source must agree with its output.

CD-3 (ALPHA-READINESS §9 C). `scripts/sync-env-example.mjs` regenerates the
repo-root `.env.example` FROM `scripts/env.example.manifest.json`. That is the
same generated-from-source relationship CLAUDE.md has with `templates/rules/`,
and that one has `rules-guard.py`. This pair had nothing, and it drifted on
every value anyone checked:

  · WEB_PORT                              manifest active, file commented
  · ORT_DYLIB_PATH                        manifest commented, file active
  · VODOU_ENABLE_MEMORY_COMPACT_SCHEDULE  manifest 1, file 0
  · VODOU_SCHEDULER_MAX_RUNS_PER_DAY      manifest 100, file 1000

Every one of those, if the generator were re-run, reverts a deliberate fix —
uncommenting WEB_PORT defeats auto-port-assignment; commenting ORT_DYLIB_PATH
turns semantic memory off for everyone AND breaks the packer's three
per-platform `sed`s, which anchor on `^ORT_DYLIB_PATH=`; re-enabling the compact
schedule resurrects the exact regression PLAN-DYNAMIC-MEMORY-MD fixed.

The drift is silent in both directions, which is the point: nobody re-runs the
generator, so nobody finds out. This checks the two files against each other on
every commit that touches either.

Deliberately compares KEY STATE (active vs commented, and the value), not the
whole rendered file: the descriptions come from a third file and reflowing prose
must not fail a commit. It is the load-bearing half that is checked.

Bypass: VODOU_SKIP_ENV_EXAMPLE_GUARD=1
"""
import json
import os
import re
import subprocess
import sys

if os.environ.get("VODOU_SKIP_ENV_EXAMPLE_GUARD") == "1":
    sys.exit(0)

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True).stdout.strip()
if not ROOT:
    sys.exit(0)

MANIFEST = os.path.join(ROOT, "scripts/env.example.manifest.json")
EXAMPLE = os.path.join(ROOT, ".env.example")

# Only run when one of the pair is staged — a guard that reads two files on
# every commit in a repo this size is a guard people turn off.
staged = subprocess.run(["git", "diff", "--cached", "--name-only"],
                        capture_output=True, text=True).stdout.split()
if not any(p in ("scripts/env.example.manifest.json", ".env.example",
                 "MCP-servers/Vodou-Console/src/api/env-descriptions.json")
           for p in staged):
    sys.exit(0)

if not (os.path.exists(MANIFEST) and os.path.exists(EXAMPLE)):
    sys.exit(0)


def example_state(path):
    """{KEY: (active, value)} as the .env.example file actually stands."""
    state = {}
    active = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
    commented = re.compile(r"^#\s*([A-Z][A-Z0-9_]*)=(.*)$")
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        m = active.match(line)
        if m:
            # An active line wins: a key can appear commented as an example
            # further up and live further down.
            state[m.group(1)] = (True, m.group(2).split("#")[0].strip().strip('"').strip("'"))
            continue
        m = commented.match(line)
        if m and m.group(1) not in state:
            state[m.group(1)] = (False, m.group(2).split("#")[0].strip().strip('"').strip("'"))
    return state


try:
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
except Exception as e:                      # a malformed manifest is its own bug
    print(f"env-example-guard: cannot read {MANIFEST}: {e}", file=sys.stderr)
    sys.exit(1)

have = example_state(EXAMPLE)
problems = []
for section in manifest.get("sections", []):
    for entry in section.get("keys", []):
        key = entry.get("key")
        if not key or key not in have:
            # A manifest key absent from the output is a generator concern, not
            # a drift: the descriptions file governs whether a key is rendered.
            continue
        want_active = bool(entry.get("active", False))
        # Normalise the same way both sides are normalised. The manifest stores
        # some defaults WITH their surrounding quotes ("/path/to/your/Vodou"),
        # because the generator emits them verbatim into a shell-ish file. The
        # example-side parser already strips quotes, so without this the guard
        # fires on four values that are in perfect agreement — and a guard that
        # reports agreement as drift is one people learn to bypass, which is
        # worse than no guard.
        want_value = str(entry.get("default", "")).strip().strip('"').strip("'")
        got_active, got_value = have[key]
        if want_active != got_active:
            problems.append(
                f"  {key}: manifest says {'active' if want_active else 'commented'}, "
                f".env.example has it {'active' if got_active else 'commented'}")
        elif want_value and got_value and want_value != got_value:
            problems.append(
                f"  {key}: manifest default {want_value!r} != .env.example {got_value!r}")

if problems:
    print("env-example-guard: scripts/env.example.manifest.json has drifted from .env.example.",
          file=sys.stderr)
    print("Re-running scripts/sync-env-example.mjs would silently change these:", file=sys.stderr)
    for p in problems:
        print(p, file=sys.stderr)
    print("\nFix the side that is WRONG — usually the manifest, because .env.example is what",
          file=sys.stderr)
    print("ships and gets fixed by hand. Then stage both. (VODOU_SKIP_ENV_EXAMPLE_GUARD=1 to bypass.)",
          file=sys.stderr)
    sys.exit(1)

sys.exit(0)
