#!/usr/bin/env python3
"""
verify-cws-claims — do the Chrome Web Store justifications still describe the code?

PLAN-MEMORY-ON-EVERY-PAGE P1 compliance bundle. Run before every CWS upload:

    python3 scripts/verify-cws-claims.py            # exit 1 if a claim is stale
    python3 scripts/verify-cws-claims.py --counts   # just print what the code does

WHY THIS EXISTS. The permission justifications assert COUNTS — "exactly three
executeScript calls", "a single right-click menu item", "there is no setBadgeText
anywhere". Every one of them was true when written and every one of them rotted:

    claim                       written   audit 2026-08-16   actual 2026-08-17
    executeScript call sites    3         6                  7
    contextMenus items          1         3                  3
    badge/title writes          0         8                  8
    sidePanel shortcuts         3         5                  5

Nobody edited a justification to make it false. The code moved, seven times, and
a markdown file cannot notice. Metadata is also not a cosmetic risk here: .52 was
REJECTED on metadata (keyword spam, 2026-08-02), and an inaccurate permission
justification is the same class of finding.

So the numbers stop being prose and become assertions. A reviewer-facing claim that
no longer matches the package fails the build instead of failing the review.

NOT A LINTER FOR PROSE. It checks the countable claims only — the ones with a
right answer. Judgement calls (is this "Web history"? does the single-purpose field
describe every lane?) are listed by `--counts` for a human, never auto-approved.
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXT = REPO / "extension" / "Store-vodou-bridge"
JUSTIFY = REPO / "PLANS" / "0.6.21-Browser-ext" / "extention" / "CWS-PERMISSION-JUSTIFICATIONS.md"


def strip_comments(js: str) -> str:
    """Drop lines that are purely commentary, so prose ABOUT a call is not counted
    as a call. (Counting comments is how the plan's audit derived "six
    executeScript calls" from a file that has seven.)

    LINE-BASED ON PURPOSE. The obvious `re.sub(r"/\\*.*?\\*/", "", js, flags=S)`
    was tried first and silently ate a REAL call site — 7 became 6 — because a
    `/*` inside a string or regex literal swallowed the code after it. In a
    document a reviewer reads, under-counting is far worse than over-counting:
    it turns "we do this seven times" into an understatement of our own access,
    which is the exact class of finding that got .52 rejected. So this only ever
    drops a line whose FIRST non-space characters open a comment, and never
    reaches inside a line.
    """
    out = []
    for line in js.split("\n"):
        s = line.lstrip()
        out.append("" if s.startswith("//") or s.startswith("*") or s.startswith("/*") else line)
    return "\n".join(out)


def counts() -> dict:
    bg = strip_comments((EXT / "background.js").read_text(errors="replace"))
    manifest = json.loads((EXT / "manifest.json").read_text())
    panel_files = [p for p in EXT.glob("*.js")]

    # Any lane that reads the FOCUSED tab's url/title, whatever the host. This is
    # the input to the "Web history" question and the reason it cannot be
    # answered from `sendActiveTab` alone — that one IS host-gated, and these
    # are not.
    any_tab_lanes = []
    for f in panel_files:
        src = strip_comments(f.read_text(errors="replace"))
        for m in re.finditer(r"chrome\.tabs\.query\s*\(\s*\{[^}]*active\s*:\s*true", src):
            line = src[: m.start()].count("\n") + 1
            gated = "isSupportedTabHost" in src[m.start() : m.start() + 1200]
            any_tab_lanes.append({"file": f.name, "line": line, "host_gated": gated})

    return {
        "executeScript": len(re.findall(r"executeScript\s*\(", bg)),
        "contextMenus": len(re.findall(r"contextMenus\.create\s*\(", bg)),
        "badge_or_title_writes": len(
            re.findall(r"\b(?:setBadgeText|setBadgeBackgroundColor|setTitle|setIcon)\s*\(", bg)
        ),
        "notifications": len(re.findall(r"notifications\.create\s*\(", bg)),
        "commands": sorted((manifest.get("commands") or {}).keys()),
        "permissions": sorted(manifest.get("permissions") or []),
        "host_permissions": manifest.get("host_permissions") or [],
        "optional_host_permissions": manifest.get("optional_host_permissions") or [],
        "version": manifest.get("version"),
        "any_tab_url_lanes": any_tab_lanes,
    }


def check(c: dict) -> list:
    """Assertions the justification doc makes. Each is (ok, message)."""
    raw = JUSTIFY.read_text(errors="replace") if JUSTIFY.exists() else ""
    # BLOCKQUOTES ARE HISTORY, NOT CLAIMS. Every correction in that document quotes
    # the wrong sentence it is retiring ("this said 'EXACTLY three…'"), which is the
    # whole value of the note — and a naive substring search reads the quotation as
    # the defect and fails forever. Only un-quoted text is a live claim to a
    # reviewer, so `>` lines are dropped before matching.
    doc = "\n".join(l for l in raw.split("\n") if not l.lstrip().startswith(">"))
    fails = []

    def claim(ok, msg):
        if not ok:
            fails.append(msg)

    # These are the exact phrasings that rotted. Matching on the STALE text means
    # a corrected doc passes and a reverted one fails.
    claim(
        "EXACTLY three executeScript" not in doc,
        f"justification still says 'EXACTLY three executeScript'; the package has {c['executeScript']}",
    )
    claim(
        "a single right-click menu item" not in doc,
        f"justification still says 'a single right-click menu item'; the package creates {c['contextMenus']}",
    )
    claim(
        "does not inspect tabs outside the supported sites" not in doc,
        "justification still says 'does not inspect tabs outside the supported sites'; "
        f"{len([l for l in c['any_tab_url_lanes'] if not l['host_gated']])} lanes read the "
        "focused tab's URL with no host gate (page memory, document match, Console Two)",
    )
    claim(
        "no `setBadgeText`" not in doc and "no setBadgeText" not in doc,
        f"justification still claims there is no setBadgeText; the package has "
        f"{c['badge_or_title_writes']} badge/title writes",
    )

    # A count written into the doc must match. Free-form prose is fine; a number
    # beside these words is a promise to a reviewer. Spelled-out numbers count
    # too — "seven executeScript" and "three items" slipped past a digits-only
    # regex on 2026-08-18 while the package had eight and four.
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
    num = r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten)"
    for label, key in (("executeScript", "executeScript"), ("context menu", "contextMenus"), ("right-click menu items?", "contextMenus")):
        for m in re.finditer(rf"\b{num}\b(?:\*\*)?\s+(?:`)?{label}", doc, re.I):
            n = m.group(1).lower()
            n = int(n) if n.isdigit() else words[n]
            claim(
                n == c[key],
                f"justification says '{m.group(0)}' but the package has {c[key]}",
            )

    n_cmds = len(c["commands"])
    for m in re.finditer(r"(three|four|five|six)\s+(?:keyboard\s+)?shortcuts?", doc, re.I):
        words = {"three": 3, "four": 4, "five": 5, "six": 6}
        claim(
            words[m.group(1).lower()] == n_cmds,
            f"justification says '{m.group(0)}' but the manifest declares {n_cmds} commands: {c['commands']}",
        )

    # P5 (0.5.97.75+): optional_host_permissions IS declared — per-site grants the
    # user makes from the panel. It must be justified in the doc (a declared
    # optional permission with no justification is the review question), and it
    # must stay OPTIONAL: any required broad host pattern would flip the install
    # warning to "read and change all your data on all websites" and disable the
    # extension on update.
    if c["optional_host_permissions"]:
        claim(
            "optional_host_permissions" in doc and "Enable Vodou on this site" in doc,
            "manifest declares optional_host_permissions but the justification doc has no "
            "`optional_host_permissions` section naming the per-site \"Enable Vodou on this site\" flow",
        )
    broad = [h for h in c["host_permissions"] if h in ("<all_urls>", "*://*/*", "https://*/*", "http://*/*")]
    claim(not broad, f"REQUIRED host_permissions contains a broad pattern {broad}; site access must stay optional (P5)")

    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--counts", action="store_true", help="print what the code does and exit 0")
    args = ap.parse_args()

    c = counts()
    if args.counts:
        print(json.dumps(c, indent=2))
        return 0

    print(f"CWS claim check — extension {c['version']}\n")
    for k in ("executeScript", "contextMenus", "badge_or_title_writes", "notifications"):
        print(f"  {k:24} {c[k]}")
    print(f"  {'commands':24} {len(c['commands'])}  {c['commands']}")

    ungated = [l for l in c["any_tab_url_lanes"] if not l["host_gated"]]
    print(f"\n  lanes reading the focused tab's URL: {len(c['any_tab_url_lanes'])} "
          f"({len(ungated)} NOT host-gated)")
    for l in c["any_tab_url_lanes"]:
        print(f"    {'host-gated' if l['host_gated'] else 'ANY HOST '}  {l['file']}:{l['line']}")
    if ungated:
        print("\n  ⚠ JUDGEMENT CALL, not auto-checked: a lane that reads the focused tab's URL on"
              "\n    ANY host is the basis of the privacy form's 'Web history' answer. Local-only"
              "\n    processing does not exempt it (CWS User-Data FAQ Q3).")

    fails = check(c)
    if fails:
        print(f"\n✗ {len(fails)} stale claim(s):")
        for f in fails:
            print(f"    - {f}")
        return 1
    print("\n✓ every countable claim matches the package")
    return 0


if __name__ == "__main__":
    sys.exit(main())
