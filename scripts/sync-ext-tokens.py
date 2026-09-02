#!/usr/bin/env python3
"""Keep the three extension builds' appearance files identical.

Two files, two sources:
  tokens.css — generated from the Console's canonical palette file.
  theme.js   — mirrored from the Store build (the one that ships) to the others.

The side panel used to carry a HAND-COPIED :root block ("MIRRORED from
01-tokens.css — replace with the shared file in P7"). It drifted, and it could
only ever be brand-dark. This copies the real file instead, so the panel has all
24 palettes and cannot fall behind the Console again.

Two edits are made on the way through, and only these two:
  1. the `* { box-sizing; margin:0; padding:0 }` reset is dropped — the panel
     supplies its own box-sizing and RELIES on default margins; importing the
     Console's reset silently collapses its layout.
  2. a generated-file header is prepended.

Usage:
  python3 scripts/sync-ext-tokens.py            # write
  python3 scripts/sync-ext-tokens.py --check    # exit 1 if any copy is stale
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'MCP-servers/Vodou-Console/public/css/01-tokens.css'
BUILDS = [
    ROOT / 'extension/vodou-bridge',
    ROOT / 'extension/Store-vodou-bridge',
    ROOT / 'extension/sideload-only-vodou-bridge',
]
TARGETS = [b / 'tokens.css' for b in BUILDS]
# theme.js is authored in the Store build and mirrored byte-for-byte.
THEME_SRC = ROOT / 'extension/Store-vodou-bridge/theme.js'
THEME_TARGETS = [b / 'theme.js' for b in BUILDS if b.name != 'Store-vodou-bridge']
RESET = '* { box-sizing: border-box; margin: 0; padding: 0; }'
HEADER = """/* GENERATED — do not edit.
 * Source: MCP-servers/Vodou-Console/public/css/01-tokens.css
 * Regenerate: python3 scripts/sync-ext-tokens.py
 *
 * The Console's palette tokens, verbatim except for its global `*` reset
 * (dropped — the panel needs its default margins). Applied by theme.js, which
 * stamps data-theme / data-palette on <html> from GET /api/appearance.
 */
"""


def render() -> str:
    lines = [ln for ln in SRC.read_text(encoding='utf-8').splitlines()
             if ln.strip() != RESET]
    return HEADER + '\n'.join(lines).rstrip('\n') + '\n'


def main() -> int:
    if not SRC.exists():
        print(f'sync-ext-tokens: source missing: {SRC}', file=sys.stderr)
        return 1
    if not THEME_SRC.exists():
        print(f'sync-ext-tokens: source missing: {THEME_SRC}', file=sys.stderr)
        return 1
    check = '--check' in sys.argv
    stale = []
    pairs = [(t, render()) for t in TARGETS]
    theme = THEME_SRC.read_text(encoding='utf-8')
    pairs += [(t, theme) for t in THEME_TARGETS]
    for t, want in pairs:
        have = t.read_text(encoding='utf-8') if t.exists() else None
        if have == want:
            continue
        if check:
            stale.append(t)
        else:
            t.write_text(want, encoding='utf-8')
            print(f'wrote {t.relative_to(ROOT)}')
    if stale:
        for t in stale:
            print(f'STALE: {t.relative_to(ROOT)}', file=sys.stderr)
        print('Run: python3 scripts/sync-ext-tokens.py', file=sys.stderr)
        return 1
    if check:
        print('sync-ext-tokens: all copies current')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
