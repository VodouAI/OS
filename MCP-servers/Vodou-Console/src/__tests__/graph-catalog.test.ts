/**
 * The tool catalog handed to the recipe author (PLAN-GRAPH-FRONTEND N5).
 *
 * Without it the author was told `SERVERS AVAILABLE: any` and invented
 * `bash.run` for "check my cpu and memory" while `mcp-monitor.get_cpu_info` sat
 * in the catalog. A plan built from an invented tool name COMPILES — the
 * compiler validates shape, and `bash.run` is a real tool — and does the wrong
 * thing.
 */
import { describe, it, expect } from 'vitest';
import { toolCatalogFor } from '../graph-offer.js';

/**
 * The catalog comes from `mcp_servers`/`tools` in `vodou-core.db`, which is a
 * RUNTIME database — not in git, and therefore absent in CI. Without it every
 * assertion below fails on an empty list.
 *
 * Skipped, never softened. The assertions stay exactly as strict as they are:
 * `if (!cat.length) return` is what let the token bug pass its own test, and a
 * silent pass here would be the same mistake wearing a CI badge. A skip is
 * VISIBLE — the run says the catalog was missing and which tests did not run.
 */
const CATALOG_AVAILABLE = (() => {
  try { return toolCatalogFor('cpu memory').length > 0; } catch { return false; }
})();

if (!CATALOG_AVAILABLE) {
  console.error(
    '[graph-catalog] SKIPPED the ranking tests: no tool catalog. `vodou-core.db` is a\n' +
    '                runtime database and is absent from a fresh checkout, so there are\n' +
    '                no tools to rank. This is an environment gap, NOT a passing test.',
  );
}

describe('tool catalog for the recipe author', () => {
  it.runIf(CATALOG_AVAILABLE)('ranks the tools a sentence is actually about', () => {
    const cat = toolCatalogFor('check my cpu and memory and write a health note');
    // NOT `if (!cat.length) return`. That escape hatch is why the token bug
    // passed its own test: an empty catalog satisfied every assertion below.
    // Absence-shaped tests are satisfied by total failure.
    expect(cat.length, 'the catalog must not be empty — a passing empty run proves nothing').toBeGreaterThan(0);
    const head = cat.slice(0, 8).join('\n').toLowerCase();
    expect(head).toMatch(/cpu|memory|mem/);
    // And it must offer REAL entries, in the exact `server.tool — description`
    // shape the prompt tells the model to use verbatim.
    expect(cat[0]).toMatch(/^[\w.-]+\.[\w-]+ — /);
  });

  /**
   * The exact sentence that broke it. "one" and "note" both appear INSIDE
   * "onenote", so substring matching scored `ms365.create-onenote-page` above
   * `mcp-monitor.get_cpu_info` — twice — and the model wrote a plan out of
   * OneNote tools. Tokens, never substrings.
   */
  it.runIf(CATALOG_AVAILABLE)('does not match words INSIDE other words', () => {
    const cat = toolCatalogFor('check my cpu and memory and write me a one line health note');
    expect(cat.length, 'an empty catalog would pass this trivially').toBeGreaterThan(0);
    const top = cat.slice(0, 5).join('\n').toLowerCase();
    expect(top).not.toMatch(/onenote/);
    expect(top).toMatch(/cpu|memory/);
  });

  it('caps the list — 893 active tools is not a prompt', () => {
    const cat = toolCatalogFor('send an email about the calendar and slack and memory and files', 10);
    expect(cat.length).toBeLessThanOrEqual(10);
  });

  it('returns nothing rather than noise when a sentence has no content words', () => {
    expect(toolCatalogFor('the and for with')).toEqual([]);
    expect(toolCatalogFor('')).toEqual([]);
  });

  /**
   * Stop words are what stop the ranking being decided by "my" and "and". A
   * sentence made only of them must not drag in an arbitrary 40 tools and
   * present them to the model as relevant.
   */
  it('does not let filler words rank the catalog', () => {
    const filler = toolCatalogFor('every morning the workflow');
    expect(filler).toEqual([]);
  });
});
