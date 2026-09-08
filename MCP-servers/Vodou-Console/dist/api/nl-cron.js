// PLAN-SKILL-CONSOLE-LOOP §17.3 — natural language + validation for /cron.
// Maps common English phrases to 5-field cron; validates with cron-parser (same family as Hermes-style UX).
import { CronExpressionParser } from 'cron-parser';
const DOW = {
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
};
/** Strip matching outer quotes from `/cron "every day at 9am"`. */
export function stripCronArgQuotes(raw) {
    const s = raw.trim();
    if (s.length >= 2) {
        if (s[0] === '"' && s[s.length - 1] === '"')
            return s.slice(1, -1).trim();
        if (s[0] === "'" && s[s.length - 1] === "'")
            return s.slice(1, -1).trim();
    }
    return s;
}
/**
 * Validate expression the Rust scheduler can run: @hourly | @daily | @weekly, or 5–6 field cron.
 */
export function validateCronSchedule(expr) {
    const t = expr.trim();
    if (!t)
        throw new Error('empty schedule');
    if (/^@(hourly|daily|weekly)$/i.test(t))
        return t.toLowerCase();
    CronExpressionParser.parse(t);
    const n = t.split(/\s+/).length;
    if (n !== 5 && n !== 6) {
        throw new Error(`cron must have 5 or 6 fields (or use @hourly / @daily / @weekly); got ${n}`);
    }
    return t;
}
/**
 * SW-19 — a clock time a person typed is LOCAL; the Rust scheduler evaluates
 * cron in UTC. Convert here, at write time, or "every day at 9am" fires at
 * 05:00 for a US-Eastern user.
 *
 * The evidence this was real: the live tasks carry hand-shifted crons —
 * `5 13 * * *` is somebody having worked out that 09:05 Eastern is 13:05 UTC
 * and typed the UTC. Every one of those is a person compensating for this bug
 * by hand, once, and getting it wrong the next time DST moves.
 *
 * Only clock-anchored schedules are converted. `*'/'15 * * * *` and
 * `0 *'/'6 * * *` name an interval, not a time of day, and shifting them would
 * change the interval rather than the wall-clock moment.
 *
 * **The day-of-week has to move with the hour.** "Every Monday at 9pm" in
 * US-Eastern is 01:00 UTC on TUESDAY — convert the hour alone and the task
 * fires a day early, every week, silently. That is the part worth testing.
 *
 * **DST is a known limit, not an oversight.** A 5-field cron has nowhere to put
 * a timezone, so the offset used is the one in effect NOW; after a DST change
 * the task fires an hour off until it is re-saved. That is exactly the flaw the
 * hand-shifted crons already had — the difference is that it is now written
 * down and labelled instead of being a surprise. Fixing it properly needs a
 * per-task IANA zone on `scheduled_tasks`, which is a schema change and a
 * migration; filed rather than smuggled in here.
 *
 * **Tasks created before this are left exactly as they are.** A stored cron is
 * already UTC and already running at whatever moment its author intended, so
 * rewriting them would move live schedules without being asked. The cost is
 * that an old "every day at 9am" still fires at 05:00 while a new one fires at
 * 09:00 — visible in the schedule list, fixed by re-saving that task, and not
 * something this code should do to somebody's calendar on its own.
 */
/** Minutes to ADD to a local wall-clock time to get UTC (EDT → 240). */
function localToUtcOffsetMinutes(at = new Date()) {
    return at.getTimezoneOffset();
}
/** Rotate one day-of-week field by whole days, keeping `*` as `*`. */
export function shiftDowField(dow, days) {
    const f = dow.trim();
    if (days === 0 || f === '*' || f === '?')
        return f;
    const rot = (n) => (((n + days) % 7) + 7) % 7;
    const out = [];
    for (const part of f.split(',')) {
        const range = /^(\d)\s*-\s*(\d)$/.exec(part.trim());
        if (range) {
            // Expanded to a list rather than a shifted range: a range that
            // crosses Sunday (`5-6` shifted +2) is not expressible as `a-b`,
            // and emitting one anyway would silently drop days.
            let [a, b] = [parseInt(range[1], 10), parseInt(range[2], 10)];
            if (a > b)
                [a, b] = [b, a];
            for (let d = a; d <= b; d++)
                out.push(rot(d));
            continue;
        }
        const n = parseInt(part.trim(), 10);
        if (Number.isNaN(n))
            return f; // something we do not understand — leave it alone
        out.push(rot(n));
    }
    const uniq = [...new Set(out)].sort((x, y) => x - y);
    // Re-collapse a contiguous run so the common case still reads as `1-5`.
    const contiguous = uniq.length > 2 && uniq.every((v, i) => i === 0 || v === uniq[i - 1] + 1);
    return contiguous ? `${uniq[0]}-${uniq[uniq.length - 1]}` : uniq.join(',');
}
/**
 * Build a 5-field cron from a LOCAL time of day, in UTC, with the day-of-week
 * carried across any midnight the offset crosses.
 */
export function cronForLocalTime(min, hour, dow, 
/**
 * Minutes to ADD to local to reach UTC. Injectable so the conversion can be
 * tested at a fixed offset: reading the process timezone would make these
 * assertions pass on the author's machine and fail in CI, which runs UTC —
 * exactly the class of bug this function exists to fix.
 */
offsetMinutes = localToUtcOffsetMinutes()) {
    const total = hour * 60 + min + offsetMinutes;
    const dayShift = Math.floor(total / 1440);
    const norm = ((total % 1440) + 1440) % 1440;
    return `${norm % 60} ${Math.floor(norm / 60)} * * ${shiftDowField(dow, dayShift)}`;
}
/** How to describe a converted schedule to the person who typed it. */
export function cronTimezoneLabel(at = new Date()) {
    const off = -localToUtcOffsetMinutes(at); // conventional sign: EDT → -240
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const hhmm = `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
    let zone = `UTC${sign}${hhmm}`;
    try {
        const named = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (named)
            zone = `${named} (UTC${sign}${hhmm})`;
    }
    catch { /* fall back to the numeric offset */ }
    return zone;
}
/**
 * English-ish schedule → 5-field cron. Returns null if unrecognized.
 */
export function parseNaturalLanguageCron(input) {
    // Drop a leading imperative verb so "run once a day" / "execute every 15
    // minutes" parse the same as the bare phrase.
    const s = input
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^(?:run|runs|running|execute|fire|trigger|schedule|please)\s+/, '')
        .trim();
    if (!s)
        return null;
    let m;
    m = /^every (\d{1,2}) minutes?$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 59)
            return `*/${n} * * * *`;
        return null;
    }
    m = /^every (\d{1,2}) hours?$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 23)
            return `0 */${n} * * *`;
        return null;
    }
    if (['hourly', 'every hour', 'once an hour', 'once hourly'].includes(s))
        return '0 * * * *';
    // "daily" means 9am to a person, and 9am is local — same conversion as an
    // explicit "at 9am".
    if (['daily', 'every day', 'everyday', 'each day', 'once a day', 'once daily', 'once per day'].includes(s)) {
        return cronForLocalTime(0, 9, '*');
    }
    if (['weekly', 'every week', 'once a week', 'once weekly', 'once per week'].includes(s))
        return cronForLocalTime(0, 9, '1');
    m = /^(?:every day|daily|everyday|each day|once a day|once daily) at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '*') : null;
    }
    m = /^at (.+?) (?:every day|daily|each day)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '*') : null;
    }
    m = /^(?:every )?weekdays? at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '1-5') : null;
    }
    m = /^at (.+?) (?:on )?weekdays?$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '1-5') : null;
    }
    m = /^(?:mon|monday)\s*-\s*(?:fri|friday) at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '1-5') : null;
    }
    m = /^(?:every )?weekends? at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '0,6') : null;
    }
    m = /^at (.+?) (?:on )?weekends?$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? cronForLocalTime(tm.m, tm.h, '0,6') : null;
    }
    m = /^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? cronForLocalTime(tm.m, tm.h, String(dow)) : null;
    }
    m = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? cronForLocalTime(tm.m, tm.h, String(dow)) : null;
    }
    m = /^weekly on (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? cronForLocalTime(tm.m, tm.h, String(dow)) : null;
    }
    return null;
}
export function resolveSkillCronExpression(raw) {
    const arg = stripCronArgQuotes(raw.trim());
    if (!arg)
        throw new Error('Missing schedule. Examples: `0 9 * * *`, `@hourly`, or `every weekday at 9am`.');
    if (/^@(hourly|daily|weekly)$/i.test(arg)) {
        const c = validateCronSchedule(arg);
        return { cron: c, nlSource: null };
    }
    const fieldCount = arg.split(/\s+/).length;
    if (fieldCount === 5 || fieldCount === 6) {
        validateCronSchedule(arg);
        return { cron: arg, nlSource: null };
    }
    const nl = parseNaturalLanguageCron(arg);
    if (nl) {
        validateCronSchedule(nl);
        return { cron: nl, nlSource: arg };
    }
    throw new Error(`Could not parse schedule. Use 5-field cron, @hourly / @daily / @weekly, or English ` +
        `(e.g. \`every weekday at 9am\`, \`daily at 4pm\`, \`every 15 minutes\`).`);
}
function parseTimeOfDay(t) {
    const raw = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (raw === 'midnight')
        return { h: 0, m: 0 };
    if (raw === 'noon')
        return { h: 12, m: 0 };
    const nospace = raw.replace(/\s/g, '');
    let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(nospace);
    if (m) {
        let hour = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        const ap = m[3];
        if (hour < 1 || hour > 12 || min > 59)
            return null;
        if (ap === 'pm' && hour !== 12)
            hour += 12;
        if (ap === 'am' && hour === 12)
            hour = 0;
        return { h: hour, m: min };
    }
    m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (m) {
        const hour = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (hour <= 23 && min <= 59)
            return { h: hour, m: min };
        return null;
    }
    m = /^(\d{1,2})$/.exec(raw);
    if (m) {
        const hour = parseInt(m[1], 10);
        if (hour <= 23)
            return { h: hour, m: 0 };
    }
    return null;
}
