#!/usr/bin/env python3
"""
Heading specificity and corpus-duplication checker. ONE owner, both writers.

WHY THIS EXISTS
Four of eleven posts shipped with a byte-identical H2 skeleton:

    What we built / The struggle / The general lesson /
    Where the standard approach falls short / What is still not solved

That is what a numbered STRUCTURE list in a prompt produces: the model reads
"3. THE STRUGGLE" as a heading to copy rather than a beat to write. Every one
of those posts also carried the instruction "write in Chad's voice", which is
the lesson: a style line in a prompt is a request, not a guarantee. The
guarantee is a checker.

Two costs to the duplication, both real:
  1. Google reads a repeated section skeleton across one domain as a
     duplicate-content signal.
  2. A human reads it as generated, which is the exact impression these posts
     exist to avoid.

THREE CHECKS, because "ban a list of bad headings" is whack-a-mole. A model
told not to write "The struggle" writes "The struggling part" and passes.

  dup       an H2 (normalized) already used by a published post
  skeleton  this post's H2 SEQUENCE overlaps an existing post's by >= SKEL_MIN.
            Catches the rename: keep the shape, change two words.
  generic   an H2 that carries no token specific to THIS post. Measured, not
            guessed: see is_specific().

Exit 0 clean, 1 findings, 2 usage/IO error. Findings are advisory to the
caller: a post is worth more than a heading, so the writers degrade rather
than die. Nothing here rewrites a file except --apply.
"""
import json
import os
import re
import sys

SKEL_MIN = 0.6

STOP = {
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'is', 'it', 'for',
    'on', 'at', 'by', 'as', 'was', 'were', 'be', 'been', 'this', 'that', 'with',
    'what', 'why', 'how', 'when', 'where', 'which', 'who', 'not', 'no', 'my',
    'i', 'we', 'you', 'your', 'our', 'us', 'me', 'its', 'from', 'about', 'into',
    'still', 'part', 'thing', 'things', 'general', 'lesson', 'rule', 'rules',
    'struggle', 'built', 'build', 'shipped', 'solved', 'fix', 'fixed', 'problem',
    'approach', 'standard', 'falls', 'short', 'wrong', 'right', 'first', 'second',
    'real', 'actually', 'just', 'so', 'then', 'than', 'more', 'less', 'one', 'two',
    'up', 'out', 'down', 'off', 'over', 'under', 'all', 'any', 'every', 'some',
    'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'would', 'will',
    'work', 'works', 'worked', 'made', 'make', 'makes', 'got', 'get', 'gets',
    'happened', 'happens', 'went', 'go', 'goes', 'came', 'come', 'looks', 'look',
    'cost', 'costs', 'took', 'take', 'takes', 'said', 'says', 'say', 'new', 'old',
}


def norm(h):
    """Compare headings on words, not punctuation. `The Struggle:` == the struggle."""
    return re.sub(r'[^a-z0-9 ]+', ' ', h.lower()).split()


def key(h):
    return ' '.join(w for w in norm(h) if w not in STOP) or ' '.join(norm(h))


def split_fm(raw):
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', raw, re.S)
    return (m.group(1), m.group(2)) if m else ('', raw)


def strip_fences(body):
    """H2 detection must ignore fenced content. A line starting `## ` inside a
    shell heredoc or a quoted log is not a heading, and a line-state machine is
    the only thing that gets this right: the naive `re.findall('```.*?```')`
    mispaired five prose paragraphs in this very corpus."""
    out, fenced = [], False
    for ln in body.split('\n'):
        if re.match(r'^\s*```', ln):
            fenced = not fenced
            continue
        if not fenced:
            out.append(ln)
    return '\n'.join(out)


def headings(body):
    return [h.strip() for h in re.findall(r'^##\s+(.+?)\s*$', strip_fences(body), re.M)]


def post_tokens(raw):
    """Tokens that make a heading SPECIFIC to this post: its title, and every
    identifier that appears in its code. A heading that shares nothing with
    either is a heading that could sit on any post on the blog."""
    fm, body = split_fm(raw)
    title = re.search(r'^title:\s*"?(.*?)"?\s*$', fm, re.M)
    toks = set()
    if title:
        toks |= {w for w in norm(title.group(1)) if len(w) >= 4 and w not in STOP}
    for m in re.finditer(r'^```[\w-]*\n(.*?)^```', body, re.S | re.M):
        for w in re.findall(r'[A-Za-z_][A-Za-z0-9_.\-]{3,}', m.group(1)):
            toks.add(w.lower())
    for w in re.findall(r'`([^`\n]+)`', strip_fences(body)):
        for t in re.findall(r'[A-Za-z_][A-Za-z0-9_.\-]{3,}', w):
            toks.add(t.lower())
    return toks


GENERIC_MAX_CONTENT_WORDS = 3


def content_words(h):
    return [w for w in norm(h) if w not in STOP]


def is_specific(h, toks):
    """Does this heading carry anything that could only have come from THIS post?

    A number, a code span, an identifier-shaped token (snake_case, dotted,
    ALLCAPS, camelCase or PascalCase), or a content word it shares with the
    post's own title or its own code.
    """
    if re.search(r'\d', h) or '`' in h:
        return True
    for w in re.findall(r'[A-Za-z][A-Za-z0-9_.\-]*', h):
        if len(w) > 2 and (('_' in w) or ('.' in w) or (w.isupper() and len(w) > 2)
                           or re.search(r'[a-z][A-Z]', w)
                           or ('-' in w and re.search(r'[A-Z]', w))):
            return True
    return any(w in toks for w in norm(h) if len(w) >= 4 and w not in STOP)


def is_generic(h, toks):
    """Generic = carries nothing post-specific AND is short enough to sit on any
    post on the blog.

    The length half is not decoration, it is what makes this detector usable.
    Specificity alone flagged 27 of 49 live headings including
    'Root cause: a guard that tested truthiness instead of provenance', which is
    an excellent heading. Calibrated on the real corpus at
    GENERIC_MAX_CONTENT_WORDS: at 4 it starts eating 'Two entry points, one
    scope, no error'; at 3 every heading it flags is one a human agrees could
    head a different post. Locked by --selftest so a later tweak has to face
    the same evidence.
    """
    return not is_specific(h, toks) and len(content_words(h)) <= GENERIC_MAX_CONTENT_WORDS


def corpus(dirpath, exclude=None):
    """Every H2 sequence already published, so a new post can be compared
    against what a reader would actually see next to it."""
    out = []
    if not os.path.isdir(dirpath):
        return out
    for f in sorted(os.listdir(dirpath)):
        if not f.endswith('.md') or (exclude and os.path.abspath(os.path.join(dirpath, f)) == os.path.abspath(exclude)):
            continue
        try:
            raw = open(os.path.join(dirpath, f), encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        out.append((f, headings(split_fm(raw)[1])))
    return out


def check(path, corpus_dir):
    raw = open(path, encoding='utf-8', errors='replace').read()
    fm, body = split_fm(raw)
    hs = headings(body)
    toks = post_tokens(raw)
    prior = corpus(corpus_dir, exclude=path)
    seen = {}
    for f, ph in prior:
        for h in ph:
            seen.setdefault(key(h), []).append(f)

    dup = [{'heading': h, 'also_in': seen[key(h)]} for h in hs if key(h) in seen]
    generic = [h for h in hs if is_generic(h, toks)]

    mine = {key(h) for h in hs}
    skeleton = []
    if mine:
        for f, ph in prior:
            theirs = {key(h) for h in ph}
            if not theirs:
                continue
            overlap = len(mine & theirs) / max(len(mine), len(theirs))
            if overlap >= SKEL_MIN:
                skeleton.append({'file': f, 'overlap': round(overlap, 2)})

    return {
        'headings': hs, 'dup': dup, 'generic': generic, 'skeleton': skeleton,
        'ok': not (dup or generic or skeleton),
    }


def apply_headings(path, new):
    """Replace H2 TEXT positionally and nothing else. The body is not reopened
    to the model, so a re-heading pass cannot silently rewrite an argument, drop
    a diagram or reintroduce a redacted string. Count mismatch is a refusal."""
    raw = open(path, encoding='utf-8', errors='replace').read()
    fm, body = split_fm(raw)
    lines = body.split('\n')
    idx, fenced = [], False
    for i, ln in enumerate(lines):
        if re.match(r'^\s*```', ln):
            fenced = not fenced
            continue
        if not fenced and re.match(r'^##\s+\S', ln) and not re.match(r'^###', ln):
            idx.append(i)
    if len(idx) != len(new):
        return False, f'{len(new)} replacement(s) for {len(idx)} heading(s)'
    for i, h in zip(idx, new):
        lines[i] = '## ' + h.strip().lstrip('#').strip()
    out = ('---\n' + fm + '\n---\n' if fm else '') + '\n'.join(lines)
    open(path, 'w', encoding='utf-8').write(out)
    return True, f'{len(idx)} heading(s) replaced'


def build_prompt(body_path, findings, blogdir, out=sys.stdout):
    """The re-heading prompt. Lives HERE, not in the writers.

    Three callers need it: the feature writer, the incident writer, and the
    backfill. Three copies of one rule is the failure this blog has now
    described in three separate posts, so it gets one owner the first time
    rather than after the third copy drifts.
    """
    import re as _re
    raw = open(body_path, encoding="utf-8", errors="replace").read()
    fm, body = split_fm(raw)
    d = findings
    hs = d["headings"]
    title = (_re.search(r'^title:\s*"?(.*?)"?\s*$', fm, _re.M) or [None, ""])[1]

    def preview(i):
        """The model needs to know what each section SAYS, or it renames a
        generic heading to something equally generic. Two sentences of the
        section's own body is enough and keeps the prompt small."""
        pat = _re.compile(r"^##\s+" + _re.escape(hs[i]) + r"\s*$", _re.M)
        m = pat.search(body)
        if not m:
            return ""
        rest = body[m.end():]
        nxt = _re.search(r"^##\s+\S", rest, _re.M)
        sec = strip_fences(rest[: nxt.start()] if nxt else rest)
        return _re.sub(r"\s+", " ", sec).strip()[:260]

    bad = {x["heading"] for x in d["dup"]} | set(d["generic"])
    prior, seen = [], set()
    for _, ph in reversed(corpus(blogdir, exclude=body_path)):
        for h in ph:
            if h.lower() not in seen:
                seen.add(h.lower()); prior.append(h)

    p = lambda *a: print(*a, file=out)
    p(f"""Rewrite the section headings of this blog post. Nothing else.

Post title: {title}

A checker flagged these headings. It reports a heading as REUSED when another
post on this blog already uses it, and GENERIC when it carries nothing specific
to this post: no number, no identifier, no code span, no word from the post's
own title or code. {len(d['skeleton'])} earlier post(s) share this post's overall
heading shape.

Write {len(hs)} replacement headings, one per line, in order, no numbering, no
markdown, no quotes, no commentary. Rules:

- Each heading must be about what ITS OWN section actually says below. Do not
  invent a heading for content that is not there.
- Each must carry something concrete from that section: the number, the
  identifier, the symptom, the name of the thing that broke.
- None may be a heading a reader could paste onto a different post.
- Keep a heading that is already good exactly as it is. Repeat it verbatim.
- Under about 70 characters. Sentence case.
- NEVER use an em dash. Use a colon, a comma, or a period.

## The sections""")
    for i, h in enumerate(hs):
        flag = "  <-- FLAGGED" if h in bad else ""
        p(f"\n{i+1}. CURRENT: {h}{flag}\n   SECTION SAYS: {preview(i)}")
    if prior:
        p("\n## Already used by other posts on this blog, do not reuse or reword\n")
        for h in prior[:40]:
            p(f"  {h}")
    p(f"\n## Output\nExactly {len(hs)} lines. Nothing else.")


def parse_reply(path):
    """Model replies carry numbering, bullets and stray fences no matter what
    the prompt says. Strip them; the caller asserts the COUNT, which is the
    only check that matters because apply_headings() is positional."""
    out = []
    for ln in open(path, encoding="utf-8", errors="replace"):
        t = ln.strip()
        if not t or t.startswith("```") or t.startswith("#"):
            continue
        t = re.sub(r"^\s*\d+[.)]\s*", "", t)
        t = re.sub(r"^\s*[-*]\s*", "", t).strip().strip('"')
        t = re.sub(r"\s*<--.*$", "", t).strip()
        if t:
            out.append(t)
    return out


# --- calibration lock -------------------------------------------------------
# These are real headings from the live corpus, graded by hand BEFORE the
# detector was tuned. A change to STOP, to is_specific() or to
# GENERIC_MAX_CONTENT_WORDS that breaks one of these is a regression in the
# detector, not an improvement, and this is where it gets caught. Hermetic: no
# network, no LLM, no filesystem.
CALIBRATION = [
    # (heading, post tokens, expected is_generic)
    ('The struggle', set(), True),
    ('What we built', set(), True),
    ('The general lesson', set(), True),
    ('Where the standard approach falls short', set(), True),
    ('What is still not solved', set(), True),
    ('The rule', set(), True),
    ('What it actually cost', set(), True),
    ('Where the usual advice stops', set(), True),
    ('The fix is a branch, not a rewrite', set(), True),
    # ... and the ones a human called good, which must survive.
    ('Root cause: a guard that tested truthiness instead of provenance', set(), False),
    ('Two entry points, one scope, no error', set(), False),
    ('The debugging lesson: measure the shape, not the instance', set(), False),
    ('The measurement that cracked it: count the writers, not the readers', set(), False),
    ('The obvious fix is wrong on the OpenAI-compat path', set(), False),   # PascalCase-hyphen
    ('A ten-minute-old measurement, reported as live', set(), False),
    ('The spawn floor was zero', set(), False),                             # shares 'spawn' w/ title
    ('STABLE_PREFIX is a cache key, not a scratchpad', set(), False),       # snake_case
    ('Results decay to zero as the query gets longer', set(), False),
    ('`dogs` is not `dog\'s`', set(), False),                                # code span
    ('Three days blaming the TTL', set(), False),                           # ALLCAPS
]


def selftest():
    bad = 0
    for h, toks, want in CALIBRATION:
        # 'The spawn floor was zero' is specific only relative to its own post.
        t = toks or ({'spawn'} if 'spawn' in h else set())
        got = is_generic(h, t)
        if got != want:
            bad += 1
            print(f'FAIL  want generic={want} got={got}  {h!r}')
        else:
            print(f'pass  generic={got:<5}  {h}')
    print(f'{len(CALIBRATION) - bad}/{len(CALIBRATION)} calibration cases')
    return 1 if bad else 0


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    if a[0] == '--prompt':
        path, cdir = a[1], (a[2] if len(a) > 2 else os.path.dirname(a[1]))
        build_prompt(path, check(path, cdir), cdir)
        return 0

    if a[0] == '--parse':
        print('\n'.join(parse_reply(a[1])))
        return 0

    if a[0] == '--selftest':
        return selftest()

    if a[0] == '--corpus':
        for f, hs in corpus(a[1]):
            for h in hs:
                print(h)
        return 0

    if a[0] == '--check':
        path, cdir = a[1], (a[2] if len(a) > 2 else os.path.dirname(a[1]))
        r = check(path, cdir)
        if '--json' in a:
            print(json.dumps(r))
        else:
            for d in r['dup']:
                print(f"dup       {d['heading']!r} already used by {', '.join(d['also_in'])}")
            for g in r['generic']:
                print(f"generic   {g!r} carries nothing specific to this post")
            for s in r['skeleton']:
                print(f"skeleton  {int(s['overlap'] * 100)}% of the H2 shape is {s['file']}")
            if r['ok']:
                print(f"headings ok ({len(r['headings'])})")
        return 0 if r['ok'] else 1

    if a[0] == '--apply':
        new = [l.rstrip() for l in open(a[2], encoding='utf-8') if l.strip()]
        ok, msg = apply_headings(a[1], new)
        print(msg, file=sys.stderr)
        return 0 if ok else 1

    print(f'unknown mode {a[0]!r}', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
