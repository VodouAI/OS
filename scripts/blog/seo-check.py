#!/usr/bin/env python3
"""
Frontmatter SEO length checker. ONE owner, both writers, the whole corpus.

WHY THIS EXISTS AS CODE AND NOT AS A PROMPT LINE
------------------------------------------------
Both draft prompts already ask for a description of "140-165 characters" (the
incident writer) and "150-160" (the feature writer). Measured on the first
eleven published posts, four came back over 165: 212, 186, 179 and 172. That is
the dedash.py lesson for the third time in this directory. A length rule an LLM
is asked to honour is a preference; a rule applied after generation is a
guarantee, and a number is the easiest thing in the world to check without
asking a model anything.

WHAT THE NUMBERS MEAN
---------------------
Google truncates a meta description around 160 characters and a title tag
around 60. Neither is a hard API limit, which is exactly why this file has two
thresholds and not one:

  DESC_TARGET = 160   over this, the tail is likely cut in the SERP. A warning.
  DESC_HARD   = 175   over this, the cut is not "likely", and the sentence that
                      got amputated was the one carrying the claim. A failure.

The gap between them is deliberate. A 163-character description that ends on a
period is a rounding error; a 212-character one loses a whole clause. Making
161 fatal would mean rejecting good posts over one word, and the writers would
then have to route around this check, which is how a checker becomes decoration.

TITLES ARE MEASURED TWICE
-------------------------
blog-site/src/pages/[...slug].astro renders the tag as `${title} · Chad Priest`,
so the string Google sees is the frontmatter title plus SUFFIX (14 chars) --
but ONLY when the joined string still fits. blog-site/src/lib/seo.ts
`pageTitle()` drops the suffix rather than shipping a title Google will
truncate, so `rendered_title()` below models that same rule. Reporting a
length the site never renders would make this checker the second surface
disagreeing with the first, which is the exact bug class it exists to catch. A
54-character title is fine on its own and 68 in the tag. Both numbers are
reported; the raw title is the one that gets graded, because the raw title is
the only half a writer controls. Title findings are WARNINGS only, always: a
truncated title suffix still shows the claim, and no title length is worth
losing a finished post over.

WHAT THIS WILL NOT DO
---------------------
It has no --apply and never will. Every other transform in this directory
(dedash.py, headings.py --apply) is positional and reversible; rewriting a
description is neither. A shortened description is a NEW CLAIM about the post,
written by a model, replacing one a human may have approved, on a page that is
already indexed and already in llms-full.txt. This file reports. A human or a
writer prompt decides. That boundary is the feature.

FINDINGS
--------
  hard  desc-missing   no description key, or an empty one
  hard  desc-long      description over DESC_HARD
  hard  desc-dup       description byte-shared with another post (normalized)
  hard  title-dup      title shared with another post (normalized)
  warn  desc-over      description over DESC_TARGET but under DESC_HARD
  warn  desc-short     description under DESC_MIN: a SERP snippet with nothing in it
  warn  title-long     raw title over TITLE_TARGET
  warn  title-missing  no title key, or an empty one
  warn  tags-missing   no tags key, or an empty list

Duplicates are hard because they are the one finding here that is not about a
threshold: two posts with one description is a duplicate-content signal on a
single domain, and it is always a mistake, never a judgement call.

USAGE
  seo-check.py --check FILE...        one line per finding; exit 1 on a hard one
  seo-check.py --check FILE... --json machine-readable, same exit codes
  seo-check.py --selftest             hermetic; no network, no LLM, no writes

Exit 0 clean or warnings only, 1 hard findings, 2 usage/IO error. Same contract
as headings.py, so the writers treat all three checkers identically.
"""
import json
import re
import sys

DESC_TARGET = 160
DESC_HARD = 175
DESC_MIN = 70
TITLE_TARGET = 60

# blog-site/src/pages/[...slug].astro:28 -> title={`${d.title} · Chad Priest`}
# If that template changes, this constant is the one place that has to follow.
SUFFIX = ' · Chad Priest'

def rendered_title(title: str) -> str:
    """What <title> actually ships. Mirrors pageTitle() in blog-site/src/lib/seo.ts:
    the branding suffix is a bonus, not a guarantee, and is dropped whenever
    appending it would push the string past TITLE_TARGET."""
    t = (title or '').strip()
    joined = f'{t}{SUFFIX}'
    return joined if len(joined) <= TITLE_TARGET else t

HARD_CODES = {'desc-missing', 'desc-long', 'desc-dup', 'title-dup'}


def split_fm(raw):
    """Same splitter as headings.py, on purpose: three checkers disagreeing
    about where the frontmatter ends is a bug nobody would ever find."""
    m = re.match(r'^---\n(.*?)\n---\n(.*)$', raw, re.S)
    return (m.group(1), m.group(2)) if m else ('', raw)


def unquote(v):
    """YAML scalars in this corpus are `"like this"` or bare. Strip a matched
    pair only: a value that merely CONTAINS a quote keeps every character,
    because the length of the string is the entire point of this file and
    trimming one it should not have trimmed reports a post as passing."""
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        return v[1:-1]
    return v


def fields(fm):
    """Pull the keys this checker grades. Single-line scalars only, which is
    what both writers emit; a folded or block scalar reads as absent and gets
    reported as missing rather than silently measured wrong."""
    out = {}
    for k in ('title', 'description', 'tags'):
        m = re.search(rf'^{k}:[ \t]*(.*)$', fm, re.M)
        if m:
            out[k] = unquote(m.group(1))
    return out


def norm(s):
    """Duplicate comparison on words, not punctuation or case, so a description
    reused with one comma moved still reads as the duplicate it is."""
    return ' '.join(re.sub(r'[^a-z0-9 ]+', ' ', s.lower()).split())


def audit(posts):
    """posts: list of (name, fields dict). Returns a flat findings list.

    Takes parsed dicts rather than paths so --selftest can hand-build corpora
    in memory: a checker whose tests need a filesystem is a checker whose tests
    get skipped in CI.
    """
    findings = []
    desc_seen, title_seen = {}, {}

    for name, f in posts:
        desc = (f.get('description') or '').strip()
        title = (f.get('title') or '').strip()
        tags = (f.get('tags') or '').strip()

        if not desc:
            findings.append((name, 'desc-missing', 'no description in frontmatter'))
        else:
            n = len(desc)
            if n > DESC_HARD:
                findings.append((name, 'desc-long',
                                 f'description is {n} chars (hard limit {DESC_HARD}, target {DESC_TARGET})'))
            elif n > DESC_TARGET:
                findings.append((name, 'desc-over',
                                 f'description is {n} chars (target {DESC_TARGET}, hard {DESC_HARD})'))
            elif n < DESC_MIN:
                findings.append((name, 'desc-short',
                                 f'description is {n} chars (under {DESC_MIN}: half a SERP snippet)'))
            desc_seen.setdefault(norm(desc), []).append(name)

        if not title:
            findings.append((name, 'title-missing', 'no title in frontmatter'))
        else:
            n = len(title)
            if n > TITLE_TARGET:
                rt = rendered_title(f.get('title', ''))
                findings.append((name, 'title-long',
                                 f'title is {n} chars; renders as {len(rt)} chars '
                                 f'(suffix {"kept" if rt.endswith(SUFFIX) else "dropped"}), '
                                 f'target {TITLE_TARGET}'))
            title_seen.setdefault(norm(title), []).append(name)

        if not tags or tags in ('[]', '""', "''"):
            findings.append((name, 'tags-missing', 'no tags in frontmatter'))

    # A post is never its own duplicate: only groups of two or more count, and
    # each member is told who it collides with.
    for seen, code, what in ((desc_seen, 'desc-dup', 'description'),
                             (title_seen, 'title-dup', 'title')):
        for _key, names in seen.items():
            if len(names) < 2:
                continue
            for nm in names:
                others = ', '.join(x for x in names if x != nm)
                findings.append((nm, code, f'{what} is shared with {others}'))

    return findings


def read_post(path):
    fm, _body = split_fm(open(path, encoding='utf-8', errors='replace').read())
    return (path, fields(fm))


def report(posts, findings, as_json, out=sys.stdout):
    hard = [f for f in findings if f[1] in HARD_CODES]
    warn = [f for f in findings if f[1] not in HARD_CODES]

    if as_json:
        by_file = {}
        for name, code, msg in findings:
            by_file.setdefault(name, []).append(
                {'code': code, 'severity': 'hard' if code in HARD_CODES else 'warn',
                 'message': msg})
        print(json.dumps({
            'posts': [{
                'file': name,
                'title': f.get('title', ''),
                'title_len': len(f.get('title', '') or ''),
                'title_rendered_len': len(rendered_title(f.get('title', '') or '')),
                'description': f.get('description', ''),
                'description_len': len(f.get('description', '') or ''),
                'tags': f.get('tags', ''),
                'findings': by_file.get(name, []),
            } for name, f in posts],
            'hard': len(hard), 'warn': len(warn), 'ok': not hard,
            'limits': {'desc_target': DESC_TARGET, 'desc_hard': DESC_HARD,
                       'desc_min': DESC_MIN, 'title_target': TITLE_TARGET,
                       'suffix_len': len(SUFFIX)},
        }, indent=2), file=out)
        return

    # Sorted so the hard findings are read first and the output is stable
    # enough to diff between runs.
    for name, code, msg in sorted(findings, key=lambda f: (f[1] not in HARD_CODES, f[0], f[1])):
        sev = 'FAIL' if code in HARD_CODES else 'warn'
        print(f'{sev}  {code:<13} {name}: {msg}', file=out)
    if not findings:
        print(f'seo ok ({len(posts)} post(s))', file=out)
    else:
        print(f'{len(posts)} post(s): {len(hard)} failure(s), {len(warn)} warning(s)', file=out)


# --- hermetic cases ---------------------------------------------------------
# Every case asserts BOTH directions: the shape is caught, and the shape one
# character under the line is not. A checker that only proves it can say no is
# a checker nobody can tell apart from a broken one.
GOOD_DESC = ('A stale CPU reading shipped as live data. The cause: a sliding replay '
             'window, and a system prompt frozen for caching so the stamps never land.')
assert DESC_MIN <= len(GOOD_DESC) <= DESC_TARGET, len(GOOD_DESC)

GOOD = {'title': 'Prompt caching froze my system prompt',
        'description': GOOD_DESC,
        'tags': '[llm, caching, debugging]'}


def _post(name, **over):
    f = dict(GOOD)
    for k, v in over.items():
        if v is None:
            f.pop(k, None)
        else:
            f[k] = v
    return (name, f)


def _codes(posts):
    return {(n, c) for n, c, _m in audit(posts)}


CASES = [
    # (name, posts, expected {(file, code)})
    ('a good post is clean',
     [_post('good.md')], set()),

    ('description over the hard limit fails',
     [_post('a.md', description='x' * (DESC_HARD + 1))], {('a.md', 'desc-long')}),

    ('description exactly at the hard limit is a warning, not a failure',
     [_post('a.md', description='x' * DESC_HARD)], {('a.md', 'desc-over')}),

    ('description between target and hard warns',
     [_post('a.md', description='x' * 165)], {('a.md', 'desc-over')}),

    ('description exactly at the target is clean',
     [_post('a.md', description='x' * DESC_TARGET)], set()),

    ('a missing description key fails',
     [_post('a.md', description=None)], {('a.md', 'desc-missing')}),

    ('an empty description fails',
     [_post('a.md', description='')], {('a.md', 'desc-missing')}),

    ('a stub description warns as too short',
     [_post('a.md', description='We fixed a bug.')], {('a.md', 'desc-short')}),

    ('a title over the target warns',
     [_post('a.md', title='t' * (TITLE_TARGET + 1))], {('a.md', 'title-long')}),

    ('a title exactly at the target is clean',
     [_post('a.md', title='t' * TITLE_TARGET)], set()),

    ('a missing title warns',
     [_post('a.md', title=None)], {('a.md', 'title-missing')}),

    ('missing tags warn',
     [_post('a.md', tags=None)], {('a.md', 'tags-missing')}),

    ('an empty tag list warns',
     [_post('a.md', tags='[]')], {('a.md', 'tags-missing')}),

    ('a shared description fails BOTH posts',
     [_post('a.md'), _post('b.md')],
     {('a.md', 'desc-dup'), ('b.md', 'desc-dup'),
      ('a.md', 'title-dup'), ('b.md', 'title-dup')}),

    ('duplicate detection ignores case and punctuation',
     [_post('a.md', title='The Struggle', description='d' * 100),
      _post('b.md', title='the struggle!', description='e' * 100)],
     {('a.md', 'title-dup'), ('b.md', 'title-dup')}),

    ('a lone post is not its own duplicate',
     [_post('a.md')], set()),

    ('two distinct posts collide on nothing',
     [_post('a.md', title='One title here', description='d' * 100),
      _post('b.md', title='Another title here', description='e' * 100)], set()),

    ('the real 212-char shape is caught',
     [_post('cached.md', description=(
         'Our OpenAI-compat provider reported cached_tokens 0 of ~16K prompt tokens '
         'every turn. The cause was per-turn memory glued into the system prompt. '
         'The fix: freeze the prefix, splice context into the message array.'))],
     {('cached.md', 'desc-long')}),

    ('one post can carry several findings at once',
     [_post('a.md', description='x' * 200, title='t' * 80, tags=None)],
     {('a.md', 'desc-long'), ('a.md', 'title-long'), ('a.md', 'tags-missing')}),
]


def _parse_cases():
    """Parsing is graded separately from the thresholds: the quoting layer is
    where a wrong answer is INVISIBLE, because a description trimmed by two
    characters still reports a plausible-looking number."""
    out = []
    raw = ('---\ntitle: "A title"\ndescription: "Twelve chars"\n'
           'tags: [a, b]\n---\nbody\n')
    f = fields(split_fm(raw)[0])
    out.append(('quoted scalars are unquoted', f['description'], 'Twelve chars'))
    out.append(('title is unquoted', f['title'], 'A title'))
    out.append(('tags survive as written', f['tags'], '[a, b]'))

    raw2 = '---\ntitle: A bare title\ndescription: bare desc\n---\nbody\n'
    f2 = fields(split_fm(raw2)[0])
    out.append(('bare scalars work', f2['description'], 'bare desc'))

    raw3 = '---\ntitle: "He said \'go\'"\n---\nbody\n'
    f3 = fields(split_fm(raw3)[0])
    out.append(('inner quotes are kept', f3['title'], "He said 'go'"))

    raw4 = '---\ndescription: "a"\n---\nbody\n'
    f4 = fields(split_fm(raw4)[0])
    out.append(('a missing key is absent, not empty', f4.get('title'), None))

    # A body line that looks like frontmatter must not be read as frontmatter.
    raw5 = '---\ntitle: "Real"\ndescription: "d"\n---\ndescription: "not this one"\n'
    f5 = fields(split_fm(raw5)[0])
    out.append(('body text is not frontmatter', f5['description'], 'd'))
    return out


def selftest():
    bad = 0
    for name, posts, want in CASES:
        got = _codes(posts)
        if got != want:
            bad += 1
            print(f'FAIL  {name}\n      want {sorted(want)}\n      got  {sorted(got)}')
        else:
            print(f'pass  {name}')
    for name, got, want in _parse_cases():
        if got != want:
            bad += 1
            print(f'FAIL  {name}: want {want!r} got {got!r}')
        else:
            print(f'pass  {name}')

    # Exit-code contract: warnings alone must not fail a build, or the writers
    # will learn to ignore this checker entirely.
    total = len(CASES) + len(_parse_cases())
    warn_only = audit([_post('a.md', title='t' * 80)])
    if any(c in HARD_CODES for _n, c, _m in warn_only):
        bad += 1
        print('FAIL  a long title must not be a hard failure')
    else:
        print('pass  warnings alone are not a hard failure')
    hard_only = audit([_post('a.md', description='x' * 200)])
    if not any(c in HARD_CODES for _n, c, _m in hard_only):
        bad += 1
        print('FAIL  an over-limit description must be a hard failure')
    else:
        print('pass  an over-limit description is a hard failure')
    total += 2

    print(f'{total - bad}/{total} cases')
    return 1 if bad else 0


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    if a[0] == '--selftest':
        return selftest()

    if a[0] == '--check':
        paths = [x for x in a[1:] if not x.startswith('--')]
        as_json = '--json' in a
        if not paths:
            print('usage: seo-check.py --check FILE... [--json]', file=sys.stderr)
            return 2
        posts = []
        for p in paths:
            try:
                posts.append(read_post(p))
            except OSError as e:
                print(f'FAIL  unreadable     {p}: {e}', file=sys.stderr)
                return 2
        findings = audit(posts)
        report(posts, findings, as_json)
        return 1 if any(c in HARD_CODES for _n, c, _m in findings) else 0

    print(f'unknown mode {a[0]!r}', file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main())
