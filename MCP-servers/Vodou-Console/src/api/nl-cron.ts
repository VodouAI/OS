// PLAN-SKILL-CONSOLE-LOOP §17.3 — natural language + validation for /cron.
// Maps common English phrases to 5-field cron; validates with cron-parser (same family as Hermes-style UX).

import { CronExpressionParser } from 'cron-parser';

const DOW: Record<string, string> = {
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
};

/** Strip matching outer quotes from `/cron "every day at 9am"`. */
export function stripCronArgQuotes(raw: string): string {
    const s = raw.trim();
    if (s.length >= 2) {
        if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).trim();
        if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).trim();
    }
    return s;
}

/**
 * Validate expression the Rust scheduler can run: @hourly | @daily | @weekly, or 5–6 field cron.
 */
export function validateCronSchedule(expr: string): string {
    const t = expr.trim();
    if (!t) throw new Error('empty schedule');
    if (/^@(hourly|daily|weekly)$/i.test(t)) return t.toLowerCase();

    CronExpressionParser.parse(t);
    const n = t.split(/\s+/).length;
    if (n !== 5 && n !== 6) {
        throw new Error(`cron must have 5 or 6 fields (or use @hourly / @daily / @weekly); got ${n}`);
    }
    return t;
}

/**
 * English-ish schedule → 5-field cron. Returns null if unrecognized.
 */
export function parseNaturalLanguageCron(input: string): string | null {
    // Drop a leading imperative verb so "run once a day" / "execute every 15
    // minutes" parse the same as the bare phrase.
    const s = input
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^(?:run|runs|running|execute|fire|trigger|schedule|please)\s+/, '')
        .trim();
    if (!s) return null;

    let m: RegExpExecArray | null;

    m = /^every (\d{1,2}) minutes?$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 59) return `*/${n} * * * *`;
        return null;
    }

    m = /^every (\d{1,2}) hours?$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 23) return `0 */${n} * * *`;
        return null;
    }

    if (['hourly', 'every hour', 'once an hour', 'once hourly'].includes(s)) return '0 * * * *';

    if (['daily', 'every day', 'everyday', 'each day', 'once a day', 'once daily', 'once per day'].includes(s)) {
        return '0 9 * * *';
    }

    if (['weekly', 'every week', 'once a week', 'once weekly', 'once per week'].includes(s)) return '0 9 * * 1';

    m = /^(?:every day|daily|everyday|each day|once a day|once daily) at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * *` : null;
    }

    m = /^at (.+?) (?:every day|daily|each day)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * *` : null;
    }

    m = /^(?:every )?weekdays? at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * 1-5` : null;
    }

    m = /^at (.+?) (?:on )?weekdays?$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * 1-5` : null;
    }

    m = /^(?:mon|monday)\s*-\s*(?:fri|friday) at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * 1-5` : null;
    }

    m = /^(?:every )?weekends? at (.+)$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * 0,6` : null;
    }

    m = /^at (.+?) (?:on )?weekends?$/.exec(s);
    if (m) {
        const tm = parseTimeOfDay(m[1]);
        return tm ? `${tm.m} ${tm.h} * * 0,6` : null;
    }

    m = /^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? `${tm.m} ${tm.h} * * ${dow}` : null;
    }

    m = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? `${tm.m} ${tm.h} * * ${dow}` : null;
    }

    m = /^weekly on (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (.+)$/.exec(s);
    if (m) {
        const dow = DOW[m[1]];
        const tm = parseTimeOfDay(m[2]);
        return dow !== undefined && tm ? `${tm.m} ${tm.h} * * ${dow}` : null;
    }

    return null;
}

export function resolveSkillCronExpression(raw: string): { cron: string; nlSource: string | null } {
    const arg = stripCronArgQuotes(raw.trim());
    if (!arg) throw new Error('Missing schedule. Examples: `0 9 * * *`, `@hourly`, or `every weekday at 9am`.');

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

    throw new Error(
        `Could not parse schedule. Use 5-field cron, @hourly / @daily / @weekly, or English ` +
            `(e.g. \`every weekday at 9am\`, \`daily at 4pm\`, \`every 15 minutes\`).`,
    );
}

function parseTimeOfDay(t: string): { h: number; m: number } | null {
    const raw = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (raw === 'midnight') return { h: 0, m: 0 };
    if (raw === 'noon') return { h: 12, m: 0 };

    const nospace = raw.replace(/\s/g, '');

    let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(nospace);
    if (m) {
        let hour = parseInt(m[1], 10);
        const min = parseInt(m[2] || '0', 10);
        const ap = m[3];
        if (hour < 1 || hour > 12 || min > 59) return null;
        if (ap === 'pm' && hour !== 12) hour += 12;
        if (ap === 'am' && hour === 12) hour = 0;
        return { h: hour, m: min };
    }

    m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (m) {
        const hour = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (hour <= 23 && min <= 59) return { h: hour, m: min };
        return null;
    }

    m = /^(\d{1,2})$/.exec(raw);
    if (m) {
        const hour = parseInt(m[1], 10);
        if (hour <= 23) return { h: hour, m: 0 };
    }

    return null;
}
