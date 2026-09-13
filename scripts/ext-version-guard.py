#!/usr/bin/env python3
"""ext-version-guard — the eighth pre-commit guard.

EX-5 shipped nine days late because nothing checked THIS.

`0.5.97.78` was set on 2026-08-27. Five commits then changed the Store build
without touching it — including EX-5, the readiness audit's only exploitable
finding — and the extension sat on the Chrome Web Store, at a version number
that had not moved, missing the fix. The store only enforces that a version is
unique AT UPLOAD, so two different builds can share one number and nothing
anywhere complains.

`verify-extension-version-chain.sh` already checks that Rust, the gateway and the
UI AGREE about a version. That is a different question. They agreed perfectly for
nine days while the code underneath moved. This guard asks the question nobody
was asking: **did the version move when the shipped code did?**

WHAT IT CHECKS

Staging a file that ends up in a user's browser — anything under
`extension/<build>/` except the excludes below — requires that build's
`manifest.json` `version` to be staged too, and to differ from HEAD's.

It is deliberately NOT satisfied by staging manifest.json alone: an unchanged
version with changed code is exactly the failure. The value must move.

WHAT IT DOES NOT CHECK

Whether the three builds agree with each other. `verify-extension-version-chain.sh`
and the packer's own gate cover that, and duplicating it here would mean two
places to update when a fourth build appears.

Excludes are the things the packer strips (`scripts/pack-vodou-bridge-store.sh`):
tests, store-assets, the icon builder, README, source maps. A change to those
cannot reach a user, so requiring a version bump for them would train people to
bypass — and a guard people bypass is worse than no guard.

Bypass a genuine emergency with VODOU_SKIP_EXT_VERSION_GUARD=1. The fix is
almost always to bump all three manifests and repack.

Mirrors rules-guard.py: reads the INDEX, never the working tree.
"""
import json
import os
import subprocess
import sys

if os.environ.get("VODOU_SKIP_EXT_VERSION_GUARD") == "1":
    sys.exit(0)

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True).stdout.strip()

# Mirrors the packer's rsync --exclude list. A path segment match, so
# `test/foo.mjs` and `store-assets/x.png` are both covered.
EXCLUDED_SEGMENTS = {"test", "tests", "store-assets", "node_modules", "__tests__"}
EXCLUDED_NAMES = {"build-icons.mjs", "README.md", ".DS_Store"}


def staged_files():
    out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
                         capture_output=True, text=True, cwd=ROOT).stdout
    return [p for p in out.split("\n") if p]


def ships_to_users(path):
    """Does this path end up in the packed extension?"""
    parts = path.split("/")
    if len(parts) < 3 or parts[0] != "extension":
        return False
    rest = parts[2:]
    if any(seg in EXCLUDED_SEGMENTS for seg in rest):
        return False
    if rest[-1] in EXCLUDED_NAMES or rest[-1].endswith(".map"):
        return False
    return True


def version_at(ref, build):
    """The manifest version at a git ref, or None if unreadable."""
    r = subprocess.run(["git", "show", f"{ref}:extension/{build}/manifest.json"],
                       capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout).get("version")
    except Exception:
        return None


staged = staged_files()
touched = {}
for p in staged:
    if ships_to_users(p):
        touched.setdefault(p.split("/")[1], []).append(p)

if not touched:
    sys.exit(0)

problems = []
for build, files in sorted(touched.items()):
    manifest = f"extension/{build}/manifest.json"
    head_v = version_at("HEAD", build)
    idx_v = version_at(":0", build)          # the staged (index) copy

    if idx_v is None:
        problems.append(
            f"  {build}: shipped files staged but manifest.json is unreadable in the index")
        continue
    if head_v is None:
        continue                              # brand-new build; nothing to compare
    if idx_v == head_v:
        shown = ", ".join(sorted(f.split('/', 2)[2] for f in files)[:4])
        more = "" if len(files) <= 4 else f" (+{len(files) - 4} more)"
        problems.append(
            f"  {build}: {len(files)} shipped file(s) changed — {shown}{more}\n"
            f"      version is still {head_v}. It must move, or the store serves\n"
            f"      different code under a number it has already accepted.")

if problems:
    sys.stderr.write(
        "ext-version-guard: extension code is changing without a version bump.\n\n"
        + "\n".join(problems) + "\n\n"
        "EX-5 shipped nine days late exactly this way: the version was set on\n"
        "2026-08-27, five commits changed the build, and the store kept serving\n"
        "the pre-fix code under the same number.\n\n"
        "Fix: bump `version` in ALL THREE manifests together (a shared version\n"
        "across builds with different code is its own finding), then\n"
        "  bash scripts/pack-vodou-bridge-store.sh\n"
        "(VODOU_SKIP_EXT_VERSION_GUARD=1 to bypass.)\n")
    sys.exit(1)

sys.exit(0)
