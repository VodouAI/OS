#!/usr/bin/env bash
# Shared helpers for the blog pipeline. Sourced, never executed.
#
# Two things macOS does not give you that this pipeline needs:
#   - flock(1)    → mutual exclusion between scheduled runs
#   - timeout(1)  → a ceiling on an LLM call that can hang forever
# Both are reimplemented here with tools that ARE on a stock mac.

# --- timeout -----------------------------------------------------------------
# perl's alarm + exec: the child replaces perl, so the process tree stays flat
# and stdout passes straight through (which matters — callers capture it).
# Returns 142 on timeout (128 + SIGALRM), like GNU timeout's 124 in spirit.
bt_timeout() {
  local secs="$1"; shift
  # exec failure must NOT reuse a caller's reserved exit code. perl's
  # `die "$!"` exits with errno -- ENOENT is 2, and blog-run.sh reserves 2 for
  # "redaction gate blocked this draft". A missing writer therefore logged as a
  # security gate DOING ITS JOB, which is the one misreport guaranteed never to
  # be investigated. 127 is the shell's own command-not-found code.
  perl -e 'alarm shift; exec @ARGV or print STDERR "bt_timeout: cannot exec $ARGV[0]: $!\n" and exit 127' "$secs" "$@"
}

# --- lock --------------------------------------------------------------------
# mkdir is atomic on every filesystem we care about. The PID file inside lets us
# tell "another run is working" from "a run died holding the lock" — the second
# case is what actually happened on 2026-08-26, when two morning runs raced,
# mined the SAME chunk, and produced two posts about one incident.
bt_lock_acquire() {
  local dir="$1" stale_after="${2:-1800}"
  if mkdir "$dir" 2>/dev/null; then
    echo $$ > "$dir/pid"; return 0
  fi
  local owner age
  owner=$(cat "$dir/pid" 2>/dev/null || echo "")
  if [[ -n "$owner" ]] && kill -0 "$owner" 2>/dev/null; then
    return 1   # genuinely running
  fi
  # Holder is gone, or the dir predates any live process: reclaim it.
  age=$(( $(date +%s) - $(stat -f %m "$dir" 2>/dev/null || echo 0) ))
  if [[ -z "$owner" || $age -gt $stale_after ]] || ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$dir"
    mkdir "$dir" 2>/dev/null && { echo $$ > "$dir/pid"; return 0; }
  fi
  return 1
}

bt_lock_release() { rm -rf "$1"; }

# --- content fingerprint -----------------------------------------------------
# What the live site SHOULD be, derived from the markdown the pipeline owns.
# Used to decide whether a deploy is needed and to prove one landed.
bt_content_hash() {
  local root="${1:-content/blog}"
  find "$root" -name '*.md' -type f -print0 2>/dev/null \
    | sort -z | xargs -0 shasum 2>/dev/null | shasum | awk '{print $1}'
}

# --- SITE fingerprint --------------------------------------------------------
# bt_content_hash only sees content/blog. That was the whole freshness bug:
# every template, sitemap, redirect and llms.txt change lived in blog-site/ and
# was therefore INVISIBLE to the deploy decision. The pipeline reported "site
# already matches content" and skipped the deploy, so a rebuilt sitemap sat on
# disk for hours while the live one advertised a URL that now 301s.
#
# The live site is a function of BOTH the markdown and the generator. Hash both.
# Build outputs, deps and caches are excluded: they are derived, and including
# them would make the hash differ on every machine and never converge.
bt_site_hash() {
  {
    find content/blog -name '*.md' -type f -print0 2>/dev/null | sort -z | xargs -0 shasum 2>/dev/null
    find blog-site/src blog-site/public -type f -print0 2>/dev/null | sort -z | xargs -0 shasum 2>/dev/null
    shasum blog-site/astro.config.mjs blog-site/redirects.json blog-site/package.json 2>/dev/null
  } | shasum | awk '{print $1}'
}

# --- memory search, with a retry ---------------------------------------------
# WHY A RETRY EXISTS (2026-08-26)
#
# `mem search` talks to the daemon over a unix socket with a ~15s read ceiling.
# On a loaded machine -- load average was 77 the evening this was written, with
# a rustc and a vitest fleet in the background -- a COLD embedding model does
# not answer inside that window and the CLI returns
#
#   daemon search failed: Resource temporarily unavailable (os error 35)
#
# That is a BUSY signal, not an empty result, and both call sites used to render
# the two identically with `|| echo '[]'`. Downstream, "no material" means the
# model is asked to write about something it could not look up, which is the
# one condition under which it invents.
#
# The first attempt warms the daemon as a side effect, which is why a retry is
# not merely hopeful: every slot today, the feature lane's single attempt timed
# out and the incident lane's search succeeded against the same daemon 15
# seconds later. Attempt 2 is talking to a warm model.
#
# WHY EXACTLY ONE RETRY, AND WHY A LONG ONE
#
# A client timeout does NOT cancel the daemon's work. The daemon's own log, the
# same evening:
#
#   [mem-search SLOW] total_ms=214071 embed_ms=199374 ... query_words=11
#
# 199 SECONDS to embed an eleven-word query, behind a 15s client door. So every
# attempt that "fails" leaves a multi-minute ONNX job running, and a retry adds
# another one to a queue that is already the reason the first one was late. A
# three-attempt loop is a self-inflicted stampede against the exact component
# it is waiting on — the daemon climbed from 152% to 526% CPU while this
# function was being written, and the abandoned work is why.
#
# One retry, after a pause long enough to be worth taking, is what the evidence
# supports: on 2026-08-26 the feature lane's single attempt timed out and the
# incident lane's search against the same daemon succeeded 15s later, every
# slot. Tune with BLOG_MEM_SEARCH_TRIES if a machine genuinely warrants more.
#
# Always exits 0 and always prints valid JSON. A caller under `set -e` must be
# able to treat an empty memory as a fact, not as a fault.
bt_mem_search() {
  local q="$1" k="${2:-12}" tries="${3:-${BLOG_MEM_SEARCH_TRIES:-2}}" i out
  for (( i=1; i<=tries; i++ )); do
    if out=$(./vodou-core mem search "$q" --top-k "$k" --json 2>/dev/null); then
      if [[ -n "$out" && "$out" != "[]" ]]; then
        printf '%s' "$out"
        return 0
      fi
    fi
    if [[ $i -lt $tries ]]; then
      echo "bt_mem_search: attempt $i/$tries returned nothing (daemon busy, or genuinely no match) — one retry in ${BLOG_MEM_SEARCH_BACKOFF:-12}s" >&2
      sleep "${BLOG_MEM_SEARCH_BACKOFF:-12}"
    fi
  done
  echo "bt_mem_search: no result after $tries attempt(s) — caller receives [] and must degrade, not invent" >&2
  printf '[]'
  return 0
}
