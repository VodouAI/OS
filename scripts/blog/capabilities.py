#!/usr/bin/env python3
"""The capability list, and the rule that travels with it.

Chad's rule (2026-09-14): every blog post about a Vodou capability MUST link
readers to sign up at vodou.ai, and MUST carry custom graphics where they help.
A prompt line is a request; this file is the guarantee. The writer asks for the
links and figures in the draft prompt, then `ensure` adds what is missing and
`check` refuses to let a post without them reach content/blog.

It also owns the capability LANE: the headline capabilities get a post even when
their commits are older than the feature miner's 30-day window.

  capabilities.py next    [--out F] [--ledger L] [--blogdir D] [--per-day N] [--today YYYY-MM-DD]
        pick the next uncovered capability, write writer-ready feature JSON to --out,
        print its id. Prints nothing (exit 0) when none is due.
  capabilities.py match   --feature-json F      capability id a mined feature belongs to, or ''
  capabilities.py inject  PROMPT MARKER --mode M [--id ID] --campaign C
  capabilities.py ensure  POST --mode M [--id ID] --campaign C      prints what it added
  capabilities.py check   POST --mode M [--id ID]                    exit 1 + findings on failure
  capabilities.py rubric-note | revise-rule
  capabilities.py url     --mode M --campaign C

Modes: `capability` (a post whose spine is one listed capability, from the
capability lane) and `feature` (a launch post from the git feature miner, which
is always about something Vodou shipped, so the same rule applies).
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
from diagrams import FENCE_OPEN, insert_block, split_fm  # noqa: E402

CAPS_FILE = os.environ.get("BLOG_CAPABILITIES_FILE", os.path.join(HERE, "capabilities.json"))
SITE = "https://blog.vodou.ai"
PUBLIC_DIR = os.path.join(ROOT, "blog-site", "public")
SIGNUP_LINK = re.compile(r'\]\(https://vodou\.ai/register[^)\s]*\)')
IMG = re.compile(r'!\[([^\]]*)\]\((\S+?)\)')
GENERIC_CTA = ("Vodou keeps your AI memory on your own machine and carries it into the "
               "chats and coding tools you already use.")
CTA_LEAD = "**Try it on your own machine.**"


def load():
    d = json.load(open(CAPS_FILE, encoding="utf-8"))
    return d, d["capabilities"]


def find(caps, cid):
    return next((c for c in caps if c["id"] == cid), None) if cid else None


def signup_url(mode, campaign):
    d, _ = load()
    camp = re.sub(r'[^a-z0-9-]+', '-', (campaign or 'blog').lower()).strip('-')[:60] or 'blog'
    medium = mode if mode in ("capability", "feature") else "post"
    return f"{d['signup_url']}?utm_source=blog&utm_medium={medium}&utm_campaign={camp}"


def infographic_url(d, cap):
    ig = (cap or {}).get("infographic")
    return (d["infographic_base"] + ig["file"], ig["alt"]) if ig else (None, None)


def strip_fences(body):
    return re.sub(r'```.*?```', '', body, flags=re.S)


# --------------------------------------------------------------------------- next
def covered_ids(ledger, blogdir):
    got = set()
    try:
        for e in json.load(open(ledger)).get("published", []):
            if e.get("post_mode") == "capability" and e.get("capability_id"):
                got.add(e["capability_id"])
    except Exception:
        pass
    # The files are the second record. A lost or reset ledger must not make the
    # lane write a second post about a capability that already has one.
    for f in glob.glob(os.path.join(blogdir, "*.md")):
        m = re.search(r'^feature:\s*"?capability-([a-z0-9-]+)"?\s*$',
                      open(f, encoding="utf-8", errors="replace").read(4000), re.M)
        if m:
            got.add(m.group(1))
    return got


def posted_today(blogdir, today):
    n = 0
    for f in glob.glob(os.path.join(blogdir, f"{today}-*.md")):
        if re.search(r'^feature:\s*"?capability-', open(f, encoding="utf-8", errors="replace").read(4000), re.M):
            n += 1
    return n


def git_commits(paths):
    if not paths:
        return []
    try:
        out = subprocess.run(
            ["git", "log", "--no-merges", "-n", "40", "--date=short",
             "--pretty=format:%H%x1f%h%x1f%ad%x1f%s", "--", *paths],
            cwd=ROOT, capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 4:
            continue
        full, short, day, subj = parts
        m = re.match(r'^(feat|fix)(\([^)]*\))?!?:', subj)
        if not m:
            continue
        rows.append({"sha": short, "full": full, "date": day, "type": m.group(1), "subject": subj})
    feats = [r for r in rows if r["type"] == "feat"][:8]
    fixes = [r for r in rows if r["type"] == "fix"][:4]
    return sorted(feats + fixes, key=lambda r: r["date"])


def cmd_next(a):
    d, caps = load()
    blogdir = os.path.join(ROOT, a.blogdir) if not os.path.isabs(a.blogdir) else a.blogdir
    ledger = os.path.join(ROOT, a.ledger) if not os.path.isabs(a.ledger) else a.ledger
    today = a.today or date.today().isoformat()
    if a.per_day > 0 and posted_today(blogdir, today) >= a.per_day:
        print(f"capabilities: today's quota of {a.per_day} capability post(s) is used", file=sys.stderr)
        return 0
    done = covered_ids(ledger, blogdir)
    queue = sorted((c for c in caps if c.get("eligible")),
                   key=lambda c: (0 if c.get("headline") else 1, c.get("order", 999)))
    pick = next((c for c in queue if c["id"] not in done), None)
    if not pick:
        print("capabilities: every eligible capability already has a post", file=sys.stderr)
        return 0
    paths = [p for p in pick.get("public_paths", []) + pick.get("docs", [])
             if os.path.exists(os.path.join(ROOT, p))]
    commits = git_commits(paths)
    try:
        from pillars import pillar_of
        pillar = pillar_of(pick["name"] + " " + pick.get("pitch", ""))
    except Exception:
        pillar = "unsorted"
    feat = {
        "feature_key": f"capability-{pick['id']}",
        "capability_id": pick["id"],
        "title": pick["name"],
        "scope": pick["id"],
        "pillar": pillar,
        "first_seen": commits[0]["date"] if commits else "",
        "last_seen": commits[-1]["date"] if commits else "",
        "commits": [{k: c[k] for k in ("sha", "date", "type", "subject")} for c in commits],
        "commit_shas": [c["full"] for c in commits],
        "files_touched": paths,
        "files_total": len(paths),
    }
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump(feat, f, indent=2)
    print(pick["id"])
    return 0


# -------------------------------------------------------------------------- match
def cmd_match(a):
    _, caps = load()
    try:
        f = json.load(open(a.feature_json))
    except Exception:
        print("")
        return 0
    if f.get("capability_id"):
        print(f["capability_id"])
        return 0
    hay = " ".join([f.get("scope", ""), f.get("title", "")]
                   + [c.get("subject", "") for c in f.get("commits", [])]
                   + list(f.get("files_touched", []))).lower()
    best, best_score = None, 0
    for c in sorted((c for c in caps if c.get("eligible")), key=lambda c: c.get("order", 999)):
        score = sum(1 for k in c.get("keywords", [])
                    if re.search(r'(?<![a-z0-9])' + re.escape(k.lower()) + r'(?![a-z0-9])', hay))
        if score > best_score:
            best, best_score = c, score
    print(best["id"] if best and best_score >= 2 else "")
    return 0


# ------------------------------------------------------------------------- inject
def brief(mode, cap, campaign):
    d, _ = load()
    url = signup_url(mode, campaign)
    ig_url, ig_alt = infographic_url(d, cap)
    out = []
    if cap:
        out += [
            "## THE VODOU CAPABILITY THIS POST IS ABOUT (from Vodou's own inventory)",
            f"Name: {cap['name']}",
            f"What it does for a person: {cap['pitch']}",
            f"Where a user finds it: {cap.get('surface') or 'n/a'}",
        ]
        if cap.get("limits"):
            out.append(f"NOT shipped, never imply otherwise: {cap['limits']}")
        if cap.get("docs"):
            out.append("Public docs you may name: " + ", ".join(cap["docs"]))
        out.append("")
    if mode == "capability":
        out += [
            "## THIS IS A CAPABILITY POST, NOT A LAUNCH POST",
            "The capability above may have shipped weeks ago, so ignore any instruction that",
            "says you just built it. Never write \"this week\", \"just shipped\" or \"today we\".",
            "The beats still apply, with beat 2 carrying more weight: what the capability",
            "does, how a person actually uses it, and why it is built the way it is. The",
            "commit subjects are the history of how it got here; use them for the build story.",
            "",
        ]
    out += [
        "## SIGNUP LINKS AND GRAPHICS: required by the author, and checked after you",
        "",
        "Every post about something Vodou does links readers to sign up and carries",
        "custom graphics. A draft without them is refused before it can publish.",
        "",
        f"Signup link. Use EXACTLY this URL as an ordinary markdown link: {url}",
        "- Link it once where Vodou is first introduced, inside the sentence itself,",
        f"  for example: \"I built this into [Vodou]({url}), which ...\".",
        "- End the post with a short closing paragraph (NOT a heading) that says in one",
        "  or two plain sentences what a reader gets from Vodou for the problem this",
        "  post is about, and links the same URL with anchor text naming vodou.ai.",
        "- Two links in total. No banner, no \"click here\", no price, no plan names, no",
        "  claim that is not in the capability description above.",
        "",
        "Graphics.",
    ]
    if mode == "capability":
        out.append("- 2 to 3 vodou-diagram figures made for THIS post, each placed where it explains")
        out.append("  something a paragraph cannot. One of them shows what the capability does for a person.")
    else:
        out.append("- At least 1 vodou-diagram figure made for THIS post (the DIAGRAMS rules above).")
    if ig_url and mode == "capability":
        out += [
            "- This capability has an official infographic. Embed it EXACTLY once, on its own",
            "  line, directly under the paragraph that explains what the capability does:",
            f"  ![{ig_alt}]({ig_url})",
        ]
    elif ig_url:
        out += [
            "- An official infographic exists for the capability this work belongs to. Embed it",
            "  once, on its own line, ONLY if it genuinely supports a point in this post:",
            f"  ![{ig_alt}]({ig_url})",
        ]
    out += [
        "- Never embed any other image: no stock photos, no screenshots, no image URL that",
        "  is not written in this brief. A post with any other image URL is refused.",
    ]
    return "\n".join(out)


def cmd_inject(a):
    _, caps = load()
    cap = find(caps, a.id)
    s = open(a.prompt, encoding="utf-8").read()
    if a.marker not in s:
        print(f"capabilities: marker {a.marker} not in {a.prompt}", file=sys.stderr)
        return 1
    open(a.prompt, "w", encoding="utf-8").write(s.replace(a.marker, brief(a.mode, cap, a.campaign)))
    return 0


# ------------------------------------------------------------------ ensure/check
def cmd_ensure(a):
    d, caps = load()
    cap = find(caps, a.id)
    raw = open(a.post, encoding="utf-8").read()
    fm, body = split_fm(raw)
    did = []
    ig_url, ig_alt = infographic_url(d, cap)
    if a.mode == "capability" and ig_url and ig_url not in body:
        body = insert_block(body, f"![{ig_alt}]({ig_url})")
        did.append(f"graphics: inserted the {cap['infographic']['file']} infographic")
    if not SIGNUP_LINK.search(strip_fences(body)):
        sentence = (cap or {}).get("cta") or GENERIC_CTA
        body = (body.rstrip() + "\n\n" + CTA_LEAD + " " + sentence +
                f" [Create your Vodou account at vodou.ai]({signup_url(a.mode, a.campaign)}).\n")
        did.append("signup: no vodou.ai signup link in the draft, appended the closing one")
    if did:
        open(a.post, "w", encoding="utf-8").write(fm + body if body.startswith("\n") or not fm else fm + "\n" + body)
    print("; ".join(did) if did else "signup link and graphics already present")
    return 0


def findings_for(post, mode, cap):
    d, _ = load()
    _, body = split_fm(open(post, encoding="utf-8").read())
    prose = strip_fences(body)
    out = []
    if not SIGNUP_LINK.search(prose):
        out.append("no signup link to https://vodou.ai/register")
    figs = len(FENCE_OPEN.findall(body))
    if figs < 1:
        out.append("no custom vodou-diagram figure")
    for alt, url in IMG.findall(prose):
        if url.startswith(SITE + "/img/"):
            if not os.path.exists(PUBLIC_DIR + url[len(SITE):]):
                out.append(f"image {url} is not in blog-site/public, it would 404")
        elif url.startswith(SITE + "/diagrams/"):
            pass
        else:
            out.append(f"image {url} is not one of ours (only vodou-diagram figures and listed infographics)")
        if len(alt.strip()) < 8:
            out.append(f"image {url} has no real alt text")
    ig_url, _ = infographic_url(d, cap)
    if mode == "capability" and ig_url and ig_url not in prose:
        out.append(f"capability infographic {ig_url} missing")
    return out, figs


def cmd_check(a):
    _, caps = load()
    out, figs = findings_for(a.post, a.mode, find(caps, a.id))
    if out:
        for f in out:
            print(f"FAIL  {f}")
        return 1
    print(f"ok: signup link present, {figs} custom figure(s)")
    return 0


def cmd_rubric_note(_a):
    print("""
## Signup links and graphics are REQUIRED by the author
Every post on this blog about a Vodou capability links to https://vodou.ai/register
(once where Vodou is introduced, once in a closing paragraph) and carries custom
figures, sometimes an official Vodou infographic. Do not deduct on any criterion
for the existence of those links or that infographic. Deduct evidence if the
closing paragraph claims something the post does not support, and say so in
complaints if a figure is decorative rather than explanatory.""")
    return 0


def cmd_revise_rule(_a):
    print("- Keep both links to https://vodou.ai/register, every ```vodou-diagram block, and any\n"
          "  ![...](https://blog.vodou.ai/img/...) infographic exactly where they are. Add no other images.")
    return 0


def cmd_url(a):
    print(signup_url(a.mode, a.campaign))
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("next")
    n.add_argument("--out"); n.add_argument("--ledger", default=".vodou/blog/ledger.json")
    n.add_argument("--blogdir", default="content/blog"); n.add_argument("--today")
    n.add_argument("--per-day", type=int, default=int(os.environ.get("BLOG_CAPABILITY_PER_DAY", "1")))
    m = sub.add_parser("match"); m.add_argument("--feature-json", required=True)
    for name in ("inject", "ensure", "check"):
        s = sub.add_parser(name)
        if name == "inject":
            s.add_argument("prompt"); s.add_argument("marker")
        else:
            s.add_argument("post")
        s.add_argument("--mode", choices=["capability", "feature"], required=True)
        s.add_argument("--id", default="")
        s.add_argument("--campaign", default="")
    sub.add_parser("rubric-note"); sub.add_parser("revise-rule")
    u = sub.add_parser("url"); u.add_argument("--mode", default="feature"); u.add_argument("--campaign", default="")
    a = p.parse_args()
    return {"next": cmd_next, "match": cmd_match, "inject": cmd_inject, "ensure": cmd_ensure,
            "check": cmd_check, "rubric-note": cmd_rubric_note, "revise-rule": cmd_revise_rule,
            "url": cmd_url}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
