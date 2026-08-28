#!/usr/bin/env python3
"""redaction-gate — refuse to publish a post that leaks the engine or a secret.

Usage:  scripts/blog/redaction-gate.py <post.md> [--explain] [--engine-src DIR]
Exit:   0 clean · 2 BLOCKED · 1 the gate itself could not run (also a block)

WHY THIS IS CODE AND NOT A PROMPT INSTRUCTION
---------------------------------------------
The feature lane's whole job is to write publicly about work whose interesting
half lives in a closed Rust engine. Every draft is one sentence away from a
leak, and the natural place to stop it — "please do not include Rust code" in
the writer prompt — fails in the one way that matters: SILENTLY, and only
sometimes. A model that ignores the instruction produces a post that looks
exactly like a post that obeyed it. There is no error, no retry, no signal.

And the failure is not recoverable. A blog post is fetched by crawlers within
minutes and cached by archive.org, Google, and every LLM training scraper on
the internet. `git revert` fixes a repo. Nothing fixes a published leak.

So the gate is a scanner that runs on the FINAL BYTES, after every LLM stage,
and its verdict is a process exit code the writer cannot argue with.

WHAT IT BLOCKS, AND THE TWO CLASSES
-----------------------------------
class `secret`   credential VALUES and operator PII, read from
                 .build/release-pii-patterns.txt — the SAME file
                 scripts/secret-guard.py and scripts/verify-release.sh read, so
                 a new key shape is added in ONE place and every layer gets it.
                 NEVER waivable. There is no reason good enough to publish a
                 key, and an escape hatch on this class is how it gets used.

class `internal` Rust source, engine module identifiers, engine file paths, and
                 our env-var namespaces. Chad's rule is that a post talks about
                 the engine HIGH LEVEL — what it does, what it cost — never its
                 insides. Waivable, but only with a stated reason (see below).

FAIL CLOSED
-----------
Anything the gate cannot resolve is a block, not a pass:
  * pattern file missing or unreadable      -> exit 1
  * a fenced block whose language we cannot identify but which carries Rust
    markers                                 -> blocked as Rust
  * a REDACT-OK comment with no real reason -> blocked, and the comment itself
    is reported as the finding
secret-guard.py takes the opposite default (absent pattern file = skip) because
blocking every commit in a CI checkout would be worse than the risk. Here the
artifact is public and permanent, so the trade runs the other way.

THE ESCAPE HATCH
----------------
    <!-- REDACT-OK: naming the crate is the point of this paragraph -->

Waives `internal` findings on its own line and in the markdown block that
follows it (the next fenced block, or the next paragraph). The reason is
mandatory and checked for substance — >= 12 characters and >= 3 words — because
an escape hatch that accepts `<!-- REDACT-OK: ok -->` is not a hatch, it is an
off switch, and it will be used as one.

WHAT IT DELIBERATELY DOES NOT BLOCK
-----------------------------------
`memory.db`, `FTS5`, `SQLite`, `sqlite3`, and the product name. Those are the
subject of the blog, they appear in already-published posts, and a gate that
fires on them fires on every draft. This repo has written that lesson down
twice already (.build/release-pii-patterns.txt, on `[Ff]enton` and on the
credential regexes in the binary pass): a gate that cries wolf gets bypassed,
and a bypassed gate is worse than no gate.
"""

import argparse
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PATTERN_FILE = ROOT / ".build" / "release-pii-patterns.txt"
SECRET_GUARD = ROOT / "scripts" / "secret-guard.py"
VALUE_SECTION = "Credential VALUE patterns"

# --------------------------------------------------------------------------
# Rust detection.
#
# Two tiers rather than one list, because the single-list version is either
# useless or unusable. `fn ` and `match ` and `Some(` occur in JavaScript,
# Python and pseudocode; `use crate::` and `&mut self` and `.unwrap()` do not
# occur anywhere else a blog post would go. So: one STRONG marker is enough,
# or three WEAK ones together.
# --------------------------------------------------------------------------
RUST_STRONG = [
    r'\buse\s+(?:crate|std|tokio|anyhow|serde|rusqlite|axum|reqwest)::',
    r'\bpub(?:\(crate\))?\s+(?:fn|struct|enum|trait|mod|const|static)\b',
    r'\basync\s+fn\s+\w+',
    r'#\[(?:derive|tokio|cfg|allow|serde|test)\b',
    r'\bimpl\s+(?:<[^>]*>\s*)?\w+(?:<[^>]*>)?\s*(?:for\s+\w+)?\s*\{',
    r'->\s*(?:Result|Option|anyhow::Result|Box<dyn)\b',
    r'\bBox<dyn\b',
    r'&mut\s+self\b',
    r'&self\s*[,)]',
    r'\blet\s+mut\s+\w+',
    r'\.unwrap\(\)',
    r'\.unwrap_or(?:_else|_default)?\(',
    r'::<[\w:<>, ]+>',
    r'\bString::from\(',
    r'\b(?:println|eprintln|format|vec|matches|anyhow|bail)!\s*[\(\[]',
    r'\bArc<(?:Mutex|RwLock)<',
]
RUST_WEAK = [
    r'\bfn\s+\w+\s*\(', r'\bmatch\s+\w+\s*\{', r'\bSome\(', r'\bNone\b',
    r'\bOk\(', r'\bErr\(', r'\?;', r'\bcrate::', r'\bstruct\s+\w+\s*\{',
    r'\benum\s+\w+\s*\{', r'\btrait\s+\w+', r"\b'static\b",
    r'\b(?:usize|isize|u8|u32|u64|i32|i64|f64)\b', r'&str\b', r'\bimpl\b',
]
RUST_STRONG_RX = [re.compile(p) for p in RUST_STRONG]
RUST_WEAK_RX = [re.compile(p) for p in RUST_WEAK]

RUST_FENCE_LANGS = {"rust", "rs", "rust,no_run", "rust,ignore", "cargo", "toml,rust"}

# Engine + repo-internal paths. `.rs` anywhere is the load-bearing one: every
# engine module is <something>.rs, so this covers files that do not exist yet.
INTERNAL_PATH = re.compile(
    r'(?<![\w/-])(?:\./)?(?:src|crates?|vodou-hook(?:/src)?)/[\w./-]+'
    r'|\b[\w-]+\.rs\b'
    r'|\bCargo\.(?:toml|lock)\b'
    # NOTE: MCP-servers/ is deliberately NOT here. Per LICENSE, the open client
    # surface (MCP-servers/, skills/, docs/, scripts/, extension/) is Apache-2.0
    # and already public on GitHub; blocking it protects nothing and would
    # false-block nearly every feature post, since features live in that tree.
    # Same reasoning for the `vodou-core <subcommand>` CLI: it is documented in
    # the public repo. Only the proprietary Rust engine (src/**) is redacted.
    r'|(?<![\w/-])\.vodou/[\w./-]+'
    r'|\bvodou-core\.db\b'
    r'|\bvodou-hook-bin\b'
)

# Our env-var namespaces. Naming one tells a reader exactly which knob to look
# for in a binary they are not supposed to be reverse-engineering.
ENV_VAR = re.compile(r'\b(?:OI|VODOU|BLOG|BT)_[A-Z][A-Z0-9_]{2,}\b')

# CamelCase engine types that no `.rs` path would catch. Short, hand-kept list;
# the snake_case module names come from the filesystem instead (see below).
# NOTE: "BrainLoader" is NOT on this list. The name appears throughout the
# Apache-2.0 gateway (MCP-servers/Vodou-Console/src/*.ts) that is already
# published on GitHub, so redacting the *name* protects nothing — what must
# stay redacted is engine implementation detail (src/**, .rs paths, line refs).
INTERNAL_IDENT_LITERAL = [
    "MemorySync", "CURRENT_SCHEMA_VERSION", "VodouLocalSign",
]
# SQLite table names are NOT engine identifiers. They are the user's own data
# (memory.db / vodou-core.db sit in the install root, documented in TOOLS.md,
# queried by the public MCP servers) and every "reader's check" that shows a
# real SQL query has to name one. On 2026-08-27 02:21 a 1763-word rubric-passing
# launch post was killed on the single word `memory_chunks`. Kept here so the
# list is not silently re-added: these are public schema, never redact them.
PUBLIC_SCHEMA_NAMES = ["intent_mappings", "memory_chunks", "work_logs", "chunk_tag"]

REDACT_OK = re.compile(r'<!--\s*REDACT-OK\s*:?\s*(?P<reason>.*?)\s*-->', re.I)
FENCE = re.compile(r'^(\s*)(`{3,}|~{3,})\s*(?P<lang>[^\s`]*)')
INLINE_CODE = re.compile(r'`([^`\n]+)`')

MAX_WAIVER_LINES = 40   # one comment cannot silence half a post


class GateError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Pattern loading — one file, shared with secret-guard.py and verify-release.sh
# --------------------------------------------------------------------------
def load_credential_patterns() -> list[str]:
    """Credential VALUE patterns, loaded through secret-guard's own loader.

    Importing the loader rather than re-parsing the file is the point: if the
    section header or the BINARY-SCAN skip ever changes, both layers change
    together. The module name has a hyphen, so it cannot be imported normally.
    """
    spec = importlib.util.spec_from_file_location("vodou_secret_guard", SECRET_GUARD)
    if spec is None or spec.loader is None:
        raise GateError(f"cannot load {SECRET_GUARD}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pats = mod.load_value_patterns()
    if not pats:
        raise GateError(f"{PATTERN_FILE} has no credential-value section")
    return pats


def load_operator_patterns() -> list[str]:
    """Everything BEFORE the credential header: operator PII + private infra.

    secret-guard deliberately does not enforce these at commit time — operator
    home paths still appear in private tooling and would block every commit.
    A blog post is a shipped artifact, not a commit, so it gets the same rules a
    release archive gets.
    """
    if not PATTERN_FILE.exists():
        raise GateError(f"{PATTERN_FILE} is missing")
    pats = []
    for line in PATTERN_FILE.read_text(encoding="utf-8").splitlines():
        if VALUE_SECTION in line:
            break
        s = line.strip()
        if s.startswith("BINARY-SCAN "):
            continue
        if s and not s.startswith("#"):
            pats.append(s)
    if not pats:
        raise GateError(f"{PATTERN_FILE} has no operator section")
    return pats


def load_engine_modules(engine_src: Path) -> list[str]:
    """snake_case module names, read from the engine tree itself.

    Derived rather than curated so a module added tomorrow is covered tomorrow.
    Only stems containing `_` are used: `brain_loader` and `extraction_queue`
    cannot occur in English, but `agent`, `daemon` and `database` are ordinary
    words and a list containing them would block every post about agents. Those
    are still covered as `agent.rs` by INTERNAL_PATH.
    """
    if not engine_src.is_dir():
        return []
    return sorted({p.stem for p in engine_src.glob("*.rs") if "_" in p.stem})


# --------------------------------------------------------------------------
# Structure: fences, waivers
# --------------------------------------------------------------------------
def fenced_regions(lines: list[str]) -> list[tuple[int, int, str]]:
    """(start_idx, end_idx_inclusive, lang) for every fenced block."""
    out, open_at, marker, lang = [], None, "", ""
    for i, line in enumerate(lines):
        m = FENCE.match(line)
        if not m:
            continue
        if open_at is None:
            open_at, marker, lang = i, m.group(2)[0] * 3, (m.group("lang") or "").strip().lower()
        elif line.strip().startswith(marker):
            out.append((open_at, i, lang))
            open_at = None
    if open_at is not None:          # unterminated fence: treat to EOF
        out.append((open_at, len(lines) - 1, lang))
    return out


def waiver_map(lines: list[str], fences: list[tuple[int, int, str]]) -> tuple[dict[int, str], list[tuple[int, str]]]:
    """Line -> waiver reason, plus a list of (line_no, problem) for bad waivers.

    A comment covers its own line and the next markdown block: the whole fenced
    block if one opens next, otherwise the next run of non-blank lines.
    """
    covered: dict[int, str] = {}
    bad: list[tuple[int, str]] = []
    fence_start = {f[0]: f for f in fences}

    for i, line in enumerate(lines):
        m = REDACT_OK.search(line)
        if not m:
            continue
        reason = (m.group("reason") or "").strip().rstrip(":").strip()
        if len(reason) < 12 or len(reason.split()) < 3:
            bad.append((i + 1, reason))
            continue                 # a reasonless waiver waives NOTHING
        covered[i] = reason
        j = i + 1
        while j < len(lines) and not lines[j].strip():
            j += 1
        if j >= len(lines):
            continue
        if j in fence_start:
            end = fence_start[j][1]
        else:
            end = j
            while end + 1 < len(lines) and lines[end + 1].strip():
                end += 1
        for k in range(i, min(end, i + MAX_WAIVER_LINES) + 1):
            covered[k] = reason
    return covered, bad


# --------------------------------------------------------------------------
# The scan
# --------------------------------------------------------------------------
def rust_markers(text: str) -> tuple[list[str], list[str]]:
    strong = [rx.pattern for rx in RUST_STRONG_RX if rx.search(text)]
    weak = [rx.pattern for rx in RUST_WEAK_RX if rx.search(text)]
    return strong, weak


def scan(path: Path, engine_src: Path) -> list[dict]:
    """Every finding, in file order. Raises GateError if the gate cannot run."""
    cred = [(p, re.compile(p)) for p in load_credential_patterns()]
    oper = [(p, re.compile(p)) for p in load_operator_patterns()]
    modules = load_engine_modules(engine_src)
    module_rx = re.compile(r'\b(?:' + '|'.join(re.escape(m) for m in modules) + r')\b') if modules else None
    ident_rx = re.compile(r'\b(?:' + '|'.join(re.escape(i) for i in INTERNAL_IDENT_LITERAL) + r')\b')

    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.split("\n")
    fences = fenced_regions(lines)
    covered, bad_waivers = waiver_map(lines, fences)
    in_fence = {}
    for start, end, lang in fences:
        for k in range(start, end + 1):
            in_fence[k] = lang

    found: list[dict] = []

    def add(cls, rule, line_no, detail, waivable=True):
        if waivable and cls == "internal" and (line_no - 1) in covered:
            return
        found.append({"class": cls, "rule": rule, "line": line_no, "detail": detail})

    for ln, reason in bad_waivers:
        found.append({
            "class": "internal", "rule": "redact-ok-without-reason", "line": ln,
            "detail": f"REDACT-OK reason {reason!r} is not a reason "
                      f"(need >= 12 chars and >= 3 words). It waives nothing.",
        })

    # --- fenced blocks: language tag, then content ---------------------------
    for start, end, lang in fences:
        body = "\n".join(lines[start + 1:end])
        if lang in RUST_FENCE_LANGS:
            add("internal", "rust-fence", start + 1,
                f"fenced block tagged ```{lang} — the engine is described, never quoted")
            continue
        strong, weak = rust_markers(body)
        if strong or len(weak) >= 3:
            why = f"strong={strong[:3]}" if strong else f"weak x{len(weak)}={weak[:4]}"
            add("internal", "rust-code", start + 1,
                f"fenced ```{lang or '(untagged)'} block reads as Rust ({why})")

    # --- inline code spans ---------------------------------------------------
    for i, line in enumerate(lines):
        if i in in_fence:
            continue
        for span in INLINE_CODE.findall(line):
            strong, _ = rust_markers(span)
            if strong:
                add("internal", "rust-inline", i + 1,
                    f"inline code `{span[:60]}` is Rust ({strong[0]})")

    # --- every line, fenced or not ------------------------------------------
    for i, line in enumerate(lines):
        if REDACT_OK.search(line):
            continue                              # the waiver itself is not content
        n = i + 1

        for m in INTERNAL_PATH.finditer(line):
            # A src/ path in a public-client language cannot be the Rust engine
            # (MCP-servers/*/src/*.ts, extension/src/*.js). Only Rust-tree paths
            # are proprietary. 2026-08-27: a 1836-word draft died on page-match.ts.
            if re.search(r'\.(?:ts|tsx|js|mjs|cjs|py|sh|json|md)$', m.group(0)):
                continue
            add("internal", "engine-path", n, f"internal path: {m.group(0)}")
        for m in ENV_VAR.finditer(line):
            add("internal", "env-var", n, f"internal env var: {m.group(0)}")
        for m in ident_rx.finditer(line):
            add("internal", "internal-identifier", n, f"engine identifier: {m.group(0)}")
        if module_rx:
            for m in module_rx.finditer(line):
                add("internal", "engine-module", n, f"engine module name: {m.group(0)}")

        # secrets last and never waivable; the match is never echoed in full.
        for src, rx in cred:
            m = rx.search(line)
            if m:
                hit = m.group(0)
                add("secret", "credential-value", n,
                    f"matches {src!r}: {hit[:4]}…[{len(hit)} chars]", waivable=False)
        for src, rx in oper:
            m = rx.search(line)
            if m:
                add("secret", "operator-pii", n,
                    f"matches {src!r} from the release PII list", waivable=False)

    found.sort(key=lambda f: (f["line"], f["rule"]))
    # One finding per (rule, line) is enough to act on.
    seen, uniq = set(), []
    for f in found:
        k = (f["rule"], f["line"], f["detail"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(f)
    return uniq


def main() -> int:
    ap = argparse.ArgumentParser(description="block a blog post that leaks the engine or a secret")
    ap.add_argument("post")
    ap.add_argument("--engine-src", default=str(ROOT / "src"))
    ap.add_argument("--explain", action="store_true")
    args = ap.parse_args()

    path = Path(args.post)
    if not path.is_file():
        sys.stderr.write(f"redaction-gate: no such file: {path}\n")
        return 1

    try:
        findings = scan(path, Path(args.engine_src))
    except GateError as e:
        sys.stderr.write(
            f"redaction-gate: CANNOT RUN — {e}\n"
            f"  Treating that as a block. A scanner that cannot read its own\n"
            f"  patterns has no opinion, and 'no opinion' must not publish.\n")
        return 1

    if not findings:
        if args.explain:
            sys.stderr.write(f"redaction-gate: clean — {path}\n")
        return 0

    sys.stderr.write(f"redaction-gate: BLOCKED {path} — {len(findings)} finding(s)\n")
    for f in findings:
        sys.stderr.write(f"  [{f['class']}/{f['rule']}] line {f['line']}: {f['detail']}\n")
    if any(f["class"] == "secret" for f in findings):
        sys.stderr.write(
            "  A `secret` finding cannot be waived. Fix the string.\n")
    if any(f["class"] == "internal" for f in findings):
        sys.stderr.write(
            "  `internal` findings can be waived deliberately, one block at a time:\n"
            "      <!-- REDACT-OK: why this internal detail has to be here -->\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
