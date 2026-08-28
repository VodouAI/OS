#!/usr/bin/env bash
#
# Vodou feature-launch writer — one post per major capability that shipped.
#
#   feature JSON (from mine-features.sh)
#     -> high-level shape of what shipped   (git, no engine internals)
#     -> the struggle behind it             (memory.db)
#     -> what the rest of the world does    (exa)
#     -> draft, with diagrams
#     -> DIAGRAM VALIDATION -> REDACTION GATE -> rubric
#     -> content/blog/<date>-<slug>.md
#
# Usage: write-feature-post.sh --feature-json <path> [--slot morning|midday|evening]
#
# Exit codes are a CONTRACT with blog-run.sh:
#   0    wrote a post; its path is the ONLY thing on stdout
#   2    the redaction gate blocked the draft (the gate working, not a fault)
#   1    anything else
#
# WHY THIS IS A DIFFERENT SCRIPT FROM write-post.sh
#
# The incident writer's spine is one memory chunk and its job is to generalise a
# bug. This writer's spine is a cluster of commits and its job is the opposite:
# take something we built and make it useful to someone building the same thing
# on a different stack. The failure modes are different too. An incident post
# that overshares leaks a bug we already fixed. A FEATURE post that overshares
# leaks the proprietary engine, permanently, to crawlers we invited.
#
# THE SECRETS RULE, AND WHY IT IS A SCANNER AND NOT A PROMPT LINE
#
# Per LICENSE: the Rust core (src/**) is PROPRIETARY. Everything else —
# MCP-servers/, skills/, docs/, scripts/, extension/ — is Apache-2.0 and already
# public on GitHub, so quoting it protects nothing and blocking it would false-
# block nearly every feature post (features live in that tree).
#
# So the prompt is told to stay behavioural about the engine, AND redaction-gate.py
# runs on the finished draft with the power to refuse. Asking a model nicely is a
# hope; a gate is a guarantee. This is the only lane where a leak is unrecoverable,
# because published + crawled + in llms-full.txt cannot be taken back.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source scripts/blog/lib.sh

FEATURE_JSON=""
SLOT="anchor"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --feature-json) FEATURE_JSON="$2"; shift 2 ;;
    --slot)         SLOT="$2";         shift 2 ;;
    *) shift ;;
  esac
done
[[ -f "$FEATURE_JSON" ]] || { echo "usage: write-feature-post.sh --feature-json <path>" >&2; exit 1; }
TODAY="$(date +%Y-%m-%d)"
# Frontmatter `date` carries a full local timestamp, not just the day.
# Nine posts once shipped on one calendar day with `date: 2026-08-26`. Every
# listing sort compared them EQUAL, so ordering fell through to glob order and
# the newest post rendered LAST on the home page. Day granularity is correct for
# the FILENAME (day identity is the local day, per PLANS/PLAN-TIME-CANON.md) and
# wrong for a sort key. Two different questions, two different values.
# RFC 3339 with a COLON in the offset, and quoted at the point of use. YAML
# has its own timestamp type whose acceptance of a bare `-0400` offset varies
# by parser; quoting makes the value unambiguously a string, which the schema
# then coerces with JS `Date`. One shape, no parser-dependent behaviour.
NOW_TS="$(date +%Y-%m-%dT%H:%M:%S)$(date +%z | sed 's/\(..\)$/:\1/')"

START_TS=$(date +%s)
BUDGET="${BLOG_WRITE_BUDGET:-840}"
T_RESEARCH="${BLOG_RESEARCH_TIMEOUT:-75}"
T_DRAFT="${BLOG_LLM_TIMEOUT:-480}"
T_RUBRIC="${BLOG_RUBRIC_TIMEOUT:-150}"
T_REVISE="${BLOG_REVISE_TIMEOUT:-360}"
RUBRIC_MIN="${BLOG_FEATURE_RUBRIC_MIN:-29}"   # of 40 (was 25/35: same 71% bar,
                                              # readers_check added the 8th dimension)
RESEARCH_QUERIES="${BLOG_RESEARCH_QUERIES:-2}"

log() { printf '[%s] [write-feature] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
elapsed()   { echo $(( $(date +%s) - START_TS )); }
remaining() { local r=$(( BUDGET - $(elapsed) )); (( r < 0 )) && r=0; echo "$r"; }
budgeted() {
  local want="$1" reserve="${2:-0}" avail
  avail=$(( $(remaining) - reserve ))
  (( avail < 20 )) && { echo 0; return; }
  (( want < avail )) && echo "$want" || echo "$avail"
}
# Every LLM call goes through here. An unbounded `claude -p` inside a command
# substitution is exactly how the site went stale for hours on 2026-08-26, and
# killing the parent does not kill the child.
llm() {
  local secs="$1" prompt_file="$2" out
  # ANTHROPIC_API_KEY takes precedence over the subscription login inside
  # `claude -p`. On 2026-08-26 that key was out of credit, so every SCHEDULED run
  # (the daemon loads .env; an interactive shell does not) got back
  # "Credit balance is too low" -- five words, exit 0 -- while every hand-run
  # test passed. Three slots lost their post and the log said "writer failed".
  # The blog lane authenticates as the logged-in user, deliberately. Unset in the
  # subshell rather than `env -u`: bt_timeout is a shell function, not a binary.
  #
  # stderr is still NOT captured -- it flows to the run log, where a fast auth
  # failure needs to stay visible and distinct from "nothing to write".
  out=$( unset ANTHROPIC_API_KEY; bt_timeout "$secs" claude -p --permission-mode bypassPermissions < "$prompt_file" || true )

  # `claude -p` prints its own refusal on STDOUT and exits 0, so an exit code
  # cannot tell "the model had nothing to say" from "this account cannot pay".
  # Match the refusal text and name it; the caller's own guard still fires, but
  # the line above it now says why instead of leaving a five-word draft to
  # fail later as "frontmatter invalid".
  if printf '%s' "$out" | grep -qiE 'credit balance is too low|invalid api key|authentication_error|please run .?claude login|rate limit exceeded'; then
    log "FATAL: the LLM refused -- this is an ACCOUNT problem, not a writing problem: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
    return 0
  fi
  printf '%s' "$out"
}

WORK=$(mktemp -d -t vodou-feature)
cleanup() { [[ "${BLOG_KEEP_WORK:-0}" == "1" ]] && { log "work dir kept: $WORK"; return; }; rm -rf "$WORK"; }
trap cleanup EXIT

# =============================================================================
# 1. What shipped — from the cluster, at the altitude we are willing to publish.
#
# The engine tree is summarised as COUNTS AND SUBSYSTEM NAMES ONLY. Never a
# path, never a line, never a diff. The open tree can be named freely; it is
# already on GitHub, and concrete public file names are what make a post
# credible rather than vague.
# =============================================================================
FEATURE_KEY=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('feature_key',''))" "$FEATURE_JSON")
[[ -n "$FEATURE_KEY" ]] || { log "FATAL: feature json has no feature_key"; exit 1; }
log "feature: $FEATURE_KEY"

python3 - "$FEATURE_JSON" > "$WORK/shape.md" <<'PY'
import json, sys, os, re
f = json.load(open(sys.argv[1]))

ENGINE = ("src/",)
open_files, engine_files = [], []
for p in f.get("files_touched", []):
    (engine_files if p.startswith(ENGINE) else open_files).append(p)

def subsystem(p):
    # "src/graph_recipe.rs" -> "graph recipe". A capability name, not a location.
    stem = os.path.basename(p).rsplit(".", 1)[0]
    return re.sub(r"[_-]+", " ", stem).strip()

print(f"feature_key: {f.get('feature_key')}")
print(f"scope: {f.get('scope','')}")
print(f"pillar: {f.get('pillar','unsorted')}")
print(f"commits: {len(f.get('commit_shas', []))}   files: {f.get('files_total','?')}")
print(f"shipped between: {f.get('first_seen','?')} .. {f.get('last_seen','?')}")

print("\n## Commit subjects (these are the capability, in Chad's own words)")
for c in f.get("commits", []):
    print(f"- {c.get('date','')}  {c.get('subject','')}")

if open_files:
    print("\n## Open-source files touched (Apache-2.0, public on GitHub — safe to name)")
    for p in open_files[:28]:
        print(f"- {p}")

if engine_files:
    # Deliberately lossy. The reader learns WHICH CAPABILITIES the closed engine
    # grew, which is the interesting part, and nothing about how.
    print(f"\n## Proprietary engine: {len(engine_files)} file(s) changed")
    print("Describe these ONLY as behaviour. Never name a file, path or line.")
    print("Capability areas the engine gained:")
    for s in sorted({subsystem(p) for p in engine_files}):
        print(f"- {s}")
PY
log "shape: $(wc -l < "$WORK/shape.md" | tr -d ' ') lines"

# Commit bodies carry the WHY. Subjects carry the what. Bodies are where the
# struggle usually is, and they are Chad's words rather than a model's guess.
python3 - "$FEATURE_JSON" <<'PY' > "$WORK/bodies.txt" 2>/dev/null || true
import json, subprocess, sys
f = json.load(open(sys.argv[1]))
for sha in f.get("commit_shas", [])[:12]:
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%s%n%b", sha],
                             capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        continue
    if out and len(out.splitlines()) > 1:
        print(out[:1200]); print("---")
PY

# =============================================================================
# 2. The struggle. Chad asked for this explicitly: a launch post that is only a
#    feature list is marketing. The thing that earns a technical reader's trust
#    is what it cost to get there. That material is in memory.db.
# =============================================================================
SEARCH_Q=$(python3 -c "
import json,sys,re
f=json.load(open(sys.argv[1]))
subs=' '.join(c.get('subject','') for c in f.get('commits',[])[:6])
subs=re.sub(r'^feat\([^)]*\):','',subs)
print((f.get('scope','')+' '+subs)[:220])
" "$FEATURE_JSON")
log "struggle search: ${SEARCH_Q:0:70}..."
bt_mem_search "$SEARCH_Q" 14 > "$WORK/struggle.json"

# The struggle section is ENRICHMENT, not the post. Before 2026-08-26 this
# heredoc was the only one of the three here left unguarded under `set -e`, so
# any exception inside it killed the entire feature lane between two log lines
# -- the run said "struggle search: ..." and then nothing, and blog-run.sh
# reported the whole slot as "feature writer failed rc=1". `mem search --json`
# under concurrent load can return rows that are not dicts, and `r.get` on a
# str raises AttributeError. An optional step must degrade, never decide.
if ! python3 - "$WORK/struggle.json" > "$WORK/struggle.md" <<'PY'
import json, sys
try: rows = json.load(open(sys.argv[1]))
except Exception: rows = []
if isinstance(rows, dict): rows = rows.get("results", rows.get("chunks", []))
n = 0
for r in rows if isinstance(rows, list) else []:
    if not isinstance(r, dict):
        continue
    t = (r.get("text") or r.get("content") or "").strip()
    if len(t) < 80:
        continue
    tag = r.get("chunk_tag") or r.get("tag") or ""
    print(f"### [{tag}]\n{t[:900]}\n")
    n += 1
    if n >= 8:
        break
if not n:
    print("(no struggle material found — write the post without it rather than inventing any)")
PY
then
  log "WARN: struggle extraction failed — writing the post without it rather than losing the slot"
  echo "(no struggle material found — write the post without it rather than inventing any)" > "$WORK/struggle.md"
fi
# `grep -c` exits 1 when it counts ZERO, and this assignment used to end in a
# `| head -1` pipe. Under `set -euo pipefail` that made an empty struggle file
# FATAL: the run logged "struggle search: ..." and then died with rc=1, between
# two log lines, with nothing written anywhere saying why. That is how the
# feature lane failed four times on 2026-08-26 while the incident lane, running
# the same search 15s later against a now-warm daemon, succeeded every time.
# No pipe, and `|| true`, because a post with no struggle notes is a fact.
STRUGGLE_N=$(grep -c '^### ' "$WORK/struggle.md" 2>/dev/null || true); STRUGGLE_N=${STRUGGLE_N:-0}
log "struggle: $STRUGGLE_N notes"

# =============================================================================
# 3. Outside research. Without this the post is a changelog. With it, the post
#    is "here is how the rest of the market solves this, and here is where that
#    breaks" — which is the only version worth a stranger's time.
# =============================================================================
RESEARCH_COUNT=0
: > "$WORK/sources.txt"
: > "$WORK/research.md"
RESEARCH_SECS=$(budgeted "$T_RESEARCH" $(( T_DRAFT + 60 )))
if (( RESEARCH_SECS >= 25 )); then
  QUERIES=$(python3 - "$FEATURE_JSON" <<'PY'
import json, sys, re
f = json.load(open(sys.argv[1]))
scope = f.get("scope", "")
subj  = re.sub(r'^feat\([^)]*\):\s*', '', (f.get("commits") or [{}])[0].get("subject", ""))
pil   = f.get("pillar", "")
qs = [f"{scope} {subj} AI agent architecture 2026".strip(),
      f"{pil} best practices LLM agent systems".strip()]
print("\n".join(q for q in qs if len(q) > 12))
PY
)
  i=0
  while IFS= read -r q; do
    [[ -z "$q" ]] && continue
    # NOT (( i++ )): that evaluates to the pre-increment value, so the first
    # pass returns 0 -> exit status 1 -> `set -e` kills the run. Cost us one
    # silent lane failure already.
    i=$(( i + 1 )); (( i > RESEARCH_QUERIES )) && break
    args=$(python3 -c "
import json,sys
print(json.dumps({'query': sys.argv[1], 'numResults': 5}))
" "$q")
    log "research: exa <- \"${q:0:70}\""
    # `|| true` twice over: bt_timeout returns 142 on alarm, vodou-core returns
    # non-zero when the MCP server is down. Neither is fatal here.
    bt_timeout "$RESEARCH_SECS" ./vodou-core call exa web_search_exa "$args" >> "$WORK/exa.raw" 2>/dev/null || true
  done <<< "$QUERIES"

  # Parsing exa is write-post.sh's parser, verbatim and on purpose. exa does NOT
  # return JSON result objects — it returns a text blob of "Title:/URL:/
  # Published:/Highlights:" records. A second, hand-rolled parser here looked for
  # {"url": ...} and silently found nothing, so this lane shipped its first post
  # with zero outside sources while reporting success. One format, one parser.
  python3 - "$WORK/exa.raw" "$WORK/research.md" "$WORK/sources.txt" <<'PY2' 2>/dev/null || true
import json, re, sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
texts = []
for m in re.finditer(r'^\s*\{', raw, re.M):
    dec = json.JSONDecoder()
    try:
        obj, _ = dec.raw_decode(raw[m.start():])
    except Exception:
        continue
    for item in (obj.get('content') or []):
        t = item.get('text')
        if isinstance(t, str):
            texts.append(t)

def field(block, name):
    m = re.search(rf'^{name}:\s*(.+)$', block, re.M)
    return m.group(1).strip() if m else ''

seen, sources = set(), []
for t in texts:
    for block in re.split(r'\n(?=Title:\s)', t):
        url = field(block, 'URL'); title = field(block, 'Title')
        if not url or not title or url in seen or 'vodou.ai' in url:
            continue
        seen.add(url)
        hi = ''
        m = re.search(r'^Highlights:\s*(.*)$', block, re.M | re.S)
        if m:
            hi = re.sub(r'\s*\n\.\.\.\n\s*', ' … ', m.group(1)).strip()
            hi = ' '.join(hi.split())[:700]
        sources.append({'title': title, 'url': url,
                        'published': field(block, 'Published')[:10], 'highlight': hi})

sources = sources[:8]
if not sources:
    sys.exit(1)
with open(sys.argv[2], 'w') as f:
    for s in sources:
        f.write(f"### {s['title']}\nURL: {s['url']}\n")
        if s['published']: f.write(f"Published: {s['published']}\n")
        if s['highlight']: f.write(f"What it says: {s['highlight']}\n")
        f.write("\n")
with open(sys.argv[3], 'w') as f:
    for s in sources:
        f.write(s['url'] + "\n")
print(len(sources), file=sys.stderr)
PY2

  # `grep -c` EXITS 1 on zero matches, so `grep -c ... || echo 0` prints BOTH the
  # grep's own "0" and the fallback "0" -> "0\n0", which then breaks every
  # arithmetic test downstream. wc -l has no such failure mode.
  [[ -s "$WORK/sources.txt" ]] && RESEARCH_COUNT=$(wc -l < "$WORK/sources.txt" | tr -d ' ')
fi
log "research: $RESEARCH_COUNT sources"

# =============================================================================
# 4. The draft.
# =============================================================================
OUTDIR="content/blog"; mkdir -p "$OUTDIR"

{
cat <<'HDR'
You are Chad Priest writing on blog.vodou.ai. You are shipping a LAUNCH POST for
a capability you just built in Vodou — a local-first AI operating system with
persistent memory, retrieval, MCP tool orchestration and autonomous agents.

Your reader is a senior engineer building an AI system of their own. They do not
use Vodou and may never. They are here because you are running the exact stack
they are standing up, in production, and you will tell them what it actually
took.

THE TEST EVERY PARAGRAPH MUST PASS:
  "Would this be useful to someone who will never install Vodou?"
If no, cut it. A feature list is marketing. A field report is worth reading.

HDR

echo "## What shipped"
cat "$WORK/shape.md"

if [[ -s "$WORK/bodies.txt" ]]; then
  echo; echo "## Commit bodies — the WHY, in Chad's own words. Prefer these over your own guesses."
  head -c 6000 "$WORK/bodies.txt"
fi

echo; echo "## What it cost to build — real engineering notes from Chad's memory system"
echo "Use these for the struggle section. Quote specifics: real numbers, real dead ends."
echo "Do NOT invent a struggle that is not here."
head -c 7000 "$WORK/struggle.md"

if (( RESEARCH_COUNT > 0 )); then
  echo; echo "## What the rest of the world is doing about this problem"
  echo "Cite these as inline markdown links where they genuinely support a point."
  echo "Never cite a source you did not use. Never invent a URL."
  cat "$WORK/research.md"
fi

cat <<'RULES'

## THE SECRETS RULE — a scanner enforces this after you, and it can refuse to publish

Vodou is open-core.

  PUBLIC (Apache-2.0, already on GitHub): MCP-servers/, skills/, docs/,
  scripts/, extension/. Name these files freely and concretely. Specific public
  file names make the post credible.

  PROPRIETARY (never publish): the Rust engine. You may say WHAT it does and WHY
  that behaviour matters. You may never give a Rust file name, a path under the
  engine tree, a line number, a function or struct name, or a Rust code block.

  Write "the engine keeps the plan and the run in one transaction, so a crash
  cannot leave a half-executed graph."
  Never  "src/graph_run.rs:412 wraps it in a tx."

Code blocks are allowed and encouraged, but ONLY in languages a reader can use
on their own stack: sql, ts, js, python, bash, json, yaml. No `rust` fences.
If an internal detail is genuinely load-bearing, you may keep it by putting this
on the line above the block, with a real reason:
    <!-- REDACT-OK: why this specific detail has to be here -->

## DIAGRAMS — this post MUST contain 1 to 3 of them

Emit a fenced block with language `vodou-diagram` containing ONE JSON object.
It is rendered to a hand-drawn SVG at build time. `alt` is REQUIRED on every
diagram (it is what a screen reader and an LLM crawler get).

Four types, and these are the ONLY fields that exist:

flow — an architecture or a sequence. `kind` is "normal" | "bad" | "good".
```vodou-diagram
{"type":"flow","alt":"Request path from user prompt through the planner to the executor",
 "title":"How a plan becomes a run","nodes":[
  {"id":"p","label":"Prompt"},
  {"id":"pl","label":"Planner","note":"names every tool up front"},
  {"id":"x","label":"Executor","kind":"good"}],
 "edges":[{"from":"p","to":"pl"},{"from":"pl","to":"x","label":"approved plan"}],
 "caption":"Nothing runs before the plan is visible."}
```

bars — a measurement. Use ONLY numbers that appear in the material above.
```vodou-diagram
{"type":"bars","alt":"Latency before and after, 2100ms down to 340ms",
 "title":"p95 latency","bars":[
  {"label":"before","value":2100,"unit":"ms","kind":"bad"},
  {"label":"after","value":340,"unit":"ms","kind":"good"}]}
```

timeline — how the build actually went, dead ends included.
```vodou-diagram
{"type":"timeline","alt":"Four stages from first attempt to shipped",
 "events":[{"when":"day 1","label":"naive version","kind":"bad"},
           {"when":"day 3","label":"shipped","kind":"good"}]}
```

beforeafter — two states side by side.
```vodou-diagram
{"type":"beforeafter","alt":"Old flow had no approval step, new flow does",
 "before":{"title":"Before","lines":["agent picks a tool","you find out after"]},
 "after":{"title":"After","lines":["agent proposes a plan","you approve","then it runs"]}}
```

Rules: valid JSON, no comments, no trailing commas. Every `edges` entry must
reference node ids that exist. Never invent a number for a `bars` diagram — if
you have no real measurement, use flow, timeline or beforeafter instead.

## HEADINGS — read this before you write a single one

The beats below are BEATS, not headings. They tell you what has to happen in
the post. They are NOT section titles and you must not use their names.

Four earlier posts on this blog shipped with a byte-identical H2 skeleton
because a writer read a numbered list like the one below and copied it out as
headings. Google reads a repeated section skeleton across one domain as
duplicate content, and a human reads it as generated. A checker runs over your
draft after you and reports every heading that is reused or that could sit on
any post, so this is a requirement, not a preference.

Every H2 you write must:
- be about THIS post, not about posts in general. A stranger who read only
  your headings should be able to tell what this post found.
- carry something concrete: the number, the identifier, the symptom, the name
  of the thing that broke. `cached_tokens stayed 0 for five calls` is a
  heading. `The struggle` is a label.
- be a heading you would not be able to paste onto a different post.

BANNED_HEADINGS_HERE

## THE BEATS — cover these, in roughly this order, under your own headings

1. Open on the READER'S problem, on their own stack, in their vocabulary. Not
   "we shipped X". Something like: "Every agent framework lets a model call a
   tool. Almost none let you see what it will do before it does it." No
   preamble, no "in this post".

2. What the capability actually is and what it does for a person using it.
   Concrete. A diagram belongs here.

3. What broke while building it: the first design that was wrong, the thing you
   threw away, the measurement that changed your mind. Specific and
   unflattering. This is the beat that earns the post, so give it real length.
   A build story where everything worked is worth nothing to a reader.

4. Name the transferable failure class. State it as a checkable property of a
   codebase, not as advice. "Be careful with caches" is advice. "A dedupe guard
   between two writers must key on provenance, not existence" is an invariant:
   it is either true or false of a given codebase, and the reader can go and
   look.

5. THE READER'S CHECK. This is the single highest-value paragraph in the post
   and the feature lane has been shipping without it.

   Give a concrete diagnostic the reader runs against THEIR OWN system, using
   NOTHING from ours: no vodou-core, no our file paths, no our binaries. Real
   commands, real SQL, real curl, real pseudocode against a generic stack, plus
   what passing output and failing output each look like. They must be able to
   run it inside five minutes and learn something true about their own code.

   A launch post that a reader cannot act on is a changelog. This beat is what
   makes it an asset instead.

6. What the existing advice on this class misses. Cite the research above with
   real links.

7. A short honest limitation that is still live. Naming one buys more
   credibility than any claim you could make instead.

## VOICE
- First person, past tense, plain. Short sentences.
- Concrete over abstract. Numbers over adjectives, and only real numbers.
- No marketing words: revolutionary, seamless, powerful, game-changing, unlock,
  leverage, robust, cutting-edge, journey, excited to announce.
- NEVER use an em dash (the long dash). Not one, anywhere in the prose. This is
  a hard house rule, not a preference. Where you would reach for one, use a
  colon if you are introducing an explanation, a comma if it is an aside, a
  period if both halves stand alone, or parentheses. Quoted log output inside a
  code fence is exempt, because a quote must stay a quote.
- No bulleted list where a sentence works.
- Never claim a benchmark, user count or result that is not in the material.

## SEO
- Title is a CLAIM, not a topic. Under 70 chars. It should make an engineer who
  has never heard of Vodou want to click. Prefer the problem over the product.
- description: 140-165 chars, states the specific takeaway.
- slug: lowercase, hyphenated, 3-7 words, keyword-first, no date.
- tags: 3-5 lowercase, from the general problem domain (ai-agents, llm, mcp,
  memory, retrieval, observability, architecture) — not Vodou-internal names.
- 1100-1700 words.

## OUTPUT — output ONLY the file body. No preamble, no fences around the whole thing.

---
title: "..."
description: "..."
slug: "..."
date: "DATE_TODAY"
author: Chad Priest
tags: [a, b, c]
canonical_host: blog
cover_image: ""
feature: "FEATURE_KEY_HERE"
---
(body starts here, no H1 — the title renders from frontmatter)
RULES
} > "$WORK/draft.prompt"
sed -i '' "s/DATE_TODAY/$NOW_TS/; s/FEATURE_KEY_HERE/$FEATURE_KEY/" "$WORK/draft.prompt"

# Inject the headings this blog has ALREADY published. A static banned list
# would be whack-a-mole: a model told not to write "The struggle" writes "The
# struggling part" and passes. Showing it the real corpus is what makes
# "do not repeat these" a fact rather than a guess, and the list grows itself
# as the blog does. Same single owner as the post-draft check (headings.py), so
# the thing the writer is warned about and the thing the checker enforces
# cannot drift apart.
python3 - "$WORK/draft.prompt" "$OUTDIR" <<'PY' || log "WARN: could not inject published headings — the writer loses its banned list, not its post"
import subprocess, sys
prompt, blogdir = sys.argv[1], sys.argv[2]
try:
    out = subprocess.run(["python3", "scripts/blog/headings.py", "--corpus", blogdir],
                         capture_output=True, text=True, timeout=20).stdout
except Exception:
    out = ""
seen, hs = set(), []
for h in reversed(out.splitlines()):          # newest files last -> most recent first
    k = h.strip().lower()
    if k and k not in seen:
        seen.add(k); hs.append(h.strip())
hs = hs[:40]
block = ("Headings already used on this blog. Using any of them, or a reworded\n"
         "version of one, is the duplicate-content failure described above:\n\n"
         + "\n".join("  " + h for h in hs)) if hs else ""
s = open(prompt, encoding="utf-8").read().replace("BANNED_HEADINGS_HERE", block)
open(prompt, "w", encoding="utf-8").write(s)
PY

DRAFT_SECS=$(budgeted "$T_DRAFT" 0)
[[ "$DRAFT_SECS" -lt 60 ]] && DRAFT_SECS=60
log "draft: writing (${DRAFT_SECS}s ceiling, prompt $(wc -c < "$WORK/draft.prompt" | tr -d ' ') bytes)"
llm "$DRAFT_SECS" "$WORK/draft.prompt" > "$WORK/body.md"

normalize() {
  python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8', errors='replace').read()
# Only strip a fence that wraps the WHOLE file. A vodou-diagram fence inside the
# body is content, and an over-eager strip would eat the first diagram.
s = re.sub(r'^\s*```(?:markdown|md)?\s*\n', '', s)
s = re.sub(r'\n```\s*$', '\n', s)
i = s.find('---')
if i > 0:
    s = s[i:]
s = s.strip()
open(p, 'w').write(s + '\n' if s else '')
PY

  # Same house rule as write-post.sh, same single owner (dedash.py). Placed in
  # normalize() so it covers the draft AND the revision without a second call
  # site that could drift out of step.
  if ! DED=$(python3 scripts/blog/dedash.py "$1" 2>&1); then
    log "WARN: dedash failed (${DED}) - post keeps its em dashes"
  else
    log "$DED"
  fi
}
normalize "$WORK/body.md"
[[ -s "$WORK/body.md" ]] || { log "FATAL: writer returned empty"; exit 1; }
log "draft: $(wc -w < "$WORK/body.md" | tr -d ' ') words"

# =============================================================================
# 5. DIAGRAM VALIDATION
#
# The remark plugin THROWS on a malformed spec, and it runs inside `astro build`.
# So one bad diagram does not damage one post — it fails the build, which kills
# the deploy, which stops the site updating 3x a day. The blast radius of a
# model typo is the entire pipeline.
#
# Therefore: validate here, and DOWNGRADE what we cannot prove good. A dropped
# diagram costs one image. A thrown build costs every post.
# =============================================================================
python3 - "$WORK/body.md" <<'PY'
import json, re, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
TYPES = {"flow", "bars", "timeline", "beforeafter"}
kept = dropped = 0

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

def repl(m):
    global kept, dropped
    raw = m.group(1)
    try:
        spec = json.loads(raw)
    except Exception as e:
        dropped += 1
        print(f"  dropped diagram: invalid JSON ({e})", file=sys.stderr)
        return ""
    err = check(spec)
    if err:
        dropped += 1
        print(f"  dropped diagram: {err}", file=sys.stderr)
        return ""
    kept += 1
    # Re-emit canonically. The renderer seeds its jitter from a hash of the spec
    # text, so a stable serialization keeps rebuilds byte-identical and stops
    # every deploy re-uploading pages that did not change.
    return "```vodou-diagram\n" + json.dumps(spec, sort_keys=True, indent=1) + "\n```"

s2 = re.sub(r'```vodou-diagram\s*\n(.*?)\n```', repl, s, flags=re.S)
s2 = re.sub(r'\n{3,}', '\n\n', s2)
open(p, "w").write(s2)
print(f"diagrams: {kept} kept, {dropped} dropped", file=sys.stderr)
PY

# =============================================================================
# 6. REDACTION GATE — the hard stop.
# =============================================================================
log "redaction gate"
set +e
python3 scripts/blog/redaction-gate.py "$WORK/body.md" --explain
GATE_RC=$?
set -e
if [[ $GATE_RC -eq 2 ]]; then
  # QUARANTINE, DO NOT DISCARD (2026-08-26)
  # $WORK is a mktemp dir that dies with the process, so a gate block used to
  # destroy the draft it stopped. The 19:00 slot lost 703 words that had already
  # passed the rubric at 26/35 over six occurrences of an internal path -- a
  # 30-second edit, if anyone had been able to see the file. The gate must be
  # able to refuse without also being the thing that decides the work is worthless.
  # This is NOT content/blog: nothing here is published, and the site hash cannot
  # see it. Waive a block with <!-- REDACT-OK: why --> and re-run the gate.
  mkdir -p .vodou/blog/blocked
  _bslug=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}/\1/p' "$WORK/body.md" 2>/dev/null | head -1)
  [[ -z "$_bslug" ]] && _bslug="draft"
  _bout=".vodou/blog/blocked/$(date +%Y-%m-%d-%H%M%S)-$_bslug.md"
  cp "$WORK/body.md" "$_bout" 2>/dev/null || true
  log "BLOCKED by the redaction gate — nothing published; draft quarantined at $_bout"
  exit 2
elif [[ $GATE_RC -ne 0 ]]; then
  log "FATAL: redaction gate could not run (rc=$GATE_RC) — refusing to publish unscanned"
  exit 1
fi

# =============================================================================
# 7. Rubric gate. One revision, never a loop. An unparseable score ships as-is —
#    a grader that can block publication forever is worse than no grader.
# =============================================================================
REVISED="no"
RUBRIC_SECS=$(budgeted "$T_RUBRIC" 30)
if (( RUBRIC_SECS >= 30 )); then
  {
    cat <<'RB'
Grade this launch post for blog.vodou.ai. Answer with ONLY a JSON object.

Score each 1-5:
  useful_without_vodou  A reader who will never install Vodou learns something
                        they can apply. 1 = it is a changelog.
  readers_check         The post gives a concrete diagnostic the reader can run
                        against THEIR OWN system in five minutes, using nothing
                        from our repo: real commands, real SQL, real curl or
                        real pseudocode against a generic stack, plus what
                        passing and failing output each look like. 1 = the
                        reader has nothing to do when they finish reading.
  struggle_is_real      The build story is specific and unflattering, with real
                        dead ends. 1 = it went perfectly.
  general_lesson        A transferable failure class or principle is NAMED, not
                        just implied.
  evidence              Real numbers, real file names, real citations. No vibes.
  no_leak               Stays behavioural about the proprietary engine. Any Rust
                        file name, path or code block = 1.
  title_is_a_claim      The title is a claim that earns a click from a stranger.
  voice                 Plain, first person, no marketing language.

Then: "complaints": [up to 4 short specific fixes], "total", "max": 40,
"verdict": "pass" or "revise".

Output shape: {"scores":{...},"complaints":[...],"total":N,"max":40,"verdict":"..."}

## The draft
RB
    cat "$WORK/body.md"
  } > "$WORK/rubric.prompt"
  llm "$RUBRIC_SECS" "$WORK/rubric.prompt" > "$WORK/rubric.raw" || true
  python3 - "$WORK/rubric.raw" "$WORK/rubric.json" <<'PY' 2>/dev/null || true
import json, re, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'\{.*\}', raw, re.S)
if m:
    d = json.loads(m.group(0))
    json.dump(d, open(sys.argv[2], "w"))
PY

  if [[ -s "$WORK/rubric.json" ]]; then
    TOTAL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('total',0))" "$WORK/rubric.json" 2>/dev/null || echo 0)
    VERDICT=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('verdict',''))" "$WORK/rubric.json" 2>/dev/null || echo "")
    log "rubric: $TOTAL/40 -> ${VERDICT:-unknown}"
    REVISE_SECS=$(budgeted "$T_REVISE" 20)
    if [[ "$VERDICT" == "revise" || "$TOTAL" -lt "$RUBRIC_MIN" ]] && (( REVISE_SECS >= 60 )); then
      log "revising once"
      {
        echo "Revise this post. Fix EVERY complaint. Keep the frontmatter fields and the"
        echo "slug unchanged. Keep all \`\`\`vodou-diagram blocks valid JSON with an alt."
        echo "Do not name any Rust file, engine path or line number. Output ONLY the file body."
        echo; echo "## What the editor said"
        cat "$WORK/rubric.json"
        echo; echo "## The draft to revise"; cat "$WORK/body.md"
      } > "$WORK/revise.prompt"
      llm "$REVISE_SECS" "$WORK/revise.prompt" > "$WORK/revised.md" || true
      normalize "$WORK/revised.md"
      if [[ -s "$WORK/revised.md" ]] && [[ $(wc -w < "$WORK/revised.md") -gt 400 ]]; then
        # A revision that reintroduces a leak must not ship just because it is newer.
        set +e; python3 scripts/blog/redaction-gate.py "$WORK/revised.md"; RRC=$?; set -e
        if [[ $RRC -eq 0 ]]; then
          mv "$WORK/revised.md" "$WORK/body.md"; REVISED="yes"; log "revised"
        else
          log "revision reintroduced a finding (rc=$RRC) — keeping the clean original"
        fi
      fi
    fi
  else
    log "FATAL: rubric unparseable — refusing to publish an unscored draft"; exit 1
  fi
fi

# =============================================================================
# 7b. HEADINGS: the last word, after any revision.
#
# Four posts shipped a byte-identical H2 skeleton (What we built / The struggle
# / The general lesson / Where the standard approach falls short / What is
# still not solved). The prompt asked for beats; the model shipped them as
# section titles. That is the dedash lesson again: a style line in a prompt is
# a request, and the guarantee is a checker.
#
# Placed AFTER the revise loop on purpose. The revision rewrites the whole body
# from the editor's complaints, so a check that ran before it could be undone
# by it. This runs last and cannot be overwritten.
#
# It rewrites HEADING TEXT ONLY, positionally, via headings.py --apply. The
# body is never reopened to the model here, so a re-heading pass cannot drop a
# diagram, rewrite an argument, or reintroduce a string the redaction gate
# already removed. That is why it is safe to run after the gate.
#
# Degrades, never dies: a post is worth more than a heading.
# =============================================================================
set +e; python3 scripts/blog/headings.py --check "$WORK/body.md" "$OUTDIR" --json > "$WORK/headings.json"; HRC=$?; set -e
if [[ $HRC -eq 0 ]]; then
  log "headings: ok ($(python3 -c "import json;print(len(json.load(open('$WORK/headings.json'))['headings']))" 2>/dev/null || echo '?'))"
else
  HSUM=$(python3 - "$WORK/headings.json" <<'PYH' 2>/dev/null || echo "unparseable"
import json, sys
d = json.load(open(sys.argv[1]))
print(f"{len(d['dup'])} reused, {len(d['generic'])} generic, {len(d['skeleton'])} skeleton match(es)")
PYH
)
  REHEAD_SECS=$(budgeted "${BLOG_REHEAD_TIMEOUT:-120}" 15)
  if (( REHEAD_SECS < 45 )); then
    log "headings: $HSUM — no budget left to fix them, shipping as drafted"
  else
    log "headings: $HSUM — rewriting"
    python3 scripts/blog/headings.py --prompt "$WORK/body.md" "$OUTDIR" > "$WORK/rehead.prompt"
    if llm "$REHEAD_SECS" "$WORK/rehead.prompt" > "$WORK/rehead.raw"; then
      python3 scripts/blog/headings.py --parse "$WORK/rehead.raw" > "$WORK/rehead.txt" 2>/dev/null || true
      # One retry, because the observed failure is a COUNT mismatch and it is a
      # model flake, not a bug: the backfill hit it once in nine posts (8 lines
      # returned for 5 headings) and a plain retry produced a clean 5. The
      # count guard means a bad retry costs nothing, so the only reason not to
      # retry is budget, which is what the guard below checks.
      if ! python3 scripts/blog/headings.py --apply "$WORK/body.md" "$WORK/rehead.txt" 2>>"$WORK/rehead.err"; then
        RETRY_SECS=$(budgeted "${BLOG_REHEAD_TIMEOUT:-120}" 15)
        if (( RETRY_SECS >= 45 )); then
          log "headings: $(tail -1 "$WORK/rehead.err" 2>/dev/null), retrying once"
          llm "$RETRY_SECS" "$WORK/rehead.prompt" > "$WORK/rehead.raw" 2>/dev/null || true
          python3 scripts/blog/headings.py --parse "$WORK/rehead.raw" > "$WORK/rehead.txt" 2>/dev/null || true
        fi
      fi
      if [[ -s "$WORK/rehead.txt" ]] && python3 scripts/blog/headings.py --apply "$WORK/body.md" "$WORK/rehead.txt" 2>>"$WORK/rehead.err"; then
        # dedash the new headings: the re-heading model never saw dedash.py.
        python3 scripts/blog/dedash.py "$WORK/body.md" >/dev/null 2>&1 || true
        set +e; python3 scripts/blog/headings.py --check "$WORK/body.md" "$OUTDIR" > "$WORK/headings.after" 2>&1; ARC=$?; set -e
        if [[ $ARC -eq 0 ]]; then
          log "headings: rewritten, now clean"
        else
          log "headings: rewritten, $(grep -c . "$WORK/headings.after" 2>/dev/null || echo '?') finding(s) remain (was: $HSUM)"
        fi
        while IFS= read -r h; do log "  H2: $h"; done < <(grep '^## ' "$WORK/body.md" | sed 's/^## //')
      else
        log "WARN: re-heading produced nothing applicable ($(tail -1 "$WORK/rehead.err" 2>/dev/null)) — keeping the drafted headings"
      fi
    else
      log "WARN: re-heading call failed — keeping the drafted headings"
    fi
  fi
fi

# =============================================================================
# 8. Frontmatter repair + write.
# =============================================================================
python3 - "$WORK/body.md" "$NOW_TS" "$FEATURE_KEY" <<'PY'
import re, sys
p, now_ts, fkey = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(p, encoding="utf-8").read()
if not raw.startswith("---"):
    print("no frontmatter in draft", file=sys.stderr); sys.exit(1)
_, fm, body = raw.split("---", 2)
fm = fm.strip()

def get(k):
    m = re.search(rf'^{k}:\s*(.+)$', fm, re.M)
    return m.group(1).strip() if m else None

for k in ("title", "description", "slug", "tags"):
    v = get(k)
    if not v or v in ('""', "''", "..."):
        print(f"frontmatter missing/placeholder: {k}", file=sys.stderr); sys.exit(1)

# Keys the pipeline actively REMOVES, whatever the model wrote. `series` makes
# dev.to group every post into an "N Part Series" switcher, which reframes each
# standalone post as chapter N of something a first-time reader hasn't read.
for k in ("series",):
    fm = re.sub(rf'^{k}:.*$\n?', '', fm, flags=re.M)

fixed = {"date": f'"{now_ts}"', "author": "Chad Priest", "canonical_host": "blog",
         "cover_image": '""',
         "feature": f'"{fkey}"'}
for k, v in fixed.items():
    if re.search(rf'^{k}:', fm, re.M):
        fm = re.sub(rf'^{k}:.*$', f'{k}: {v}', fm, count=1, flags=re.M)
    else:
        fm += f'\n{k}: {v}'

if len(body.split()) < 300:
    print(f"body too short: {len(body.split())} words", file=sys.stderr); sys.exit(1)
open(p, 'w').write(f'---\n{fm}\n---\n{body.lstrip()}')
PY

# =============================================================================
# 8a. SEO LENGTHS: warnings warn; hard findings get one rewrite, then block.
#
# This lane's draft prompt already asks for a 150-160 character description.
# Four of the first eleven published posts came back at 212, 186, 179 and 172.
# Same single owner as the incident writer (seo-check.py), same doctrine as
# dedash.py and headings.py: the prompt line is the request, the checker is the
# guarantee.
#
# Placed HERE on purpose, immediately after section 8 has repaired the
# frontmatter and before the file is copied to $OUT. Anything earlier measures
# a string the repair pass can still change.
#
# Advisory ONLY, and seo-check.py has no --apply by design. Shortening a
# description means writing a new claim about the post, and losing a finished
# post over one long sentence is a worse trade than a truncated SERP snippet.
# =============================================================================
# The published corpus goes in alongside the draft so a description or title
# reused from an earlier post is caught: that is the one finding a single-file
# check structurally cannot see. Output is then filtered to THIS draft, because
# an older post's long description is a real finding but not this run's job.
SEO_ARGS=("$WORK/body.md")
for f in "$OUTDIR"/*.md; do [[ -f "$f" ]] && SEO_ARGS+=("$f"); done
set +e; SEO=$(python3 scripts/blog/seo-check.py --check "${SEO_ARGS[@]}" 2>&1); SEORC=$?; set -e
if (( SEORC >= 2 )); then
  log "WARN: seo-check could not run (rc=$SEORC) - title/description lengths unverified"
else
  # Match the draft as the SUBJECT of a finding ("<file>: <message>"), not
  # merely as a mention: a dup finding names the OTHER post in its message, and
  # without the trailing colon this run would log that post's row as its own.
  SEO_MINE=$(printf '%s\n' "$SEO" | grep -F "$WORK/body.md: " | sed "s|$WORK/body.md|draft|" || true)
  if [[ -z "$SEO_MINE" ]]; then
    log "seo: title and description lengths ok"
  else
    while IFS= read -r l; do
      [[ -n "$l" ]] && log "WARN: seo: $l"
    done <<< "$SEO_MINE"
  fi
  # A hard finding used to be logged as FAIL and then shipped anyway (three
  # posts on 2026-08-27 at 216, 195 and 186 chars). A FAIL that does not fail
  # is decoration. The checker never rewrites (see seo-check.py); a writer
  # prompt may. So: one targeted rewrite of the description alone, re-check,
  # and if it is still hard the draft does not ship. Dup findings and a
  # missing description have no rewrite path and block outright.
  if (( SEORC == 1 )) && printf '%s\n' "$SEO_MINE" | grep -q '^FAIL'; then
    if printf '%s\n' "$SEO_MINE" | grep -q '^FAIL  desc-long'; then
      CUR_DESC=$(sed -n 's/^description: *//p' "$WORK/body.md" | head -1)
      {
        echo "Rewrite this blog post meta description so it is 130-160 characters. Keep the same claim; do not add a new one. No em dashes. Output ONLY the new description on one line, no quotes, no preamble."
        echo; echo "Title: $(sed -n 's/^title: *//p' "$WORK/body.md" | head -1)"
        echo "Current description: $CUR_DESC"
      } > "$WORK/desc.prompt"
      NEW_DESC=$(llm 90 "$WORK/desc.prompt" | tr -d '\r' | grep -v '^[[:space:]]*$' | head -1 | sed 's/^"//; s/"$//; s/"/\\"/g')
      if [[ -n "$NEW_DESC" && ${#NEW_DESC} -le 175 ]]; then
        python3 - "$WORK/body.md" "$NEW_DESC" <<'PY2'
import re, sys
p, d = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
s = re.sub(r'^description:.*$', 'description: "' + d + '"', s, count=1, flags=re.M)
open(p, 'w').write(s)
PY2
        log "seo: description rewritten (${#NEW_DESC} chars): $NEW_DESC"
      else
        log "seo: description rewrite unusable (${#NEW_DESC} chars)"
      fi
      set +e; SEO=$(python3 scripts/blog/seo-check.py --check "${SEO_ARGS[@]}" 2>&1); SEORC=$?; set -e
      SEO_MINE=$(printf '%s\n' "$SEO" | grep -F "$WORK/body.md: " | sed "s|$WORK/body.md|draft|" || true)
    fi
    if (( SEORC == 1 )) && printf '%s\n' "$SEO_MINE" | grep -q '^FAIL'; then
      log "FATAL: seo hard finding after rewrite, draft not shipped: $(printf '%s\n' "$SEO_MINE" | grep '^FAIL' | tr '\n' ';')"
      exit 1
    fi
    log "seo: hard finding cleared"
  fi
fi

SLUG=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}/\1/p' "$WORK/body.md" | head -1)
[[ -z "$SLUG" ]] && SLUG="feature-$(date +%H%M%S)"
OUT="$OUTDIR/$TODAY-$SLUG.md"
cp "$WORK/body.md" "$OUT"
log "wrote: $OUT"

# =============================================================================
# 9. Ledger. mine-features.sh dedupes on feature_key AND on sha overlap, so BOTH
#    go in. Without feature_commits, a re-clustered version of the same work
#    (different key, same commits) would publish a second time.
# =============================================================================
python3 - "$OUT" "$FEATURE_JSON" <<'PY'
import json, sys, os, re
sys.path.insert(0, "scripts/blog")
try:
    from pillars import pillar_of
except Exception:
    pillar_of = lambda s: "unsorted"

out, fj = sys.argv[1], sys.argv[2]
feat = json.load(open(fj))
raw = open(out, encoding="utf-8").read()
fm = raw.split("---", 2)[1] if raw.startswith("---") else ""

def field(k):
    m = re.search(rf'^{k}:\s*"?(.+?)"?\s*$', fm, re.M)
    return m.group(1).strip() if m else None

title = field("title") or os.path.basename(out)
slug = field("slug") or os.path.basename(out).rsplit(".", 1)[0]
base = os.environ.get("BLOG_CANONICAL_BASE", "https://blog.vodou.ai").rstrip("/")

entry = {
    "file": out,
    "source_chunk_ids": [],
    "status": "drafted",
    "targets": {},
    "title": title,
    "canonical": f"{base}/{slug}",
    "pillar": feat.get("pillar") or pillar_of(title + " " + raw),
    "lane": "feature",
    "feature_key": feat.get("feature_key"),
    "feature_commits": feat.get("commit_shas", []),
}
p = ".vodou/blog/ledger.json"
d = json.load(open(p)) if os.path.exists(p) else {"published": []}
d.setdefault("published", []).append(entry)
json.dump(d, open(p, "w"), indent=2)
PY

python3 - "$OUT" "$FEATURE_KEY" "$SLOT" "$WORK/rubric.json" "$REVISED" "$RESEARCH_COUNT" "$(elapsed)" <<'PY' 2>/dev/null || true
import json, os, sys
out, fkey, slot, rub, revised, nres, secs = sys.argv[1:8]
rec = {"file": out, "lane": "feature", "feature_key": fkey, "slot": slot,
       "research_sources": int(nres), "revised": revised == "yes", "elapsed_s": int(secs)}
if os.path.exists(rub):
    d = json.load(open(rub))
    rec["rubric"] = {"scores": d.get("scores"), "total": d.get("total"),
                     "verdict": d.get("verdict"), "complaints": d.get("complaints")}
os.makedirs(".vodou/blog", exist_ok=True)
with open(".vodou/blog/rubric.jsonl", "a") as f:
    f.write(json.dumps(rec) + "\n")
PY

log "done in $(elapsed)s (research=$RESEARCH_COUNT, revised=$REVISED)"
echo "$OUT"
