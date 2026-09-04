/**
 * Vodou-Console — shared, null-safe HTML/attribute escaping.
 *
 * One canonical escaper for the whole console. Loaded FIRST (before any
 * view/lens script) so window.VodouSafe is always present at module-load.
 *
 * window.VodouSafe = { escapeHtml, escapeAttr, setText, html, raw }
 *   escapeHtml(s)  — encodes & < > " ' ; coerces null/undefined to ''.
 *   escapeAttr(s)  — same set, attribute-safe (use inside "..." or '...').
 *   setText(el, s) — textContent assignment with null coercion.
 *   html`...`      — tagged template; auto-escapes every ${interpolation}.
 *                    Arrays are joined (no separator) so html`${rows}` works.
 *                    Wrap a value in VodouSafe.raw(x) to bypass escaping.
 */
(function () {
  'use strict';

  const ENT = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ENT[ch]);
  }

  // Same character set is sufficient for double- or single-quoted attributes.
  const escapeAttr = escapeHtml;

  function setText(el, s) {
    if (el) el.textContent = String(s == null ? '' : s);
  }

  // Marker for trusted, pre-built HTML that must NOT be re-escaped.
  function raw(s) {
    return { __vodouRawHtml: String(s == null ? '' : s) };
  }
  function isRaw(v) {
    return v && typeof v === 'object' && typeof v.__vodouRawHtml === 'string';
  }

  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      let piece;
      if (isRaw(v)) {
        piece = v.__vodouRawHtml;
      } else if (Array.isArray(v)) {
        // Each item escaped unless explicitly raw() — lets you map rows.
        piece = v.map(x => (isRaw(x) ? x.__vodouRawHtml : escapeHtml(x))).join('');
      } else {
        piece = escapeHtml(v);
      }
      out += piece + strings[i + 1];
    }
    return out;
  }

  window.VodouSafe = { escapeHtml, escapeAttr, setText, html, raw };
})();
