#!/usr/bin/env python3
"""
audit-dormant-tests.py — find test functions that never run (CO-3).

A function inside a `#[cfg(test)]` module that ASSERTS but carries no `#[test]`
is a test nobody runs. rustc does say so — "function `…` is never used" — but it
says it among a hundred other warnings, and both of the ones this was written
for had been dormant long enough that nobody could say when they stopped.

`the_work_appears_exactly_once_when_gated` guarded a gated graph emitting its
work twice; `off_mode_never_calls_a_model` pinned that Off mode returns its
input untouched. Both passed the moment they were switched on, which is the
worst case: nothing was broken, so nothing ever pointed at them.

The signal is deliberately narrow — a body containing `assert`. Test modules are
full of legitimate helpers (`fn db()`, `fn make_token()`) and flagging those
would make this another warning people learn to skip.

Exit 1 on any finding.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ATTRS = ('#[test]', '#[tokio::test]', '#[ignore]', '#[should_panic')


def dormant_in(text: str):
    """Yield (line_no, fn_name) for asserting fns in test modules with no test attribute."""
    out = []
    for m in re.finditer(r'#\[cfg\(test\)\]', text):
        # The module body: from the marker to the end of file is fine — a later
        # #[cfg(test)] just gets scanned twice and we dedupe on line number.
        body = text[m.start():]
        for fm in re.finditer(r'\n(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(', body):
            indent, name = fm.group(1), fm.group(2)
            # Only functions nested inside the module (indented), not top level.
            if len(indent.replace('\t', '    ')) < 4:
                continue
            # Look back a few lines for an attribute.
            before = body[max(0, fm.start() - 260):fm.start()]
            if any(a in before for a in ATTRS):
                continue
            # Body: to the next declaration OR doc comment at the same level.
            #
            # The doc-comment terminator matters. Without it the slice ran past
            # the closing brace into the NEXT function — which is how the first
            # run of this script reported `fn test_db()`, a fixture builder,
            # because the real test three lines below it contained an assert.
            after = body[fm.end():fm.end() + 4000]
            nxt = re.search(r'\n\s*(?:///|#\[|(?:pub\s+)?(?:async\s+)?fn\s)', after)
            fn_body = after[:nxt.start()] if nxt else after
            if 'assert' not in fn_body:
                continue
            line_no = text[:m.start()].count('\n') + body[:fm.start()].count('\n') + 2
            out.append((line_no, name))
    return out


def main() -> int:
    findings = []
    for path in sorted((ROOT / 'src').rglob('*.rs')):
        text = path.read_text(errors='ignore')
        if '#[cfg(test)]' not in text:
            continue
        seen = set()
        for line_no, name in dormant_in(text):
            if name in seen:
                continue
            seen.add(name)
            findings.append((path.relative_to(ROOT), line_no, name))

    if not findings:
        print('audit-dormant-tests: no dormant tests found')
        return 0

    print(f'audit-dormant-tests: {len(findings)} function(s) assert but never run:', file=sys.stderr)
    for path, line_no, name in findings:
        print(f'  {path}:{line_no}  fn {name}()', file=sys.stderr)
    print('\nAdd #[test] (or rename it if it is genuinely a helper). CO-3.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
