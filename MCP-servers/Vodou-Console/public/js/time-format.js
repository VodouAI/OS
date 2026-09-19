/**
 * Every rendered time, on the PERSON's clock.
 *
 * The engine resolves schedules in `user.timezone` (migration 102,
 * PLAN-ONE-CLOCK). The screen did not: every `toLocale*String` call in this tree
 * rendered in the BROWSER's zone, and `next ${task.nextRunAt}` rendered a raw
 * UTC ISO string. So a person with their zone set to America/Detroit, opening
 * the console from a machine on UTC, saw one time while the scheduler fired at
 * another — worst of all on the Scheduler page, which exists to answer exactly
 * that question.
 *
 * Audited 2026-09-12 across `public/js` (excluding the frozen `classic/`):
 * 14 `toLocale{Time,Date}String`, 8 `toLocaleString()` on a date, 7 raw ISO
 * interpolations, and 16 calls to three named helpers. This module is the one
 * place any of it is spelled now.
 *
 * ## The zone, and why the fallback is the browser
 *
 * `user.timezone` is authoritative when the person set one. When they have not,
 * the resolved source is `host` — the SERVER's guess — and the browser's own
 * zone is a better guess than the server's, because the person is sitting in
 * front of it. So: chosen zone if there is one, else the browser.
 *
 * Loads asynchronously and renders correctly before it arrives: with no zone
 * yet, `Intl` uses the browser's, which is what the old code did anyway. There
 * is no moment where this is worse than what it replaces.
 */
const VodouTime = {
  _zone: null,        // the person's chosen zone, or null for "use the browser"
  _source: 'host',
  _loading: null,

  /** Ask the gateway once. Safe to call repeatedly; safe never to call. */
  async init() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      try {
        const r = await fetch('/api/profile');
        if (!r.ok) return;
        const d = await r.json();
        // `resolvedZone` is what the ENGINE would use — not the raw setting —
        // so the screen and the scheduler answer from the same value.
        if (d && d.resolvedZone) {
          this._source = d.resolvedSource || 'host';
          this._zone = this._source === 'host' ? null : d.resolvedZone;
        }
      } catch (_) { /* the browser zone remains, which is the old behaviour */ }
    })();
    return this._loading;
  },

  /** The zone to render in, or `undefined` to let Intl use the browser's. */
  zone() { return this._zone || undefined; },

  /** True when the person actually chose a zone. */
  isChosen() { return this._source !== 'host'; },

  /** Coerce anything the API hands us into a Date, or null. */
  _d(v) {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  },

  _fmt(v, opts, fallback) {
    const d = this._d(v);
    if (!d) return fallback;
    try { return d.toLocaleString('en-US', { ...opts, timeZone: this.zone() }); }
    catch (_) { return d.toLocaleString('en-US', opts); }
  },

  /** `14:05` */
  time(v, fallback = '') {
    return this._fmt(v, { hour: '2-digit', minute: '2-digit' }, fallback);
  },
  /** `Sep 15` */
  date(v, fallback = '') {
    return this._fmt(v, { month: 'short', day: 'numeric' }, fallback);
  },
  /** `Mon, Sep 15, 14:05` */
  dateTime(v, fallback = '') {
    return this._fmt(v, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }, fallback);
  },
  /** Full, for a provenance line. */
  full(v, fallback = '') {
    return this._fmt(v, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }, fallback);
  },

  /**
   * `2026-09-14` — the CALENDAR DAY an instant falls on, on the person's clock.
   *
   * "Is this today?" is a day comparison, and a day only exists in a zone.
   * `d.toDateString() === now.toDateString()` answers it on the BROWSER's clock
   * while the time beside it renders on the person's — so with the two zones
   * apart, an entry near midnight was labelled with one day and shown at an
   * hour belonging to another (logs.js, found 2026-09-14).
   */
  dayKey(v) {
    const d = this._d(v);
    if (!d) return '';
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
    let parts;
    try { parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: this.zone() }).formatToParts(d); }
    catch (_) { parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(d); }
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  },

  /**
   * `Today` / `Yesterday` on the person's clock, or '' for any other day.
   *
   * Yesterday is calendar arithmetic on the day KEY, never `now - 24h`: across a
   * DST change a day is 23 or 25 hours long, and 24 hours back from 00:30 lands
   * two days ago.
   */
  dayLabel(v, now = new Date()) {
    const key = this.dayKey(v);
    const today = this.dayKey(now);
    if (!key || !today) return '';
    if (key === today) return 'Today';
    const [y, m, day] = today.split('-').map(Number);
    const yesterday = new Date(Date.UTC(y, m - 1, day - 1, 12)).toISOString().slice(0, 10);
    return key === yesterday ? 'Yesterday' : '';
  },

  /**
   * A DURATION, which has no timezone — `3m ago`. Here so that callers reach for
   * one module rather than deciding per-site whether a zone applies.
   */
  ago(v, fallback = '') {
    const d = this._d(v);
    if (!d) return fallback;
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  },
};

if (typeof window !== 'undefined') {
  window.VodouTime = VodouTime;
  VodouTime.init();
}
