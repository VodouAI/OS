/**
 * "Every day at 9am" is converted against the PERSON's zone, not the gateway's.
 *
 * `nl-cron` converted a typed wall-clock time to a UTC cron with
 * `Date.prototype.getTimezoneOffset()` — the Node process's zone — and labelled
 * the receipt from `Intl.DateTimeFormat().resolvedOptions().timeZone`, the same
 * process's zone. It never consulted `user.timezone`, which is the canonical
 * answer to "what time is it for this person" and the reason `user-time.ts`
 * exists at all.
 *
 * These were the same number for as long as Vodou only ran on one laptop, which
 * is exactly why it went unnoticed: the old code was right by coincidence. In a
 * container the process zone is UTC, so "every day at 9am" would have been
 * stored as `0 9 * * *` and fired at 04:00 for a US-Eastern person — the very
 * failure the SW-19 conversion was written to prevent, reintroduced by the
 * clock it asked.
 *
 * Driven through the real precedence chain (`VODOU_TZ` → `user.timezone` →
 * host) rather than a mocked clock: a test that stubs the resolver proves the
 * stub works.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cronForLocalTime, cronTimezoneLabel, parseNaturalLanguageCron } from '../api/nl-cron.js';
import { utcOffsetMinutes, invalidateUserZone, userZone } from '../user-time.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.resolve(HERE, '../..');
const ORIGINAL_TZ = process.env.VODOU_TZ;
function asZone(tz) {
    if (tz === undefined)
        delete process.env.VODOU_TZ;
    else
        process.env.VODOU_TZ = tz;
    invalidateUserZone();
}
beforeEach(() => asZone(undefined));
afterAll(() => asZone(ORIGINAL_TZ));
// Instants either side of a US daylight-saving boundary.
const SUMMER = new Date('2026-07-01T12:00:00Z');
const WINTER = new Date('2026-01-15T12:00:00Z');
describe('utcOffsetMinutes — minutes to ADD to a local time to reach UTC', () => {
    it('is positive west of Greenwich and negative east of it', () => {
        expect(utcOffsetMinutes(SUMMER, 'America/Detroit')).toBe(240); // EDT, UTC-4
        expect(utcOffsetMinutes(SUMMER, 'Asia/Tokyo')).toBe(-540); // JST, UTC+9
        expect(utcOffsetMinutes(SUMMER, 'UTC')).toBe(0);
    });
    it('follows daylight saving, because it is computed for the instant', () => {
        expect(utcOffsetMinutes(SUMMER, 'America/Detroit')).toBe(240); // EDT
        expect(utcOffsetMinutes(WINTER, 'America/Detroit')).toBe(300); // EST
    });
    it('handles the half-hour zones a tabulated list gets wrong', () => {
        expect(utcOffsetMinutes(SUMMER, 'Asia/Kolkata')).toBe(-330); // UTC+5:30
        expect(utcOffsetMinutes(SUMMER, 'Australia/Adelaide')).toBe(-570); // ACST, UTC+9:30 in July
    });
    it('reads the resolved zone when no override is given', () => {
        asZone('Asia/Tokyo');
        expect(userZone().zone).toBe('Asia/Tokyo');
        expect(utcOffsetMinutes(SUMMER)).toBe(-540);
    });
});
describe('the cron a person gets follows their setting, not the process', () => {
    it('converts 9am against the PERSON’s zone', () => {
        asZone('America/Detroit');
        // 09:00 EDT is 13:00 UTC, same day.
        expect(cronForLocalTime(0, 9, '*', utcOffsetMinutes(SUMMER))).toBe('0 13 * * *');
    });
    it('carries the day-of-week across the midnight the offset crosses', () => {
        asZone('America/Detroit');
        // Monday 21:00 EDT is 01:00 UTC on TUESDAY. Convert the hour alone and the
        // task fires a day early, every week, silently.
        expect(cronForLocalTime(0, 21, '1', utcOffsetMinutes(SUMMER))).toBe('0 1 * * 2');
    });
    it('still shifts when an offset is given — the LEGACY contract', () => {
        // A row with a NULL zone is read as UTC by the engine, so anything writing
        // one must still shift. Passing the offset explicitly is how that is spelled
        // now that the DEFAULT is zero.
        const detroit = cronForLocalTime(0, 9, '*', utcOffsetMinutes(SUMMER, 'America/Detroit'));
        const tokyo = cronForLocalTime(0, 9, '*', utcOffsetMinutes(SUMMER, 'Asia/Tokyo'));
        expect(detroit).toBe('0 13 * * *');
        expect(tokyo).toBe('0 0 * * *');
        expect(detroit).not.toBe(tokyo);
    });
    it('the DEFAULT path reads the setting — the injectable argument proves nothing', () => {
        // Every other case here passes `offsetMinutes` explicitly, which exercises
        // `cronForLocalTime` but NOT the default that feeds it. That default was
        // the broken wiring, and restoring the bug left all of them green. So:
        // drive the whole sentence, twice, and require the answer to move with the
        // setting. Reading the process clock makes these two identical.
        asZone('Asia/Tokyo');
        const tokyo = parseNaturalLanguageCron('every day at 9am');
        asZone('America/Detroit');
        const detroit = parseNaturalLanguageCron('every day at 9am');
        // INVERTED by P2, deliberately. Before, the zone lived IN the string and the
        // two had to differ. Now the zone travels on the row (`timezone = '@user'`),
        // so the stored expression is the same wall clock for everyone — and 9am
        // means 9am wherever the person is. A test that has to be consciously
        // inverted is one nobody updates by reflex.
        expect(detroit).toBe('0 9 * * *');
        expect(tokyo).toBe('0 9 * * *');
        expect(tokyo).toBe(detroit);
    });
    it('the stored expression never depends on the process timezone', () => {
        // The container case, which is the one that was actually broken. It is now
        // answered structurally rather than by arithmetic: nothing is shifted at
        // write time, so the process zone cannot enter the stored string at all.
        for (const z of ['America/Detroit', 'Asia/Tokyo', undefined]) {
            asZone(z);
            expect(parseNaturalLanguageCron('every day at 9am')).toBe('0 9 * * *');
        }
    });
});
describe('the receipt says which clock it used', () => {
    it('names the zone the conversion actually used', () => {
        asZone('Asia/Tokyo');
        const label = cronTimezoneLabel(SUMMER);
        expect(label).toContain('Asia/Tokyo');
        expect(label).toMatch(/UTC[+-]\d{2}:\d{2}/);
    });
    it('says so when the zone is only this machine’s guess', () => {
        // An unset zone is not a bug to hide. A receipt that reads "in
        // America/Detroit" when nobody chose it is indistinguishable from one the
        // person configured — which is the silent host-clock failure, one layer up.
        asZone(undefined);
        if (userZone().source !== 'host')
            return; // a real setting is present here
        expect(cronTimezoneLabel(SUMMER)).toContain("this machine's zone");
    });
    it('does not add that caveat when the zone was chosen', () => {
        asZone('Asia/Tokyo');
        expect(cronTimezoneLabel(SUMMER)).not.toContain("this machine's zone");
    });
});
describe('one clock, one owner', () => {
    it('nl-cron never reads the process clock directly', () => {
        // `user_time` is the only module allowed to ask the machine what zone it is
        // in. A guard in one producer is not a rule, so this is the rule.
        const body = readFileSync(path.join(CONSOLE_ROOT, 'src/api/nl-cron.ts'), 'utf8')
            .split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
        expect(body).not.toContain('getTimezoneOffset');
        expect(body).not.toContain('resolvedOptions');
    });
});
describe('P2 — the stored expression is the wall clock, pinned absolutely', () => {
    // These assertions exist because `tests/nl-cron.test.ts` CANNOT see this
    // change: every clock assertion there compares two callers of the same
    // function, so implementation and expectation move together. Measured
    // 2026-09-12 by applying P2 and running it: 30/30 still passed.
    //
    // So these pin literal strings against a fixed zone. They cannot move with
    // the implementation, which is the entire point.
    it('4pm is stored as 16:00 in every zone, because the zone is not in the string', () => {
        asZone('America/Detroit');
        expect(parseNaturalLanguageCron('daily at 4pm')).toBe('0 16 * * *');
        asZone('Asia/Tokyo');
        expect(parseNaturalLanguageCron('daily at 4pm')).toBe('0 16 * * *');
        asZone(undefined);
        expect(parseNaturalLanguageCron('daily at 4pm')).toBe('0 16 * * *');
    });
    it('a weekday schedule keeps its OWN days — no day-of-week rotation', () => {
        // The day-of-week only ever had to move because the hour crossed midnight
        // during the shift. With nothing shifted, Monday stays Monday.
        asZone('Asia/Tokyo'); // +9: under the old behaviour 9pm Monday became Tuesday
        expect(parseNaturalLanguageCron('every weekday at 9am')).toBe('0 9 * * 1-5');
        expect(parseNaturalLanguageCron('every monday at 9pm')).toBe('0 21 * * 1');
    });
    it('an interval is untouched by any of this', () => {
        asZone('America/Detroit');
        expect(parseNaturalLanguageCron('every 15 minutes')).toBe('*/15 * * * *');
        expect(parseNaturalLanguageCron('once an hour')).toBe('0 * * * *');
    });
});
