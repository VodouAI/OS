import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNothingToReport } from '../nothing-to-report.js';

/**
 * A skill with nothing to say must not reach anyone — not a channel, and not the
 * extension inbox. The inline check guarded channel delivery only, so every
 * quiet meeting-brief (it fires every 30 minutes) landed in the panel's inbox as
 * "Meeting brief — NOTHING_TO_REPORT" (2026-09-14).
 */
describe('isNothingToReport — the TS twin of memory::entities::is_nothing_to_report', () => {
  it('recognises the sentinel however the model dresses it', () => {
    for (const quiet of [
      'NOTHING_TO_REPORT',
      '  NOTHING_TO_REPORT  ',
      "I'll start by checking the calendar for the next two hours.\n\nNOTHING_TO_REPORT",
      'Checked.\n**NOTHING_TO_REPORT**\n',
      '`NOTHING_TO_REPORT`',
    ]) {
      expect(isNothingToReport(quiet), JSON.stringify(quiet)).toBe(true);
    }
  });

  it('is not fooled by a real reply that mentions it', () => {
    for (const real of [
      'NOTHING_TO_REPORT\n- but Steve owns a boat',   // anything after the sentinel is a reply
      'Standup at 3pm with Steve [chunk:abc]',
      'The sentinel NOTHING_TO_REPORT appears mid-sentence here.',
      '',
    ]) {
      expect(isNothingToReport(real), JSON.stringify(real)).toBe(false);
    }
    expect(isNothingToReport(null)).toBe(false);
    expect(isNothingToReport(undefined)).toBe(false);
  });
});

describe('both delivery paths consult the one spelling', () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
    'utf8',
  );

  it('the extension inbox push skips a quiet reply', () => {
    const start = src.indexOf('const notifyPanelOfRun = async');
    expect(start, 'notifyPanelOfRun not found in index.ts').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    expect(body).toMatch(/isNothingToReport\(payload\.response\)/);
  });

  it('channel delivery uses the helper, not a private copy of the check', () => {
    expect(src).toMatch(/const quietReply = isNothingToReport\(finalText\)/);
    // A second inline spelling is how the two paths drifted apart.
    expect(src.match(/=== 'NOTHING_TO_REPORT'/g) ?? []).toEqual([]);
  });
});
