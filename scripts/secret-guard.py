#!/usr/bin/env python3
"""secret-guard — block commits that stage a credential VALUE.

Why this exists (2026-08-01): a real Figma personal access token
(`figd_…`) sat in `.build/templates/config.json.example` from the initial
commit until it was found BY ACCIDENT while sanitising file paths. Three
layers already existed and none of them could have caught it:

  * scripts/verify-release.sh scans shipped ARCHIVES — that file never ships.
  * .git/hooks/pre-commit ran commit-guard.py, which checks module/import
    consistency and has no notion of secrets.
  * GitHub push protection only sees PUBLIC pushes; this repo is private.
    (It did later catch an `sk_live_`-shaped TEST FIXTURE on the OSS sync —
    proving the pattern class works, just at the wrong moment: after the
    value is already in history.)

So the gap was never "no scanning" — it was that nothing scanned key VALUES
at commit time, which is the only moment a secret can still be kept out of
history. This closes that.

Patterns are shared with the release scan (.build/release-pii-patterns.txt),
so a new key shape is added in ONE place and both layers get it. That file
lives outside the shipped surface on purpose: putting operator PII patterns
under scripts/ would itself leak them.

Scans the STAGED CONTENT (`git diff --cached`), added lines only:
  * staged content is what actually enters history — the worktree is not
  * added lines only, so a pre-existing secret elsewhere in a file you are
    editing does not block unrelated work (and is reported by the release
    scan / a full sweep instead)

Bypass, for the case where a pattern is genuinely a false positive:
  VODOU_SKIP_SECRET_GUARD=1 git commit ...   (or git commit --no-verify)

If you bypass, prefer FIXING THE STRING instead. The `sk_live_` fixture that
tripped GitHub was a synthetic test value — the right fix was to make the
fixture not key-shaped, not to whitelist it forever.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

PATTERN_FILE = Path(__file__).resolve().parent.parent / ".build" / "release-pii-patterns.txt"

# Operator-PII patterns are for shipped archives, not for commits — this repo is
# full of legitimate /Users/chad paths and linkies.com references. Only the
# credential-VALUE block is enforced here, marked by this header in the file.
VALUE_SECTION = "Credential VALUE patterns"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True, check=False).stdout


def load_value_patterns() -> list[str]:
    """Patterns AFTER the credential-value header. Empty list if absent."""
    if not PATTERN_FILE.exists():
        return []
    pats, in_section = [], False
    for line in PATTERN_FILE.read_text(encoding="utf-8").splitlines():
        if VALUE_SECTION in line:
            in_section = True
            continue
        if not in_section:
            continue
        s = line.strip()
        # BINARY-SCAN lines belong to verify-release.sh's binary pass, not here.
        # Loading them as patterns made this guard match its OWN pattern file: the
        # line "BINARY-SCAN 5862013686" is itself a literal match for the regex
        # "BINARY-SCAN 5862013686", so adding that section blocked every commit
        # touching it (2026-08-03). The values are already covered by the operator-PII
        # entries above, which this guard deliberately does not enforce at commit time.
        if s.startswith("BINARY-SCAN "):
            continue
        if s and not s.startswith("#"):
            pats.append(s)
    return pats


def main() -> int:
    if os.environ.get("VODOU_SKIP_SECRET_GUARD") == "1":
        return 0

    patterns = load_value_patterns()
    if not patterns:
        # Absent pattern file (e.g. a CI checkout without .build/) must not block
        # commits — but say so, because a silent no-op guard is how this class of
        # bug survives in the first place.
        sys.stderr.write(f"secret-guard: {PATTERN_FILE} absent or has no value section — scan skipped.\n")
        return 0

    try:
        compiled = [(p, re.compile(p)) for p in patterns]
    except re.error as e:
        sys.stderr.write(f"secret-guard: bad pattern in {PATTERN_FILE.name}: {e}\n")
        return 1

    # Added lines only, with the file they belong to.
    diff = git("diff", "--cached", "--unified=0", "--no-color")
    hits, current = [], "?"
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            current = line[6:]
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        body = line[1:]
        for src, rx in compiled:
            m = rx.search(body)
            if m:
                # Never print the secret. Show enough to locate it, nothing usable.
                found = m.group(0)
                shown = found[:6] + "…" + f"[{len(found)} chars]"
                hits.append((current, src, shown))
                break

    if hits:
        sys.stderr.write(
            "\nsecret-guard: a credential VALUE is staged — refusing.\n"
            "Committing it writes it into history, where removing the file later does NOT remove it.\n\n"
        )
        for path, pat, shown in hits:
            sys.stderr.write(f"  ✗ {path}\n      matches /{pat}/  →  {shown}\n")
        sys.stderr.write(
            "\nFix: replace the value with a placeholder (YOUR_API_KEY) and read the real one\n"
            "from the environment. If it is a TEST FIXTURE, make it not key-shaped — a\n"
            "realistic-looking fake trips every scanner forever.\n"
            "If the value was ever real, REVOKE it: it is already on this disk.\n\n"
            "Bypass (only for a true false positive): VODOU_SKIP_SECRET_GUARD=1 git commit ...\n\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
