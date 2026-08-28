#!/usr/bin/env bash
#
# Vodou blog post writer.
# Takes one mined topic (chunk id), gathers surrounding evidence from memory.db,
# gathers OUTSIDE context from the web, drives an LLM to a full post in Chad
# Priest's voice, then grades that post against an editorial rubric and revises
# once if it misses the bar.
#
# Usage: scripts/blog/write-post.sh <chunk_id> [--slot morning|midday|evening]
# Output: content/blog/YYYY-MM-DD-<slug>.md   (path printed on stdout)
#
# WHY THE EXTRA STAGES (2026-08-26)
# The first five posts were true and well-written and completely insular: every
# one of them was "here is a bug in MY system." A reader building their own
# agent got a story, not an asset. The writer was structurally incapable of
# doing better — its only inputs were memory.db chunks, so it had nothing to
# relate the incident TO. Three additions fix that:
#
#   1. CLASSIFY  — name the general failure class the incident belongs to, and
#                  derive web queries from the class, not from our file paths.
#   2. RESEARCH  — search the open web for what is already written about that
#                  class, so the post can say what the existing advice misses
#                  and can cite real, linkable sources.
#   3. RUBRIC    — grade the draft on the things that actually predict value to
#                  a stranger (takeaway, reproduction, real numbers, a title
#                  that makes a claim), and revise ONCE against the complaints.
#
# Every one of those is optional at runtime. A dead exa server, a slow model, a
# malformed JSON score — none of them may cost us the post. Each stage is
# bounded by bt_timeout, each degrades to "skip it and keep going", and the
# whole script runs under a wall-clock budget so blog-run.sh's 900s ceiling is
# never the thing that decides whether a draft exists.
#
# Contract with blog-run.sh is unchanged: same args, the post path is the ONLY
# thing on stdout, non-zero exit means no post. All diagnostics go to stderr.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source scripts/blog/lib.sh

CHUNK_ID="${1:?usage: write-post.sh <chunk_id> [--slot morning|midday|evening]}"
SLOT="${3:-anchor}"
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

# --- budget ------------------------------------------------------------------
# blog-run.sh wraps this whole script in bt_timeout 900. Being killed there is
# the worst outcome available: the draft dies in a command substitution and
# nothing reaches disk. So we keep our own clock, spend it in priority order,
# and drop optional stages rather than run past the edge.
START_TS=$(date +%s)
BUDGET="${BLOG_WRITE_BUDGET:-840}"
T_CLASSIFY="${BLOG_CLASSIFY_TIMEOUT:-120}"
T_RESEARCH="${BLOG_RESEARCH_TIMEOUT:-75}"
T_DRAFT="${BLOG_LLM_TIMEOUT:-480}"
T_RUBRIC="${BLOG_RUBRIC_TIMEOUT:-150}"
T_REVISE="${BLOG_REVISE_TIMEOUT:-360}"
RUBRIC_MIN="${BLOG_RUBRIC_MIN:-26}"      # of 35
RUBRIC_FLOOR="${BLOG_RUBRIC_FLOOR:-3}"   # of 5, per criterion
RESEARCH_QUERIES="${BLOG_RESEARCH_QUERIES:-2}"

log() { printf '[%s] [write-post] %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }

elapsed()   { echo $(( $(date +%s) - START_TS )); }
remaining() { local r=$(( BUDGET - $(elapsed) )); (( r < 0 )) && r=0; echo "$r"; }

# budgeted <wanted_secs> <reserve_secs> -> seconds this stage may have, 0 = skip
budgeted() {
  local want="$1" reserve="${2:-0}" avail
  avail=$(( $(remaining) - reserve ))
  (( avail < 20 )) && { echo 0; return; }
  (( want < avail )) && echo "$want" || echo "$avail"
}

# Every LLM call in this file goes through here. No exceptions — an unbounded
# `claude -p` inside a command substitution is exactly how the site went stale
# for hours on 2026-08-26, and killing the parent does not kill the child.
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

WORK=$(mktemp -d -t vodou-blog)
cleanup() { [[ "${BLOG_KEEP_WORK:-0}" == "1" ]] && { log "work dir kept: $WORK"; return; }; rm -rf "$WORK"; }
trap cleanup EXIT

# =============================================================================
# 1. The spine: the chunk this post is built on.
# =============================================================================
SPINE=$(sqlite3 -json memory.db "SELECT id, chunk_tag, text, path, date(created_at,'localtime') day FROM memory_chunks WHERE id='$CHUNK_ID';")
[[ "$SPINE" == "[]" || -z "$SPINE" ]] && { echo "no such chunk: $CHUNK_ID" >&2; exit 1; }
printf '%s\n' "$SPINE" > "$WORK/spine.json"

SPINE_TEXT=$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))[0]['text'])
" "$WORK/spine.json" 2>/dev/null || echo "")

log "spine: $CHUNK_ID (${#SPINE_TEXT} chars)"

# =============================================================================
# 2. Inside evidence: related chunks, via the daemon's real hybrid pipeline
#    (FTS5 + vector + reranker) — NOT a raw FTS MATCH, which skips the reranker.
# =============================================================================
QUERY=$(python3 -c "
import json,sys,re
c = json.load(open(sys.argv[1]))[0]
t = re.sub(r'[^A-Za-z0-9 ._-]', ' ', c['text'])
print(' '.join(t.split()[:14]))
" "$WORK/spine.json" 2>/dev/null || echo "")
EVIDENCE=$(bt_mem_search "$QUERY" 12)
printf '%s\n' "$EVIDENCE" > "$WORK/evidence.json"
log "evidence: $(printf '%s' "$EVIDENCE" | wc -c | tr -d ' ') bytes from mem search"

# =============================================================================
# 3. CLASSIFY: what general problem is this a specific case of?
#
# This is the hinge. Searching the web for our own file paths returns nothing;
# searching for "stale cached tool output in agent loops" returns the entire
# conversation the industry is already having. The model's only job here is to
# translate one incident into the vocabulary the rest of the world uses for it.
# =============================================================================
PROBLEM_CLASS=""
READER_STACKS=""
declare -a SEARCH_QUERIES=()

CLASSIFY_SECS=$(budgeted "$T_CLASSIFY" $(( T_DRAFT + 30 )))
if [[ "$CLASSIFY_SECS" -gt 0 ]]; then
  {
    cat <<'EOF'
You are triaging one engineering incident so a writer can place it in the
industry-wide conversation about that class of bug.

Below is a raw engineering note from a developer's own memory system. It is
specific to their codebase. Your job is to name the GENERAL problem it is an
instance of, in the vocabulary that people building LLM / agent / RAG / backend
systems actually use — the words they would search for, not our internal names.

## The incident
EOF
    cat "$WORK/spine.json"
    cat <<'EOF'

## Output
Return ONLY minified JSON, no prose, no markdown fence:
{
  "problem_class": "<8-14 words naming the general failure class, no product names>",
  "why_general": "<one sentence: why this bites anyone with a similar architecture>",
  "reader_stacks": "<comma-separated list of 3-4 concrete stacks where this same bug appears, e.g. 'LangChain tool caching, Postgres full-text search, any MCP server'>",
  "search_queries": [
    "<a natural-language query describing the ideal blog post / doc about this problem class>",
    "<a second query aimed at the standard ADVICE or best practice for this class, so we can find what that advice misses>"
  ]
}
EOF
  } > "$WORK/classify.prompt"

  log "classify: asking for problem class (${CLASSIFY_SECS}s ceiling)"
  llm "$CLASSIFY_SECS" "$WORK/classify.prompt" > "$WORK/classify.out" || true

  # Parse defensively. A fenced block, a preamble sentence, or a truncated
  # response all mean "no classification" — never a crash.
  python3 - "$WORK/classify.out" "$WORK/classify.json" <<'PY' 2>/dev/null || true
import json, re, sys
raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'\{.*\}', raw, re.S)
if not m:
    sys.exit(1)
d = json.loads(m.group(0))
out = {
    "problem_class": str(d.get("problem_class", "")).strip(),
    "why_general": str(d.get("why_general", "")).strip(),
    "reader_stacks": str(d.get("reader_stacks", "")).strip(),
    "search_queries": [str(q).strip() for q in (d.get("search_queries") or []) if str(q).strip()],
}
if not out["problem_class"]:
    sys.exit(1)
json.dump(out, open(sys.argv[2], "w"))
PY

  if [[ -s "$WORK/classify.json" ]]; then
    PROBLEM_CLASS=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['problem_class'])" "$WORK/classify.json")
    READER_STACKS=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['reader_stacks'])" "$WORK/classify.json")
    while IFS= read -r q; do [[ -n "$q" ]] && SEARCH_QUERIES+=("$q"); done < <(
      python3 -c "import json,sys;[print(q) for q in json.load(open(sys.argv[1]))['search_queries'][:$RESEARCH_QUERIES]]" "$WORK/classify.json"
    )
    log "classify: \"$PROBLEM_CLASS\" (${#SEARCH_QUERIES[@]} queries)"
  else
    log "classify: FAILED or unparseable — falling back to keyword query"
  fi
else
  log "classify: SKIPPED (budget: $(remaining)s left, draft needs ${T_DRAFT}s)"
fi

# Fallback so research still has something to search for: the spine's own words.
if [[ ${#SEARCH_QUERIES[@]} -eq 0 && -n "$QUERY" ]]; then
  SEARCH_QUERIES+=("technical blog post or documentation explaining $QUERY")
fi

# =============================================================================
# 4. RESEARCH: what has the rest of the world already written about this class?
#
# Bounded per query, degrades to nothing. A failed search must NEVER block the
# post — the writer prompt has a whole separate branch for "no sources today".
# =============================================================================
: > "$WORK/exa.raw"
RESEARCH_COUNT=0

if [[ "${BLOG_RESEARCH:-1}" == "1" && ${#SEARCH_QUERIES[@]} -gt 0 ]]; then
  for q in "${SEARCH_QUERIES[@]}"; do
    secs=$(budgeted "$T_RESEARCH" $(( T_DRAFT + 30 )))
    if [[ "$secs" -eq 0 ]]; then
      log "research: SKIPPED remaining queries (budget: $(remaining)s left)"
      break
    fi
    args=$(python3 -c "
import json,sys
print(json.dumps({'query': sys.argv[1], 'numResults': 5}))
" "$q")
    log "research: exa <- \"${q:0:80}\" (${secs}s ceiling)"
    # `|| true` twice over: bt_timeout returns 142 on alarm, vodou-core returns
    # non-zero when the MCP server is down. Neither is fatal here.
    bt_timeout "$secs" ./vodou-core call exa web_search_exa "$args" >> "$WORK/exa.raw" 2>/dev/null || true
  done

  # Parse every exa payload we managed to collect into a source list.
  python3 - "$WORK/exa.raw" "$WORK/research.md" "$WORK/sources.txt" <<'PY' 2>/dev/null || true
import json, re, sys

raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()

# `vodou-core call` prints a human preamble, then the JSON result. Collect every
# top-level JSON object in the stream rather than assuming one call, one blob.
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
    # exa returns one blob with many "Title: / URL: / Published: / Highlights:"
    # records; split on the URL line so records stay whole.
    for block in re.split(r'\n(?=Title:\s)', t):
        url = field(block, 'URL')
        title = field(block, 'Title')
        if not url or not title or url in seen:
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
        f.write(f"### {s['title']}\n")
        f.write(f"URL: {s['url']}\n")
        if s['published']:
            f.write(f"Published: {s['published']}\n")
        if s['highlight']:
            f.write(f"What it says: {s['highlight']}\n")
        f.write("\n")
with open(sys.argv[3], 'w') as f:
    for s in sources:
        f.write(s['url'] + "\n")
# stderr, not stdout: this script's stdout is a CONTRACT — blog-run.sh reads it
# as the path of the post that was written. A stray count on stdout made $POST
# "8\ncontent/blog/...", which silently skipped the per-post live-URL check.
print(len(sources), file=sys.stderr)
PY

  [[ -s "$WORK/sources.txt" ]] && RESEARCH_COUNT=$(wc -l < "$WORK/sources.txt" | tr -d ' ')
  log "research: $RESEARCH_COUNT usable sources"
else
  log "research: DISABLED (BLOG_RESEARCH=${BLOG_RESEARCH:-1})"
fi

# =============================================================================
# 5. Slot shapes the post's length and ambition.
# =============================================================================
case "$SLOT" in
  morning|anchor) SHAPE="ANCHOR POST — 1100-1600 words. Full narrative: symptom, false leads, the measurement that cracked it, root cause with real SQL and real measurements, the fix, and the section that generalizes it. This is the SEO/canonical piece." ;;
  midday)         SHAPE="BUILD LOG — 500-800 words. Tight and punchy: one specific thing learned today, one code block, and the generalization section in compressed form (2-3 paragraphs, still with a real reproduction). Written like a good commit message that grew up." ;;
  evening)        SHAPE="TIL / SHORT — 300-500 words. One sharp observation. Title must be the lesson itself. No preamble. The generalization is the spine of the piece, not a section: name the class in paragraph one, give the reader's check in paragraph three." ;;
  *)              SHAPE="ANCHOR POST — 1100-1600 words." ;;
esac

OUTDIR="content/blog"; mkdir -p "$OUTDIR"

# =============================================================================
# 6. DRAFT
# =============================================================================
build_draft_prompt() {
  local f="$1"
  : > "$f"
  {
    cat <<'EOF'
You are ghostwriting a technical blog post as **Chad Priest**, founder of Vodou —
a local-first AI memory + orchestration system (Rust engine, SQLite memory store
with FTS5 + vector hybrid retrieval, a Node/TS gateway, MCP servers, a Chrome
extension). He builds in public. Readers are senior engineers on dev.to,
Hashnode, Hacker News, and r/programming.

MOST OF THEM DO NOT USE VODOU AND NEVER WILL. They are here because they are
building their own agent, their own RAG pipeline, their own gateway, and they
want to not hit the bug you hit. The incident is your EVIDENCE. It is not your
SUBJECT. A post that only documents our repo is a changelog, and a changelog
earns nothing from a stranger.

EOF
    printf '%s\n\n' "$SHAPE"

    if [[ -n "$PROBLEM_CLASS" ]]; then
      cat <<'EOF'
## The general failure class this post is actually about
EOF
      python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
print(d['problem_class'])
if d.get('why_general'): print('Why it generalizes: ' + d['why_general'])
if d.get('reader_stacks'): print('Other stacks with the same bug: ' + d['reader_stacks'])
" "$WORK/classify.json"
      printf '\n'
    fi

    cat <<'EOF'
## The spine of this post (a real engineering note from Chad's own memory system)
EOF
    cat "$WORK/spine.json"

    cat <<'EOF'

## Supporting evidence from the same codebase (use freely, cite specifics)
EOF
    cat "$WORK/evidence.json"
    printf '\n'

    if [[ "$RESEARCH_COUNT" -gt 0 ]]; then
      cat <<'EOF'

## What the rest of the internet already says about this problem class
These are REAL search results, fetched just now. Use them to position the post.

RULES FOR THESE SOURCES — violating any of them is worse than not citing at all:
- Link with a normal markdown link and the FULL url, copied character for
  character from the "URL:" lines below. Never invent, shorten, or guess a URL.
- Never cite a source you did not actually engage with in the sentence.
- If a source is irrelevant to this incident, ignore it silently. Do not pad.
- Do not summarize the list. Argue with it.

Somewhere in the post, engage with at least one of these by name and say what it
gets right and what it misses for the case in the evidence above. The most
valuable sentence you can write is "the standard advice is X; X does not cover
the case where Y", followed by the evidence that Y happened.

EOF
      cat "$WORK/research.md"
    else
      cat <<'EOF'

## Outside sources
The web search returned nothing usable this run. Write the post WITHOUT external
citations — do not invent a link, a study, a benchmark, or a "most teams" claim
to fill the gap. Generalize from the evidence you have instead: name the class,
state the invariant, give the reader a check they can run. An uncited post that
teaches is fine. A fabricated citation is not.
EOF
    fi

    cat <<'EOF'

## Structural requirement — the post MUST do this or it is worthless
Somewhere after the root cause, and before the ending, the post carries a
section (your own H2 wording, never a generic "Generalization" header) that does
three things in order:

1. NAMES THE CLASS. State the general failure this incident is one instance of,
   in words that contain no Vodou nouns. A reader should be able to recognize
   the same bug in a stack that shares nothing with ours. Name two or three
   other places it shows up.

2. STATES THE INVARIANT. One bolded sentence that is true of any system with
   this shape — the rule that was violated. Not advice ("be careful with
   caches"). A checkable property ("a dedupe guard between two writers must key
   on provenance, not existence"). If you cannot state it as something that is
   either true or false of a codebase, it is not an invariant yet.

3. GIVES THE READER'S CHECK. A concrete reproduction or diagnostic the reader
   runs against THEIR OWN system, using nothing from our repo — no vodou-core,
   no our-file-paths, no our binaries. Real commands, real SQL, real curl, real
   pseudocode against a generic stack, plus what the passing output and the
   failing output each look like. The reader must be able to run it inside five
   minutes and learn something true about their own code. This is the single
   highest-value paragraph in the post; write it like it is.

The specific incident is the evidence for all three. Keep it specific — real
numbers, real SQL, real paths outside the engine (never src/*.rs). Specificity is what makes the
generalization believable, so do not sand it down.

## What may and may not be named — the redaction gate enforces this, hard
  PUBLIC (Apache-2.0, already on GitHub): MCP-servers/, skills/, docs/,
  scripts/, extension/. Name these files freely and concretely.

  PROPRIETARY (never publish): the Rust engine. You may say WHAT it does and WHY
  that behaviour matters. You may never give a Rust file name, a path under the
  engine tree (src/*.rs), a line number, a function or struct name, or a Rust
  code block. Code blocks ONLY in sql, ts, js, python, bash, json, yaml.
  Write "the engine keeps the plan and the run in one transaction."
  Never  "src/graph_run.rs:412 wraps it in a tx."
  If an internal detail is genuinely load-bearing, put this on the line above:
    <!-- REDACT-OK: why this specific detail has to be here -->

## Voice rules — these are non-negotiable
- First person, past tense, plain declarative sentences. Chad is direct, dry, a
  little funny. He does NOT do LinkedIn energy, hype, or "🚀 Excited to share".
- NEVER open with "In the world of..." / "As developers, we all know..." /
  "Have you ever...". Open with the concrete failure or the concrete number.
- Show real SQL, real shell, real measurements, real PUBLIC file paths from the
  evidence above; engine internals are described, never named. Specificity IS the distribution strategy. Vague = zero shares.
- Admit what was wrong first. The "I was wrong about X for three days" beat is
  the single highest-trust move in dev writing.
- End with a rule a stranger can apply to a codebase that isn't ours.
- NEVER use an em dash (the long dash). Not one, anywhere in the prose. This is
  a hard house rule, not a preference. Where you would reach for one, use a
  colon if you are introducing an explanation, a comma if it is an aside, a
  period if both halves stand alone, or parentheses. Quoted log output inside a
  code fence is exempt, because a quote must stay a quote.
- No bullet-list-only sections, no "Conclusion" header.
- Do not sell Vodou. It is the lab, not the pitch. No feature list, no CTA.
- If the evidence does not support a claim, cut the claim. Never invent a
  benchmark, a version number, a date, a quote, or a URL.

## SEO rules
- Title: 50-62 chars, and it must make a CLAIM, not announce a topic. "Your
  dedupe guard is checking existence, not freshness" beats "Notes on caching".
  Front-load the searchable failure mode; aim at a query a frustrated engineer
  types at 2am.
- Include the literal error text / symptom string somewhere in the body — that
  is what people paste into Google.
- 3-5 H2 sections. Every heading must be about THIS post: carry the number, the
  identifier, the symptom or the name of the thing that broke. A heading you
  could paste onto a different post is not a heading, it is a label. "The rule"
  has been used three times on this blog already; a checker runs over your
  draft and reports every heading that is reused or that carries nothing
  specific, so this is a requirement rather than a preference.

BANNED_HEADINGS_HERE
- 150-160 char meta description that names the problem and the resolution.

## Output format — output ONLY the file body, nothing before or after
No preamble, no markdown code fence around the whole thing. Start with the
opening `---` of the frontmatter and end with the last line of the body.
EOF
    cat <<EOF
---
title: "..."
description: "..."
slug: "kebab-case-from-title"
date: "$NOW_TS"
author: Chad Priest
tags: [4 lowercase dev.to-style tags, e.g. sqlite, rust, debugging, ai]
canonical_host: blog
cover_image: ""
---

<full markdown body here>
EOF
  } >> "$f"
}

build_draft_prompt "$WORK/draft.prompt"

# Show the writer what this blog has already published. A static banned list is
# whack-a-mole: a model told not to write "The rule" writes "The rule here" and
# passes. The real corpus makes it a fact, and it grows itself as the blog does.
# Same single owner as the post-draft check (headings.py), so the warning and
# the enforcement cannot drift apart.
python3 - "$WORK/draft.prompt" "$OUTDIR" <<'PYH' || log "WARN: could not inject published headings — the writer loses its banned list, not its post"
import subprocess, sys
prompt, blogdir = sys.argv[1], sys.argv[2]
try:
    out = subprocess.run(["python3", "scripts/blog/headings.py", "--corpus", blogdir],
                         capture_output=True, text=True, timeout=20).stdout
except Exception:
    out = ""
seen, hs = set(), []
for h in reversed(out.splitlines()):
    k = h.strip().lower()
    if k and k not in seen:
        seen.add(k); hs.append(h.strip())
hs = hs[:40]
block = ("Headings already used on this blog. Using any of them, or a reworded\n"
         "version of one, is a duplicate-content signal to Google and reads as\n"
         "generated to a human:\n\n" + "\n".join("  " + h for h in hs)) if hs else ""
s = open(prompt, encoding="utf-8").read().replace("BANNED_HEADINGS_HERE", block)
open(prompt, "w", encoding="utf-8").write(s)
PYH

DRAFT_SECS=$(budgeted "$T_DRAFT" 0)
[[ "$DRAFT_SECS" -lt 60 ]] && DRAFT_SECS=60   # the draft is the one thing we never skip
log "draft: writing (${DRAFT_SECS}s ceiling, prompt $(wc -c < "$WORK/draft.prompt" | tr -d ' ') bytes)"
llm "$DRAFT_SECS" "$WORK/draft.prompt" > "$WORK/body.md"

# The model occasionally wraps the file in a fence or leads with a sentence.
# Normalizing here is cheaper than losing a good post to a stray line.
normalize() {
  python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8', errors='replace').read()
s = re.sub(r'^\s*```[a-zA-Z]*\s*\n', '', s)
s = re.sub(r'\n```\s*$', '\n', s)
i = s.find('---')
if i > 0:
    s = s[i:]
s = s.strip()
# Write nothing rather than a lone newline: callers test with `-s`, and a
# 1-byte file made an empty LLM response look like a successful draft.
open(p, 'w').write(s + '\n' if s else '')
PY

  # The house no-em-dash rule, applied where BOTH the draft and the revision
  # pass through. A style line in the prompt is a request; this is the
  # guarantee. Never fatal: losing a finished post over punctuation is a worse
  # trade than shipping one dash, so it warns and carries on.
  if ! DED=$(python3 scripts/blog/dedash.py "$1" 2>&1); then
    log "WARN: dedash failed (${DED}) - post keeps its em dashes"
  else
    log "$DED"
  fi
}
normalize "$WORK/body.md"
[[ -s "$WORK/body.md" ]] || { log "FATAL: writer returned empty"; echo "writer returned empty" >&2; exit 1; }
log "draft: $(wc -w < "$WORK/body.md" | tr -d ' ') words"

# =============================================================================
# 7. RUBRIC GATE
#
# Grading is a second, cheaper LLM call that only ever returns JSON. It is a
# gate, not a loop: at most one revision, and an unparseable score means the
# draft ships as-is. A grader that can block publication forever is worse than
# no grader.
# =============================================================================
build_rubric_prompt() {
  local f="$1"
  {
    cat <<'EOF'
You are a brutal acquisitions editor for a top-tier engineering publication.
Score the draft below. You are NOT the author, you are NOT being helpful, and
you have no interest in the company that wrote it. Your only question is
whether an engineer who has never heard of this company gets something they can
use on their own system.

Score each criterion 0-5. 3 is "acceptable", 5 is "best in class this month".
Be stingy. Most drafts deserve 3s.

- stranger_takeaway: a reader with zero context on this product finishes with
  something they can apply Monday. 0 if the post is only comprehensible to
  someone who knows this codebase.
- reproduction: there is a concrete check or repro the reader runs against
  THEIR OWN stack, using none of the author's tools or file paths, with stated
  pass/fail output. 0 if the "takeaway" is only advice.
- evidence_real: numbers, paths, line numbers, error strings are specific and
  traceable. Deduct hard for vibes ("much faster", "most teams", "significant
  improvement") and for any statistic with no source.
- not_a_changelog: reads as an argument about how systems fail, not a status
  update about one repo. 0 if you could retitle it "what I did this week".
- title_is_a_claim: the title asserts something falsifiable or names a specific
  failure mode. A topic ("Notes on caching") scores 1. A claim ("your dedupe
  guard checks existence, not freshness") scores 5.
- transferable_principle: the post names the GENERAL failure class and states
  an invariant that is checkably true or false of an arbitrary codebase.
- voice: first person, blunt, concrete, admits being wrong, no marketing, no
  LinkedIn energy, no "In the world of".

Then write complaints. Each complaint must be ACTIONABLE and point at a
specific paragraph, sentence, or missing thing. "Make it better" is useless.
"The reader's check in section 4 uses the author's own CLI, so nobody else can
run it — replace it with plain SQL against any FTS5 table" is useful.

Return ONLY minified JSON, no prose, no markdown fence:
{"scores":{"stranger_takeaway":N,"reproduction":N,"evidence_real":N,"not_a_changelog":N,"title_is_a_claim":N,"transferable_principle":N,"voice":N},"complaints":["...","..."],"fix_instructions":"<3-6 sentences telling the writer exactly what to change, in priority order>"}

## The draft
EOF
    cat "$WORK/body.md"
  } > "$f"
}

# score_draft <jsonfile> -> writes rubric json, echoes "total|verdict" or ""
score_draft() {
  local out="$1" secs
  secs=$(budgeted "$T_RUBRIC" 0)
  if [[ "$secs" -eq 0 ]]; then
    log "rubric: SKIPPED (budget: $(remaining)s left)"
    return 1
  fi
  build_rubric_prompt "$WORK/rubric.prompt"
  log "rubric: scoring (${secs}s ceiling)"
  llm "$secs" "$WORK/rubric.prompt" > "$WORK/rubric.out"
  python3 - "$WORK/rubric.out" "$out" "$RUBRIC_MIN" "$RUBRIC_FLOOR" <<'PY' 2>/dev/null
import json, re, sys
raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'\{.*\}', raw, re.S)
if not m:
    sys.exit(1)
d = json.loads(m.group(0))
keys = ["stranger_takeaway","reproduction","evidence_real","not_a_changelog",
        "title_is_a_claim","transferable_principle","voice"]
sc = {k: int(d.get("scores", {}).get(k, 0) or 0) for k in keys}
total = sum(sc.values())
floor = int(sys.argv[4])
weakest = min(sc.values())
verdict = "pass" if (total >= int(sys.argv[3]) and weakest >= floor) else "revise"
out = {"scores": sc, "total": total, "max": 5*len(keys), "weakest": weakest,
       "verdict": verdict,
       "complaints": [str(c) for c in (d.get("complaints") or [])][:8],
       "fix_instructions": str(d.get("fix_instructions", "")).strip()}
json.dump(out, open(sys.argv[2], "w"))
print(f'{total}|{verdict}')
PY
}

log_scores() {
  local tag="$1" file="$2"
  [[ -s "$file" ]] || return 0
  python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
s = d['scores']
print('  ' + '  '.join(f'{k}={v}' for k, v in s.items()))
print(f\"  total={d['total']}/{d['max']}  weakest={d['weakest']}  verdict={d['verdict']}\")
for c in d['complaints'][:5]:
    print('  - ' + c[:200])
" "$file" 2>/dev/null | while IFS= read -r l; do log "rubric[$tag]:$l"; done
}

RUBRIC_RESULT=""
REVISED="no"
if [[ "${BLOG_RUBRIC:-1}" == "1" ]]; then
  RUBRIC_RESULT=$(score_draft "$WORK/rubric.json" || true)
  if [[ -n "$RUBRIC_RESULT" ]]; then
    log "rubric: ${RUBRIC_RESULT%%|*}/35 -> ${RUBRIC_RESULT##*|}"
    log_scores "draft" "$WORK/rubric.json"
  else
    log "FATAL: rubric unscorable — refusing to publish an unscored draft"; exit 1
  fi

  if [[ "${RUBRIC_RESULT##*|}" == "revise" ]]; then
    REVISE_SECS=$(budgeted "$T_REVISE" 0)
    if [[ "$REVISE_SECS" -gt 0 ]]; then
      {
        cat <<'EOF'
Revise the blog post below. An editor scored it and it missed the bar. Their
complaints are specific; fix each one. This is the ONLY revision pass — there is
no round two, so land it now.

## What the editor said
EOF
        python3 -c "
import json,sys
d = json.load(open(sys.argv[1]))
print('Scores (0-5): ' + ', '.join(f'{k}={v}' for k, v in d['scores'].items()))
print(f\"Total {d['total']}/{d['max']} — needed {sys.argv[2]} with nothing below {sys.argv[3]}.\")
print()
print('Complaints:')
for c in d['complaints']:
    print('- ' + c)
print()
if d['fix_instructions']:
    print('Fix instructions: ' + d['fix_instructions'])
" "$WORK/rubric.json" "$RUBRIC_MIN" "$RUBRIC_FLOOR"

        cat <<'EOF'

## Hard rules for the revision
- Keep the frontmatter block exactly as-is in shape: the same keys, in the same
  order (title, description, slug, date, author, tags, canonical_host,
  cover_image). If you change the title, change the slug to match it in
  kebab case. Change nothing else in the frontmatter.
- Do not invent evidence, numbers, benchmarks, dates, quotes, or URLs to satisfy
  a complaint. If a complaint asks for something the evidence cannot support,
  fix it by removing the unsupported claim instead of inventing support.
- Only cite URLs that already appear in the draft.
- Keep the voice: first person, past tense, blunt, dry, admits being wrong.
- The reader's-own-system check must use no tooling specific to this author.
- Output ONLY the revised file body: the opening `---` through the last line.
  No preamble, no fence, no explanation of what you changed.

## The draft to revise
EOF
        cat "$WORK/body.md"
      } > "$WORK/revise.prompt"

      log "revise: one pass (${REVISE_SECS}s ceiling)"
      llm "$REVISE_SECS" "$WORK/revise.prompt" > "$WORK/body.revised.md"
      normalize "$WORK/body.revised.md"

      # Only accept a revision that is actually a post. A truncated or empty
      # revision must not be allowed to destroy a draft that already exists.
      if [[ -s "$WORK/body.revised.md" ]] && head -1 "$WORK/body.revised.md" | grep -q '^---$' \
         && grep -q '^slug:' "$WORK/body.revised.md"; then
        cp "$WORK/body.revised.md" "$WORK/body.md"
        REVISED="yes"
        log "revise: accepted ($(wc -w < "$WORK/body.md" | tr -d ' ') words)"
        if [[ "${BLOG_RUBRIC_RESCORE:-0}" == "1" ]]; then
          RESCORE=$(score_draft "$WORK/rubric2.json" || true)
          [[ -n "$RESCORE" ]] && { log "rubric: rescored ${RESCORE%%|*}/35 -> ${RESCORE##*|}"; log_scores "revised" "$WORK/rubric2.json"; }
        fi
      else
        log "revise: REJECTED (empty or malformed) — keeping the original draft"
      fi
    else
      log "revise: SKIPPED (budget: $(remaining)s left) — shipping the draft as scored"
    fi
  fi
else
  log "rubric: DISABLED (BLOG_RUBRIC=0)"
fi

# =============================================================================
# 7c. HEADINGS: the last word, after any revision.
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
# 8. Frontmatter validation + deterministic repair
#
# The Astro content collection validates this schema and rejects the build if a
# key is missing, which turns one bad draft into a dead site. The five keys we
# know the correct value for get repaired silently; the four the model must
# supply are a hard failure, because guessing a title is not repair.
# =============================================================================
python3 - "$WORK/body.md" "$NOW_TS" <<'PY' || { log "FATAL: frontmatter invalid"; exit 1; }
import re, sys
p, now_ts = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8', errors='replace').read()
m = re.match(r'^---\n(.*?)\n---\n(.*)$', s, re.S)
if not m:
    print("no frontmatter block", file=sys.stderr); sys.exit(1)
fm, body = m.group(1), m.group(2)

def get(k):
    mm = re.search(rf'^{k}:\s*(.*)$', fm, re.M)
    return mm.group(1).strip() if mm else None

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
         "cover_image": '""'}
for k, v in fixed.items():
    if re.search(rf'^{k}:', fm, re.M):
        fm = re.sub(rf'^{k}:.*$', f'{k}: {v}', fm, count=1, flags=re.M)
    else:
        fm += f'\n{k}: {v}'

if len(body.split()) < 120:
    print(f"body too short: {len(body.split())} words", file=sys.stderr); sys.exit(1)

open(p, 'w').write(f'---\n{fm}\n---\n{body.lstrip()}')
PY

# =============================================================================
# 8a. SEO LENGTHS: warnings warn; hard findings get one rewrite, then block.
#
# The draft prompt already asks for a 140-165 character description. Four of
# the first eleven published posts came back at 212, 186, 179 and 172. That is
# the dedash lesson a third time in this directory: the prompt line is the
# request, the checker is the guarantee.
#
# Placed HERE on purpose, immediately after section 8 has repaired and
# rewritten the frontmatter. Anything earlier measures a string the repair pass
# can still change, and the number that matters is the one in the file that
# ships.
#
# Advisory ONLY, and seo-check.py has no --apply by design. Shortening a
# description means writing a new claim about the post, and losing a finished
# post over one long sentence is a worse trade than a truncated SERP snippet.
# So it warns and carries on, exactly like dedash above it.
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

# =============================================================================
# 8b. REDACTION GATE
#
# This lane leaks less than the feature lane, but it leaks: engine file names
# with LINE NUMBERS reached the live archive before anything ever ran this
# scanner, and a published post is in llms-full.txt and cannot be recalled.
# Same contract as write-feature-post.sh — rc 2 means the gate refused.
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

SLUG=$(sed -n 's/^slug: *"\{0,1\}\([a-z0-9-]*\)"\{0,1\}/\1/p' "$WORK/body.md" | head -1)
[[ -z "$SLUG" ]] && SLUG="post-$(date +%H%M%S)"
OUT="$OUTDIR/$TODAY-$SLUG.md"
cp "$WORK/body.md" "$OUT"
log "wrote: $OUT"

# =============================================================================
# 9. Ledger + rubric log
#
# Ledger format is unchanged on purpose — publish.mjs keys entries by `file` and
# mine-topics.sh reads `source_chunk_ids`. The editorial telemetry lives in its
# own JSONL so scores can be tracked over time without touching that contract.
# =============================================================================
python3 - "$OUT" "$CHUNK_ID" <<'PY'
import json, sys, os, re
sys.path.insert(0, "scripts/blog")
from pillars import pillar_of

out, chunk = sys.argv[1], sys.argv[2]
raw = open(out, encoding="utf-8").read()
fm  = raw.split("---", 2)[1] if raw.startswith("---") else ""

def field(k):
    m = re.search(rf'^{k}:\s*"?(.+?)"?\s*$', fm, re.M)
    return m.group(1).strip() if m else None

title = field("title") or os.path.basename(out)
slug  = field("slug")  or os.path.basename(out).rsplit(".", 1)[0]
base  = os.environ.get("BLOG_CANONICAL_BASE", "https://blog.vodou.ai").rstrip("/")

entry = {
    "file": out,
    "source_chunk_ids": [chunk],
    "status": "drafted",
    "targets": {},
    "title": title,
    "canonical": f"{base}/{slug}",
    # Which of the four pillars this post landed in. mine-topics.sh reads the
    # sequence of these to decide what to write NEXT — without it the miner has
    # no memory of coverage and one topic runs away with the whole blog.
    "pillar": pillar_of(title + " " + raw),
}
feat = field("feature")
if feat:
    entry["feature"] = feat

p = ".vodou/blog/ledger.json"
d = json.load(open(p)) if os.path.exists(p) else {"published": []}
d.setdefault("published", []).append(entry)
json.dump(d, open(p, "w"), indent=2)
PY

python3 - "$OUT" "$CHUNK_ID" "$SLOT" "$WORK/rubric.json" "$REVISED" "$PROBLEM_CLASS" "$RESEARCH_COUNT" "$WORK/sources.txt" "$(elapsed)" <<'PY' 2>/dev/null || true
import json, os, sys
out, chunk, slot, rub, revised, klass, nres, srcf, secs = sys.argv[1:10]
rec = {"file": out, "chunk": chunk, "slot": slot, "problem_class": klass,
       "research_sources": int(nres), "revised": revised == "yes",
       "elapsed_s": int(secs)}
if os.path.exists(srcf):
    rec["sources"] = [l.strip() for l in open(srcf) if l.strip()]
if os.path.exists(rub):
    d = json.load(open(rub))
    rec["rubric"] = {"scores": d["scores"], "total": d["total"], "max": d["max"],
                     "verdict": d["verdict"], "complaints": d["complaints"]}
os.makedirs(".vodou/blog", exist_ok=True)
with open(".vodou/blog/rubric.jsonl", "a") as f:
    f.write(json.dumps(rec) + "\n")
PY

log "done in $(elapsed)s (research=$RESEARCH_COUNT sources, revised=$REVISED)"
echo "$OUT"
