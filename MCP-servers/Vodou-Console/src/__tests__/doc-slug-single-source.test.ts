/**
 * COHERENCE F13 — "The same document gets a different token depending on which
 * surface made it."
 *
 * The `@doc:` slug rule was written out four times: `doc-attach.ts` (which
 * resolves it), `public/library/index.html` (drag payload), and twice inline in
 * the panel's `sidepanel.js` (documents lane, page-memory lane). All four
 * agreed, held together by comments reading "MUST match" — which is why nothing
 * would have caught the day they stopped. The failure is silent and total: a
 * token minted one way and resolved another names a document that does not
 * exist, so Vodou reports it attached your contract and then answers about
 * something else.
 *
 * The fix removed the deciders rather than synchronising them. Every route that
 * hands a document to a client mints the slug with the resolver's own function,
 * and the clients paste what they were given.
 *
 * This file is the guard on that, and it is deliberately a SOURCE test. A
 * behavioural test cannot see the defect: four copies of one expression pass
 * every behavioural test ever written, right up until one of them is edited.
 * What has to stay true is that the rule exists in exactly one place.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(here, '../..');
const REPO = path.resolve(CONSOLE_DIR, '../..');

/**
 * The distinctive tail of the rule: lowercase, non-alphanumerics to hyphens,
 * trim hyphens. Matching on this rather than the whole expression means a
 * reformatted or subtly-altered copy is still caught — a copy that drifted is
 * exactly the thing worth catching.
 */
const RULE = /\[\^a-z0-9\]\+\/g,\s*'-'/;

/** Files that hand a user an `@doc:` token but must not know how to build one. */
const CONSUMERS = [
  path.join(CONSOLE_DIR, 'public/library/index.html'),
  path.join(REPO, 'extension/Store-vodou-bridge/sidepanel.js'),
];

describe('the @doc: slug has exactly one implementation', () => {
  it('lives in doc-attach.ts, next to the code that resolves it', async () => {
    const src = fs.readFileSync(path.join(CONSOLE_DIR, 'src/doc-attach.ts'), 'utf8');
    expect(src).toMatch(RULE);
    const { slugOf } = await import('../doc-attach.js');
    expect(slugOf('01-MASTER-AGREEMENT.md', 6)).toBe('01-master-agreement');
  });

  it('is not restated by any surface that shows a token', () => {
    for (const file of CONSUMERS) {
      if (!fs.existsSync(file)) continue; // a checkout without the extension
      const text = fs.readFileSync(file, 'utf8');
      expect(
        RULE.test(text),
        `${path.relative(REPO, file)} computes the @doc: slug itself. It must read the ` +
          '`slug` the server put on the row instead — a token computed two ways is two documents.',
      ).toBe(false);
    }
  });

  it('has each surface reading the slug it was handed', () => {
    const page = fs.readFileSync(path.join(CONSOLE_DIR, 'public/library/index.html'), 'utf8');
    expect(page).toMatch(/src\.slug/);

    const panel = path.join(REPO, 'extension/Store-vodou-bridge/sidepanel.js');
    if (fs.existsSync(panel)) {
      const text = fs.readFileSync(panel, 'utf8');
      // Both lanes: the documents matcher and the page-memory rows.
      expect(text).toMatch(/data-slug/);
      expect(text).toMatch(/data-doc-slug/);
    }
  });

  it('mints the token in every route that ships a document row', () => {
    const routes = [
      path.join(CONSOLE_DIR, 'src/api/library.ts'),
      path.join(CONSOLE_DIR, 'src/api/page-match.ts'),
    ];
    for (const r of routes) {
      const text = fs.readFileSync(r, 'utf8');
      expect(
        text.includes("from '../doc-attach.js'"),
        `${path.basename(r)} ships document rows and must mint their slug from the resolver`,
      ).toBe(true);
      expect(text).toMatch(/slugOf\(/);
    }
  });

  /**
   * The id is a legitimate fallback — `resolveDocTokens` accepts `@doc:<id>` —
   * and it matters that the fallback is the ID rather than a local restatement
   * of the rule, which is how the copies got there in the first place.
   */
  it('falls back to the id, never to a second copy of the rule', () => {
    const page = fs.readFileSync(path.join(CONSOLE_DIR, 'public/library/index.html'), 'utf8');
    expect(page).toMatch(/src\.slug \|\| String\(src\.id\)/);
  });
});
