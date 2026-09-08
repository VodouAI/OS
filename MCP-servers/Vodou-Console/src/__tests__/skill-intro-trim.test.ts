/**
 * SW-13 — three quarters of the skill library showed no intro at all.
 *
 * The terminator required a markdown HEADING (`## STOPPING POINT`). Measured
 * against the shipped corpus: of the 95 skills that have a stopping point, 18
 * use `##` and **73** use `**STOPPING POINT n**`. For those 73 the search
 * returned -1, the `stopIdx > 0` guard failed, and the intro came out empty —
 * so the menu appeared with no explanation above it, on most of the library.
 *
 * Run over the real SKILL.md files rather than fixtures: the finding is about
 * what the corpus actually contains, and a fixture would have agreed with
 * whatever the regex already did.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { SKILL_INTRO_END } from '../llm.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

function skillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'SKILL.md') out.push(p);
    }
  };
  walk(path.join(repoRoot, 'skills'));
  return out;
}

describe('SW-13 — the skill intro terminator', () => {
  it('matches the BOLD form, which most of the library uses', () => {
    expect('intro\n\n**STOPPING POINT 1**\nmenu'.search(SKILL_INTRO_END)).toBeGreaterThan(0);
    expect('intro\n\n**⏸️ STOPPING POINT**\nmenu'.search(SKILL_INTRO_END)).toBeGreaterThan(0);
  });

  it('still matches the heading form it always did', () => {
    for (const h of ['## STOPPING POINT', '### STOPPING POINT 2', '## 🛑 STOPPING POINT', '## Choose', '## Agent Instructions']) {
      expect(`intro text here\n\n${h}\nmenu`.search(SKILL_INTRO_END), h).toBeGreaterThan(0);
    }
  });

  it('does not fire on prose that merely mentions a stopping point', () => {
    // Four shipped skills do exactly this. Matching them would truncate a real
    // intro mid-sentence, which is worse than the bug being fixed.
    const prose = 'This skill runs to completion. No menus, no tools, no stopping point.';
    expect(prose.search(SKILL_INTRO_END)).toBe(-1);
    expect('…but ONLY after you approve the stopping point.'.search(SKILL_INTRO_END)).toBe(-1);
  });

  it('recovers the intro across the real shipped corpus', () => {
    const files = skillFiles();
    expect(files.length, 'the corpus must be findable, or this test proves nothing').toBeGreaterThan(50);

    let withMarker = 0;
    let intros = 0;
    for (const f of files) {
      const body = fs.readFileSync(f, 'utf8').replace(/^---[\s\S]*?---\s*/m, '');
      if (!/STOPPING POINT/i.test(body)) continue;
      withMarker++;
      const idx = body.search(SKILL_INTRO_END);
      if (idx > 0 && body.slice(0, idx).trim().length >= 20) intros++;
    }
    // Before this fix the number was 18 of 95. It must now be most of them.
    expect(withMarker).toBeGreaterThan(50);
    expect(intros / withMarker, `${intros} of ${withMarker} skills yield an intro`).toBeGreaterThan(0.8);
  });
});
