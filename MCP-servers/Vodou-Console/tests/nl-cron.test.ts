import { describe, it, expect } from 'vitest';
import {
  stripCronArgQuotes,
  validateCronSchedule,
  parseNaturalLanguageCron,
  resolveSkillCronExpression,
} from '../src/api/nl-cron.js';

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
    expect(parseNaturalLanguageCron('daily at 4pm')).toBe('0 16 * * *');
  });
  it('maps weekdays at time', () => {
    expect(parseNaturalLanguageCron('every weekday at 9am')).toBe('0 9 * * 1-5');
  });
  it('maps "once a day" and friends to 9am daily', () => {
    expect(parseNaturalLanguageCron('once a day')).toBe('0 9 * * *');
    expect(parseNaturalLanguageCron('once daily')).toBe('0 9 * * *');
    expect(parseNaturalLanguageCron('each day')).toBe('0 9 * * *');
    expect(parseNaturalLanguageCron('everyday')).toBe('0 9 * * *');
  });
  it('maps "once a day at <time>"', () => {
    expect(parseNaturalLanguageCron('once a day at 7am')).toBe('0 7 * * *');
  });
  it('maps "once an hour" and "once a week"', () => {
    expect(parseNaturalLanguageCron('once an hour')).toBe('0 * * * *');
    expect(parseNaturalLanguageCron('once a week')).toBe('0 9 * * 1');
  });
  it('strips a leading imperative verb', () => {
    expect(parseNaturalLanguageCron('run once a day')).toBe('0 9 * * *');
    expect(parseNaturalLanguageCron('execute every 15 minutes')).toBe('*/15 * * * *');
    expect(parseNaturalLanguageCron('schedule daily at 6am')).toBe('0 6 * * *');
  });
  it('returns null for garbage', () => {
    expect(parseNaturalLanguageCron('whenever i feel like it')).toBeNull();
  });
});

describe('resolveSkillCronExpression', () => {
  it('passes through literal 5-field', () => {
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
    expect(r.cron).toMatch(/^\d+ 12 \* \* \*$/);
    expect(r.nlSource).toBe('every day at noon');
  });
  it('throws on unparseable', () => {
    expect(() => resolveSkillCronExpression('not a schedule')).toThrow(/Could not parse/);
  });
});
