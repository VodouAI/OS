/**
 * PLAN-SKILL-SYSTEMS-SEAM P1 — one answer to "which skill system is this?"
 *
 * Runs against the REAL databases: 160 registry rows, 15 console rows, zero
 * collisions (measured 2026-08-27). The rules are pinned against live rows
 * because the bug this closes was always a lookup that believed one table.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { getDb, getGatewayDb } from '../db.js';
import { hasLive, skipNote } from './_live.js';
import {
  classify, classifySkill, scheduleNameFor, schedulePayloadTypeFor, skillFromScheduleRow,
  CONSOLE_SCHEDULE_PREFIX,
} from '../skill-kind.js';

// Asked BEFORE any query, because `prepare()` throws on a missing table and a
// guard placed after it never runs. `skills_registry` and `scheduled_tasks` live
// in vodou-core.db, which is gitignored — CI has never had one. See `_live.ts`.
const LIVE_REGISTRY = hasLive('core', 'skills_registry');
const LIVE_SCHED = hasLive('core', 'scheduled_tasks');
const LIVE_CONSOLE = hasLive('gateway', 'skills_meta');
if (!LIVE_REGISTRY) console.warn(skipNote('skill-kind', 'core', 'skills_registry'));
if (!LIVE_SCHED) console.warn(skipNote('skill-kind', 'core', 'scheduled_tasks'));
if (!LIVE_CONSOLE) console.warn(skipNote('skill-kind', 'gateway', 'skills_meta'));

const oneFile = () => (getDb().prepare('SELECT name FROM skills_registry LIMIT 1').get() as { name: string } | undefined)?.name;
const oneConsole = () => (getGatewayDb().prepare('SELECT name FROM skills_meta LIMIT 1').get() as { name: string } | undefined)?.name;

describe('classify', () => {
  it.skipIf(!LIVE_REGISTRY)('a registry skill is a file skill', () => {
    const n = oneFile(); if (!n) return;
    const r = classify(n);
    expect(r?.kind).toBe('file');
    expect(r?.name).toBe(n);
    expect(r?.id).toBeUndefined();
  });

  it.skipIf(!LIVE_CONSOLE)('a skills_meta skill is a console skill, and carries its id and cron', () => {
    const n = oneConsole(); if (!n) return;
    const r = classify(n);
    expect(r?.kind).toBe('console');
    expect(typeof r?.id).toBe('number');
    expect('scheduleCron' in (r ?? {})).toBe(true);
  });

  it('an unknown name is null, with the reason', () => {
    const res = classifySkill('no-such-skill-anywhere-9f3a');
    expect(res.ref).toBeNull();
    expect(res.miss?.reason).toBe('not_found');
    expect(classify('')).toBeNull();
  });

  it.skipIf(!LIVE_REGISTRY || !LIVE_CONSOLE)('a name in BOTH systems is an error, not a guess', () => {
    // Manufacture the collision the rule exists for, then remove it.
    const n = oneFile(); if (!n) return;
    const gw = getGatewayDb();
    // principal_id is NOT NULL; borrow a real one so the fixture is a real row.
    const pid = (gw.prepare('SELECT principal_id FROM skills_meta LIMIT 1').get() as { principal_id: string } | undefined)?.principal_id ?? 'principal:self:test';
    gw.prepare(`INSERT INTO skills_meta (name, display_name, prompt_template, is_active, principal_id) VALUES (?, ?, 'x', 1, ?)`).run(n, n, pid);
    try {
      const res = classifySkill(n);
      expect(res.ref, 'a collision must not be silently won by either table').toBeNull();
      expect(res.miss?.reason).toBe('ambiguous');
      if (res.miss?.reason === 'ambiguous') {
        expect(res.miss.file.kind).toBe('file');
        expect(res.miss.console.kind).toBe('console');
      }
    } finally {
      gw.prepare('DELETE FROM skills_meta WHERE name = ? AND prompt_template = ?').run(n, 'x');
    }
    expect(classify(n)?.kind, 'the collision must be gone again').toBe('file');
  });
});

describe('the two schedule spellings', () => {
  it('round-trip: a ref → its scheduler row → the same ref', () => {
    const file = { kind: 'file' as const, name: 'my-graph', active: true };
    const cons = { kind: 'console' as const, name: 'morning-pulse', id: 2, active: true };
    expect(scheduleNameFor(file)).toBe('my-graph');
    expect(schedulePayloadTypeFor(file)).toBe('query');
    expect(scheduleNameFor(cons)).toBe(`${CONSOLE_SCHEDULE_PREFIX}morning-pulse`);
    expect(schedulePayloadTypeFor(cons)).toBe('skill_run');
    expect(skillFromScheduleRow({ name: scheduleNameFor(file), payload_type: schedulePayloadTypeFor(file) })).toEqual({ kind: 'file', name: 'my-graph' });
    expect(skillFromScheduleRow({ name: scheduleNameFor(cons), payload_type: schedulePayloadTypeFor(cons) })).toEqual({ kind: 'console', name: 'morning-pulse' });
  });

  it('rows that are not a skill at all map to null', () => {
    expect(skillFromScheduleRow({ name: 'vodou-heartbeat', payload_type: 'gateway_chat' })).toBeNull();
    expect(skillFromScheduleRow({ name: 'blog-morning', payload_type: 'mcp_tool' })).toBeNull();
    expect(skillFromScheduleRow({ name: 'memory-janitor', payload_type: 'health_check' })).toBeNull();
  });

  it.skipIf(!LIVE_SCHED)('the live scheduler table classifies every skill row and nothing else', () => {
    const rows = getDb().prepare('SELECT name, payload_type FROM scheduled_tasks').all() as Array<{ name: string; payload_type: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const m = skillFromScheduleRow(r);
      if (r.payload_type === 'skill_run') expect(m?.kind, r.name).toBe('console');
      else if (r.payload_type === 'query') expect(m?.kind, r.name).toBe('file');
      else expect(m, `${r.name} (${r.payload_type}) is not a skill row`).toBeNull();
    }
  });
});

/**
 * THE GATE. Nothing outside skill-kind.ts may spell the seam. This fails until
 * every local derivation is rewired — which is the whole of P1's second half —
 * and it is the thing that stops a sixth copy appearing next month.
 */
describe('P1 gate — the seam is spelled in one file', () => {
  const root = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) { if (e !== '__tests__' && e !== 'node_modules') walk(p); }
      else if (p.endsWith('.ts') && !p.endsWith('skill-kind.ts')) files.push(p);
    }
  };
  walk(root);

  const offenders = (re: RegExp) =>
    files.filter((f) => re.test(readFileSync(f, 'utf-8').replace(/^\s*(\/\/|\*).*$/gm, ''))).map((f) => path.relative(root, f));

  it("no other file spells the console lane's payload_type as a schedule", () => {
    // `payload_type = 'skill_run'` / `payload_type: 'skill_run'` / `=== 'skill_run'`.
    // NOT a bare 'skill_run' string: db.ts keeps one in a conversation-SOURCE
    // allowlist (what a chat came from), which is a different word that happens
    // to be spelled the same. The gate is about the scheduler seam.
    expect(offenders(/payload_type\s*(===?|:|=)\s*['"]skill_run['"]/)).toEqual([]);
  });
  it("no other file builds or strips the 'skill:' prefix by hand", () => {
    expect(offenders(/`skill:\$\{|['"]skill:['"] *\+|replace\(\/\^skill:\//)).toEqual([]);
  });
});
