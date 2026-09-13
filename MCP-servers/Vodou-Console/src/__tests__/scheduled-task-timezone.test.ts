/**
 * A task created through the console carries the zone its schedule is written
 * in (migration 102).
 *
 * Nothing on `POST /api/scheduler` shifts a cron — `schedule` is taken from the
 * request body verbatim — so it was already the person's wall clock while the
 * engine resolved it as UTC. `0 9 * * *` fired at 04:00 for a US-Eastern person
 * and drifted an hour at every daylight-saving change. Stamping the zone is the
 * entire fix on this route; there is nothing to un-shift.
 *
 * The decision is a pure function (`taskZoneFor`) so it can be exercised
 * everywhere, including a fresh checkout with no vodou-core.db. The end-to-end
 * case — does the INSERT actually write the column — needs that database, so it
 * declares itself through `_live.js` the way the live-db gate requires.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasLive, skipNote } from './_live.js';
import { taskZoneFor, taskZoneForWith } from '../api/scheduler.js';
import { invalidateUserZone } from '../user-time.js';

const ORIGINAL_TZ = process.env.VODOU_TZ;
function asZone(tz: string | undefined) {
  if (tz === undefined) delete process.env.VODOU_TZ;
  else process.env.VODOU_TZ = tz;
  invalidateUserZone();
}
afterAll(() => asZone(ORIGINAL_TZ));

describe('taskZoneFor — which new tasks carry a zone', () => {
  it('stamps a clock-face schedule with a REFERENCE, not a frozen zone name', () => {
    // Late bound (PLAN-ONE-CLOCK §3.1): the row says "follow the person", so a
    // timezone change moves every follows-me schedule with zero rows rewritten.
    asZone('America/Detroit');
    expect(taskZoneFor('cron')).toBe('@user');
    expect(taskZoneFor('at')).toBe('@user');
    // …and it does not vary with the setting, which is the whole point.
    asZone('Asia/Tokyo');
    expect(taskZoneFor('cron')).toBe('@user');
  });

  it('never stamps a duration — no zone can move "every 4h"', () => {
    asZone('America/Detroit');
    expect(taskZoneFor('every')).toBeNull();
    expect(taskZoneFor('in')).toBeNull();
  });

  it('stamps even when nobody has set a zone — that case is the argument, not an edge', () => {
    // System tasks are seeded by the worker at FIRST START, which can run before
    // onboarding finishes. An early-bound stamp would write nothing there
    // (`Zone::Host` has no IANA name), so `0 2 * * *` would be read as UTC and
    // run at 10pm local, permanently, on every fresh install. The sentinel costs
    // nothing at seed time and becomes right the moment the zone is known.
    asZone(undefined);
    expect(taskZoneFor('cron')).toBe('@user');
  });
});

describe('the two writers agree about what a stamped row means', () => {
  it('the gateway applies the same two conditions the engine does', () => {
    // A stamped row asserts "this schedule is wall clock in this zone". If one
    // writer stamped on looser terms than the other, a schedule would be
    // converted twice and fire an offset away from where it was asked to.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const engine = readFileSync(path.resolve(here, '../../../../src/scheduler.rs'), 'utf8');
    const start = engine.indexOf('pub fn zone_for_new_task');
    expect(start, 'the engine helper still exists under that name').toBeGreaterThan(-1);
    const body = engine.slice(start, start + 600);
    expect(body, 'engine: clock-face types only').toContain('"cron" | "at"');
    expect(body, 'engine: stamps the late-bound sentinel').toContain('FOLLOWS_USER');

    const gateway = readFileSync(path.resolve(here, '../api/scheduler.ts'), 'utf8');
    const g = gateway.slice(gateway.indexOf('export function taskZoneFor'));
    expect(g, 'gateway: clock-face types only').toContain("!== 'cron' && scheduleType !== 'at'");
    expect(g, 'gateway: stamps the late-bound sentinel').toContain('return FOLLOWS_USER');

    // The two must spell the sentinel identically — a row stamped '@user' by one
    // and read as a literal zone name by the other is the double conversion this
    // whole seam exists to prevent.
    //
    // It is DECLARED in `user_time.rs`, not here: `database.rs` names it in a
    // WHERE clause and is library code, which cannot reach a bin module. This
    // gate caught that move — it was still looking in `scheduler.rs` after P8
    // relocated it, which is precisely the drift it exists to notice.
    const userTime = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/user_time.rs'),
      'utf8',
    );
    expect(userTime, 'the sentinel is declared in the library').toContain(
      'pub const FOLLOWS_USER: &str = "@user"',
    );
    expect(engine, 'and the scheduler re-exports it rather than redeclaring').toContain(
      'pub use crate::user_time::FOLLOWS_USER',
    );
    expect(gateway).toContain("export const FOLLOWS_USER = '@user'");
  });
});

// The INSERT itself reads vodou-core.db, whose schema the Rust engine owns and
// which no fresh checkout has. Declared, not assumed.
const LIVE = hasLive('core', 'scheduled_tasks', 0);
describe.skipIf(!LIVE)('POST /api/scheduler writes the column', () => {
  let app: any; let request: any; let db: any;

  beforeAll(async () => {
    if (!LIVE) { console.log(skipNote('scheduled-task-timezone', 'core', 'scheduled_tasks')); return; }
    const core = await import('../db.js');
    db = core.getDb();
    const express = (await import('express')).default;
    const { schedulerRouter } = await import('../api/scheduler.js');
    app = express();
    app.use(express.json());
    app.use('/api/scheduler', schedulerRouter);
    request = (await import('supertest')).default;
  });

  it('stores the wall clock unchanged, with the zone beside it', async () => {
    asZone('America/Detroit');
    const name = `tz-test-${Date.now()}`;
    await request(app).post('/api/scheduler')
      .send({ name, schedule: '0 9 * * *', schedule_type: 'cron', payload: 'do a thing' });
    const row = db.prepare('SELECT schedule, timezone FROM scheduled_tasks WHERE name = ?').get(name);
    try {
      expect(row?.timezone).toBe('@user');    // a reference, resolved at fire time
      expect(row?.schedule).toBe('0 9 * * *'); // NOT shifted — the engine resolves it in the zone
    } finally {
      db.prepare('DELETE FROM scheduled_tasks WHERE name = ?').run(name);
    }
  });
});

describe('P3 — nothing tells the person the schedule is UTC any more', () => {
  const read = (rel: string) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return readFileSync(path.resolve(here, rel), 'utf8');
  };

  it('the cron receipt no longer claims "stored as UTC", nor warns about DST', () => {
    // Both halves of the old sentence became FALSE with P1/P2: the expression
    // is the wall clock the person typed, and it now HOLDS across a DST change.
    // A receipt describing the old behaviour is worse than none — it teaches a
    // person to distrust a time that is now correct.
    const src = read('../api/skill-console-handler.ts');
    const line = src.split('\n').find((l) => l.includes('parsed from')) || '';
    expect(line, 'the receipt still exists').not.toBe('');
    expect(line).not.toContain('stored as UTC');
    // `nlNote =` matches its own declaration (`let nlNote = ''`) first, so take
    // the ASSIGNMENT — the last occurrence — not the first.
    const note = src.slice(src.lastIndexOf('nlNote ='), src.lastIndexOf('nlNote =') + 700);
    expect(note, 'the DST warning describes a bug that is fixed')
      .not.toMatch(/shifts it by an hour until you re-save/);
    expect(note).toContain('keeps that hour');
  });

  it('every surface that prints a cron prints the clock it is on', () => {
    // A wall-clock expression without its zone is not an answer, and after P2
    // every new expression IS a wall clock.
    const skills = read('../../public/js/views/skills.js');
    expect(skills, 'the Skills chip must name the zone').toContain('scheduleTimezone');
    const meta = read('../api/skill-console-meta.ts');
    expect(meta, 'and the API must serve it').toContain('scheduleTimezone: t?.timezone');
    expect(meta, 'both task queries must select it').not.toMatch(
      /SELECT name, schedule, next_run_at/,
    );
  });

  it('the CLI listing reads the AUTHORITATIVE store, not skills_meta', () => {
    // `scheduled_tasks` decides when a skill runs; `skills_meta.schedule_cron`
    // is the fallback. Printing the latter shows a time the product does not
    // honour — the console fixed this, the CLI had not.
    const main = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src/main.rs'),
      'utf8',
    );
    // COALESCE is in the SELECT list, which comes BEFORE `FROM` — slice the
    // whole statement, not forward from the join.
    const at = main.indexOf('FROM skills_meta s');
    const q = main.slice(at - 600, at + 400);
    expect(q).toContain("LEFT JOIN scheduled_tasks t ON t.name = 'skill:' || s.name");
    expect(q).toContain('COALESCE(t.schedule, s.schedule_cron)');
  });
});

describe('a caller may pin a zone through the console too', () => {
  // The engine has had this since `732e94e6`; the console route did not, so the
  // three-way contract (`@user` / a literal / NULL) was reachable from the CLI
  // and the HTTP route and not from the screen. P3 already RENDERS the literal
  // case, which means the UI could show a state the UI could not create.
  it('omitted still follows the person', () => {
    expect(taskZoneForWith('cron', undefined)).toBe('@user');
    expect(taskZoneForWith('cron', '')).toBe('@user');
    expect(taskZoneForWith('cron', '   ')).toBe('@user');
    expect(taskZoneForWith('cron', 42)).toBe('@user');   // not a string at all
  });

  it('a named zone is pinned — "9am London" must not move when you fly', () => {
    expect(taskZoneForWith('cron', 'Europe/London')).toBe('Europe/London');
    expect(taskZoneForWith('at', ' Asia/Tokyo ')).toBe('Asia/Tokyo');
    expect(taskZoneForWith('cron', 'UTC')).toBe('UTC');     // the legacy contract
    expect(taskZoneForWith('cron', '@user')).toBe('@user'); // the sentinel, spelled
  });

  it('a misspelled zone is REFUSED, never downgraded to "follows you"', () => {
    // A silent downgrade is a schedule firing somewhere nobody chose.
    expect(() => taskZoneForWith('cron', 'Eastern')).toThrow(/not an IANA timezone/);
    expect(() => taskZoneForWith('cron', 'America/Nowhere')).toThrow(/not an IANA timezone/);
  });

  it('a duration cannot carry a zone, and says so rather than ignoring it', () => {
    expect(taskZoneForWith('every', undefined)).toBeNull();
    expect(() => taskZoneForWith('every', 'Europe/London')).toThrow(/duration/);
    expect(() => taskZoneForWith('in', 'UTC')).toThrow(/duration/);
  });

  it('the console refuses on the same terms the engine does', () => {
    // Not "both have an override" — both must REFUSE the same inputs. One side
    // accepting what the other rejects is how a row gets a zone its writer never
    // meant, which is the double-conversion this seam exists to prevent.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const engine = readFileSync(path.resolve(here, '../../../../src/scheduler.rs'), 'utf8');
    const fn = engine.slice(engine.indexOf('pub fn zone_for_new_task_with'));
    const body = fn.slice(0, 1400);
    expect(body, 'engine: refuses a non-IANA name').toContain('not an IANA timezone name');
    expect(body, 'engine: refuses a zone on a duration').toContain('names a duration, not a time of day');
    expect(body, 'engine: accepts the sentinel spelled out').toContain('FOLLOWS_USER');

    const gw = readFileSync(path.resolve(here, '../api/scheduler.ts'), 'utf8');
    const g = gw.slice(gw.indexOf('export function taskZoneForWith'));
    expect(g, 'gateway: refuses a non-IANA name').toContain('not an IANA timezone name');
    expect(g, 'gateway: refuses a zone on a duration').toContain('names a duration, not a time of day');
    expect(g, 'gateway: accepts the sentinel spelled out').toContain('FOLLOWS_USER');
  });
});
