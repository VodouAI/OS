/**
 * PLAN-CONTEXT-COORDINATION P8 — one context assembler.
 *
 * The plan's acceptance, verbatim: "`grep -c '<active_context>' src/llm.ts` = 1
 * (the assembler); the same for the ground-truth call and the tool-results
 * strip regex." Written BEFORE the extraction, against the file as it stood on
 * 2026-08-27 — 2 emitters, 5 strip copies, 5 bootstrap-for-turn calls, 4
 * callers of buildUserPromptWithOIResults — so it is red until every copy is
 * gone, and it says which copy is still there. A gate that passes before the
 * work is done is the trap; this one cannot.
 *
 * ── P9 (§20.3, 2026-08-28) ────────────────────────────────────────────────
 * The 08-28 recount found P8's seam was real but not exclusive: three paths
 * ran BESIDE it, one of them the path the product most advertises.
 *
 *   - `chatWithSkill` set `skillSystemPromptOverride` and every provider then
 *     skipped `assembleContext` entirely (5 copies) — so a skill turn had no
 *     bootstrap decision, no budget, and no `skill` lane. 0 rows in 375 receipts.
 *   - `maybeAppendScopeBlock` ran AFTER the assembler at 5 more per-provider
 *     sites — P8's disease reintroduced one layer downstream, carrying an
 *     uncapped operator free-text block (`workbench_instructions`) with it.
 *   - Ground truth was prepended into `memoryContext` on 3 of 5 providers, so
 *     the block labelled "THIS BLOCK WINS" was evictable by the memory budget
 *     and no record said so.
 *
 * The counts below were confirmed RED before the work (5 / 5 / 0 / 0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const llm = readFileSync(path.resolve(__dirname, '../llm.ts'), 'utf-8');
const count = (re: RegExp) => (llm.match(re) ?? []).length;

/** The body of assembleContext — where the seam is allowed to live. */
const ASSEMBLER = (() => {
  const start = llm.indexOf('export async function assembleContext(');
  expect(start, 'assembleContext not found').toBeGreaterThan(-1);
  // Ends at the next top-level `export`/`function` after it; generous window is fine
  // because the assertions below are all "does NOT appear outside".
  const end = llm.indexOf('\n// PLAN-CONTEXT-COORDINATION P7-0', start);
  return llm.slice(start, end > start ? end : start + 20000);
})();
const OUTSIDE = llm.slice(0, llm.indexOf('export async function assembleContext(')) +
  llm.slice(llm.indexOf('export async function assembleContext(') + ASSEMBLER.length);

/** The assembler plus the one helper it owns — `maybeAppendScopeBlock` is part of
 *  the seam, not a copy of it, so the lane records it pushes count as "inside". */
const SEAM = ASSEMBLER + (() => {
  const i = llm.indexOf('function maybeAppendScopeBlock(');
  return i < 0 ? '' : llm.slice(i, llm.indexOf('\n}', i));
})();

describe('P8 gate — the seam is spelled in one place', () => {
  it('<active_context> is emitted by the assembler and nowhere else', () => {
    expect(count(/<active_context>\\n\$\{/g), 'inline <active_context> emitters outside the assembler').toBe(1);
  });
  it('the tool-results strip regex exists once', () => {
    expect(count(/\.replace\(\/### Vodou Tool Results/g), 'copies of the §3.2 strip (the READ at the ground-truth site is not a copy)').toBe(1);
  });
  it('the per-turn bootstrap is decided once', () => {
    expect(count(/await getWorkspaceBootstrapForTurn\(\)/g), 'per-provider bootstrap decisions (each a chance to drop the guest/heartbeat/panel suppression)').toBe(1);
  });
  it('the API family no longer has its own lane-6 helper', () => {
    expect(count(/buildUserPromptWithOIResults\(/g), 'buildUserPromptWithOIResults call sites (the second implementation of lane 6)').toBe(0);
  });
  it('every provider calls the assembler', () => {
    expect(count(/await assembleContext\(/g)).toBeGreaterThanOrEqual(5);
  });
});

describe('P9 gate — the three side doors are closed', () => {
  it('no provider assembles its own skill prompt', () => {
    // The five providers still BRANCH on the override — that is dispatch, and it
    // is fine. What must not exist is a provider CONCATENATING its own prompt out
    // of it: `contextParts + '---' + skillSystemPromptOverride` was the bypass,
    // five copies of it, each one a turn the receipt could not see. The override
    // may now only be READ into an assembleContext call.
    const concatenations = (OUTSIDE.match(/[+:]\s*skillSystemPromptOverride\b/g) ?? []).length;
    expect(
      concatenations,
      'providers building their own skill prompt instead of passing it to the assembler',
    ).toBe(0);
    // …and every provider that branches on it must hand it to the assembler.
    const mute: number[] = [];
    const re = /^[ \t]*if \(skillSystemPromptOverride\) \{/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(llm))) {
      const body = llm.slice(m.index, m.index + 500);
      if (!/assembleContext\(\{[\s\S]*skillSystemPromptOverride/.test(body)) {
        mute.push(llm.slice(0, m.index).split('\n').length);
      }
    }
    expect(mute, `skill branches that never reach the assembler, at llm.ts lines: ${mute.join(', ')}`).toEqual([]);
  });

  it('the scope block is applied inside the assembler, not after it', () => {
    // Was 5 post-cache per-provider call sites; now 0. The assembler calls it on
    // each of its three exits (cache hit, skill override, normal assembly) —
    // those are the seam, not copies of it. The load-bearing assertion is that
    // NOTHING outside `assembleContext` appends a scope block, because that is
    // how five copies appeared downstream of the one assembler P8 built.
    const callsOutside = (OUTSIDE.match(/^\s*(?:systemPrompt|out|sp)\s*=\s*maybeAppendScopeBlock\(/gm) ?? []).length;
    expect(callsOutside, 'maybeAppendScopeBlock call sites outside assembleContext').toBe(0);
    expect(ASSEMBLER, 'the assembler must be the one that applies it').toMatch(/maybeAppendScopeBlock\(/);
  });

  it('ground truth is never folded into the memory lane', () => {
    // The line that made "THIS BLOCK WINS" evictable by the memory budget on
    // OpenAI-compat / SDK / Ollama.
    expect(
      count(/memoryContext\s*=\s*memoryContext\s*\?\s*gtBlock/g),
      'ground truth prepended into memoryContext (it must be its own lane)',
    ).toBe(0);
  });

  it('ground truth is placed by the assembler', () => {
    expect(ASSEMBLER, 'assembleContext must own the ground-truth placement').toMatch(/groundTruth/);
    expect(ASSEMBLER).toMatch(/lane: 'ground_truth'/);
  });

  it('the skill lane can actually be emitted', () => {
    expect(ASSEMBLER).toMatch(/lane: isSkill \? 'skill' : 'tool_results'|lane: 'skill'/);
  });

  it('scope, workbench and automation are lanes, not anonymous text', () => {
    for (const lane of ['scope', 'workbench', 'automation']) {
      expect(SEAM, `${lane} must be recorded`).toMatch(new RegExp(`lane: '${lane}'`));
    }
  });
});

describe('P9 gate — every lane literal is registered', () => {
  const lanesToml = readFileSync(path.resolve(__dirname, '../../../../lanes.toml'), 'utf-8');
  const registered = new Set(
    [...lanesToml.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map((m) => m[1]),
  );

  it('lanes.toml carries every lane llm.ts can emit', () => {
    const emitted = new Set([...llm.matchAll(/lane:\s*'([a-z_]+)'/g)].map((m) => m[1]));
    const missing = [...emitted].filter((l) => !registered.has(l));
    expect(missing, `lane literals with no lanes.toml stanza: ${missing.join(', ')}`).toEqual([]);
  });

  it('the lanes the recount found unregistered are now registered', () => {
    // §20.1(c). Registering them is what makes coherence-guard Rule 8 able to
    // see the next one; a private budget is the thing rule 3 exists to stop.
    // `lenses` and `rolling_summary` were on this list until 2026-09-03: retired
    // from lanes.toml because their bytes were already logged under
    // `system_prompt` / `api_late_context` (SEAMS §61, wire-or-delete).
    for (const lane of [
      'scope', 'workbench', 'automation',
      'page_context', 'doc_attach', 'channel_envelope', 'history',
    ]) {
      expect(registered.has(lane), `lanes.toml is missing "${lane}"`).toBe(true);
    }
  });

  it('every stanza declares a budget and a trust label', () => {
    // Rule 8's own requirement, asserted on the file itself so a stanza added to
    // satisfy the guard cannot be an empty one.
    const stanzas = lanesToml.split(/^\[\[lane\]\]$/m).slice(1);
    const bad = stanzas
      .filter((s) => !/^\s*budget\s*=/m.test(s) || !/^\s*trust\s*=/m.test(s))
      .map((s) => (s.match(/name\s*=\s*"([^"]+)"/) ?? [])[1] ?? '(unnamed)');
    expect(bad, `stanzas missing budget or trust: ${bad.join(', ')}`).toEqual([]);
  });
});
