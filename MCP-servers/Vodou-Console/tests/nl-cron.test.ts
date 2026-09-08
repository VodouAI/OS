import { describe, it, expect } from 'vitest';
import {
  stripCronArgQuotes,
  validateCronSchedule,
  parseNaturalLanguageCron,
  resolveSkillCronExpression,
  cronForLocalTime,
  shiftDowField,
  cronTimezoneLabel,
} from '../src/api/nl-cron.js';

/**
 * SW-19 — a clock time a person types is LOCAL; the scheduler evaluates cron in
 * UTC. These assertions used to encode the bug: "every day at 9am" was expected
 * to produce `0 9 * * *`, which fires at 05:00 for a US-Eastern user.
 *
 * The NL cases below are written against the machine's ACTUAL offset, so they
 * hold on a developer laptop and in CI (which runs UTC, where the conversion is
 * a no-op and the old expectations happen to be right). The conversion itself
 * is pinned at fixed offsets further down, where nothing depends on where the
 * test runs.
 */
const OFFSET = new Date().getTimezoneOffset();     // minutes to ADD to local → UTC
const utcHour = (localHour: number) => ((((localHour * 60 + OFFSET) % 1440) + 1440) % 1440) / 60 | 0;

describe('stripCronArgQuotes', () => {
  it('strips double quotes', () => {
    expect(stripCronArgQuotes('"every day at 9am"')).toBe('every day at 9am');
  });
  it('strips single quotes', () => {
    expect(stripCronArgQuotes("'@hourly'")).toBe('@hourly');
  });
  it('leaves unquoted', () => {
    expect(stripCronArgQuotes('0 9 * * *')).toBe('0 9 * * *');
  });
});

describe('validateCronSchedule', () => {
  it('accepts @hourly / @daily / @weekly', () => {
    expect(validateCronSchedule('@hourly')).toBe('@hourly');
    expect(validateCronSchedule('@DAILY')).toBe('@daily');
  });
  it('accepts 5-field cron', () => {
    expect(validateCronSchedule('0 9 * * *')).toBe('0 9 * * *');
  });
  it('rejects empty', () => {
    expect(() => validateCronSchedule('')).toThrow(/empty/);
  });
});

describe('parseNaturalLanguageCron', () => {
  it('maps every N minutes', () => {
    expect(parseNaturalLanguageCron('every 15 minutes')).toBe('*/15 * * * *');
  });
  it('maps daily at time', () => {
    expect(parseNaturalLanguageCron('daily at 4pm')).toBe(cronForLocalTime(0, 16, '*'));
  });
  it('maps weekdays at time', () => {
    expect(parseNaturalLanguageCron('every weekday at 9am')).toBe(cronForLocalTime(0, 9, '1-5'));
  });
  it('maps "once a day" and friends to 9am daily', () => {
    expect(parseNaturalLanguageCron('once a day')).toBe(cronForLocalTime(0, 9, '*'));
    expect(parseNaturalLanguageCron('once daily')).toBe(cronForLocalTime(0, 9, '*'));
    expect(parseNaturalLanguageCron('each day')).toBe(cronForLocalTime(0, 9, '*'));
    expect(parseNaturalLanguageCron('everyday')).toBe(cronForLocalTime(0, 9, '*'));
  });
  it('maps "once a day at <time>"', () => {
    expect(parseNaturalLanguageCron('once a day at 7am')).toBe(cronForLocalTime(0, 7, '*'));
  });
  it('maps "once an hour" and "once a week"', () => {
    expect(parseNaturalLanguageCron('once an hour')).toBe('0 * * * *');
    expect(parseNaturalLanguageCron('once a week')).toBe(cronForLocalTime(0, 9, '1'));
  });
  it('strips a leading imperative verb', () => {
    expect(parseNaturalLanguageCron('run once a day')).toBe(cronForLocalTime(0, 9, '*'));
    expect(parseNaturalLanguageCron('execute every 15 minutes')).toBe('*/15 * * * *');
    expect(parseNaturalLanguageCron('schedule daily at 6am')).toBe(cronForLocalTime(0, 6, '*'));
  });
  it('returns null for garbage', () => {
    expect(parseNaturalLanguageCron('whenever i feel like it')).toBeNull();
  });
});

describe('resolveSkillCronExpression', () => {
  it('passes through literal 5-field UNCONVERTED', () => {
    // A person who types a cron expression has already decided what the fields
    // mean. Only English phrases carry an implied local clock, so only they are
    // converted — silently shifting a hand-written cron would be a new bug in
    // the shape of the old one.
    const r = resolveSkillCronExpression('30 14 * * *');
    expect(r.cron).toBe('30 14 * * *');
    expect(r.nlSource).toBeNull();
  });
  it('resolves NL and sets nlSource', () => {
    const r = resolveSkillCronExpression('every hour');
    expect(r.cron).toBe('0 * * * *');
    expect(r.nlSource).toBe('every hour');
  });
  it('strips quotes before NL', () => {
    const r = resolveSkillCronExpression('"every day at noon"');
    expect(r.cron).toBe(cronForLocalTime(0, 12, '*'));
    expect(r.nlSource).toBe('every day at noon');
  });
  it('throws on unparseable', () => {
    expect(() => resolveSkillCronExpression('not a schedule')).toThrow(/Could not parse/);
  });
});


/**
 * SW-19 — the conversion, pinned at fixed offsets so nothing here depends on
 * where the test runs. The live tasks carried hand-shifted crons (`5 13 * * *`
 * is 09:05 US-Eastern written out by hand), which is what a person does when
 * the product will not do it for them — and gets wrong the next time DST moves.
 */
describe('cronForLocalTime — local clock to a UTC cron', () => {
  const EDT = 240;    // UTC-4, minutes to ADD to local
  const IST = -330;   // UTC+5:30
  const CET = -60;    // UTC+1
  const UTC = 0;

  it('shifts the hour by the offset', () => {
    expect(cronForLocalTime(0, 9, '*', EDT)).toBe('0 13 * * *');
    expect(cronForLocalTime(5, 9, '*', EDT)).toBe('5 13 * * *');   // the hand-shifted live task
    expect(cronForLocalTime(0, 9, '*', CET)).toBe('0 8 * * *');
  });

  it('is a no-op at UTC, so a UTC install is unchanged', () => {
    expect(cronForLocalTime(30, 14, '*', UTC)).toBe('30 14 * * *');
    expect(cronForLocalTime(0, 9, '1-5', UTC)).toBe('0 9 * * 1-5');
  });

  it('handles a half-hour offset', () => {
    expect(cronForLocalTime(0, 9, '*', IST)).toBe('30 3 * * *');
  });

  // THE ONE THAT MATTERS. Convert the hour alone and a weekly task fires a full
  // day early, every week, and nothing says so.
  it('carries the day-of-week across midnight', () => {
    // Monday 9pm US-Eastern is 01:00 UTC on TUESDAY.
    expect(cronForLocalTime(0, 21, '1', EDT)).toBe('0 1 * * 2');
    // Sunday 11pm Eastern rolls to Monday.
    expect(cronForLocalTime(0, 23, '0', EDT)).toBe('0 3 * * 1');
    // And backwards: Monday 00:30 in CET is Sunday 23:30 UTC.
    expect(cronForLocalTime(30, 0, '1', CET)).toBe('30 23 * * 0');
  });

  it('moves every day in a range or a list, not just the first', () => {
    expect(cronForLocalTime(0, 21, '1-5', EDT)).toBe('0 1 * * 2-6');
    expect(cronForLocalTime(0, 21, '0,6', EDT)).toBe('0 1 * * 0,1');
  });

  it('leaves `*` alone — every day is still every day', () => {
    expect(cronForLocalTime(0, 21, '*', EDT)).toBe('0 1 * * *');
  });
});

describe('shiftDowField', () => {
  it('is identity for a zero shift', () => {
    expect(shiftDowField('1-5', 0)).toBe('1-5');
    expect(shiftDowField('*', 3)).toBe('*');
  });

  it('wraps around the week in both directions', () => {
    expect(shiftDowField('6', 1)).toBe('0');
    expect(shiftDowField('0', -1)).toBe('6');
  });

  it('expands a range that would wrap, instead of emitting an impossible one', () => {
    // 5-6 shifted +2 is Sunday and Monday: `0,1`, never `0-1` reversed or `7-8`.
    expect(shiftDowField('5-6', 2)).toBe('0,1');
  });

  it('re-collapses a contiguous run so the common case still reads as a range', () => {
    expect(shiftDowField('1-5', 1)).toBe('2-6');
  });

  it('leaves a field it does not understand untouched rather than guessing', () => {
    expect(shiftDowField('MON-FRI', 1)).toBe('MON-FRI');
  });
});

describe('cronTimezoneLabel', () => {
  it('names a zone and a signed offset, so the stored UTC cron is explainable', () => {
    expect(cronTimezoneLabel()).toMatch(/UTC[+-]\d{2}:\d{2}/);
  });
});
