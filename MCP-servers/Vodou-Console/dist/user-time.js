/**
 * The one answer, on this side of the seam, to "what timezone is this person in".
 *
 * The engine's half is `src/user_time.rs`; this is its twin, and the two must
 * agree because they name the same days in the same files. Precedence is
 * identical: `VODOU_TZ` (env) → `gateway_settings.user.timezone` → the host zone.
 *
 * Measured 2026-09-10: `user.timezone` was written by onboarding and Settings
 * and read by nothing that computed anything. Every day key came from the
 * PROCESS's zone. On a laptop that is the person's zone and nothing looks
 * wrong; on a server (app.vodou.ai) or a machine that travels, "today" in a
 * filename stops being the person's today, and the engine and the gateway can
 * disagree about which day a memory belongs to — while writing into the same
 * daily file.
 *
 * Use `todayKey()` / `dayKeyOf()` for day identity. For "rows from today",
 * `dayWindowUtc()` gives the naive-UTC half-open range, which is correct across
 * a DST change in a way a fixed offset is not.
 */
import { getSetting } from './db.js';
/** Cached like the engine's: long enough to be free, short enough to notice a change. */
const CACHE_MS = 60_000;
let _cache = null;
function valid(tz) {
    try {
        new Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/** The resolved IANA zone and where it came from. */
export function userZone() {
    if (_cache && Date.now() - _cache.at < CACHE_MS)
        return { zone: _cache.zone, source: _cache.source };
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    let zone = host;
    let source = 'host';
    const env = String(process.env.VODOU_TZ ?? '').trim();
    if (env) {
        // A named zone that does not parse is a typo worth saying out loud, not a
        // silent fall-through to the machine's opinion.
        if (valid(env)) {
            zone = env;
            source = 'VODOU_TZ';
        }
        else
            console.error(`[user-time] VODOU_TZ=${JSON.stringify(env)} is not an IANA zone — falling back`);
    }
    if (source === 'host') {
        let setting = '';
        try {
            setting = String(getSetting('user.timezone') ?? '').trim();
        }
        catch { /* db not open yet */ }
        if (setting && valid(setting)) {
            zone = setting;
            source = 'user.timezone';
        }
        else if (setting)
            console.error(`[user-time] user.timezone=${JSON.stringify(setting)} is not an IANA zone — falling back`);
    }
    _cache = { at: Date.now(), zone, source };
    return { zone, source };
}
/**
 * Minutes to ADD to a wall-clock time in the person's zone to reach UTC.
 * US-Eastern in summer → 240; Tokyo → -540.
 *
 * `Date.prototype.getTimezoneOffset()` answers the same question for the NODE
 * PROCESS's zone, which is the gateway's own opinion and not the person's —
 * the distinction this module exists to make. Anything converting a time
 * somebody typed must come through here.
 */
export function utcOffsetMinutes(at = new Date(), zoneOverride) {
    const zone = zoneOverride || userZone().zone;
    try {
        // `longOffset` renders "GMT-04:00" / "GMT+05:30" / "GMT", and it is
        // computed for `at`, so it is correct on both sides of a DST change rather
        // than tabulated once.
        const named = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
            .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value || '';
        if (named === 'GMT' || named === 'UTC')
            return 0;
        const m = /^(?:GMT|UTC)([+-])(\d{2}):(\d{2})$/.exec(named);
        if (m) {
            const mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
            // A zone WEST of Greenwich reads "GMT-04:00" and needs +240 added to
            // reach UTC. The sign flips.
            // `-mins` is `-0` at a zero offset, and `Object.is(-0, 0)` is false —
            // so a UTC person's offset would compare unequal to zero. Normalise.
            return (m[1] === '-' ? mins : -mins) || 0;
        }
        console.error(`[user-time] could not read an offset for ${JSON.stringify(zone)} (got ${JSON.stringify(named)}) — using this machine's`);
    }
    catch (e) {
        console.error(`[user-time] offset lookup failed for ${JSON.stringify(zone)}: ${e.message} — using this machine's`);
    }
    // Last resort, and it is said out loud above: the process zone, which is what
    // every caller used before this function existed.
    return at.getTimezoneOffset();
}
/** Drop the cached zone — call after writing the setting so the next read is the new value. */
export function invalidateUserZone() { _cache = null; }
/**
 * Wall-clock time in the person's zone, `HH:MM` by default.
 *
 * The alternative — `new Date().toLocaleTimeString(...)` with no `timeZone` —
 * renders in the NODE PROCESS's zone. That is the same number on a laptop and a
 * different one in a container, and it produced a real inconsistency: the pin
 * writer chose its FILENAME with `todayKey()` (the person's day) and its heading
 * with the process clock two lines later, so a pin at 11pm Detroit landed in
 * that day's file under a 03:00 heading.
 */
export function localTime(d = new Date(), opts = {}) {
    const { zone } = userZone();
    return d.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false, ...opts, timeZone: zone,
    });
}
/** `YYYY-MM-DD` for an instant, in the person's zone. */
export function dayKeyOf(d = new Date()) {
    const { zone } = userZone();
    // `en-CA` renders ISO-shaped dates; the alternative is assembling parts by hand.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}
/** The person's today, `YYYY-MM-DD`. */
export function todayKey() { return dayKeyOf(new Date()); }
/** The person's current month, `YYYY-MM`. */
export function monthKey(d = new Date()) { return dayKeyOf(d).slice(0, 7); }
/**
 * A naive-UTC instant string (`YYYY-MM-DD HH:MM:SS`, what SQLite stores) → the
 * person's day. Returns '' for empty, and the leading 10 chars for anything
 * unparseable, so a bad row degrades to something readable rather than throwing.
 */
export function dayKeyOfNaiveUtc(stamp) {
    const s = String(stamp || '');
    if (!s)
        return '';
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
    if (!Number.isFinite(t))
        return s.slice(0, 10);
    return dayKeyOf(new Date(t));
}
/**
 * The half-open naive-UTC window `[start, end)` covering one of the person's
 * days — what a `WHERE created_at >= ? AND created_at < ?` needs.
 *
 * This exists because SQLite's `'localtime'` modifier uses the PROCESS's zone
 * and cannot be told an IANA name, and because a fixed offset is wrong twice a
 * year. The boundaries are computed with the real zone rules and handed to the
 * query as plain strings.
 */
export function dayWindowUtc(dayKey = todayKey()) {
    const { zone } = userZone();
    const utcOf = (key) => {
        const [y, m, d] = key.split('-').map(Number);
        // Midnight in `zone` is some instant; find it by measuring the zone's own
        // offset at roughly that moment and correcting. Two passes settle DST.
        let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
        for (let i = 0; i < 2; i++) {
            const asLocal = new Intl.DateTimeFormat('en-CA', {
                timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
            }).formatToParts(new Date(guess));
            const g = (t) => Number(asLocal.find((p) => p.type === t)?.value ?? 0);
            const shown = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
            guess += Date.UTC(y, m - 1, d, 0, 0, 0) - shown;
        }
        return new Date(guess);
    };
    const naive = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
    const start = utcOf(dayKey);
    const nextKey = dayKeyOf(new Date(start.getTime() + 36 * 3_600_000));
    return { start: naive(start), end: naive(utcOf(nextKey)) };
}
