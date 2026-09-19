/**
 * THE GATE: no view renders a time on the browser's clock.
 *
 * The engine resolves schedules in `user.timezone`; the screen did not. Every
 * `toLocale*String` in `public/js` rendered in the BROWSER's zone, and
 * `next ${task.nextRunAt}` rendered a raw UTC ISO string — so a person with
 * their zone set to America/Detroit, opening the console from a machine on UTC,
 * saw one time while the scheduler fired at another. Worst on the Scheduler
 * page, which exists to answer exactly that question.
 *
 * ## Why this gate checks FOUR idioms
 *
 * The first audit counted one — `toLocale{Time,Date}String` — and reported "40
 * sites in 6 files". Measuring properly gave a different answer in BOTH
 * directions: 17 of those 40 were `.toLocaleString()` on a NUMBER (thousands
 * separators, no clock involved), and three whole idioms were invisible to that
 * grep:
 *
 *   A  toLocale{Time,Date}String          14
 *   B  toLocaleString() on a date          8
 *   C  a named helper (fmtDate, formatDate, timeAgo)   16 calls, 3 definitions
 *   D  raw ISO interpolation — `next ${a.nextRunAt}`    2 genuinely raw
 *
 * A gate that knows one idiom certifies a tree that still gets the time wrong,
 * which is worse than no gate. So this one knows all four, and says so.
 *
 * `timeAgo` is deliberately NOT flagged: a duration has no timezone.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../../public/js');
const OWNER = 'time-format.js';
function jsFiles(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) {
            if (e === 'classic')
                continue; // a frozen legacy bundle with its own copies
            jsFiles(p, out);
        }
        else if (e.endsWith('.js') && e !== OWNER) {
            out.push(p);
        }
    }
    return out;
}
const codeLines = (file) => readFileSync(file, 'utf8')
    .split('\n')
    .map((l, i) => [l.trim(), i + 1])
    .filter(([l]) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
describe('every rendered time is on the person’s clock', () => {
    it('idiom A+B — no toLocale date/time render without an explicit zone', () => {
        const offenders = [];
        for (const f of jsFiles(JS)) {
            for (const [l, n] of codeLines(f)) {
                if (l.includes('timeZone'))
                    continue;
                const isDateRender = l.includes('toLocaleTimeString') ||
                    l.includes('toLocaleDateString') ||
                    /(new Date\([^)]*\)|\bd\b|\bts\b|\biso\b|At|_at)\s*\.toLocaleString\(/i.test(l);
                if (isDateRender)
                    offenders.push(`${path.relative(JS, f)}:${n}  ${l.slice(0, 88)}`);
            }
        }
        expect(offenders, 'Render through `window.VodouTime` (time/date/dateTime/full/ago):\n  ' +
            offenders.join('\n  ')).toEqual([]);
    });
    it('idiom D — no raw timestamp interpolated straight into markup', () => {
        // Invisible to any `toLocale` grep. `skills.js` printed `next ${a.nextRunAt}`
        // — a raw UTC ISO string — on a page about when things run.
        const offenders = [];
        const raw = /\$\{\s*[a-zA-Z_$][\w.$]*\.(nextRunAt|lastRunAt|next_run_at|last_run_at|created_at|createdAt)\s*\}/;
        for (const f of jsFiles(JS)) {
            for (const [l, n] of codeLines(f)) {
                if (raw.test(l))
                    offenders.push(`${path.relative(JS, f)}:${n}  ${l.slice(0, 88)}`);
            }
        }
        expect(offenders, 'A stored instant is UTC; interpolating it prints UTC:\n  ' +
            offenders.join('\n  ')).toEqual([]);
    });
    it('idiom C — a helper that builds a date from browser-local parts', () => {
        // `getFullYear`/`getMonth`/`getDate` read the BROWSER's calendar day. Near
        // midnight that is a different day, which mislabels a memory.
        const offenders = [];
        for (const f of jsFiles(JS)) {
            for (const [l, n] of codeLines(f)) {
                if (/\.getFullYear\(\)/.test(l) && /\.getMonth\(\)|\.getDate\(\)/.test(l)) {
                    offenders.push(`${path.relative(JS, f)}:${n}  ${l.slice(0, 88)}`);
                }
            }
        }
        expect(offenders, 'Build the day through `VodouTime`, not from local parts:\n  ' +
            offenders.join('\n  ')).toEqual([]);
    });
    it('idiom E — a day compared on the browser clock', () => {
        // `toDateString()` names the BROWSER's calendar day. Four idioms did not see
        // it, so "is this today?" stayed on the browser's clock in three views while
        // the time beside it rendered on the person's (found 2026-09-14: History,
        // the Home summary, the scheduled-row hint). Near midnight, with the two
        // zones apart, that labels an entry with the wrong day.
        const offenders = [];
        for (const f of jsFiles(JS)) {
            for (const [l, n] of codeLines(f)) {
                if (l.includes('.toDateString()'))
                    offenders.push(`${path.relative(JS, f)}:${n}  ${l.slice(0, 88)}`);
            }
        }
        expect(offenders, 'Compare days through `VodouTime.dayKey` / `dayLabel`:\n  ' +
            offenders.join('\n  ')).toEqual([]);
    });
    it('the gate can see each idiom it claims to cover', () => {
        // A source gate's characteristic failure is finding nothing and calling it
        // agreement. These are the REAL lines that were live until 2026-09-12
        // (E: until 2026-09-14).
        const wasLive = {
            A: "return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit' });",
            B: "const created = new Date(item.created_at).toLocaleString();",
            D: 'if (a.nextRunAt) bits.push(`next ${a.nextRunAt}`);',
            C: "return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;",
            E: 'if (d.toDateString() === now.toDateString()) {',
        };
        const raw = /\$\{\s*[a-zA-Z_$][\w.$]*\.(nextRunAt|lastRunAt|next_run_at|last_run_at|created_at|createdAt)\s*\}/;
        expect(wasLive.A.includes('toLocaleTimeString')).toBe(true);
        expect(/(new Date\([^)]*\))\s*\.toLocaleString\(/.test(wasLive.B)).toBe(true);
        expect(raw.test(wasLive.D)).toBe(true);
        expect(/\.getFullYear\(\)/.test(wasLive.C) && /\.getDate\(\)/.test(wasLive.C)).toBe(true);
        expect(wasLive.E.includes('.toDateString()')).toBe(true);
        // …and must NOT fire on a number or on a duration, which is what keeps it
        // credible enough not to be bypassed.
        expect(/(new Date\([^)]*\)|\bd\b|\bts\b)\s*\.toLocaleString\(/i.test('n.toLocaleString()')).toBe(false);
        expect(raw.test('const m = Math.round((Date.now() - t) / 60000);')).toBe(false);
    });
    it('the owner exists and is loaded before any view', () => {
        const html = readFileSync(path.resolve(JS, '../index.html'), 'utf8');
        const mod = html.indexOf('/js/time-format.js');
        expect(mod, 'time-format.js is not loaded at all').toBeGreaterThan(-1);
        for (const v of ['/js/views/scheduler.js', '/js/views/chat.js', '/js/views/memory.js']) {
            expect(mod, `loaded after ${v}`).toBeLessThan(html.indexOf(v));
        }
    });
});
describe('a day is decided on the person’s clock', () => {
    // time-format.js is a browser script: evaluate it, and pin the zone the way
    // init() would once /api/profile answers.
    const load = (zone) => {
        const src = readFileSync(path.resolve(JS, OWNER), 'utf8');
        // eslint-disable-next-line no-new-func
        const vt = new Function(`${src}\nreturn VodouTime;`)();
        vt._zone = zone;
        return vt;
    };
    it('one instant is a different day in different zones', () => {
        const lateSunday = '2026-09-14T03:30:00Z'; // 23:30 Sun in New York
        expect(load('America/New_York').dayKey(lateSunday)).toBe('2026-09-13');
        expect(load('UTC').dayKey(lateSunday)).toBe('2026-09-14');
    });
    it('Today and Yesterday follow the zone, not the machine', () => {
        const now = new Date('2026-09-14T04:30:00Z'); // 00:30 Mon in New York
        const lateSunday = '2026-09-14T03:30:00Z';
        expect(load('America/New_York').dayLabel(lateSunday, now)).toBe('Yesterday');
        expect(load('UTC').dayLabel(lateSunday, now)).toBe('Today');
        expect(load('America/New_York').dayLabel('2026-09-10T15:00:00Z', now)).toBe('');
    });
    it('Yesterday is the calendar day before, even across a DST change', () => {
        // 2026-03-08 is 23 hours long in New York. At 00:30 on Mar 9, `now - 24h`
        // is 23:30 on Mar 7 — which would call Mar 7 "yesterday".
        const vt = load('America/New_York');
        const now = new Date('2026-03-09T04:30:00Z'); // 00:30 EDT Mon Mar 9
        expect(vt.dayLabel('2026-03-08T05:30:00Z', now)).toBe('Yesterday'); // 00:30 EST Mar 8
        expect(vt.dayLabel('2026-03-08T04:30:00Z', now)).toBe(''); // 23:30 EST Mar 7
    });
});
describe('the renderer is actually fed', () => {
    it('/api/profile serves the RESOLVED zone, not just the raw setting', async () => {
        // `time-format.js` asks for `resolvedZone`/`resolvedSource`. Without them it
        // silently falls back to the browser's clock — which is the old behaviour,
        // so nothing looks broken and every rendered time is quietly wrong again.
        //
        // This exists because that is what happened: the P7 edit adding these fields
        // was written by a script with NO assertion, its anchor did not match, it
        // printed success, and the change was never made. The suite was green
        // because nothing tested the endpoint — only that the module existed and was
        // loaded. Caught by driving the live gateway after deploying.
        const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../api/profile.ts'), 'utf8');
        expect(src, 'GET /api/profile must serve resolvedZone').toContain('resolvedZone: userZone().zone');
        expect(src, 'and resolvedSource, so the UI can tell chosen from guessed')
            .toContain('resolvedSource: userZone().source');
        // …and the consumer must still be asking for exactly those names.
        const fmt = readFileSync(path.resolve(JS, 'time-format.js'), 'utf8');
        expect(fmt).toContain('d.resolvedZone');
        expect(fmt).toContain('d.resolvedSource');
    });
});
