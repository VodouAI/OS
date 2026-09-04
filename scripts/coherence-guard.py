#!/usr/bin/env python3
"""coherence-guard — the COHERENCE seam audit's rules, as a guard.

Why this exists (PLANS/0.6.27/COHERENCE, Phase 4). The audit found 40 ways the
product told a user something that was not true about itself, and fixed them.
Fixing them is not the point. The plan says so plainly:

    "The audit must not stay an event... the difference between an inspection
     and a smoke detector."

Nobody reviews here in the human sense, so a rule that lives in prose is a rule
that lapses. The working idiom is the guard family — commit-guard, secret-guard,
date-guard: scripts that read the diff and fail the commit. These are §7.1's
three named rules in that form.

WHAT IS ENFORCED (rule numbers are §7's):

  Rule 7 · Internal taxonomy never reaches a user's eye.
    A raw `scope` / enum written into textContent, innerHTML or an HTML
    template. F7: 32,392 of 47,722 chunks (68%) displayed their origin as
    `web` or `workbench` — and `web` was not even true, it was the no-token
    default. The allowed path is `scope_label()`, which has a total mapping
    and a human-word fallback.

  Rule 8 · No new prompt-injection lane without a registry entry.
    PLAN-CONTEXT-COORDINATION P6. A staged line that introduces a lane name
    literal (`lane: 'x'`, `"lane": "x"`, `append_turn_receipt_lane(.., "x"`)
    must name a stanza in lanes.toml carrying `budget` and `trust`. Seven
    injectors accumulated with nobody deciding to have seven; the eighth
    arrived with a private budget eleven minutes after a shared one was
    agreed, because there was nothing to register with.

  Rule 9 · The product never misreports itself.
    A `*_count` displayed by one module that no module writes. F10: the board
    UI showed `run_count` for skills; nothing incremented it, so every skill
    read "never run". A counter that can be wrong is worse than one that is
    absent.

  Rule 5 · A layout crosses a host only with a width contract.
    An iframe with no declared minimum width nearby. F5: clicking Apps in a
    narrow side panel framed a full console screen into ~380px and produced a
    squashed, unusable view of another app.

THE ESCAPE HATCH IS PART OF THE DESIGN, not a concession:

    // COHERENCE-INTENTIONAL: <why>

anywhere in the same hunk. MEMORY.md is *deliberately* dual-injected and
documented as such; a rule system that cannot express "duplication by design"
gets bypassed once and ignored forever. Say why, in the diff, where the next
reader will find it.

Bypass the whole guard for a true false-positive:
    VODOU_SKIP_COHERENCE_GUARD=1 git commit ...
If you reach for that twice for the same reason, the rule is wrong — fix the
rule here rather than training yourself past it.
"""

import os
import re
import subprocess
import sys

# WHAT THIS GUARDS, and why it is not the whole repo.
#
# The audit's §5 flows are about the SHIPPING product: the extension panel, the
# Vodou-Console gateway, and the engine. `start-vodou-services.sh` boots exactly
# one console — `MCP-servers/Vodou-Console` — and references neither
# `ExecDesk-Console` (398 files) nor `ARCHIVE/Vodou-Console-NEW` (186, archived 2026-09-02). Those trees
# carry real instances of these defects (a calibration sweep found 55 raw-scope
# renders across them) and are deliberately NOT guarded: a rule that fires on
# code nobody ships is a rule people learn to bypass, and the plan is explicit
# that a bypassed rule is worse than none. If either tree becomes live, add it
# here and expect to fix what the guard then finds.
GUARDED = (
    "extension/Store-vodou-bridge/",
    "MCP-servers/Vodou-Console/src/",
    "MCP-servers/Vodou-Console/public/",
    "src/",
)
SKIP_DIRS = ("node_modules/", ".build/", "target/", "dist/", "vendor/", "test/", "tests/", "__tests__/")
HATCH = re.compile(r"COHERENCE-INTENTIONAL:")

# ── Rule 7 ────────────────────────────────────────────────────────────────
# A DOM sink, or an HTML template hole, fed by a RAW scope field. `scope_label`
# and `scopeLabel` are the sanctioned path and must not match, which is why the
# field name is bounded on both sides.
# Not followed by a TEST. `data.scope === 'memory' ? 'Memory' : 'Web'` and
# `state.scope ? \`from ${label(state.scope)}\` : ''` both render the ternary's
# branches, never the value; the raw scope is the condition. Flagging either
# taught nothing and cost a hatch, which is how a rule earns a reputation for
# crying wolf. Both shapes found in the first week of real use.
RAW_SCOPE = r"(?:chunk_scope|(?<![\w])scope)(?![\w])(?!\s*(?:[!=]==?|\?))"
# The sanctioned path: `scopeLabel(x)` / `scope_label(x)`. Stripped before the
# rules run — see the note at the call site.
SANCTIONED_CALL = re.compile(r"scope_?[Ll]abel\s*\([^)]*\)")
RULE7 = [
    re.compile(rf"(?:textContent|innerHTML|innerText)\s*=\s*(?![=]).{{0,100}}\.{RAW_SCOPE}"),
    re.compile(rf"\$\{{[^}}]*\.{RAW_SCOPE}[^}}]*\}}"),
]

# ── Rule 9 ────────────────────────────────────────────────────────────────
# Something displays a counter. Captured so the writer search can name it.
RULE9_DISPLAY = re.compile(
    r"(?:textContent|innerHTML|innerText)\s*=\s*(?![=]).{0,120}?\.(\w*_count)\b"
    r"|\$\{[^}]*\.(\w*_count)\b[^}]*\}"
)

# ── Rule 5 ────────────────────────────────────────────────────────────────
# ONLY framing one of our OWN surfaces. F5 was a console screen rendered into a
# ~380px side panel, not an embed: a third-party video or a PDF blob has no
# width contract to declare and flagging them taught nothing. So the src must
# look like an internal route.
RULE5_FRAME = re.compile(r"(?:<iframe|createElement\(\s*['\"]iframe['\"])")
RULE5_INTERNAL = re.compile(r"src\s*=\s*[\"'`]\s*/(?!/|api/)|\bpane-frame\b|/two/|consoleUrl|screenUrl")
# A width contract is not always spelled in CSS. `two.js` declares
# `PANEL_MAX = 560` and gates framing on `innerWidth > PANEL_MAX`, with a
# fallback that opens the screen in a tab — a complete, correct contract that a
# `min-width` grep cannot see. It cost a false finding (F43, filed off a grep
# hit and closed on reading the code), which is the failure mode §7.1 warns
# about: a rule that fires on correct work gets bypassed and then ignored.
RULE5_CONTRACT = re.compile(
    r"min-width|minWidth|MIN_WIDTH|minimumWidth"
    r"|innerWidth\s*[<>]|clientWidth\s*[<>]|offsetWidth\s*[<>]"
    r"|[A-Z_]*(?:MAX|MIN)_?WIDTH|PANEL_MAX"
)


def staged_hunks():
    """Yield (path, added_lines, all_hunk_lines) per hunk of the staged diff."""
    out = subprocess.run(
        ["git", "diff", "--cached", "--no-color", "-U3"],
        capture_output=True, text=True, check=False,
    ).stdout
    path, added, ctx = None, [], []
    for line in out.splitlines():
        if line.startswith("+++ b/"):
            if path and added:
                yield path, added, ctx
            path, added, ctx = line[6:], [], []
        elif line.startswith("@@"):
            if path and added:
                yield path, added, ctx
            added, ctx = [], []
        elif line.startswith("+") and not line.startswith("+++"):
            added.append(line[1:])
            ctx.append(line[1:])
        elif line.startswith((" ", "-")) and not line.startswith("---"):
            ctx.append(line[1:])
    if path and added:
        yield path, added, ctx


def is_our_column(column: str) -> bool:
    """Is this a column of OURS, or a field off someone else's payload?

    A lens renderer showing `model.comment_count` from a social embed is not
    F10 — we do not own that number and cannot write it. F10 is specifically a
    column in OUR schema that a display reads and no writer maintains, so the
    schema is the gate.
    """
    r = subprocess.run(
        ["git", "grep", "-lP", rf"\b{column}\b", "--", "*.sql", "migrations/*", "*.rs"],
        capture_output=True, text=True, check=False,
    )
    return bool(r.stdout.strip())


def contract_nearby(path: str) -> bool:
    """Does a sibling module already declare the width contract?

    Markup and its behaviour live in different files: `two/index.html` holds the
    iframe, `two/two.js` holds `PANEL_MAX` and the tab fallback. Judging the
    markup alone reports a contract-less frame where a complete contract exists
    one file over — which is exactly what F43 was, and F43 was wrong.

    Deliberately narrow: the SAME directory only. A contract two directories
    away is not a contract this frame can be said to honour, and widening the
    search until nothing ever fires would leave the rule enforcing nothing.
    """
    d = os.path.dirname(path) or "."
    try:
        names = os.listdir(d)
    except OSError:
        return False
    for name in names:
        if not name.endswith((".js", ".mjs", ".ts", ".css", ".html")):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8", errors="ignore") as fh:
                if RULE5_CONTRACT.search(fh.read()):
                    return True
        except OSError:
            continue
    return False


def writes_anywhere(column: str) -> bool:
    """Does ANY code write this counter? A SQL alias counts — it is computed."""
    # -P, not -E. `git grep -E` is POSIX ERE: \b and \s are not portable there
    # and matched nothing, so a first cut of this guard reported EVERY counter
    # as unwritten — including run_count, which three Rust modules write. A
    # guard that fires on everything is a guard that gets switched off.
    r = subprocess.run(
        ["git", "grep", "-lP",
         rf"(SET[^;]*\b{column}\b|\b{column}\s*=|\b{column}\s*\+|\bAS\s+{column}\b|INSERT[^;]*\b{column}\b)",
         "--", "*.rs", "*.ts", "*.js", "*.mjs", "*.sql", "*.py"],
        capture_output=True, text=True, check=False,
    )
    return bool(r.stdout.strip())


# ── Rule 8 ──────────────────────────────────────────────────────────────────
LANE_LITERAL = re.compile(r"""(?:\blane\b\s*[:=]\s*|_receipt_lane\([^,]+,\s*)['"]([a-z][a-z0-9_]*)['"]""")
LANE_TERNARY = re.compile(r"""\blane\s*:\s*[^,]*?\?\s*['"]([a-z][a-z0-9_]*)['"]\s*:\s*['"]([a-z][a-z0-9_]*)['"]""")
LANE_FILES = ("MCP-servers/Vodou-Console/src/", "src/", "vodou-hook/src/", ".claude/hooks/")

# A second, older namespace also spells its values `lane:` — `persistCaptureTurn`'s
# TRANSPORT lane (`'web' | 'manual'`, bridge.ts:1225), which says how a captured turn
# arrived, not what went into a prompt. Two systems, one word: the exact shape
# `seam-spelled-in-one-file-with-a-gate` warns about, met here in the guard rather
# than in the product. Scoped to the two files that OWN that type, and to its two
# declared values, so any other lane name in those files still fails the rule — and
# so a prompt lane genuinely called `web` elsewhere is still caught.
CAPTURE_LANE_FILES = (
    "MCP-servers/Vodou-Console/src/api/memory-capture.ts",
    "MCP-servers/Vodou-Console/src/vbb/bridge.ts",
)
CAPTURE_LANES = {"web", "manual"}


def registered_lanes():
    """name → {budget, trust} from lanes.toml. Missing file → empty (the rule then fires on any lane)."""
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    try:
        import tomllib  # 3.11+
        with open(os.path.join(root, "lanes.toml"), "rb") as f:
            data = tomllib.load(f)
    except (ImportError, FileNotFoundError, OSError):
        try:
            text = open(os.path.join(root, "lanes.toml"), encoding="utf-8").read()
        except OSError:
            return {}
        out = {}
        for block in text.split("[[lane]]")[1:]:
            fields = dict(re.findall(r'^\s*(\w+)\s*=\s*(.+?)\s*(?:#.*)?$', block, re.M))
            name = fields.get("name", "").strip('"')
            if name:
                out[name] = {"budget": fields.get("budget"), "trust": fields.get("trust")}
        return out
    return {l.get("name"): {"budget": l.get("budget"), "trust": l.get("trust")} for l in data.get("lane", []) if l.get("name")}


def lane_names_in(line: str):
    names = set(LANE_LITERAL.findall(line))
    for m in LANE_TERNARY.finditer(line):
        names.update(m.groups())
    return names


def main() -> int:
    if os.environ.get("VODOU_SKIP_COHERENCE_GUARD") == "1":
        return 0
    hits = []
    registry = None
    for path, added, ctx in staged_hunks():
        if not path.startswith(LANE_FILES) or "__tests__" in path or "/tests/" in path:
            continue
        if any(HATCH.search(l) for l in ctx):
            continue
        for line in added:
            for name in lane_names_in(line):
                if path in CAPTURE_LANE_FILES and name in CAPTURE_LANES:
                    continue   # capture transport, not a prompt lane — see CAPTURE_LANES
                if registry is None:
                    registry = registered_lanes()
                entry = registry.get(name)
                if entry is None:
                    hits.append((path, line, "Rule 8", (
                        f"lane `{name}` writes into a model's prompt and is not in lanes.toml. "
                        "Add a stanza with `budget` and `trust` (PLAN-CONTEXT-COORDINATION P6 / "
                        "lane canon rule 3) — seven injectors accumulated with nobody deciding to "
                        "have seven.")))
                elif not entry.get("budget") or not entry.get("trust"):
                    hits.append((path, line, "Rule 8", (
                        f"lane `{name}` is in lanes.toml without a `budget` and `trust` — a registry "
                        "entry that declares neither is the private budget the rule exists to stop.")))
    for path, added, ctx in staged_hunks():
        if not path.startswith(GUARDED):
            continue
        if any(d in path for d in SKIP_DIRS) or path == "scripts/coherence-guard.py":
            continue
        if any(HATCH.search(l) for l in ctx):
            continue

        for line in added:
            # A raw scope handed TO the translator is the sanctioned path, and
            # `scopeLabel(chunk.chunk_scope)` obviously mentions a raw scope.
            # Strip the translator calls before judging what is left, so the
            # rule cannot flag the very fix it asks for — and so a line that
            # both translates AND leaks is still caught.
            judged = SANCTIONED_CALL.sub("", line)
            if any(rx.search(judged) for rx in RULE7):
                hits.append((path, line, "Rule 7", (
                    "a raw scope/enum reaches a user's eye. Translate through "
                    "`scope_label()` (total mapping + human-word fallback) — "
                    "F7 showed 68% of a corpus its own internal taxonomy, and "
                    "the most common value shown was not even true.")))

            m = RULE9_DISPLAY.search(judged)
            if m:
                col = m.group(1) or m.group(2)
                if col and is_our_column(col) and not writes_anywhere(col):
                    hits.append((path, line, "Rule 9", (
                        f"`{col}` is displayed and NOTHING in the repo writes it. "
                        "That is F10 exactly: the board showed run_count for every "
                        "skill and nothing incremented it, so a skill that ran "
                        "nightly read 'never run'. A counter that can be wrong is "
                        "worse than one that is absent — either wire the write or "
                        "do not show it.")))

            if (RULE5_FRAME.search(line) and RULE5_INTERNAL.search(line)
                    and not any(RULE5_CONTRACT.search(l) for l in ctx)
                    and not contract_nearby(path)):
                hits.append((path, line, "Rule 5", (
                    "a surface is framed with no declared minimum width. F5: a "
                    "console screen framed into a ~380px side panel rendered as a "
                    "squashed, unusable copy of another app. Declare a min-width "
                    "and a fallback for when it is unmet.")))

    if not hits:
        return 0
    print("coherence-guard: staged lines break a COHERENCE rule "
          "(PLANS/0.6.27/COHERENCE/PLAN-COHERENCE-SEAM-AUDIT.md §7):\n", file=sys.stderr)
    for path, line, rule, why in hits:
        print(f"  {path}  [{rule}]\n    + {line.strip()[:120]}\n    → {why}\n", file=sys.stderr)
    print("If the duplication or the raw value is DELIBERATE, say so in the diff:\n"
          "    // COHERENCE-INTENTIONAL: <why>\n"
          "Or bypass a true false-positive with VODOU_SKIP_COHERENCE_GUARD=1.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
