/**
 * Vodou Bridge — appearance.
 *
 * The panel wears the palette you picked in Vodou → Settings → Appearance.
 * Source of truth is the gateway's GET /api/appearance (the same
 * .vodou/workspace/appearance.json the Console writes on every pick); the
 * tokens themselves are tokens.css, generated from the Console's own file.
 *
 * Two axes:
 *   palette — always Vodou's. It is a taste you already expressed.
 *   mode    — light/dark is Vodou's too, by default.
 *
 * Mode used to follow the BROWSER, on the reasoning that this surface lives in
 * Chrome's chrome and a dark panel against a light browser reads as a foreign
 * object. That is still a real concern, and it is still one tick away — but it
 * made the whole feature invisible for the common case (Console on light, browser
 * reporting dark: the panel stayed exactly as hardcoded and nothing appeared to
 * happen). Matching Vodou is what "make the panel match my Appearance settings"
 * means, so it is the default and following the browser is the opt-out.
 *
 * The stored key is `modeChoice`, and it is written ONLY when someone ticks the
 * box: a default must stay distinguishable from a choice, or changing the
 * default silently fails to reach everyone who already ran the old one.
 *
 * Load this FIRST in <head>: the cached value is stamped synchronously from
 * localStorage so the panel never paints one palette and then swaps.
 */
(function () {
  'use strict';

  var PALETTES = ['brand', 'ritual', 'ember', 'moss', 'ocean', 'crimson', 'violet',
    'rose', 'graphite', 'glacier', 'espresso', 'saffron', 'blush', 'lilac', 'mint',
    'powder', 'seafoam', 'peach', 'lime', 'cobalt', 'magenta', 'tangerine',
    'burgundy', 'olive'];
  var KEY = 'vodou_appearance';
  var root = document.documentElement;
  var state = { theme: 'dark', palette: 'brand', mode: 'vodou' };

  function normalize(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    return {
      theme: o.theme === 'light' ? 'light' : 'dark',
      palette: PALETTES.indexOf(o.palette) >= 0 ? o.palette : 'brand',
      // Absent means "never chosen" — take the default. The legacy `mode` key is
      // deliberately ignored: it recorded the old default, not anyone's decision.
      mode: o.modeChoice === 'browser' ? 'browser' : 'vodou',
    };
  }

  function browserPrefersLight() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (_) { return false; }
  }

  function effectiveTheme(s) {
    if (s.mode === 'vodou') return s.theme;
    return browserPrefersLight() ? 'light' : 'dark';
  }

  function paint() {
    root.setAttribute('data-theme', effectiveTheme(state));
    root.setAttribute('data-palette', state.palette);
  }

  // ── synchronous first paint from the local cache ─────────────────────────
  var chosen = false;
  try {
    var cached = localStorage.getItem(KEY);
    if (cached) {
      var raw = JSON.parse(cached);
      chosen = raw && (raw.modeChoice === 'browser' || raw.modeChoice === 'vodou');
      state = normalize(raw);
    }
  } catch (_) { /* first run, or storage denied — defaults are fine */ }
  paint();

  /** What we persist. `modeChoice` appears only once someone has actually chosen. */
  function payload() {
    var out = { theme: state.theme, palette: state.palette };
    if (chosen) out.modeChoice = state.mode;
    return out;
  }

  /** The synchronous pre-paint cache. */
  function cacheLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(payload())); } catch (_) {}
  }

  function save() {
    cacheLocal();
    // Mirrored for the other extension surfaces (console2, future in-page UI),
    // which cannot read this page's localStorage.
    try { chrome.storage.local.set({ vodou_appearance: payload() }); } catch (_) {}
  }

  function gatewayOrigin() {
    return new Promise(function (resolve) {
      var fallback = 'http://127.0.0.1:8765';
      try {
        chrome.storage.local.get(['vodou_gateway_url'], function (v) {
          try {
            var u = new URL((v && v.vodou_gateway_url) || 'ws://127.0.0.1:8765/api/vbb');
            resolve('http://' + u.hostname + ':' + (u.port || 8765));
          } catch (_) { resolve(fallback); }
        });
      } catch (_) { resolve(fallback); }
    });
  }

  // ── the gateway is authoritative; the cache only covers it being down ────
  var refreshing = false;
  function refresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return gatewayOrigin().then(function (origin) {
      return fetch(origin + '/api/appearance', { cache: 'no-store' });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (a) {
      // mode is OURS — the gateway does not know about it. Keep it.
      var next = normalize({ theme: a.theme, palette: a.palette, modeChoice: state.mode });
      state = next;
      paint();
      save();
      render();
    }).catch(function () {
      /* Gateway down or unpaired: the cached palette stands. Never blank. */
    }).then(function () { refreshing = false; });
  }

  // ── the live lane ────────────────────────────────────────────────────────
  // A PUT to /api/appearance pushes down the bridge socket; the service worker
  // writes it to chrome.storage, and this repaints an ALREADY-OPEN panel. Without
  // it the panel only re-reads on open, which looks exactly like nothing working
  // when you change the palette with the panel sitting right there.
  //
  // Deliberately does NOT save(): this IS the write we are hearing about, and
  // echoing it back would be a loop.
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.vodou_appearance) return;
      var v = changes.vodou_appearance.newValue;
      if (!v) return;
      var next = normalize({ theme: v.theme, palette: v.palette, modeChoice: state.mode });
      if (next.theme === state.theme && next.palette === state.palette) return;
      state = next;
      cacheLocal();
      paint();
      render();
    });
  } catch (_) { /* not an extension page (test harness, static preview) */ }

  // Browser mode flipping under us (auto light/dark by time of day).
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onMq = function () { if (state.mode === 'browser') paint(); };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  } catch (_) {}

  // ── settings UI (present in the panel; absent elsewhere, and that's fine) ─
  function render() {
    var box = document.getElementById('appearance-swatches');
    if (box) {
      var cs = getComputedStyle(root);
      // Read the LIVE tokens rather than a second copy of the palette table —
      // a hardcoded swatch list is exactly the drift this change removes.
      var vars = ['--accent', '--bg-secondary', '--text-primary'];
      box.innerHTML = '';
      vars.forEach(function (v) {
        var s = document.createElement('span');
        s.style.background = cs.getPropertyValue(v).trim() || 'transparent';
        box.appendChild(s);
      });
    }
    var name = document.getElementById('appearance-name');
    if (name) name.textContent = state.palette;
    var cb = document.getElementById('appearance-follow-browser');
    if (cb) cb.checked = state.mode === 'browser';
  }

  function bind() {
    var cb = document.getElementById('appearance-follow-browser');
    if (cb) {
      cb.addEventListener('change', function () {
        state.mode = cb.checked ? 'browser' : 'vodou';
        chosen = true;
        paint();
        save();
        render();
      });
    }
    // Point the "change it in Vodou" link at the gateway we actually talk to,
    // not the default port baked into the markup.
    var link = document.getElementById('appearance-link');
    if (link) {
      gatewayOrigin().then(function (origin) {
        link.href = origin + '/#/settings?tab=appearance';
      });
    }
    render();
    refresh();
    // Reopening the panel usually rebuilds the document, but a tab switch can
    // leave it alive across a palette change in the Console.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.VodouPanelTheme = { refresh: refresh, get: function () { return Object.assign({}, state); } };
})();
