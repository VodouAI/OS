/**
 * The timezone control, spelled ONCE.
 *
 * Settings → Profile grew a proper dropdown (browser zone list, live UTC
 * offsets, a curated fallback for engines without `supportedValuesOf`, and the
 * already-saved value always selectable). Onboarding then grew a second,
 * worse one: no offsets, no fallback list, a bare text box when the browser
 * could not enumerate zones. Two spellings of one control is how the heartbeat
 * editor wrote a file nothing read — so the logic lives here and both views
 * call it.
 *
 * Everything downstream needs a valid IANA name: `src/user_time.rs` and
 * `src/user-time.ts` both resolve every day boundary through the saved value
 * and both fall back to the machine's zone when it does not parse. A typo does
 * not fail — it silently reverts the whole system to the host clock, which on
 * a laptop looks identical to working. That is why this is a LIST.
 */
const VodouTimezone = {
  /**
   * For engines without `Intl.supportedValuesOf` (ES2022). A short, honest
   * list beats an empty menu — and this is exactly the browser that also
   * cannot name its own zone, so it is the one case where a person is asked.
   */
  FALLBACK_ZONES: [
    'America/New_York', 'America/Detroit', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Athens', 'Europe/Moscow',
    'Africa/Lagos', 'Africa/Johannesburg', 'Africa/Cairo', 'Asia/Jerusalem', 'Asia/Dubai',
    'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Singapore',
    'Asia/Tokyo', 'Asia/Seoul', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
  ],

  /** This browser's IANA zone. Nobody should ever TYPE one; the machine knows. */
  detect() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
    catch (_) { return ''; }
  },

  isValid(tz) {
    try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
    catch (_) { return false; }
  },

  /**
   * Can `isValid` actually tell zones apart here? A browser whose Intl is
   * stubbed rejects `UTC` too, and a validator that rejects everything is
   * worse than none: it turns a required field into a door with no key.
   */
  validatorWorks() {
    return this.isValid('UTC') && !this.isValid('Not/AZone');
  },

  /**
   * The zone list, with `chosen` always present — a value the field cannot
   * show is a value the field would silently discard on the next save.
   */
  zones(chosen) {
    let list = [];
    try { list = (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []) || []; }
    catch (_) { list = []; }
    if (!list.length) list = this.FALLBACK_ZONES.slice();
    const c = (chosen || '').trim();
    if (c && !list.includes(c)) list = [c].concat(list);
    return list;
  },

  /**
   * "UTC-04:00" for a zone — computed, not tabulated, so it is right on both
   * sides of a daylight-saving change.
   */
  offset(tz, now) {
    try {
      const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(now || new Date()).find((p) => p.type === 'timeZoneName')?.value;
      return s ? s.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+00:00') : '';
    } catch (_) { return ''; }
  },

  esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /** `<option>` rows. `placeholder` adds a blank first row for a required field. */
  optionsHtml(chosen, placeholder) {
    const c = (chosen || '').trim();
    const now = new Date();
    const rows = this.zones(c).map((z) => {
      const off = this.offset(z, now);
      const label = off ? `${z} (${off})` : z;
      return `<option value="${this.esc(z)}"${z === c ? ' selected' : ''}>${this.esc(label)}</option>`;
    });
    if (placeholder) rows.unshift(`<option value=""${c ? '' : ' selected'}>${this.esc(placeholder)}</option>`);
    return rows.join('');
  },

  /** The whole control. `id` differs per surface; nothing else does. */
  selectHtml(opts) {
    const o = opts || {};
    const cls = o.className ? ` class="${this.esc(o.className)}"` : '';
    const req = o.required ? ' required' : '';
    return `<select id="${this.esc(o.id)}"${cls}${req}>${this.optionsHtml(o.chosen, o.placeholder)}</select>`;
  },
};

if (typeof window !== 'undefined') window.VodouTimezone = VodouTimezone;
