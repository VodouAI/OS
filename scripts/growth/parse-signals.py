#!/usr/bin/env python3
"""Parse raw signal-hunt MCP output -> dedup against the ledger -> ranked digest.

The ledger is the point. exa and HN will hand you the SAME forty accounts every
week; a listening loop without suppression is a machine for re-annoying people.
A lead's status is sticky: contacted / rejected / competitor / bot never resurface.
"""
import argparse, json, os, re, sys, time, hashlib
from datetime import datetime, timezone

LANE_WEIGHT = {"ask": 3.0, "pain": 2.0, "rival": 1.0}
SUPPRESSED = {"contacted", "rejected", "competitor", "bot", "self", "dead"}
# Our own properties: never lead-generate ourselves.
SELF_HOSTS = ("vodou.ai", "github.com/vodouai", "github.com/VodouAI")

# --- repliability -------------------------------------------------------------
# The reply lane needs a place to REPLY. A blog post, a vendor landing page and a
# help-center doc have no comment box and no human on the other end; ranking them
# as "leads" is how the first ledger filled up with SEO pages. A lead is a reply
# target only if its URL is a thread on a surface that accepts public replies.
# Everything else is still useful -- as research for the writing lane -- so it is
# laned `article`, not deleted.
#
# reply_window_days: after this, the thread is effectively closed. HN disables
# replies about two weeks in, so a 195-day-old HN item is not a target at any
# score. Forums stay open but a stranger reviving a 6-month thread reads as spam.
VENUES = (
    (re.compile(r"news\.ycombinator\.com/item\?id=", re.I),      "hn",        14),
    (re.compile(r"reddit\.com/r/[^/]+/comments/", re.I),          "reddit",    45),
    (re.compile(r"community\.openai\.com/t/", re.I),             "openai",    60),
    (re.compile(r"discuss\.huggingface\.co/t/", re.I),           "hf",        60),
    (re.compile(r"community\.[a-z0-9-]+\.(com|ai|org)/t/", re.I), "discourse", 60),
    (re.compile(r"(stackoverflow|serverfault|superuser)\.com/questions/", re.I), "so", 60),
    (re.compile(r"github\.com/[^/]+/[^/]+/(issues|discussions)/\d+", re.I), "github", 90),
)


def venue_of(url):
    for rx, name, window in VENUES:
        if rx.search(url or ""):
            return name, window
    return None, None


def load_json_blob(path):
    """vodou-core prints human preamble then '📤 Result:' then JSON."""
    try:
        raw = open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    i = raw.find("{")
    while i != -1:
        try:
            return json.JSONDecoder().raw_decode(raw[i:])[0]
        except json.JSONDecodeError:
            i = raw.find("{", i + 1)
    return None


def text_blocks(blob):
    if not isinstance(blob, dict):
        return []
    return [c.get("text", "") for c in blob.get("content", []) if isinstance(c, dict)]


def parse_exa(blob, lane):
    out = []
    for text in text_blocks(blob):
        for chunk in text.split("\n---\n"):
            m_url = re.search(r"^URL:\s*(\S+)", chunk, re.M)
            if not m_url:
                continue
            m_t = re.search(r"^Title:\s*(.+)$", chunk, re.M)
            m_p = re.search(r"^Published:\s*(\S+)", chunk, re.M)
            m_a = re.search(r"^Author:\s*(.+)$", chunk, re.M)
            hl = chunk.split("Highlights:", 1)[-1].strip()
            hl = re.sub(r"\s*\n\.\.\.\n\s*", " … ", hl)
            out.append({
                "source": "exa", "lane": lane, "url": m_url.group(1).strip(),
                "title": (m_t.group(1).strip() if m_t else "(untitled)"),
                "author": (m_a.group(1).strip() if m_a else "N/A"),
                "published": (m_p.group(1)[:10] if m_p else ""),
                "snippet": hl[:600], "points": 0, "comments": 0,
            })
    return out


def parse_hn(blob, lane):
    out = []
    for text in text_blocks(blob):
        try:
            inner = json.loads(text)
        except json.JSONDecodeError:
            continue
        for h in inner.get("hits", []):
            oid = str(h.get("objectID", ""))
            if not oid:
                continue
            body = (h.get("comment_text") or h.get("story_text") or "").strip()
            body = re.sub(r"<[^>]+>", "", body)
            out.append({
                "source": "hn", "lane": lane,
                "url": h.get("url") or f"https://news.ycombinator.com/item?id={oid}",
                "title": h.get("title") or h.get("story_title") or "(HN comment)",
                "author": h.get("author", "?"),
                "published": (h.get("created_at") or "")[:10],
                "snippet": body[:600],
                "points": h.get("points") or 0,
                "comments": h.get("num_comments") or 0,
            })
    return out


def parse_discourse(blob, lane):
    """Discourse /search.json -- the only FRESH, keyless, repliable source we have.
    exa returns articles and HN's phrase hits skew old; community.openai.com is
    people describing the problem this week, in a thread that is still open."""
    out = []
    base = blob.get("_base", "https://community.openai.com")
    users = {u.get("id"): u.get("username") for u in blob.get("users", []) or []}
    posters = {}
    for t in blob.get("topics", []) or []:
        posters[t.get("id")] = t
    for t in blob.get("topics", []) or []:
        tid = t.get("id")
        if not tid:
            continue
        out.append({
            "source": "discourse", "lane": lane,
            "url": f"{base}/t/{t.get('slug','t')}/{tid}",
            "title": t.get("title") or "(untitled)",
            "author": users.get(t.get("last_poster_user_id")) or "N/A",
            "published": (t.get("created_at") or "")[:10],
            "snippet": (t.get("excerpt") or t.get("title") or "")[:600],
            "points": t.get("like_count") or 0,
            "comments": max((t.get("posts_count") or 1) - 1, 0),
        })
    return out


# --- rival detection ---------------------------------------------------------
# First run of this script put ContextVault, Mem0, Core and MemoryPlugin at the
# TOP of the actionable list. They are not leads -- they are the competitive set
# announcing itself. A launch post is a rival even when the query was "ask",
# because the author already HAS the tool they'd be pitched.
RIVAL_TITLE = re.compile(
    r"(show hn:|launch(ing|ed)?\b|^introducing\b|\bwe built\b|\bi built\b|\bi made\b)",
    re.I)
RIVAL_PRODUCT = re.compile(
    r"(memory (layer|graph|plugin|engine|lake)|context vault|contextvault|mem0|memoryplugin"
    r"|second brain|knowledge graph for ai|ai memory|memx|memdex|memorylake|recall\.ai"
    r"|portable memory|cross-platform (ai )?memory|one memory (across|for|every))", re.I)
# A vendor's own marketing page is a rival even with no launch verb in the title:
# "AI Memory for ChatGPT, Claude & Gemini | MemoryPlugin" is a competitor's
# landing page, and the first ledger ranked four of them as prospects.
RIVAL_BRAND = re.compile(
    r"\|\s*(memoryplugin|memx|memdex|memorylake|contextvault|mem0|core|supermemory)\s*$", re.I)


def reclassify(lead):
    """A launch announcement about a memory product is competitive intel, not a lead."""
    title = (lead.get("title") or "").strip().lower()
    # A dead/flagged HN item has no page and no author to reply to. It is not a
    # lead at any score -- suppress it outright rather than ranking a corpse.
    if title in ("[dead]", "[flagged]", "[deleted]", ""):
        lead["status"] = "dead"
        lead["why"] = "HN item is dead/flagged/untitled -- nothing to reply to"
        return lead
    blob = f"{lead.get('title','')} {lead.get('url','')}"
    if RIVAL_BRAND.search(lead.get("title", "")) or (
            RIVAL_TITLE.search(blob)
            and RIVAL_PRODUCT.search(f"{blob} {lead.get('snippet','')}")):
        lead["lane"] = "rival"
        lead["why"] = "memory-product launch or vendor page — competitive set, not a prospect"
        lead["repliable"] = False
        return lead

    # Can we actually reply to this?
    venue, window = venue_of(lead.get("url", ""))
    lead["venue"] = venue or ""
    lead["repliable"] = bool(venue)
    lead["age_days"] = age_days(lead.get("published"))

    if not venue:
        # No comment box, no human. Still worth reading -- it is what the writing
        # lane mines -- but it can never be a reply target.
        lead["lane"] = "article"
        lead["why"] = "no public reply surface at this URL — research input, not a target"
        return lead

    hits = topic_hits(lead)
    lead["topic_hits"] = hits
    if hits == 0:
        # Fresh, repliable, and about something else entirely. Not a target.
        lead["status"] = "offtopic"
        lead["why"] = "no memory/context language in title or excerpt — search matched on stray terms"
        return lead
    if lead.get("status") == "offtopic":
        lead["status"] = "new"          # repair pass: widened TOPIC can revive it
        lead.pop("why", None)

    age = lead["age_days"]
    if age is None:
        lead["status"] = "undated"
        lead["why"] = "no publish date — cannot tell if the thread is still open"
    elif age > window:
        lead["status"] = "stale"
        lead["why"] = f"{venue} thread is {age}d old (reply window {window}d) — closed or dead air"
    elif lead.get("status") in ("stale", "undated"):
        lead["status"] = "new"      # repair pass: a widened window can revive a row
        lead.pop("why", None)
    return lead


# --- topical relevance --------------------------------------------------------
# Discourse ORs its search terms, so "carry memory between chats projects"
# returns an image-gallery thread and an SSH question. Freshness without a
# topic gate just produces fresh noise. A reply target must actually be about
# the thing we fix: memory / context / continuity across turns or tools.
TOPIC = re.compile(
    r"\b(memor(y|ies)|remember(s|ing)?|forget(s|ting|ful)?|amnesia"
    r"|context (window|limit|length|rot|loss)|re-?explain(ing)?|repeat myself"
    r"|start(ing)? over|from scratch|persistent|continuity|carry (it |them )?over"
    r"|across (chats|sessions|conversations|tools|accounts|models|devices)"
    r"|between (chats|sessions|conversations)|new (chat|session|conversation)"
    r"|long[- ]term|conversation (length|limit)|maximum length)\b", re.I)


def topic_hits(lead):
    blob = f"{lead.get('title','')} {lead.get('snippet','')}"
    return len(set(m.group(0).lower() for m in TOPIC.finditer(blob)))


def age_days(published):
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(
            (published or "")[:10] + "T00:00:00+00:00")).days
    except Exception:
        return None


def lead_id(lead):
    return hashlib.sha1(lead["url"].encode()).hexdigest()[:16]


def score(lead):
    """Rank REPLY TARGETS. An unrepliable page and a closed thread score 0 --
    not 'a bit lower'. The first ledger ranked a 195-day-old HN item and four
    vendor landing pages above the one live thread, because the old decay term
    bottomed out at 90 days and nothing tested for a comment box."""
    if lead["lane"] in ("rival", "article") or not lead.get("repliable"):
        return 0.0
    if lead.get("status") in ("stale", "dead", "offtopic"):
        return 0.0
    s = LANE_WEIGHT.get(lead["lane"], 1.0)
    age_d = lead.get("age_days")
    if age_d is None:
        s -= 1.0                                    # undated = probably unopenable
    else:
        _, window = venue_of(lead["url"])
        window = window or 60
        s += 2.5 * max(0.0, 1.0 - age_d / float(window))   # linear to the close
        if age_d <= 7:
            s += 1.0                                # this week: the thread is live
    s += min(1.5, (lead["points"] + lead["comments"]) / 100.0)
    if re.search(r"\b(I|my|we)\b", lead["snippet"][:200]):
        s += 0.75                                   # first person = a human hurting
    s += min(1.5, 0.5 * (lead.get("topic_hits", 0) - 1))   # density = really about it
    if re.search(r"\?\s*$|^(how|why|can|does|is there|anyone)\b",
                 (lead.get("title") or "").strip(), re.I):
        s += 0.5                                    # a question invites an answer
    return round(s, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--digest", required=True)
    ap.add_argument("--attempted", type=int, default=0)
    ap.add_argument("--succeeded", type=int, default=0)
    a = ap.parse_args()

    ledger = {"leads": []}
    if os.path.exists(a.ledger):
        try:
            ledger = json.load(open(a.ledger))
        except Exception:
            ledger = {"leads": []}
    known = {l["id"]: l for l in ledger.get("leads", [])}

    found = []
    for fn in sorted(os.listdir(a.raw)):
        if not fn.endswith(".out"):
            continue
        lane_f = os.path.join(a.raw, fn[:-4] + ".lane")
        lane = open(lane_f).read().strip() if os.path.exists(lane_f) else "pain"
        blob = load_json_blob(os.path.join(a.raw, fn))
        if blob is None:
            continue
        if fn.startswith("exa-"):
            found += parse_exa(blob, lane)
        elif fn.startswith("disc-"):
            found += parse_discourse(blob, lane)
        else:
            found += parse_hn(blob, lane)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    new = []
    # seen_count means "runs this lead resurfaced in", NOT "queries it matched".
    # 17 searches share one phrase file, so a lead that answers five of them was
    # incrementing five times per run -- one lead read seen_count 16 after three
    # runs and the skill was told to treat that as recurrence. Count once per run.
    bumped = set()
    for lead in found:
        if any(h in lead["url"] for h in SELF_HOSTS):
            continue
        lead = reclassify(lead)
        lid = lead_id(lead)
        if lid in known:
            known[lid]["last_seen"] = now
            if lid not in bumped:
                known[lid]["seen_count"] = known[lid].get("seen_count", 1) + 1
                bumped.add(lid)
            continue
        bumped.add(lid)
        lead.update({"id": lid, "status": lead.get("status", "new"),
                     "found_at": now, "last_seen": now,
                     "seen_count": 1, "score": score(lead)})
        known[lid] = lead
        new.append(lead)

    # Repair pass: rules change, the ledger must not stay wrong. Re-lane and
    # re-score every row each run, but NEVER overwrite a human status decision.
    for l in known.values():
        if l.get("status") in SUPPRESSED:
            continue
        reclassify(l)
        l["score"] = score(l)

    ledger["leads"] = sorted(known.values(), key=lambda l: -l.get("score", 0))
    ledger["updated_at"] = now
    os.makedirs(os.path.dirname(a.ledger), exist_ok=True)
    json.dump(ledger, open(a.ledger, "w"), indent=1)

    # The header used to print len(actionable) AFTER slicing to 10, so it read
    # "10 actionable" forever regardless of the real number. Count, then cap.
    actionable = [l for l in ledger["leads"]
                  if l.get("status") not in SUPPRESSED
                  and l.get("status") not in ("stale", "undated", "offtopic")
                  and l.get("repliable") and l.get("score", 0) > 0]
    n_actionable = len(actionable)
    stale = [l for l in ledger["leads"] if l.get("status") in ("stale", "undated")]
    offtopic = [l for l in ledger["leads"] if l.get("status") == "offtopic"]
    articles = [l for l in ledger["leads"] if l["lane"] == "article"]
    rivals = [l for l in ledger["leads"] if l["lane"] == "rival"]
    new.sort(key=lambda l: -l["score"])

    with open(a.digest, "w") as f:
        f.write(f"# Signal hunt — {now[:10]}\n\n")
        f.write(f"searches: {a.succeeded}/{a.attempted} ok · "
                f"parsed: {len(found)} · new: {len(new)} · "
                f"ledger: {len(ledger['leads'])} total · "
                f"{n_actionable} repliable · {len(stale)} past reply window · "
                f"{len(offtopic)} off-topic · {len(articles)} articles · "
                f"{len(rivals)} rivals\n\n")
        if n_actionable == 0:
            f.write("**No repliable target today.** Every hit was a closed thread, "
                    "an article with no comment box, or a competitor. That is a "
                    "SOURCING failure, not a quiet day: the free sources that "
                    "return live threads are HN (14d window) and Discourse "
                    "forums. Widen those before widening the phrase list.\n\n")
        if not new:
            f.write("**No new signal today.** Every hit was already in the ledger. "
                    "This is a real quiet day, not a failure — the searches ran.\n\n")
        else:
            f.write("## New\n\n")
            for l in new:
                f.write(f"### [{l['lane']}·{l['score']}] {l['title']}\n"
                        f"{l['url']} — {l['author']} · {l['published']} · {l['source']}\n\n"
                        f"> {l['snippet'][:400]}\n\n")
        f.write(f"## Reply targets — open threads ({n_actionable})\n\n")
        for l in actionable[:10]:
            f.write(f"- **{l['score']}** [{l['lane']}·{l.get('venue','?')}·"
                    f"{l.get('age_days','?')}d] {l['title'][:85]} — {l['url']}\n")
        f.write(f"\n## Past the reply window ({len(stale)}) — do not revive\n\n")
        for l in stale[:8]:
            f.write(f"- {l['title'][:80]} — {l.get('why','')}\n")
        f.write(f"\n## Articles ({len(articles)}) — writing-lane research, no reply surface\n\n")
        for l in articles[:8]:
            f.write(f"- {l['title'][:85]} — {l['url']}\n")
        f.write("\n## Competitive set (auto-detected, never pitched)\n\n")
        for l in rivals[:12]:
            f.write(f"- {l['title'][:95]} — {l['url']}\n")
        f.write("\n_Drafting a reply is a separate, human-approved step. "
                "Nothing here is auto-sent._\n")

    print(f"parsed={len(found)} new={len(new)} ledger={len(ledger['leads'])} digest={a.digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
