import { describe, it, expect } from 'vitest';
import { applyEdit, applyMultiEdit, EditError } from '../src/edit-applier.js';

function expectErr(fn: () => unknown, code: string) {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(EditError);
    expect((e as EditError).code).toBe(code);
    return;
  }
  throw new Error(`expected EditError(${code}), none thrown`);
}

describe('edit-applier — exact tier', () => {
  it('replaces a unique exact match and preserves surrounding bytes', () => {
    const src = 'line A\nline B\nline C\n';
    const r = applyEdit(src, 'line B', 'line B2');
    expect(r.strategy).toBe('exact');
    expect(r.updated).toBe('line A\nline B2\nline C\n');
    expect(r.replacements).toBe(1);
  });

  it('ambiguous when the exact string appears more than once', () => {
    expectErr(() => applyEdit('x\nx\n', 'x', 'y'), 'ambiguous');
  });

  it('no_match when absent', () => {
    expectErr(() => applyEdit('abc', 'zzz', 'q'), 'no_match');
  });

  it('bad_arg on empty old_string', () => {
    expectErr(() => applyEdit('abc', '', 'q'), 'bad_arg');
  });

  it('replacement is literal — no $-expansion', () => {
    const r = applyEdit('val = OLD', 'OLD', '$1 & $&');
    expect(r.updated).toBe('val = $1 & $&');
  });
});

describe('edit-applier — replace_all (strict literal)', () => {
  it('replaces every occurrence', () => {
    const r = applyEdit('a a a', 'a', 'b', { replaceAll: true });
    expect(r.replacements).toBe(3);
    expect(r.updated).toBe('b b b');
    expect(r.strategy).toBe('exact');
  });
  it('replace_all no_match', () => {
    expectErr(() => applyEdit('abc', 'z', 'q', { replaceAll: true }), 'no_match');
  });
});

describe('edit-applier — line-number-stripped tier', () => {
  it('matches when the model echoed line-number gutters', () => {
    const src = 'function f() {\n  return 1;\n}\n';
    const old = '12: function f() {\n13:   return 1;\n14: }';
    const r = applyEdit(src, old, 'function f() {\n  return 2;\n}');
    expect(r.strategy).toBe('line-number-stripped');
    expect(r.updated).toBe('function f() {\n  return 2;\n}\n');
  });

  it('supports pipe gutters "12 | "', () => {
    const src = 'alpha\nbeta\n';
    const r = applyEdit(src, '1 | alpha\n2 | beta', 'ALPHA\nBETA');
    expect(r.strategy).toBe('line-number-stripped');
    expect(r.updated).toBe('ALPHA\nBETA\n');
  });
});

describe('edit-applier — trailing-whitespace tier', () => {
  it('matches despite trailing spaces in the file', () => {
    const src = 'const a = 1;   \nconst b = 2;\n';
    const r = applyEdit(src, 'const a = 1;\nconst b = 2;', 'const a = 10;\nconst b = 2;');
    expect(r.strategy).toBe('trailing-ws');
    expect(r.updated).toBe('const a = 10;\nconst b = 2;\n');
  });
});

describe('edit-applier — indent-flexible tier (with re-indentation)', () => {
  it('matches under-indented old_string and re-indents new_string to the file indent', () => {
    const src = 'class C:\n    def m(self):\n        return 1\n';
    // model wrote the body with NO leading indent
    const old = 'def m(self):\n    return 1';
    const neu = 'def m(self):\n    return 2';
    const r = applyEdit(src, old, neu);
    expect(r.strategy).toBe('indent-flexible');
    // new_string re-indented by the file's 4-space delta on the matched block
    expect(r.updated).toBe('class C:\n    def m(self):\n        return 2\n');
  });

  it('re-indents a MULTI-LINE new_string while preserving its relative indentation (ADD)', () => {
    const src = 'class C:\n    def m(self):\n        x = 1\n        return x\n';
    const old = 'def m(self):\n    x = 1\n    return x'; // model wrote it at column 0
    const neu = 'def m(self):\n    y = 2\n    return y';
    const r = applyEdit(src, old, neu);
    expect(r.strategy).toBe('indent-flexible');
    // body lines keep their +4 relative indent under the re-indented def
    expect(r.updated).toBe('class C:\n    def m(self):\n        y = 2\n        return y\n');
  });

  it('mixed tab/space indent (non-prefix) applies new_string verbatim — never flattens', () => {
    const src = '\t\tfoo()\n';
    const r = applyEdit(src, '  foo()', '  bar()\n  baz()'); // 2-space old vs 2-tab file
    expect(r.strategy).toBe('indent-flexible');
    expect(r.updated).toBe('  bar()\n  baz()\n'); // verbatim, relative indent intact (not collapsed)
  });

  it('matches over-indented old_string (strips delta from new_string)', () => {
    const src = 'def m():\n    return 1\n';
    const old = '        def m():\n            return 1'; // model over-indented
    const neu = '        def m():\n            return 2';
    const r = applyEdit(src, old, neu);
    expect(r.strategy).toBe('indent-flexible');
    expect(r.updated).toBe('def m():\n    return 2\n');
  });
});

describe('edit-applier — fuzzy tier (conservative)', () => {
  it('matches a single small typo above threshold', () => {
    const src = 'const greeting = "hello world";\nconst x = 1;\n';
    // one-char difference (helo vs hello) — exact/ws/indent all fail
    const r = applyEdit(src, 'const greeting = "helo world";', 'const greeting = "hi";');
    expect(r.strategy).toMatch(/^fuzzy/);
    expect(r.updated).toBe('const greeting = "hi";\nconst x = 1;\n');
  });

  it('rejects a low-similarity (gibberish) old_string', () => {
    expectErr(() => applyEdit('const greeting = "hello world";\n', 'totally different nonsense line', 'q'), 'no_match');
  });

  it('refuses to fuzzy-guess between two near-identical blocks (returns no_match without a hint)', () => {
    const src = 'value = 100;\nvalue = 101;\n';
    // "value = 10X" is ~equally close to both lines → ambiguous → no auto-apply
    expectErr(() => applyEdit(src, 'value = 10Z;', 'value = 999;'), 'no_match');
  });

  it('startLine hint resolves an otherwise-ambiguous fuzzy match', () => {
    const src = 'value = 100;\nvalue = 101;\n';
    const r = applyEdit(src, 'value = 10Z;', 'value = 999;', { startLine: 2 });
    expect(r.strategy).toMatch(/^fuzzy/);
    expect(r.updated).toBe('value = 100;\nvalue = 999;\n');
  });
});

describe('edit-applier — applyMultiEdit (order-invariant, atomic)', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';

  it('applies multiple non-overlapping edits', () => {
    const r = applyMultiEdit(src, [
      { oldString: 'const a = 1;', newString: 'const a = 10;' },
      { oldString: 'const c = 3;', newString: 'const c = 30;' },
    ]);
    expect(r.updated).toBe('const a = 10;\nconst b = 2;\nconst c = 30;\n');
    expect(r.totalReplacements).toBe(2);
  });

  it('is ORDER-INVARIANT — hunks given bottom-to-top produce the same result', () => {
    const top2bottom = applyMultiEdit(src, [
      { oldString: 'const a = 1;', newString: 'A' },
      { oldString: 'const c = 3;', newString: 'C' },
    ]).updated;
    const bottom2top = applyMultiEdit(src, [
      { oldString: 'const c = 3;', newString: 'C' },
      { oldString: 'const a = 1;', newString: 'A' },
    ]).updated;
    expect(bottom2top).toBe(top2bottom);
    expect(bottom2top).toBe('A\nconst b = 2;\nC\n');
  });

  it('rejects overlapping edits (hard error, nothing applied)', () => {
    expectErr(() => applyMultiEdit('hello world foo', [
      { oldString: 'hello world', newString: 'X' },
      { oldString: 'world foo', newString: 'Y' }, // overlaps the first
    ]), 'overlap');
  });

  it('is atomic — a no-match in ANY edit throws (whole call fails)', () => {
    expectErr(() => applyMultiEdit(src, [
      { oldString: 'const a = 1;', newString: 'A' },
      { oldString: 'DOES NOT EXIST', newString: 'Z' },
    ]), 'no_match');
  });

  it('supports mixed strategies (exact + indent-flexible) in one call', () => {
    const s = 'class C:\n    def m(self):\n        return 1\n';
    const r = applyMultiEdit(s, [
      { oldString: 'class C:', newString: 'class D:' },                       // exact (line 0)
      { oldString: 'def m(self):\n    return 1', newString: 'def m(self):\n    return 2' }, // indent-flexible (file is +4)
    ]);
    expect(r.updated).toBe('class D:\n    def m(self):\n        return 2\n');
    expect(r.edits[0].strategy).toBe('exact');
    expect(r.edits[1].strategy).toBe('indent-flexible');
  });

  it('supports replace_all within a multi-edit', () => {
    const s = 'x x\ny\nx\n';
    const r = applyMultiEdit(s, [
      { oldString: 'x', newString: 'Q', replaceAll: true },
      { oldString: 'y', newString: 'Y' },
    ]);
    expect(r.updated).toBe('Q Q\nY\nQ\n');
    expect(r.edits[0].replacements).toBe(3);
  });

  it('bad_arg on empty edits array or empty old_string (with index)', () => {
    expectErr(() => applyMultiEdit(src, []), 'bad_arg');
    expectErr(() => applyMultiEdit(src, [{ oldString: '', newString: 'x' }]), 'bad_arg');
  });

  it('bad_arg when over the edit-count cap', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ oldString: `e${i}`, newString: 'x' }));
    expectErr(() => applyMultiEdit(src, many), 'bad_arg');
  });
});

describe('edit-applier — startLine disambiguation', () => {
  it('picks the hinted occurrence when an exact string appears on multiple lines', () => {
    const src = 'x = 1\ny = 2\nx = 1\n';
    expectErr(() => applyEdit(src, 'x = 1', 'x = 9'), 'ambiguous'); // no hint → safe error
    const r = applyEdit(src, 'x = 1', 'x = 9', { startLine: 3 });
    expect(r.strategy).toBe('exact');
    expect(r.updated).toBe('x = 1\ny = 2\nx = 9\n');
  });
});
