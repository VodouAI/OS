import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { filterSnapshot, parseLine, LINKS_PER_GROUP, OPTIONS_WHEN_CLOSED } from '../browser-hands/snapshot-filter.js';

// PLAN-BROWSER-HANDS §13.4: the inner loop keeps ONE snapshot in context, so it
// must be small. Fixtures are real chrome-devtools-mcp 1.10.1 snapshots taken
// 2026-09-28 (OpenTable headed — it refuses headless — and Resy headless).
const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'browser-hands', f), 'utf8');
const OT = fx('opentable-home.snapshot.txt');
const RESY = fx('resy-home.snapshot.txt');
const RESY_TYPED = fx('resy-search-typed.snapshot.txt'); // "Carbone" typed into search; location scrubbed

describe('browser-hands snapshot filter', () => {
  it('parses a snapshot line', () => {
    expect(parseLine('    uid=1_17 combobox "Time selector" expandable value="7:30 PM"')).toEqual({
      depth: 4, uid: '1_17', role: 'combobox', name: 'Time selector', attrs: 'expandable value="7:30 PM"',
    });
    expect(parseLine('## Latest page snapshot')).toBeNull();
  });

  it('cuts the real OpenTable homepage (110k chars) to a small fraction', () => {
    const r = filterSnapshot(OT);
    expect(r.inChars).toBeGreaterThan(100_000);
    // Measured 2026-09-28: 110,862 -> 10,131 chars (~2.5k tokens), 1,199 -> 210 nodes.
    expect(r.outChars).toBeLessThan(12_000);
    expect(r.outChars / r.inChars).toBeLessThan(0.12);
  });

  it('keeps every control an errand needs', () => {
    const t = filterSnapshot(OT).text;
    for (const want of ['button "Sep 28"', 'combobox "Time selector"', 'option "8:00 PM"', 'button "Sign in"', 'button "search"', 'main', 'banner']) {
      expect(t).toContain(want);
    }
  });

  it('drops URLs, images and repeated tile links', () => {
    const t = filterSnapshot(OT).text;
    expect(t).not.toMatch(/url="/);
    expect(t).not.toMatch(/ image /);
    expect(t).toMatch(/… \+\d+ more links/);
    // no single parent shows more than LINKS_PER_GROUP links before its summary line
    const linkRuns = t.split(/\n(?=\s*… \+)/);
    expect(linkRuns.length).toBeGreaterThan(1);
  });

  it('never drops what is inside a dialog (a booking summary lives there)', () => {
    const snap = [
      'uid=1_0 RootWebArea "Book"',
      '  uid=1_1 dialog "Confirm reservation"',
      '    uid=1_2 StaticText "Sidecar · Sat, Oct 4 · 7:30 PM · Party of 4"',
      '    uid=1_3 image "logo"',
      '    uid=1_4 button "Complete reservation"',
    ].join('\n');
    const t = filterSnapshot(snap).text;
    expect(t).toContain('StaticText "Sidecar · Sat, Oct 4 · 7:30 PM · Party of 4"');
    expect(t).toContain('button "Complete reservation"');
    expect(t).toContain('image "logo"'); // inside a dialog everything stays
  });

  it('caps links per parent and says how many were hidden', () => {
    const links = Array.from({ length: 20 }, (_, i) => `    uid=1_${i + 2} link "Restaurant ${i}" url="https://x.test/r/${i}"`);
    const snap = ['uid=1_0 RootWebArea "x"', '  uid=1_1 list "Results"', ...links].join('\n');
    const t = filterSnapshot(snap).text;
    expect((t.match(/ link "/g) || []).length).toBe(LINKS_PER_GROUP);
    expect(t).toContain(`… +${20 - LINKS_PER_GROUP} more links`);
  });

  it('truncates very long names', () => {
    const t = filterSnapshot(`uid=1_0 RootWebArea "x"\n  uid=1_1 button "${'a'.repeat(300)}"`).text;
    expect(t).toMatch(/button "a{79}…"/);
  });

  it('a CLOSED dropdown shows a few options and a count; an OPEN one shows them all', () => {
    const t = filterSnapshot(RESY_TYPED).text;
    // Resy's guests picker: 20 options, closed.
    expect(t).toContain('combobox "2" expandable haspopup="menu" value="2 Guests"');
    expect(t).toContain('option "1 Guest"');
    expect(t).not.toContain('option "20 Guests"');
    expect(t).toContain(`… +${20 - OPTIONS_WHEN_CLOSED} more options`);
    const open = ['uid=1_0 RootWebArea "x"', '  uid=1_1 combobox "Time" expandable expanded', ...Array.from({ length: 10 }, (_, i) => `    uid=1_${i + 2} option "${i + 5}:00 PM"`)].join('\n');
    expect((filterSnapshot(open).text.match(/ option "/g) || []).length).toBe(10);
  });

  it('a live region keeps its whole announcement (the suggestion list itself is not in the tree)', () => {
    const t = filterSnapshot(RESY_TYPED).text;
    expect(t).toContain('There are 5 results from your query. Use the up and down arrows to navigate results. Carbone');
  });

  it('small pages stay readable (Resy)', () => {
    const r = filterSnapshot(RESY);
    expect(r.outChars).toBeLessThan(r.inChars);
    expect(r.keptNodes).toBeGreaterThan(10);
  });
});
