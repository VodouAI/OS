# Growth machine — the LISTEN and REPURPOSE organs

Built 2026-08-31. Companion to `scripts/blog/` (which MAKES content) and
`skills/agents/marketing/` (19 agents that PLAN it). Those two already existed.
What was missing was a reason to write a given post and a way for it to reach
anyone outside this repo.

## Why these two and not more

Counted first: 19 marketing agents, 1 publisher (dev.to + Hashnode), 0 listeners,
0 measurers. Adding creation capacity to that has negative value. The two organs
here are the ones with no equivalent anywhere in the tree.

## Pieces

| File | Does |
|---|---|
| `phrases.txt` | exa queries. exa wants a *description of the ideal page*, not keywords. `<lane>\|<query>` |
| `hn-phrases.txt` | HN Algolia queries — keyword search. `<lane>\|<query>\|<tag>` |
| `signal-hunt.sh` | Runs both, dedups against the ledger, writes a ranked digest |
| `parse-signals.py` | Parse → reclassify → suppress → rank → digest |

Lanes: `ask` (someone wants this) > `pain` (someone hurts) > `rival` (competitive
set, never pitched).

## The ledger is the point

`.vodou/growth/leads.json`. exa and HN return the *same forty accounts* every week.
A listening loop without suppression is a machine for re-annoying people.

Status is sticky and human-owned: `new` → `contacted` / `rejected` / `competitor`
/ `bot` / `self`. Anything in `SUPPRESSED` never resurfaces and is never re-scored.
Everything else is re-laned and re-scored on every run, because the rules change
and a ledger that stays wrong is worse than no ledger.

Set a status by hand:

```bash
python3 - <<'PY'
import json; p='.vodou/growth/leads.json'; d=json.load(open(p))
for l in d['leads']:
    if 'news.ycombinator.com/item?id=44848995' in l['url']: l['status']='contacted'
json.dump(d, open(p,'w'), indent=1)
PY
```

## Rival auto-demotion

The first run put ContextVault, Mem0, Core and MemoryPlugin at the *top* of the
actionable list. They are not leads — they are the competitive set announcing
itself, and the author of a memory tool is the one person who will never install
another one. `reclassify()` lanes a launch-post-about-a-memory-product as `rival`,
scores it below every human lane, and files it under "competitive set, never
pitched." Free competitor tracking falls out of the same run.

## Exit codes — the verdict, unsoftened

| Code | Means |
|---|---|
| `0` + new leads | digest written |
| `0`, `new: 0` | genuine quiet day — the searches *ran* and returned known hits |
| `3` | **every search failed.** The lane is broken, not quiet |
| `1` | lock held by another run |

`3` exists because absence-shaped metrics are satisfied by total failure. A dead
exa server and a quiet Tuesday produce the same empty digest; only the
`searches: N/M ok` header and this exit code tell them apart. The console skill is
instructed to read that header before anything else.

## Cost

$0. exa is a keyless hosted MCP server; HN Algolia is public.

**X search is deliberately absent.** Posting is on X's free tier; *search* starts
at Basic — $200/month, twice the entire marketing budget. General rule for every
social channel: **read by free API, write by human browser session.** Posting
through a scraped or automated session is how accounts get shadowbanned.

## Wired into Vodou

```
script_registry  vodou-growth::signal-hunt      (background, 240s)
                 vodou-growth::signal-digest    (sync, for prompt injection)
                 vodou-growth::latest-post      (sync, for prompt injection)
scheduled_tasks  growth-signal-hunt       0 11 * * *   → runs the hunt
                 skill:growth-signal     30 11 * * *   → reads digest, drafts, → Telegram
                 skill:growth-repurpose   0 21 * * *   → post → thread/HN/reddit → Telegram
skills_meta      growth-signal (145), growth-repurpose (146)
```

Both skills are **draft-only**. Neither has a send path, and both prompts forbid
claiming one. Outreach and posting are human acts.

## Manual

```bash
./scripts/growth/signal-hunt.sh                    # hunt now
SIGNAL_HUNT_LIMIT=10 ./scripts/growth/signal-hunt.sh
cat .vodou/growth/digest-$(date +%F).md
tail .vodou/growth/runs.log
```
