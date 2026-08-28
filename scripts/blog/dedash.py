#!/usr/bin/env python3
"""
Vodou blog em-dash scrubber — ONE owner for the "no em dashes" house rule.

WHY THIS EXISTS AS CODE AND NOT AS A PROMPT LINE
------------------------------------------------
Both draft prompts already said "No em-dash-heavy rhythm" in their VOICE
section. Across the first 11 posts the model emitted 66 em dashes in prose
anyway. A style rule an LLM is asked to honour is a preference; a rule applied
after generation is a guarantee. This is the guarantee. The prompt rule stays,
because a draft that never contains one needs no repair and reads better than
a repaired one -- but nothing downstream depends on the model obeying it.

WHAT IT WILL NOT TOUCH
----------------------
* fenced code blocks -- quoted log output, shell transcripts and diagram specs
  are EVIDENCE. Rewriting a character inside a pasted log falsifies the quote,
  which is the exact sin this blog keeps writing about.
* inline code spans (`like this`) -- same reason, smaller scale.
* link targets and image URLs -- an em dash in a URL is a different character
  with a different meaning.
* frontmatter keys other than title/description -- slug, tags and dates have
  their own grammar.

Fences are parsed with a LINE STATE MACHINE, not a regex. The obvious
`re.findall(r'```.*?```', s, re.S)` mispairs the moment a document contains an
odd fence or a nested one: it then treats the PROSE between block 2's close and
block 3's open as if it were code. Measured on this very corpus -- that regex
classified five prose paragraphs as code blocks, which would have meant
skipping the paragraphs that need scrubbing and rewriting the blocks that must
not be touched. Exactly backwards.

REPLACEMENT RULES (in order)
----------------------------
The hard part is that an em dash is four different punctuation marks wearing
one glyph. Picking wrong produces a comma splice or a sentence fragment, so the
default is chosen to be the one substitution that can never do either:

  1. 2026—2027            -> hyphen            (numeric range)
  2. paired in a sentence -> commas            (parenthetical aside)
  3. followed by a conjunction/subordinator/negator ("because", "but", "not")
                          -> comma            (a comma is already correct there)
  4. short tail (<=4 words) ending the sentence, and NOT beginning with a
     subject word     -> comma                (appositive, not a second clause)
  5. sentence already has a colon
                          -> period + capital (never two colons in one sentence)
  6. everything else      -> colon            (the safe default)

Why colon as the default: a colon after an independent clause is grammatical
whether what follows is a full clause OR a fragment. A comma there risks a
splice; a period risks a fragment. In this voice the dash is nearly always
introducing an elaboration, which is what a colon is for.

USAGE
  dedash.py FILE            rewrite in place, print a count to stderr
  dedash.py FILE --check    exit 1 if any prose em dash remains, rewrite nothing
  dedash.py FILE --explain  show every before/after line
"""
import re
import sys

EM = '—'          # — em dash
HBAR = '―'        # ― horizontal bar, same job
EN = '–'          # – en dash: only a problem when spaced like an em dash

# After the dash, these words mean a comma was always the right mark.
# A short tail that STARTS like a subject is an independent clause, not an
# appositive, so rule 4 must not give it a comma. "A thing broke - the log
# lied." became "A thing broke, the log lied." on the first cut: a comma
# splice, which is worse than the dash it replaced.
SUBJECT_STARTERS = {
    'the', 'a', 'an', 'it', 'they', 'we', 'i', 'he', 'she', 'this', 'that',
    'there', 'you', 'its', 'their', 'our', 'my', 'his', 'her', 'these',
    'those', 'nobody', 'everything', 'nothing', 'something', 'everyone',
    'someone', 'one', 'both', 'each', 'every', 'all', 'most', 'some', 'few',
}

COMMA_STARTERS = {
    'and', 'but', 'or', 'so', 'yet', 'nor',
    'because', 'since', 'while', 'although', 'though', 'whereas', 'unless',
    'until', 'after', 'before', 'when', 'whenever', 'if', 'which', 'who',
    'whom', 'whose', 'where', 'than', 'as',
    'not', 'no', 'never', 'just', 'only', 'exactly', 'precisely', 'usually',
    'always', 'sometimes', 'often', 'especially', 'particularly', 'including',
    'plus', 'minus', 'with', 'without', 'for', 'from', 'to', 'in', 'on', 'at',
    'by', 'of', 'about', 'over', 'under', 'per', 'via', 'like',
}

SENT_END = re.compile(r'[.!?]["\')\]]?\s*$')


def _split_protected(line):
    """Split a prose line into (text, is_protected) runs.

    Protected: inline code spans, markdown link/image targets, bare URLs.
    """
    runs, i, n = [], 0, len(line)
    buf = ''
    while i < n:
        c = line[i]
        if c == '`':
            # inline code span: match the longest run of backticks
            m = re.match(r'(`+)', line[i:])
            ticks = m.group(1)
            close = line.find(ticks, i + len(ticks))
            if close != -1:
                if buf:
                    runs.append((buf, False))
                    buf = ''
                runs.append((line[i:close + len(ticks)], True))
                i = close + len(ticks)
                continue
        if c == '(' and buf.endswith(']'):
            close = line.find(')', i)
            if close != -1:
                if buf:
                    runs.append((buf, False))
                    buf = ''
                runs.append((line[i:close + 1], True))
                i = close + 1
                continue
        m = re.match(r'https?://\S+', line[i:])
        if m:
            if buf:
                runs.append((buf, False))
                buf = ''
            runs.append((m.group(0), True))
            i += len(m.group(0))
            continue
        buf += c
        i += 1
    if buf:
        runs.append((buf, False))
    return runs


def _sentence_of(text, pos):
    """Rough sentence boundaries around index pos."""
    start = 0
    for m in re.finditer(r'[.!?]\s+', text[:pos]):
        start = m.end()
    m = re.search(r'[.!?](\s|$)', text[pos:])
    end = pos + m.end() if m else len(text)
    return text[start:end], start, end


def _mask(line):
    """Replace protected runs with sentinels that contain no dash and no period.

    Masking (rather than splitting the line into runs and scrubbing each one
    independently) is what keeps SENTENCE context intact. Run-splitting broke
    two rules at once when it was tried: a dash right after an inline code span
    started a run with whitespace, which the "dash opening a line is a bullet"
    rule then matched mid-sentence; and a paired parenthetical whose halves
    landed in different runs got a comma on one side and a colon on the other.
    """
    runs = _split_protected(line)
    masked, store = '', []
    for run, protected in runs:
        if protected:
            masked += '\x00%d\x01' % len(store)
            store.append(run)
        else:
            masked += run
    return masked, store


def _unmask(text, store):
    return re.sub(r'\x00(\d+)\x01', lambda m: store[int(m.group(1))], text)


def _pick(sentence, offset, tail):
    """Which mark replaces the dash at `offset` within `sentence`?"""
    tail_word = re.match(r'[\*_`"\'\x00-\x01]*([A-Za-z]+)', tail)
    tail_word = tail_word.group(1).lower() if tail_word else ''
    if tail_word in COMMA_STARTERS:
        return ', '                                          # rule 3
    tail_sentence = tail[:len(sentence) - offset]
    if (len(tail_sentence.split()) <= 4 and SENT_END.search(tail_sentence)
            and tail_word not in SUBJECT_STARTERS):
        return ', '                                          # rule 4
    if ':' in sentence:
        return '. '                                          # rule 5
    return ': '                                              # rule 6


def _replace_in_text(text):
    """Apply the rules to one masked prose LINE. Returns (new, count)."""
    count = 0

    # Rule 1: numeric range, no spaces -> hyphen.
    text, k = re.subn(r'(?<=\d)[' + EM + HBAR + r'](?=\d)', '-', text)
    count += k

    # A dash opening the LINE is a bullet, not punctuation. Only at line start:
    # mid-sentence this rule produced " - one in the content script".
    text, k = re.subn(r'^(\s*)[' + EM + HBAR + r']\s+', r'\1- ', text)
    count += k

    # Spaced en dash is doing an em dash's job; fold it in.
    text = re.sub(r'\s' + EN + r'\s', ' ' + EM + ' ', text)

    dash = '[' + EM + HBAR + ']'
    guard = 0
    while True:
        guard += 1
        if guard > 200:
            break
        m = re.search(r'\s*' + dash + r'\s*', text)
        if not m:
            break
        sentence, s_start, _ = _sentence_of(text, m.start())
        n = len(re.findall(dash, sentence))

        if n >= 2:
            # Rule 2, applied to the WHOLE sentence in one pass. Doing it one
            # dash at a time made the second half of a pair re-evaluate as a
            # lone dash and come back a colon: "the rule, how it works: lived".
            fixed = re.sub(r'\s*' + dash + r'\s*', ', ', sentence)
            text = text[:s_start] + fixed + text[s_start + len(sentence):]
            count += n
            continue

        rep = _pick(sentence, m.start() - s_start, text[m.end():])
        head = text[:m.start()].rstrip()
        rest = text[m.end():].lstrip()
        if rep == '. ' and rest:
            rest = rest[0].upper() + rest[1:]
        text = head + rep + rest
        count += 1

    return text, count


def scrub(src):
    """Scrub a whole markdown document. Returns (new_text, count, changes)."""
    lines = src.split('\n')
    out, changes, total = [], [], 0
    fence = None            # the exact fence marker that opened the block
    in_front = False
    front_done = False

    for idx, line in enumerate(lines):
        stripped = line.lstrip()

        # --- fenced code: a line state machine, deliberately not a regex ------
        fm = re.match(r'(`{3,}|~{3,})', stripped)
        if fence is None and fm:
            fence = fm.group(1)[0] * len(fm.group(1))
            out.append(line)
            continue
        if fence is not None:
            if fm and fm.group(1)[0] == fence[0] and len(fm.group(1)) >= len(fence) \
               and not stripped[len(fm.group(1)):].strip():
                fence = None
            out.append(line)
            continue

        # --- frontmatter: only title/description are prose -------------------
        if idx == 0 and stripped == '---':
            in_front = True
            out.append(line)
            continue
        if in_front:
            if stripped == '---':
                in_front, front_done = False, True
                out.append(line)
                continue
            km = re.match(r'^(\s*(?:title|description)\s*:\s*)(.*)$', line)
            if km:
                _m, _s = _mask(km.group(2))
                new, k = _replace_in_text(_m)
                new = _unmask(new, _s)
                if k:
                    total += k
                    changes.append((idx + 1, line, km.group(1) + new))
                out.append(km.group(1) + new)
            else:
                out.append(line)
            continue

        # --- body prose ------------------------------------------------------
        if EM not in line and HBAR not in line and EN not in line:
            out.append(line)
            continue
        masked, store = _mask(line)
        new, k_line = _replace_in_text(masked)
        rebuilt = _unmask(new, store)
        if k_line:
            total += k_line
            changes.append((idx + 1, line, rebuilt))
        out.append(rebuilt)

    return '\n'.join(out), total, changes


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if not args:
        print('usage: dedash.py FILE [--check] [--explain]', file=sys.stderr)
        return 2
    path = args[0]
    src = open(path, encoding='utf-8', errors='replace').read()
    new, count, changes = scrub(src)

    if '--explain' in flags:
        for ln, before, after in changes:
            print(f'  {ln}: - {before.strip()[:160]}', file=sys.stderr)
            print(f'  {ln}: + {after.strip()[:160]}', file=sys.stderr)

    if '--check' in flags:
        if count:
            print(f'dedash: {count} em dash(es) in prose', file=sys.stderr)
            return 1
        return 0

    if count:
        open(path, 'w', encoding='utf-8').write(new)
    print(f'dedash: {count} replaced', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
