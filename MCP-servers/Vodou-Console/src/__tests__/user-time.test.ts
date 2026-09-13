/**
 * One timezone across the whole system — the gateway's half.
 *
 * The engine's twin is `src/user_time.rs`, whose own gate proves no Rust file
 * outside it reads the machine clock. This file proves the same rule here, and
 * that the two halves agree about what a day is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { dayKeyOf, dayKeyOfNaiveUtc, dayWindowUtc, monthKey, userZone, invalidateUserZone } from '../user-time.js';

const SRC = path.resolve(__dirname, '..');

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e === '__tests__' || e === 'node_modules') continue;
      sources(f, acc);
    } else if (e.endsWith('.ts')) acc.push(f);
  }
  return acc;
}

describe('one clock — the person’s, not the process’s', () => {
  const priorTz = process.env.VODOU_TZ;
  beforeEach(() => { invalidateUserZone(); });
  afterEach(() => {
    if (priorTz === undefined) delete process.env.VODOU_TZ;
    else process.env.VODOU_TZ = priorTz;
    invalidateUserZone();
  });

  it('resolves VODOU_TZ first, and says which source it used', () => {
    process.env.VODOU_TZ = 'Asia/Tokyo';
    invalidateUserZone();
    expect(userZone()).toEqual({ zone: 'Asia/Tokyo', source: 'VODOU_TZ' });
    // A typo is not silently the machine's opinion — it falls back and says so.
    process.env.VODOU_TZ = 'Mars/Olympus';
    invalidateUserZone();
    expect(userZone().source).not.toBe('VODOU_TZ');
  });

  it('a day key is the person’s day — the assertion the whole change is about', () => {
    // 2026-09-10 02:30 UTC is still the 9th in Detroit, already the 10th in Tokyo.
    const instant = new Date('2026-09-10T02:30:00Z');
    process.env.VODOU_TZ = 'America/Detroit';
    invalidateUserZone();
    expect(dayKeyOf(instant)).toBe('2026-09-09');
    expect(dayKeyOfNaiveUtc('2026-09-10 02:30:00')).toBe('2026-09-09');
    expect(monthKey(instant)).toBe('2026-09');
    process.env.VODOU_TZ = 'Asia/Tokyo';
    invalidateUserZone();
    expect(dayKeyOf(instant)).toBe('2026-09-10');
    expect(dayKeyOfNaiveUtc('2026-09-10 02:30:00')).toBe('2026-09-10');
  });

  it('a bad stamp degrades to something readable instead of throwing', () => {
    expect(dayKeyOfNaiveUtc('')).toBe('');
    expect(dayKeyOfNaiveUtc(null)).toBe('');
    expect(dayKeyOfNaiveUtc('not a date at all')).toBe('not a date');
  });

  it('the day window is the person’s midnight-to-midnight, in naive UTC', () => {
    process.env.VODOU_TZ = 'America/Detroit';
    invalidateUserZone();
    // EDT (UTC-4): 2026-09-10 local midnight is 04:00Z, and the day is 24h.
    expect(dayWindowUtc('2026-09-10')).toEqual({ start: '2026-09-10 04:00:00', end: '2026-09-11 04:00:00' });
    // The two days a year a fixed offset is wrong. 2026-11-01 is the US fall
    // back: the local day is 25 hours, and both ends must still be midnight.
    const fall = dayWindowUtc('2026-11-01');
    expect(fall.start).toBe('2026-11-01 04:00:00');   // EDT, UTC-4
    expect(fall.end).toBe('2026-11-02 05:00:00');     // EST, UTC-5 — 25 hours later
    // …and spring forward, a 23-hour day.
    const spring = dayWindowUtc('2026-03-08');
    expect(spring.start).toBe('2026-03-08 05:00:00');
    expect(spring.end).toBe('2026-03-09 04:00:00');
  });

  it('every window contains its own start and excludes its own end', () => {
    process.env.VODOU_TZ = 'Asia/Kolkata';           // a half-hour offset
    invalidateUserZone();
    const w = dayWindowUtc('2026-09-10');
    expect(w.start).toBe('2026-09-09 18:30:00');
    expect(w.end).toBe('2026-09-10 18:30:00');
    expect(dayKeyOfNaiveUtc(w.start)).toBe('2026-09-10');
    expect(dayKeyOfNaiveUtc(w.end)).toBe('2026-09-11');   // half-open: the end belongs to the next day
  });

  it('nothing outside this module builds a day key from the process clock', () => {
    // The spellings this tree used before the arbiter existed. A new one is a
    // deliberate act that updates this list, not a silent drift back.
    const offenders: string[] = [];
    for (const f of sources(SRC)) {
      if (f.endsWith('user-time.ts')) continue;
      const rel = path.relative(SRC, f);
      readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        const l = line.trim();
        if (l.startsWith('//') || l.startsWith('*')) return;
        // A day key assembled from local getters, or SQLite's process-zone modifier.
        if (/getFullYear\(\)[\s\S]{0,80}getMonth\(\)/.test(l) || l.includes("'localtime'")) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    // brain/queries.ts groups a TIMELINE by day in SQL. Grouping per row needs
    // the zone inside SQLite, which `'localtime'` cannot be given; it is a
    // chart's bucketing, not an identity anything is stored under. Pinned by
    // name so it stays a known exception rather than becoming the norm.
    expect(offenders).toEqual(['brain/queries.ts:1080']);
  });
});
