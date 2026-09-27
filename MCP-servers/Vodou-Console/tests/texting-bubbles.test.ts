/**
 * T2 (PLAN-TEXTING-FEEL): /simple splits a reply into bubbles EXACTLY the way
 * the phone gets them. The algorithm lives twice — here in /simple and in the
 * relay (APP-VODOU-AI relay/src/brain.mjs toBubbles) — and both run the same
 * cases (tests/fixtures/texting-bubbles.json == relay/test/fixtures/…).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const html = readFileSync(join(__dirname, '../public/simple/index.html'), 'utf8');
const start = html.indexOf('  function toBubbles(text, opts) {');
const end = html.indexOf('\n  }\n', start) + 4;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const toBubbles = new Function(`${html.slice(start, end)}; return toBubbles;`)() as (t: string, o?: any) => string[];
const cases = JSON.parse(readFileSync(join(__dirname, 'fixtures/texting-bubbles.json'), 'utf8')) as Array<[string, string, any, string[]]>;

describe('/simple bubbles match the phone', () => {
  for (const [name, text, opts, want] of cases) {
    it(name, () => expect(toBubbles(text, opts)).toEqual(want));
  }
  it('a long paragraph splits at sentences, no bubble over ~320 chars', () => {
    const b = toBubbles('This is a fairly long sentence about the plan. '.repeat(20), {});
    expect(b.length).toBeGreaterThan(1);
    expect(Math.max(...b.map((x) => x.length))).toBeLessThanOrEqual(320);
  });
  it('aiSay and the finished stream use it', () => {
    expect(html).toContain('var parts = toBubbles(t, { max: 4 });');
    expect(html).toMatch(/toBubbles\(t, \{ max: 4 \}\)\.length > 1/);
  });
});

describe('/simple hides notes meant for the model', () => {
  it('the "[Attachments saved: …]" note never shows in the thread', () => {
    const a = html.indexOf('  function splitAttachments(text) {');
    const b = html.indexOf('\n  }\n', a) + 4;
    const fn = new Function(`var ATTACH_RE = /\\[Channel attachment: (\\S+) local_path=(\\S+) mime=(\\S*) type=(\\w+)\\]/g; ${html.slice(a, b)}; return splitAttachments;`)() as (t: string) => { text: string; files: any[] };
    const r = fn('look\n\n[Channel attachment: a.png local_path=/x/a.png mime=image/png type=image]\n\n[Attachments saved: every file above is stored on this computer at its local_path.]');
    expect(r.text).toBe('look');
    expect(r.files).toHaveLength(1);
  });
});
