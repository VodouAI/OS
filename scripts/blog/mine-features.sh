#!/usr/bin/env bash
#
# Vodou blog FEATURE miner — lane 1 of blog-run.sh.
#
# Reads `git log`, works out what SHIPPED, filters out anything already posted,
# and prints ranked feature candidates as JSON.
#
# Usage: scripts/blog/mine-features.sh [--limit N] [--days N] [--max N]
#                                      [--json] [--explain]
# Output: a JSON array on stdout. `[]` and exit 0 when nothing is unposted —
#         that is the EXPECTED result most days and blog-run.sh treats it as a
#         normal outcome, not a failure.
#
# WHY THIS IS A CLUSTERING PROBLEM, NOT A DETECTION PROBLEM
#
# Detecting a shipped feature is trivial: Chad's commit subjects are already
# headlines ("feat(graph): the plan card — see what will run before it runs").
# The hard part is that ONE feature ships as a dozen-plus commits. The graph
# frontend is 20 `feat(graph)` commits across four days; naive per-commit
# detection would queue twenty near-identical launch posts about one launch.
#
# Near-duplicate content is exactly what Google demotes — it is the same
# ranking bug mine-topics.sh's filter 2 exists to stop, arriving by a different
# road. So clustering IS this script's job, and everything else is bookkeeping.
#
# THE CLUSTERING RULE, AND WHY EACH TERM IS THERE
#
#   scope        The conventional-commit scope is the strongest signal we have
#                that two commits are the same body of work, and it is free.
#                Compound scopes (`feat(bridge+console)`) group under their
#                first part so they land with their siblings.
#
#   time         A scope is reused forever. `feat(memory)` covers document
#                extraction in August and the Brain graph two weeks later —
#                different features, one scope. Consecutive commits chain only
#                while the gap stays under --gap days.
#
#   similarity   A gap slightly over the tight threshold is not proof of a new
#                feature; work pauses for a weekend. So a wider gap can still
#                chain IF the subject shares vocabulary with the cluster so far.
#                This is deliberately the weaker of the two: it can only EXTEND
#                a chain the time rule nearly allowed, never start one.
#
#   span cap     Single-linkage over a busy scope can chain forever — commit
#                every day for a month and the whole month is "one feature".
#                --span bounds a cluster's total width so an active scope
#                produces several posts rather than one impossible one.
#
# FOUR FILTERS, EACH FROM A SPECIFIC FAILURE MODE
#
#   1. type        Only `feat` can START a feature; `fix` commits are collected
#                  because they are the best material in the post ("here is
#                  what it cost to build"), but a cluster of nothing but fixes
#                  is a bug-fix week, not a launch. Fix-only clusters are
#                  dropped.
#   2. scope       Plumbing scopes (ci, deps, build, release, test, version
#                  bumps) ship nothing a reader can use. Dropped by name.
#   3. ledger      Three ways, because a cluster is not a stable object: its
#                  `feature_key`, any SHA overlap with a published post, and a
#                  title-similarity check. The SHA check is the load-bearing
#                  one — a cluster GROWS as more commits land, so the same
#                  feature legitimately presents a different key next week.
#   4. rotation    Same pillar-staleness boost as mine-topics.sh, from the same
#                  table (scripts/blog/pillars.py). Topical authority beats
#                  scattered one-offs, and a blog with two lanes needs ONE
#                  rotation policy or the lanes fight over the same pillar.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LIMIT="${BLOG_FEATURE_LIMIT:-6}"
DAYS="${BLOG_FEATURE_DAYS:-30}"
MAXC="${BLOG_FEATURE_MAX_COMMITS:-600}"
GAP="${BLOG_FEATURE_GAP_DAYS:-4}"
LOOSE="${BLOG_FEATURE_LOOSE_GAP_DAYS:-12}"
SPAN="${BLOG_FEATURE_SPAN_DAYS:-14}"
EXPLAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)   LIMIT="$2"; shift 2 ;;
    --days)    DAYS="$2";  shift 2 ;;
    --max)     MAXC="$2";  shift 2 ;;
    --gap)     GAP="$2";   shift 2 ;;
    --span)    SPAN="$2";  shift 2 ;;
    --explain) EXPLAIN=1;  shift ;;
    --json)    shift ;;
    *) shift ;;
  esac
done

LEDGER=".vodou/blog/ledger.json"
mkdir -p "$(dirname "$LEDGER")"
[[ -f "$LEDGER" ]] || echo '{"published":[]}' > "$LEDGER"

# Two git calls, both bounded, both plain reads. `--no-merges` because a merge
# commit's subject is never a headline and its name-only listing is the union
# of the branch, which would blow the file cap on every cluster it touched.
#
# US separates the fields so a subject containing anything at all stays intact.
COMMITS=$(git log --no-merges -n "$MAXC" --since="$DAYS days ago" \
  --pretty=format:'%H%x1f%h%x1f%ad%x1f%at%x1f%s' --date=short 2>/dev/null || true)

# sha -> files, from ONE walk. Per-commit `git show` was the obvious way and it
# is O(cluster size) subprocesses; on the graph cluster that is 20 spawns for
# data one traversal already has.
FILES=$(git log --no-merges -n "$MAXC" --since="$DAYS days ago" \
  --pretty=format:'%x1e%H' --name-only 2>/dev/null || true)

export MF_COMMITS="$COMMITS" MF_FILES="$FILES" MF_LIMIT="$LIMIT" \
       MF_GAP="$GAP" MF_LOOSE="$LOOSE" MF_SPAN="$SPAN" MF_EXPLAIN="$EXPLAIN"

python3 <<'PYEOF'
import json, os, re, sys
from datetime import date

limit   = int(os.environ["MF_LIMIT"])
gap_d   = float(os.environ["MF_GAP"])
loose_d = float(os.environ["MF_LOOSE"])
span_d  = float(os.environ["MF_SPAN"])
explain = os.environ["MF_EXPLAIN"] == "1"

def note(msg):
    if explain:
        print(f"[mine-features] {msg}", file=sys.stderr)

sys.path.insert(0, "scripts/blog")
from pillars import pillar_of_feature   # one pillar table, several readers

DAY = 86400.0

# --- filter 2: scopes that ship nothing a stranger can use --------------------
# Deliberately a DENYLIST, not an allowlist. An allowlist silently drops every
# new scope the repo invents, and the failure mode is invisible: the lane just
# says "nothing shipped" forever.
PLUMBING_SCOPES = {
    "ci", "cd", "deps", "dep", "build", "chore", "refactor", "test", "tests",
    "release", "version", "ext-version", "packaging", "packer", "lint",
    "format", "typo", "docs", "doc", "readme", "meta", "repo", "git",
    "scripts", "tooling", "infra", "wip", "revert", "bump", "vendor",
}
# Files that say nothing about what shipped. Kept out of files_touched so the
# cap is spent on paths that actually describe the feature's surface area.
NOISE_FILES = re.compile(
    r'(^|/)(package-lock\.json|yarn\.lock|Cargo\.lock|\.DS_Store)$'
    r'|^(node_modules|dist|build|target|\.build|\.vodou)/'
    r'|\.(db|db-wal|db-shm|lock|snap|map|min\.js|min\.css)$'
)

STOP = set("""a an and the to of for in on at by with from is are was were be been it its
this that these those not no as or if then so but into out over under up down off only
when while now new old more less than very just also all any some each per via vs no-op
what which who whose why how does did do done make makes made get gets got had has have
i we you they he she them us our your their my me""".split())

def toks(s):
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 2 and w not in STOP}

def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)

def slugify(s, cap=60):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:cap].rstrip("-") or "feature"

# --- parse the log -----------------------------------------------------------
SUBJ = re.compile(r'^(?P<type>[a-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<rest>.+)$')

# NOTE: str.splitlines() is WRONG for this data and the failure is silent.
# Python splits on \x1c, \x1d, \x1e, \x85,   and   as well as \n, and
# \x1e is exactly the record separator git writes for %x1e — so splitlines()
# consumed every delimiter and the file index came back empty with no error at
# all (files_touched: [] on every candidate). Split on "\n" only, everywhere.
commits = []
for line in (os.environ.get("MF_COMMITS") or "").split("\n"):
    parts = line.split("\x1f")
    if len(parts) != 5:
        continue
    full, short, day, ts, subject = parts
    m = SUBJ.match(subject.strip())
    if not m:
        continue                      # not a conventional commit; no scope axis
    ctype = m.group("type")
    if ctype not in ("feat", "fix"):
        continue
    scope_raw = (m.group("scope") or "general").strip().lower()
    # `feat(bridge+console)` is one feature touching two surfaces. Group it with
    # its first surface so it lands beside its siblings instead of alone.
    scope = re.split(r"[+,/]", scope_raw)[0].strip() or "general"
    commits.append({
        "sha": full, "short": short, "day": day, "ts": float(ts),
        "type": ctype, "scope": scope, "scope_raw": scope_raw,
        "subject": subject.strip(),
        "headline": m.group("rest").strip(),
        "breaking": bool(m.group("bang")),
    })

note(f"{len(commits)} conventional feat/fix commits in window")

# sha -> files
files_by_sha = {}
cur = None
for line in (os.environ.get("MF_FILES") or "").split("\n"):
    if line.startswith("\x1e"):
        cur = line[1:].strip()
        files_by_sha[cur] = []
    elif cur and line.strip():
        files_by_sha[cur].append(line.strip())

# --- cluster -----------------------------------------------------------------
by_scope = {}
for c in commits:
    if c["scope"] in PLUMBING_SCOPES:
        continue
    by_scope.setdefault(c["scope"], []).append(c)

clusters = []
for scope, group in by_scope.items():
    group.sort(key=lambda c: c["ts"])          # oldest first
    cur, cur_toks = [], set()
    for c in group:
        if not cur:
            cur, cur_toks = [c], toks(c["headline"])
            continue
        gap = (c["ts"] - cur[-1]["ts"]) / DAY
        span = (c["ts"] - cur[0]["ts"]) / DAY
        sim = jaccard(toks(c["headline"]), cur_toks)
        # tight gap links unconditionally; a wider one only when the subject
        # still looks like the same body of work. Either way the span cap wins.
        link = (gap <= gap_d or (gap <= loose_d and sim >= 0.25)) and span <= span_d
        if link:
            cur.append(c)
            cur_toks |= toks(c["headline"])
        else:
            clusters.append((scope, cur))
            cur, cur_toks = [c], toks(c["headline"])
    if cur:
        clusters.append((scope, cur))

note(f"{len(clusters)} raw clusters across {len(by_scope)} scopes")

# --- title: which commit subject is the headline? ----------------------------
# Chad writes subjects as headlines already, so the job is picking the best one,
# not writing one. The scoring is all negative space: internal tracker refs
# ("(N7 + N8)", "(item 11)", "phase 2") and janitorial verbs ("finish",
# "correct the test count") mark a subject as a progress note rather than a
# claim about a capability.
TRACKER = re.compile(r'\((?:[A-Z]?\d+[a-z]?(?:\s*[+,]\s*[A-Z]?\d+[a-z]?)*|item\s+\d+|phase\s+\d+[^)]*|[A-Z]-?\d+)\)', re.I)
JANITORIAL = re.compile(r'^\s*(finish|correct|stamp|drop|bump|re-?add|restore|tidy|rename)\b', re.I)

def signal_files(sha):
    return [f for f in files_by_sha.get(sha, []) if not NOISE_FILES.search(f)]

def headline_score(c):
    h = c["headline"]
    s = 0
    s += 30 if c["type"] == "feat" else 0
    s += 15 if c["breaking"] else 0
    s += 10 if "—" in h else 0            # Chad's claim-then-payoff shape
    s += min(len(h), 90) // 10
    # The commit that touched the most surface is usually the one that IS the
    # feature; the one-file commits around it are its follow-ups. Without this
    # the graph cluster titled itself off `parked` — a real commit, but an
    # internal state name, not the capability twenty commits actually shipped.
    s += min(len(signal_files(c["sha"])), 30) // 2
    s -= 25 if TRACKER.search(h) else 0
    s -= 30 if JANITORIAL.match(h) else 0
    s -= 20 if re.search(r'\b(test|tests|suite|fixture)\b', h, re.I) else 0
    # A subject that opens with a backticked internal token names a mechanism,
    # not a capability. Readable as a headline only to someone who already
    # knows the codebase, which is the exact reader this blog is not for.
    s -= 15 if h.lstrip().startswith("`") else 0
    return s

def clean_headline(h):
    h = TRACKER.sub("", h)
    h = re.sub(r'\s*\((?:partial|option [A-Z]|D\d+[^)]*)\)', "", h, flags=re.I)
    h = re.sub(r'\s{2,}', " ", h).strip(" -–—,")
    return h

# --- ledger ------------------------------------------------------------------
ledger = json.load(open(".vodou/blog/ledger.json"))
pub = ledger.get("published", [])

posted_keys  = {p.get("feature_key") for p in pub if p.get("feature_key")}
posted_shas  = set()
for p in pub:
    # Backward compatible on purpose: every entry written before the feature
    # lane existed lacks all three fields and contributes nothing here, rather
    # than raising or being treated as a match.
    for s in (p.get("feature_commits") or []):
        posted_shas.add(s)
posted_titles = [toks(p.get("title", "")) for p in pub if p.get("title")]

# Rotation, identical in spirit to mine-topics.sh: least-recently-covered pillar
# wins, and `unsorted` is penalised rather than rewarded (absence is not
# "overdue"). The two lanes share a ledger, so they share a rotation.
recent = [p.get("pillar") for p in reversed(pub) if p.get("pillar")]
def staleness_boost(pillar):
    if pillar == "unsorted":
        return -20
    try:
        return max(0, 40 - 10 * recent.index(pillar))
    except ValueError:
        return 45

today = date.today()

out = []
for scope, cs in clusters:
    feats = [c for c in cs if c["type"] == "feat"]
    if not feats:
        note(f"skip {scope} {cs[0]['day']}..{cs[-1]['day']} — fix-only cluster ({len(cs)} commits)")
        continue

    head = max(feats, key=headline_score)
    title = clean_headline(head["headline"])
    if len(title) < 12:
        note(f"skip {scope} — headline too thin: {title!r}")
        continue

    # feature_key is scope + the headline commit's slug. Stable while the
    # headline holds; the SHA check below is what actually survives a cluster
    # growing or the window sliding.
    key = f"{scope}-{slugify(title)}"

    shas = [c["sha"] for c in cs]
    if key in posted_keys:
        note(f"skip {key} — feature_key already in ledger")
        continue
    overlap = posted_shas.intersection(shas)
    if overlap:
        note(f"skip {key} — {len(overlap)} commit(s) already covered by a published post")
        continue
    ttoks = toks(title)
    dup = next((t for t in posted_titles if jaccard(ttoks, t) >= 0.62), None)
    if dup:
        note(f"skip {key} — title is a near-duplicate of a published post")
        continue

    seen, ordered = {}, []
    for c in cs:
        for f in files_by_sha.get(c["sha"], []):
            if NOISE_FILES.search(f):
                continue
            seen[f] = seen.get(f, 0) + 1
    ordered = [f for f, _ in sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))][:25]

    pillar = pillar_of_feature(scope, " ".join(c["headline"] for c in cs))

    first_seen, last_seen = cs[0]["day"], cs[-1]["day"]
    days_since = (today - date.fromisoformat(last_seen)).days

    score = (
        12 * min(len(feats), 8)                       # how much shipped
        + 5 * min(len(cs) - len(feats), 6)            # the fixes are the story
        + max(0, 30 - 2 * days_since)                 # features are perishable
        + 4 * min(len(ordered) // 3, 6)               # surface area
        + staleness_boost(pillar)
        + (15 if any(c["breaking"] for c in cs) else 0)
    )

    out.append({
        "feature_key": key,
        "title": title,
        "scope": scope,
        "scopes_raw": sorted({c["scope_raw"] for c in cs}),
        "pillar": pillar,
        "first_seen": first_seen,
        "last_seen": last_seen,
        "days_since": days_since,
        "n_commits": len(cs),
        "n_feat": len(feats),
        "n_fix": len(cs) - len(feats),
        "score": score,
        "headline_sha": head["short"],
        "commits": [
            {"sha": c["short"], "date": c["day"], "type": c["type"], "subject": c["subject"]}
            for c in cs
        ],
        "commit_shas": shas,
        "files_touched": ordered,
        "files_total": len(seen),
    })

out.sort(key=lambda c: (-c["score"], c["last_seen"]))
kept = out[:limit]

if explain:
    for c in kept:
        note(f"{c['score']:>4}  {c['feature_key']}  "
             f"[{c['pillar']}] {c['n_feat']}feat+{c['n_fix']}fix "
             f"{c['first_seen']}..{c['last_seen']}")
    note("pillar mix: " + json.dumps(
        {p: sum(1 for k in kept if k["pillar"] == p) for p in sorted({k["pillar"] for k in kept})}))

print(json.dumps(kept, indent=2))
PYEOF
