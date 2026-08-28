/**
 * PLAN-SKILL-SYSTEMS-SEAM P2 — one lookup that answers for both.
 *
 * The plan's gate, verbatim: "/api/skills and /api/graph/shapes both report a
 * count that equals listAllSkills().length for their lane, and their union has
 * no duplicates. A skill that exists is findable from one call."
 *
 * Every assertion runs against the REAL databases and the REAL filesystem,
 * because the bug this closes was always a lookup that believed one source.
 * Building it found three skills the disk-keyed lookup called "unregistered"
 * — `templates/{custom,research-analysis,code-review}` — whose directory is a
 * short alias for a longer frontmatter name. Identity is the name.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { existsSync } from 'fs';
import { getDb, getGatewayDb } from '../db.js';
import { hasLive, skipNote } from './_live.js';
import { listAllSkills, listFileSkills, listConsoleSkills, registryNameForDir, classify } from '../skill-kind.js';
import { findSkills } from '../skill-discovery.js';

const ROOT = path.resolve(__dirname, '../../../..');

// Every describe below compares a lane's output against the LIVE registry, so
// none of them can run on a machine without one. Asked before any query: a
// missing table makes `prepare()` throw, so a guard inside the test body would
// never be reached. `skills_registry` lives in vodou-core.db (gitignored), which
// is why a fresh CI checkout failed all six of these. See `_live.ts`.
const LIVE = hasLive('core', 'skills_registry');
if (!LIVE) console.warn(skipNote('skill-kind-p2', 'core', 'skills_registry'));

describe.skipIf(!LIVE)('P2 — the file lane equals /api/skills, row for row', () => {
  it('same names, same count, same active flags as the endpoint\'s own query', () => {
    // The exact SELECT /api/skills runs with no filters (api/skills.ts:343).
    const api = getDb().prepare('SELECT name, COALESCE(is_active,1) AS is_active FROM skills_registry').all() as Array<{ name: string; is_active: number }>;
    const lane = listFileSkills();
    expect(lane.length).toBe(api.length);
    const byName = new Map(lane.map((s) => [s.name, s]));
    for (const r of api) {
      const s = byName.get(r.name);
      expect(s, `registry row ${r.name} missing from the lane`).toBeDefined();
      expect(s!.active).toBe(r.is_active !== 0);
    }
  });

  it('derives the directory from file_path, never from the directory_path column', () => {
    // directory_path is wrong for ten autonomous/ rows (stores the parent).
    const wrong = getDb().prepare("SELECT name, file_path FROM skills_registry WHERE directory_path = 'autonomous'").all() as Array<{ name: string; file_path: string }>;
    if (!wrong.length) return;
    const lane = new Map(listFileSkills().map((s) => [s.name, s]));
    for (const r of wrong) {
      expect(lane.get(r.name)?.dir, r.name).toBe(r.file_path.replace(/\/SKILL\.md$/, ''));
      expect(lane.get(r.name)?.dir, `${r.name} must not collapse to the parent`).not.toBe('autonomous');
    }
  });

  it('a registration outside skills/ is surfaced, not hidden', () => {
    const outside = listFileSkills().filter((s) => s.outsideSkillsRoot);
    for (const s of outside) expect(s.path.startsWith('/'), s.name).toBe(true);
    // And every inside one is relative.
    for (const s of listFileSkills().filter((s) => !s.outsideSkillsRoot)) expect(s.path.startsWith('/'), s.name).toBe(false);
  });
});

describe.skipIf(!LIVE)('P2 — the console lane equals /api/skill-console/list', () => {
  it('same names, same count as the endpoint\'s own query', () => {
    const api = getGatewayDb().prepare('SELECT name FROM skills_meta').all() as Array<{ name: string }>;
    const lane = listConsoleSkills();
    expect(lane.length).toBe(api.length);
    expect(new Set(lane.map((s) => s.name))).toEqual(new Set(api.map((r) => r.name)));
    for (const s of lane) { expect(typeof s.id).toBe('number'); expect(s.kind).toBe('console'); }
  });
});

describe.skipIf(!LIVE)('P2 — the union', () => {
  it('has no duplicate names, and every row is labelled', () => {
    const { skills, collisions } = listAllSkills();
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of skills) expect(['file', 'console']).toContain(s.kind);
    expect(collisions, 'no name collides today (15 vs 161, measured 2026-08-27)').toEqual([]);
    expect(skills.length).toBe(listFileSkills().length + listConsoleSkills().length);
  });

  it('a skill that exists is findable from one call, and classify agrees on its kind', () => {
    for (const s of listAllSkills().skills.slice(0, 40)) {
      expect(classify(s.name)?.kind, s.name).toBe(s.kind);
    }
  });
});

describe.skipIf(!LIVE)('P2 — disk and registry agree once identity is the name', () => {
  it('every skill discovered on disk resolves to a registry name — aliases AND duplicates included', async () => {
    const found = await findSkills(path.join(ROOT, 'skills'));
    const unresolved = found
      .filter((f) => f.skillMdPath) // a dir with only actions.json is not a skill the sync registers
      .filter((f) => registryNameForDir(path.relative(path.join(ROOT, 'skills'), f.dir)) === null)
      .map((f) => path.relative(path.join(ROOT, 'skills'), f.dir));
    expect(unresolved, `on disk with a SKILL.md, and NOTHING explains it: ${JSON.stringify(unresolved)}`).toEqual([]);
  });

  it('the BUILT dist finds the duplicate — vitest cannot stand in for production here', async () => {
    // Vitest transpiles this file to CJS, where `require` exists. The duplicate
    // walk once called require('fs') inside the ESM source: fine here, a
    // swallowed ReferenceError in the running gateway, zero duplicates in
    // production while this file was green. The only honest check is the
    // artifact production loads. If dist/ has not been built this is a skip,
    // said out loud — never a pass.
    const distPath = path.resolve(__dirname, '../../dist/skill-kind.js');
    if (!existsSync(distPath)) { console.error('[skill-kind-p2] SKIPPED dist check: run `npm run build` first'); return; }
    const dist = await import(distPath) as typeof import('../skill-kind.js');
    dist._resetSkillDiskCache();
    const dups = dist.listFileSkills().filter((s) => s.duplicateOf).map((s) => `${s.name} ↔ ${s.duplicateOf}`);
    expect(dups, 'the built module found no duplicate — the walk is dead in production again').toEqual(['board-worker ↔ agents/project-management/board-worker']);
  });

  it('the lane REPORTS what disagrees instead of hiding it: stale rows and duplicate names', () => {
    const lane = listFileSkills();
    const stale = lane.filter((s) => s.stale).map((s) => s.name).sort();
    const dups = lane.filter((s) => s.duplicateOf).map((s) => `${s.name} ↔ ${s.duplicateOf}`);
    // Measured 2026-08-27. A NEW stale row or duplicate fails here by name —
    // that is the alarm, not a nuisance: the sync never prunes and never sees
    // a second copy, so nothing else will ever say so.
    expect(stale.length, `stale registry rows (file gone): ${JSON.stringify(stale)}`).toBeLessThanOrEqual(10);
    for (const n of ['notion-create-page', 'save-picker-demo']) expect(stale, `${n} was measured stale`).toContain(n);
    expect(dups, `duplicate names on disk: ${JSON.stringify(dups)}`).toEqual(['board-worker ↔ agents/project-management/board-worker']);
  });

  it('the three short-named templates resolve to their long frontmatter names', () => {
    expect(registryNameForDir('templates/custom')).toBe('custom-skill-template');
    expect(registryNameForDir('templates/research-analysis')).toBe('research-analysis-template');
    expect(registryNameForDir('templates/code-review')).toBe('code-review-template');
    expect(registryNameForDir('templates/does-not-exist')).toBeNull();
  });
});
