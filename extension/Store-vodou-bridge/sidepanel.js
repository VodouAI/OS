// Vodou Bridge side panel.
//
// All state comes from background.js or chrome.storage; the panel never touches
// the page directly and never opens a socket of its own — background.js owns the
// single gateway connection.

const q = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// How the panel was opened. Diagnostic only — shown with ?debug=1, which the user
// never sees. Comes from background rather than a query param because setting the
// param needs setOptions() BEFORE open(), and any await before open() spends the
// user gesture. Kept for the next time an open path misbehaves.
if (params.get('debug') === '1') {
  const wrap = q('how-wrap');
  if (wrap) wrap.style.display = 'inline';
  q('how').textContent = params.get('how') || 'resolving…';
  chrome.runtime.sendMessage({ type: 'get_panel_context' }).then((ctx) => {
    if (params.get('how')) return;                     // param wins if present
    const fresh = ctx && ctx.at && (Date.now() - ctx.at) < 5000;
    q('how').textContent = fresh ? ctx.how : 'unknown (opened from the sidebar itself?)';
  }).catch(() => { q('how').textContent = 'unknown (background did not answer)'; });
}

async function main() {
  // The tab we belong to. `tabId` arrives in the path when background.js targets
  // a specific tab; fall back to querying the active tab when the panel was
  // opened globally via side_panel.default_path.
  let tabId = Number(params.get('tabId'));
  let tab = null;
  try {
    if (Number.isFinite(tabId) && tabId > 0) {
      tab = await chrome.tabs.get(tabId);
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab && tab.id;
    }
  } catch (_) { /* tab closed under us */ }

  if (!tab) { setState(null, null, 'no tab'); return; }
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) { host = tab.url || ''; }

  const site = (globalThis.VODOU_SITES || []).find((s) => s.host.test(host));

  // One sentence, built from what is actually true. Written from the user's side of
  // the screen: "saving this chat", not "capture: on". Each clause appears only when
  // it applies, so the line never claims something it cannot back up.
  const lanes = await readLanes(site);
  setState(site, lanes, null);
  startStatusPolling(site, lanes);

  // THE SHOWCASE — the hero button sends exactly what the ⌃B hotkey sends
  // (background: INJECT_COMMANDS['inject-visible'] → visible:true). On an
  // adapter site that's the full memory-answer into the draft; on any other
  // page the content script's any-page insert takes over. One tested path.
  try {
    const hero = document.getElementById('hero');
    const heroSub = document.getElementById('hero-sub');
    const heroBtn = document.getElementById('hero-inject');
    const heroStatus = document.getElementById('hero-status');
    if (hero && heroBtn && tab && /^https?:/.test(tab.url || '')) {
      hero.hidden = false;
      heroSub.textContent = site
        ? 'This is ' + (site.label || host) + ' — type your message, then attach everything Vodou knows that could help. You review the draft before sending.'
        : 'Works on this page too: memories from this page first, or suggestions seeded by whatever you are drafting.';
      // Save this chat — the existing manual-capture lane (page_save on the
      // vodou-two port; idempotent, lands under import:<src>:<uuid>). Adapter
      // sites only: that is where a "chat" exists to save.
      const heroSave = document.getElementById('hero-save');
      if (heroSave && site) {
        heroSave.hidden = false;
        heroSave.addEventListener('click', () => {
          heroSave.disabled = true;
          heroStatus.textContent = 'saving this chat…';
          try {
            const p2 = chrome.runtime.connect({ name: 'vodou-two' });
            const timer = setTimeout(() => { try { p2.disconnect(); } catch (_) {} heroStatus.textContent = '✗ save timed out'; heroSave.disabled = false; }, 60000);
            p2.onMessage.addListener((r) => {
              if (!r || r.cmd !== 'page_save_result') return;
              clearTimeout(timer);
              heroStatus.textContent = r.ok ? '✓ saved to your memory' : ('✗ ' + (r.error || 'save failed'));
              heroSave.disabled = false;
              try { p2.disconnect(); } catch (_) {}
            });
            p2.postMessage({ type: 'page_save' });
          } catch (_) {
            heroStatus.textContent = '✗ could not reach Vodou';
            heroSave.disabled = false;
          }
        });
      }
      heroBtn.addEventListener('click', async () => {
        heroBtn.disabled = true;
        heroStatus.textContent = 'attaching…';
        try {
          globalThis.__vodouMarkInserted?.([]);
          const r = await chrome.tabs.sendMessage(tabId, { type: 'vodou_run_inject', visible: true });
          heroStatus.textContent = r && r.ok ? '✓ watch your draft on the page' : ('✗ ' + ((r && r.error) || 'the page did not answer — click into a text box first'));
        } catch (_) {
          heroStatus.textContent = '✗ this tab has no Vodou script yet — right-click the page once, or reload it';
        }
        setTimeout(() => { heroBtn.disabled = false; }, 1500);
      });
    }
  } catch (_) { /* hero is optional chrome */ }

  // Follow the active tab (Chad, 2026-08-20: "when I change website the panel
  // should change too"). page-mem and doc-match already re-query on tab
  // switches; the hero and the state line were frozen at boot. Re-derive both.
  const followTab = async (newTabId) => {
    try {
      const t = await chrome.tabs.get(newTabId);
      if (!t || !t.url) return;
      tab = t; tabId = newTabId;
      try { host = new URL(t.url).hostname; } catch (_) { host = t.url || ''; }
      const s2 = (globalThis.VODOU_SITES || []).find((x) => x.host.test(host));
      const lanes2 = await readLanes(s2);
      setState(s2, lanes2, null);
      const hero = document.getElementById('hero');
      const heroSub = document.getElementById('hero-sub');
      const heroSave = document.getElementById('hero-save');
      const heroStatus = document.getElementById('hero-status');
      if (hero) {
        hero.hidden = !/^https?:/.test(t.url || '');
        if (heroSub) heroSub.textContent = s2
          ? 'This is ' + (s2.label || host) + ' — type your message, then attach everything Vodou knows that could help. You review the draft before sending.'
          : 'Works on this page too: memories from this page first, or suggestions seeded by whatever you are drafting.';
        if (heroSave) heroSave.hidden = !s2;
        if (heroStatus) heroStatus.textContent = '';
      }
    } catch (_) { /* tab gone mid-switch */ }
  };
  try {
    chrome.tabs.onActivated.addListener((i) => followTab(i.tabId));
    chrome.tabs.onUpdated.addListener((id, info, t) => {
      if ((info.status === 'complete' || info.url) && t && t.active) followTab(id);
    });
  } catch (_) { /* panel without tabs API */ }

  // Ask the page for what only it knows: the composer draft (the search seed) and
  // the conversation id. A content script may be absent — an unsupported host, a
  // tab that predates the extension being reloaded — and that is not an error, it
  // just means no seed and no conversation scoping.
  let page = { host, provider: '', convId: '', seed: '' };
  const probe = async () => {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'vodou_panel_probe' });
      return r && r.ok ? r : null;
    } catch (_) { return null; }
  };
  let got = await probe();
  if (!got) {
    // The tab is almost certainly running an orphaned content script from before
    // the last extension reload. Heal it rather than telling the user to reload the
    // page — that instruction is how this failure survives.
    const healed = await chrome.runtime.sendMessage({ type: 'vodou_ensure_content', tabId })
      .catch(() => null);
    if (healed && healed.ok) got = await probe();
  }
  if (got) page = got;
  else if (site) {
    q('status').textContent = 'couldn’t reach this page — reload the tab to search with its context';
  }
  initPicker(tabId, page);
}

main();

// ── PLAN-BRIDGE-SIDE-PANEL P1 — the picker, moved out of the page ────────────
//
// Ported from content.js's in-page picker with the ranking behaviour intact,
// because that behaviour was tuned against real queries and is not arbitrary:
//   • relPct / ageLabel / sourceLabel produce the same chips
//   • the ADAPTIVE PRE-CHECK is the median-relevance rule with a 20% floor and a
//     cap of 5, and private items are never auto-ticked
//   • an explicit tick survives re-sort and re-query (checkedText)
//   • the block is assembled from the gateway's own fence parts, so the fence has
//     one producer — and being fenced is why no strip registration is needed
//
// What changed is only WHERE it lives. The page keeps the two jobs only it can do:
// reading the composer draft / conversation id, and typing into the composer.

const REL_GOOD = 45;        // chip turns green at/above this
const PRE_FLOOR = 20;       // never auto-tick a uniformly weak set
const PRE_CAP = 5;          // never auto-tick more than this

const relPct = (item) => {
  const r = typeof item.relevance === 'number' ? item.relevance : 0;
  return Math.max(0, Math.min(99, Math.round(r * 100)));
};
function ageLabel(iso) {
  if (!iso) return '';
  const t = Date.parse(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
  if (!t) return '';
  const days = (Date.now() - t) / 86400000;
  if (days < 1) return 'today';
  if (days < 30) return Math.round(days) + 'd';
  if (days < 365) return Math.round(days / 30) + 'mo';
  return Math.round(days / 365) + 'y';
}
// COHERENCE Phase 2 — this was the panel's own translator, and core's docs
// name it as the reason the rule needed a home: it "came to handle two prefixes
// and pass the rest through raw". `return scope.split(':')[0]` is F7 exactly —
// `web`, `workbench`, `gateway` straight to the eye — and it returned slugs
// (`claude-code`) where a person reads a product name (`Claude Code`).
//
// It now delegates to the shared module, which mirrors provenance.rs and is
// held to it by test/vocabulary-parity.test.mjs. Kept as a named function so
// the fallback call site below reads the same as it always did.
function sourceLabel(scope) {
  if (!scope) return '';
  return globalThis.VodouVocabulary.scopeLabel(scope);
}

// ── State line ───────────────────────────────────────────────────────────────
// Replaces three key/value rows. "Tab #2055520826" is gone with them — a tab id is
// developer noise in a surface an end user reads.
function setState(site, lanes, note) {
  const bits = [];
  if (site) bits.push(site.label);
  if (lanes && lanes.capture === 'on') bits.push('saving this chat');
  else if (lanes && lanes.capture === 'paused') bits.push('saving paused by Vodou');
  else if (lanes && lanes.capture === 'off') bits.push('not saving');
  if (lanes && lanes.inject) bits.push('⌃B ready');
  if (!site) bits.push('not an AI chat — search still works');
  if (note) bits.push(note);
  q('s-line').textContent = bits.join(' · ');
}

// Where the pair code lives: the console's Browser bridge card. Derived from the
// gateway URL the same way the header links are, so a custom host still lands on
// the right console.
function pairCodeUrl(st) {
  try {
    const u = new URL((st && st.gateway_url) || 'ws://127.0.0.1:8765/api/vbb');
    return `http://${u.hostname}:${u.port || 8765}/#/settings?tab=memory&section=bridge`;
  } catch (_) {
    return 'http://127.0.0.1:8765/#/settings?tab=memory&section=bridge';
  }
}

// Lane state is READ-THROUGH, not a snapshot.
//
// It used to be computed once in main() and closed over by the poller forever, so
// arming "Auto-capture AI chats" in the Settings tab left the line above still
// reading "not saving" — the panel contradicting its own checkbox one row down.
// Caught in a store screenshot on 2026-07-30, which is a bad place to find out.
const LANE_KEYS = [
  'vodou_auto_capture', 'vodou_capture_sites', 'vodou_capture_policy', 'vodou_inject_settings',
];

function computeLanes(site, st) {
  if (!site) return { capture: null, inject: null };
  const veto = ((st.vodou_capture_policy || {}).providers || {})[site.capture];
  let capture;
  if (veto && veto.capture === false) capture = 'paused';
  else if (!st.vodou_auto_capture) capture = 'off';
  else capture = (st.vodou_capture_sites || {})[site.capture] !== false ? 'on' : 'off';
  const inj = st.vodou_inject_settings || {};
  return { capture, inject: inj.master !== false && (inj.sites || {})[site.key] !== false };
}

async function readLanes(site) {
  try {
    return computeLanes(site, await chrome.storage.local.get(LANE_KEYS));
  } catch (_) {
    return { capture: null, inject: null };
  }
}

/**
 * The panel's standing promise, under the picker. It shipped as static markup
 * reading "Nothing reaches the chat unless you press Ctrl+B or insert from the
 * picker" — which auto-attach makes false, and which went out in `.66`/`.70` and
 * into two store screenshots before anyone read it against the feature list.
 *
 * Exactly the same failure as the status line below (computed once, never
 * revisited), so it hangs off the same storage listener rather than a second one.
 * A privacy claim in the UI is code: it has to be recomputed when the thing it
 * claims about changes.
 */
function paintGate(inj) {
  const el = q('gate-claim');
  if (!el) return;
  el.textContent = '';
  if ((inj || {}).autoSend === true) {
    el.appendChild(document.createTextNode('Auto-attach is '));
    const on = document.createElement('b');
    on.textContent = 'on';
    el.appendChild(on);
    el.appendChild(document.createTextNode(
      ': memory is added to the messages you send, and Vodou sends them for you. Turn it off under Settings.'));
    return;
  }
  el.appendChild(document.createTextNode('Nothing reaches the chat unless you press '));
  const k = document.createElement('b');
  k.textContent = 'Ctrl+B';
  el.appendChild(k);
  el.appendChild(document.createTextNode(' or insert from the picker.'));
}

// ── First run: no Vodou on this machine ─────────────────────────────────────
// Shown only when the extension has never once connected. Hides the tab strip
// while it shows — with no Vodou, every tab is an empty promise — and takes
// itself down the moment a connection lands, without a reload.
let everConnected = null;   // null = unknown yet, true/false once storage answers
try {
  chrome.storage.local.get('vodou_ever_connected').then((st) => {
    everConnected = !!(st && st.vodou_ever_connected);
    if (!everConnected) paintWelcome(false);
  }).catch(() => { everConnected = true; });   // storage denied → never nag
} catch (_) { everConnected = true; }

function paintWelcome(connected) {
  const box = document.getElementById('welcome');
  const tabsNav = document.querySelector('nav.tabs');
  if (!box) return;
  if (connected) {
    if (!everConnected) {
      everConnected = true;
      try { chrome.storage.local.set({ vodou_ever_connected: true }); } catch (_) { /* */ }
    }
    if (!box.hidden) {
      box.hidden = true;
      if (tabsNav) tabsNav.hidden = false;
      for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-memory';
      document.querySelector('.tab[data-view="memory"]')?.classList.add('on');
    }
    return;
  }
  if (everConnected !== false) return;   // known user, or storage hasn't answered yet
  box.hidden = false;
  if (tabsNav) tabsNav.hidden = true;
  for (const v of document.querySelectorAll('.view')) v.hidden = true;
}
try {
  document.getElementById('welcome-retry')?.addEventListener('click', (e) => {
    e.preventDefault();
    // The same lane the Connect toggle uses — no new background message.
    const link = document.getElementById('welcome-retry');
    if (link) link.textContent = 'checking…';
    try { chrome.runtime.sendMessage({ type: 'set_enabled', enabled: true }).catch(() => {}); } catch (_) { /* */ }
    setTimeout(() => { if (link) link.textContent = 'Check again now'; }, 2500);
  });
} catch (_) { /* */ }

function startStatusPolling(site, initialLanes) {
  let lanes = initialLanes;
  const dot = q('d-conn');
  const paint = (st) => {
    const ok = !!(st && st.connected);
    dot.className = 'dot ' + (ok ? 'on' : (st && st.enabled) ? 'bad' : 'off');
    // FIRST RUN — has this install EVER reached a Vodou? The flag is what
    // separates "never heard of Vodou" (welcome them) from "app is stopped"
    // (they already know what it is). Written once, on the first success.
    paintWelcome(ok);
    // Connection trouble outranks everything else on the line: if Vodou is not
    // running, nothing else on this panel is going to work and saying "saving this
    // chat" would be a lie.
    if (!ok) {
      // Pairing outranks "isn't running": a 4403 close means Vodou IS running
      // and wants a code — sending someone to restart services for that is a lie.
      const line = q('s-line');
      if (st && st.pairing_required) {
        // Text + a real link to where the code IS. The line is textContent
        // everywhere else, so build the anchor explicitly rather than innerHTML.
        line.textContent = 'pairing required — ';
        const a = document.createElement('a');
        a.textContent = 'get the code';
        a.href = pairCodeUrl(st);
        a.target = '_blank';
        a.rel = 'noopener';
        line.appendChild(a);
        line.appendChild(document.createTextNode(', then paste it under Settings'));
      } else {
        // F19 — the down state says what to DO. The sentence lives in
        // gateway-errors.js so this panel and Console Two answer one condition
        // with one answer; the fallback keeps the old text if an older
        // gateway-errors.js is somehow loaded beside a newer panel.
        const notRunning = (globalThis.VodouGatewayError && globalThis.VodouGatewayError.notRunning)
          ? globalThis.VodouGatewayError.notRunning('panel')
          : 'Vodou isn\u2019t running';
        line.textContent = !st ? 'no answer from the extension'
          : !st.enabled ? 'disconnected — you turned Vodou off'
          : st.slot_standby ? 'another window holds the connection'
          : notRunning;
      }
    } else {
      // "paired" only when the gateway ENFORCED pairing and this session passed —
      // an optional-mode connection stays unlabelled rather than claiming a check
      // that never ran.
      setState(site, lanes, st.paired ? 'paired' : null);
    }
    const tog = q('s-toggle');
    tog.hidden = false;
    tog.textContent = ok ? 'Disconnect' : 'Connect';
    if (st) {
      try {
        const u = new URL(st.gateway_url || 'ws://127.0.0.1:8765/api/vbb');
        q('s-link-gw').href = `http://${u.hostname}:${u.port || 8765}/`;
        // PLAN-BRIDGE-BRAIN-LINK §3.1 — one pure function, so the three cases
        // (twin / console / old gateway) are testable without a browser.
        q('s-link-brain').href = globalThis.VodouBrainLink.brainLinkFor(st, st.gateway_url);
      } catch (_) { /* malformed stored URL */ }
    }
  };
  const tick = () => chrome.runtime.sendMessage({ type: 'get_status' }).then(paint).catch(() => paint(null));
  tick();
  setInterval(tick, 2000);
  // The settings that drive this line live in THIS panel, one tab away, so a
  // toggle has to move it immediately rather than whenever the next poll lands.
  // Storage is the only way these change — the Settings tab writes it, and the
  // gateway's set_capture_armed writes it too — so one listener covers both.
  try {
    chrome.storage.local.get(['vodou_inject_settings'], (v) => paintGate(v && v.vodou_inject_settings));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !LANE_KEYS.some((k) => k in changes)) return;
      if ('vodou_inject_settings' in changes) paintGate(changes.vodou_inject_settings.newValue);
      readLanes(site).then((fresh) => { lanes = fresh; tick(); });
    });
  } catch (_) { /* storage events unavailable — the 2s poll still repaints */ }
  q('s-toggle').addEventListener('click', async () => {
    const cur = await chrome.runtime.sendMessage({ type: 'get_status' }).catch(() => null);
    await chrome.runtime.sendMessage({ type: 'set_enabled', enabled: !(cur && cur.connected) }).catch(() => {});
    setTimeout(tick, 300);
  });
}

const picker = {
  tabId: null,
  page: null,                 // probe result: host/provider/convId/seed
  items: [],
  scope: 'all',
  checked: new Set(),         // by text, so a tick survives sort and re-query
  timer: null,
};

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function syncFoot() {
  const boxes = [...document.querySelectorAll('#list input[type=checkbox]')];
  const n = boxes.filter((b) => b.checked).length;
  const btn = q('insert');
  btn.textContent = n ? `Insert ${n}` : 'Insert';
  btn.disabled = n === 0;
  q('all').checked = boxes.length > 0 && n === boxes.length;
  q('foot').style.display = boxes.length ? 'flex' : 'none';
}

function render(items) {
  picker.items = items;
  const list = q('list');
  list.textContent = '';
  const sortBy = q('sort').value;
  const sorted = items.slice().sort((a, b) => (sortBy === 'recency'
    ? String(b.created_at || '').localeCompare(String(a.created_at || ''))
    : relPct(b) - relPct(a)));

  // Adaptive pre-check: tick in-vault items at or above the MEDIAN relevance of
  // this result set, floored at 20% so a weak set ticks nothing, capped at 5. A
  // sharp query pre-checks its strong head; a vague one pre-checks little.
  const rels = sorted.map(relPct).sort((a, b) => a - b);
  const median = rels.length ? rels[Math.floor(rels.length / 2)] : 0;
  const preThresh = Math.max(PRE_FLOOR, median);
  let preCount = 0;

  for (const item of sorted) {
    const row = document.createElement('label');
    row.className = 'item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.text = item.text;
    const autoPre = !!item.in_vault && relPct(item) >= preThresh && preCount < PRE_CAP;
    cb.checked = picker.checked.has(item.text) || autoPre;
    if (autoPre && !picker.checked.has(item.text)) preCount++;
    if (cb.checked) picker.checked.add(item.text);
    cb.addEventListener('change', () => {
      if (cb.checked) picker.checked.add(cb.dataset.text); else picker.checked.delete(cb.dataset.text);
      syncFoot();
    });

    const body = document.createElement('div');
    body.className = 'body';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = item.text.length > 220 ? item.text.slice(0, 217) + '…' : item.text;
    txt.title = item.text;
    const chips = document.createElement('div');
    chips.className = 'chips';
    chips.appendChild(chip(relPct(item) + '%', relPct(item) >= REL_GOOD ? 'good' : ''));
    if (item.tag) chips.appendChild(chip(item.tag));
    // COHERENCE F7 — prefer the label core computed (`scope_label`); it is the
    // one place that knows every scope, and its fallback is a human word rather
    // than a schema key. sourceLabel() stays as the fallback for results that
    // predate the field (cached entries) and for a gateway older than this build.
    const src = item.scope_label || sourceLabel(item.scope);
    if (src) chips.appendChild(chip(src, 'src'));
    const age = ageLabel(item.created_at); if (age) chips.appendChild(chip(age));
    if (!item.in_vault) chips.appendChild(chip('🔒 private', 'priv'));
    // PLAN-MEMORY-ON-EVERY-PAGE P2 — "📎 this page": stamp THIS memory with the
    // page the panel is looking at. Shown only while the page-memory lane is on
    // (its consent covers reading the tab; the picker never reads it itself —
    // it uses the url that lane already published). A button inside the row's
    // <label> would toggle the checkbox, so the click is stopped at the chip.
    const pm = globalThis.__vodouPageMem;
    if (pm && pm.enabled && pm.url && item.id && (pm.mode || 'collect') === 'collect') {
      const linkBtn = document.createElement('button');
      linkBtn.type = 'button';
      linkBtn.className = 'chip link';
      linkBtn.textContent = '📎 this page';
      linkBtn.title = 'Remember this on the page you are on (' + (pm.host || pm.url) + ')';
      linkBtn.style.cssText = 'cursor:pointer;background:transparent;border:1px solid var(--line,#2A3441);color:inherit';
      linkBtn.addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        linkBtn.disabled = true; linkBtn.textContent = 'linking…';
        try {
          const res = await fetch(gatewayBase() + '/api/page-match/link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: pm.url, chunkId: item.id }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.ok) {
            linkBtn.textContent = '📎 linked';
            document.dispatchEvent(new CustomEvent('vodou-page-mem-refresh'));
          } else {
            linkBtn.textContent = '✗ ' + ((data && data.error) || 'failed');
            linkBtn.disabled = false;
          }
        } catch (_) { linkBtn.textContent = '✗ offline'; linkBtn.disabled = false; }
      });
      chips.appendChild(linkBtn);
    }
    body.append(txt, chips);
    row.append(cb, body);
    list.appendChild(row);
  }

  const priv = sorted.filter((i) => !i.in_vault).length;
  // Empty states say what was searched and what to do — a blank box is not an answer.
  if (!sorted.length) {
    q('status').textContent = picker.vault === 'all'
      ? 'nothing matched — try different words'
      : `nothing in vault "${picker.vault}" matched — try all memory`;
  } else if (picker.vault !== 'all') {
    q('status').textContent = `${sorted.length} in vault "${picker.vault}"`;
  } else {
    q('status').textContent = `${sorted.length} memories · ${priv} private (🔒 = outside your shared vault; tick to include)`;
  }
  syncFoot();
}

function search(query) {
  q('status').textContent = 'searching…';
  const all = picker.vault === 'all';
  chrome.runtime.sendMessage({
    type: 'get_context',
    query,
    host: (picker.page && picker.page.host) || '',
    all_memory: all,
    vault: all ? '' : picker.vault,
    conv_id: (picker.page && picker.page.convId) || '',
    provider: (picker.page && picker.page.provider) || '',
  }).then((r) => {
    if (!r || !r.ok || !Array.isArray(r.items)) {
      q('status').textContent = '✗ ' + ((r && r.error) || 'search failed — is Vodou running?');
      return;
    }
    // Vault list arrives with the first response; populate the scope selector once.
    const sel = q('vault-select');
    if (Array.isArray(r.vaults) && sel.options.length === 1) {
      for (const v of r.vaults) {
        const o = document.createElement('option');
        o.value = v; o.textContent = 'vault: ' + v;
        sel.appendChild(o);
      }
    }
    render(r.items);
  }).catch((e) => { q('status').textContent = '✗ ' + (e && e.message); });
}

// ── PLAN-ALPHA 11e — briefings: render + mark seen ──────────────────────────
// The panel is the arrival surface for skill results (badge = lure, Inbox =
// payoff). PLAN-EXT-PANEL-IA re-homed briefings into the Inbox view, and with
// that, SEEN changed meaning: it now fires when the Inbox is actually opened
// with unseen briefings in it — "user SAW it" (G5) becomes literally true,
// where before it fired on any panel open regardless of tab. The toolbar badge
// therefore persists until the Inbox is visited, which is the lure working.
// Live-updates via storage.onChanged; unseen items light the Inbox tab dot.
async function renderBriefings(markSeen = false) {
  const box = document.getElementById('briefings');
  if (!box) return;
  let items = [];
  try { ({ vodou_briefings: items = [] } = await chrome.storage.local.get('vodou_briefings')); } catch (_) { /* leave empty */ }
  const headEl = document.getElementById('briefings-head');
  const emptyEl = document.getElementById('inbox-empty');
  if (headEl) headEl.hidden = !items.length;
  if (emptyEl) emptyEl.hidden = !!items.length;
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent = '';
  for (const b of items.slice(0, 5)) {
    const card = document.createElement('div');
    // F28 — a failed run reads as a failure. Older stored arrivals have no `ok`
    // field and were all successes, so only an explicit false marks one.
    const failed = b.ok === false;
    card.className = 'briefing' + (b.seen ? '' : ' unseen') + (failed ? ' failed' : '');
    const head = document.createElement('div');
    head.className = 'briefing-head';
    const title = document.createElement('span');
    title.textContent = (failed ? '⚠ ' : '') + (b.display_name || 'Briefing');
    const when = document.createElement('span');
    when.className = 'briefing-when';
    try { when.textContent = new Date(b.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { when.textContent = ''; }
    // Every arrival says where it came from — Chad's 2026-08-20 click-through:
    // "what are these messages from?" should never need asking.
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = '✕';
    dismiss.title = 'Dismiss this arrival';
    dismiss.style.cssText = 'background:none;border:0;color:inherit;opacity:.5;cursor:pointer;font-size:11px;padding:0 0 0 6px';
    dismiss.addEventListener('click', () => dismissBriefing(b.at, b.name));
    head.append(title, when, dismiss);
    const src = document.createElement('div');
    src.style.cssText = 'font-size:10px;opacity:.5;margin:1px 0 2px';
    src.textContent = (failed ? 'your scheduled skill had a problem' : 'from your scheduled skill')
      + (b.name ? ' · ' + b.name : '');
    const body = document.createElement('div');
    body.className = 'briefing-body';
    body.textContent = b.response || '';
    card.append(head, src, body);
    box.appendChild(card);
  }
  const hasUnseen = items.some((b) => !b.seen);
  const inboxVisible = !document.getElementById('view-activity')?.hidden;
  setTabDot('activity', hasUnseen && !inboxVisible);
  if (hasUnseen && (markSeen || inboxVisible)) {
    try { chrome.runtime.sendMessage({ type: 'vodou_briefings_seen' }); } catch (_) { /* next open retries */ }
    setTabDot('activity', false);
  }
}
// Dismiss one arrival / clear them all — storage is the single source of
// truth, and the storage.onChanged listener re-renders every open panel.
async function dismissBriefing(at, name) {
  try {
    const { vodou_briefings = [] } = await chrome.storage.local.get('vodou_briefings');
    await chrome.storage.local.set({ vodou_briefings: vodou_briefings.filter((b) => !(b.at === at && b.name === name)) });
  } catch (_) { /* next open retries */ }
}
try {
  document.getElementById('briefings-clear')?.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await chrome.storage.local.set({ vodou_briefings: [] }); } catch (_) {}
  });
} catch (_) { /* */ }
// COHERENCE F33 — surface what Vodou is unsure about.
//
// The contradiction queue was populated and reachable, and told nobody: 86 open
// conflicts sat in a table you could only find by opening a console view and
// pressing a button you had no reason to press. Detection without delivery is
// the same defect as F2 (skill results arriving where the badge did not point),
// which the Inbox already solved — so conflicts arrive here too.
//
// Read-only and fail-quiet: an older gateway without the route, or a stopped
// daemon, simply leaves the card hidden. A panel that announced "couldn't check
// for conflicts" on every open would be worse than one that stays silent.
async function renderConflicts() {
  const box = document.getElementById('conflicts');
  const body = document.getElementById('conflicts-body');
  const link = document.getElementById('conflicts-open');
  if (!box || !body) return;
  try {
    const r = await fetch(gatewayBase() + '/api/import/contradictions', { cache: 'no-store' });
    if (!r.ok) { box.hidden = true; return; }
    const d = await r.json();
    const rows = Array.isArray(d && d.contradictions) ? d.contradictions : [];
    if (!rows.length) { box.hidden = true; return; }
    const n = rows.length;
    // Show the disagreement, not just a count: "2 things" is a number, but the
    // pair itself is what makes a person want to fix it.
    const first = rows[0] || {};
    const a = String(first.native_text || first.native_value || '').trim();
    const b = String(first.import_text || first.import_value || '').trim();
    const clip = (t) => (t.length > 90 ? t.slice(0, 88) + '\u2026' : t);
    body.textContent = '';
    const head = document.createElement('div');
    head.textContent = n === 1
      ? 'I have two different answers about one thing.'
      : 'I have two different answers about ' + n + ' things.';
    body.appendChild(head);
    if (a && b) {
      const pair = document.createElement('div');
      pair.style.cssText = 'margin-top:5px;opacity:.75;font-size:11px;line-height:1.45';
      pair.textContent = '\u201c' + clip(a) + '\u201d  vs  \u201c' + clip(b) + '\u201d';
      body.appendChild(pair);
    }
    if (link) link.href = gatewayBase() + '/#/memory';
    box.hidden = false;
  } catch (_) {
    box.hidden = true;   // fail quiet — see above
  }
}

// A tab's "something landed while you were elsewhere" dot (Here and Inbox).
function setTabDot(view, on) {
  const t = document.querySelector('.tab[data-view="' + view + '"]');
  if (t) t.classList.toggle('has-new', !!on);
}
// Flag the Here tab when a page card (the fill review) fires while another
// view is up — the card is a page phenomenon, Here is its home.
function flagHere() {
  const v = document.getElementById('view-here');
  if (v && v.hidden) setTabDot('here', true);
}
// Typing/⌃B lookups are MEMORY results (Chad, 2026-08-20) — their card lives
// with search, and lands a dot on the Memory tab when it fires off-view.
function flagMemory() {
  const v = document.getElementById('view-memory');
  if (v && v.hidden) setTabDot('memory', true);
}
try {
  renderBriefings(false);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.vodou_briefings) renderBriefings(false);
  });
} catch (_) { /* panel without storage — memory search still works */ }

async function initPicker(tabId, page) {
  picker.tabId = tabId;
  picker.page = page;
  const seed = (page && page.seed) || '';
  if (seed && seed.length < 80) q('q').value = seed;

  // PLAN-EXT-PANEL-IA v3 (Chad: "the typing card fights with search — should
  // search autofill?"). The draft now flows INTO the search box instead of a
  // rival card: one surface. Guard: a query the user typed themselves is never
  // clobbered — auto-seeding only overwrites its own last value.
  let autoSeeded = q('q').value || '';
  // Echo guard (Chad, 2026-08-20): inserting memories into the page changes
  // the draft, the draft seeds this box — without a guard the search bar
  // fills with the exact memories just inserted. Inserts mark themselves
  // (a time window + content fingerprints) and the seed hook refuses echoes.
  globalThis.__vodouMarkInserted = (texts) => {
    globalThis.__vodouNoSeedUntil = Date.now() + 20000;
    globalThis.__vodouInsertedMarks = (texts || []).slice(0, 8).map((t) => String(t).slice(0, 60));
  };
  const seedChip = document.getElementById('seed-chip');
  const seedChipHost = document.getElementById('seed-chip-host');
  globalThis.__vodouSeedSearch = (text, fromHost) => {
    const box = q('q');
    const t = String(text || '').slice(0, 300).trim();
    if (!t) return;
    if (Date.now() < (globalThis.__vodouNoSeedUntil || 0)) return; // just inserted
    const marks = globalThis.__vodouInsertedMarks || [];
    if (marks.some((m) => m && t.includes(m))) return; // the draft is our own echo
    if (box.value.trim() && box.value !== autoSeeded) return; // user owns the box
    box.value = t;
    box.style.height = 'auto';
    box.style.height = Math.min(66, box.scrollHeight) + 'px';
    autoSeeded = t;
    if (seedChip) {
      seedChip.hidden = false;
      if (seedChipHost) seedChipHost.textContent = fromHost || '';
    }
    search(t);
  };
  if (seedChip) document.getElementById('seed-chip-x')?.addEventListener('click', () => {
    seedChip.hidden = true;
    if (q('q').value === autoSeeded) { q('q').value = ''; render([]); }
    autoSeeded = '';
  });
  q('q').addEventListener('input', () => {
    if (q('q').value !== autoSeeded) { autoSeeded = ''; if (seedChip) seedChip.hidden = true; }
    clearTimeout(picker.timer);
    const v = q('q').value.trim();
    if (!v.length) {
      // An emptied box empties the list (Chad, 2026-08-20) — stale results
      // under a blank query read as "the search is broken".
      picker.checked.clear();
      render([]);
      q('status').textContent = '';
      return;
    }
    if (v.length < 2) return;
    picker.timer = setTimeout(() => search(v), 300);
  });
  q('vault-select').addEventListener('change', () => {
      // COHERENCE F42 — this was `picker.scope`, and the value it holds is a
    // VAULT NAME. Line ~564 already wrote it out as `vault:` on the wire, so
    // only the local name was lying — which is the cheapest kind of confusion
    // to keep and the cheapest to remove. Internal state, no wire change.
    picker.vault = q('vault-select').value;
    q('q').placeholder = picker.vault === 'all' ? 'Search all your memory…' : `Search vault: ${picker.vault}…`;
    search(q('q').value.trim() || seed);
  });
  q('sort').addEventListener('change', () => render(picker.items));
  q('all').addEventListener('change', () => {
    for (const b of document.querySelectorAll('#list input[type=checkbox]')) {
      b.checked = q('all').checked;
      if (b.checked) picker.checked.add(b.dataset.text); else picker.checked.delete(b.dataset.text);
    }
    syncFoot();
  });

  q('insert').addEventListener('click', async () => {
    const chosen = [...document.querySelectorAll('#list input[type=checkbox]')]
      .filter((b) => b.checked).map((b) => b.dataset.text);
    if (!chosen.length) return;
    // Send the CHOSEN FACTS, not a formatted block. The page owns how injected text
    // reads — it used to receive the gateway's ⟦vodou:context v1⟧ fence, which is
    // correct for the invisible network path and wrong in a composer a human reads.
    // Keeping the framing in one place is also why the panel does not need the
    // gateway's fence parts at all.
    const btn = q('insert');
    btn.disabled = true;
    btn.textContent = 'inserting…';
    try {
      const resp = await chrome.tabs.sendMessage(picker.tabId, { type: 'vodou_panel_insert', items: (globalThis.__vodouMarkInserted?.(chosen), chosen) });
      if (resp && resp.ok) {
        q('status').textContent = `✓ added ${chosen.length} to your draft — review and send`;
      } else {
        // Never lose the text. The page refusing an insert is a known failure mode
        // on rich editors, and the clipboard is the fallback that cannot break.
        await navigator.clipboard.writeText(chosen.join('; ') + '.');
        q('status').textContent = `✗ ${(resp && resp.error) || 'insert failed'} — copied to your clipboard instead`;
      }
    } catch (e) {
      q('status').textContent = '✗ the page did not answer — reload the tab and try again';
    }
    syncFoot();
  });

  // An empty seed is NOT a query. Sending '' makes the gateway seed from the
  // conversation's captured turns, which returns plausible-looking but unrelated
  // memories — that is why asking about a wife's name in a Vodou dev chat came back
  // with Vodou memories and looked like a retrieval bug. Say what to do instead.
  if (seed && seed.trim().length >= 2) {
    search(seed.trim());
  } else {
    q('status').textContent = 'type a question in the chat, or search your memory above';
  }
}

// ── Views: Memory / Activity / Settings ──────────────────────────────────────
// Settings live here rather than in a separate options page (plan §3.3 revised by
// Chad, 2026-07-29). The renderers come from controls.js — the module the old popup
// shared before it was retired (2026-07-30, the toolbar icon opens this panel now).
(function views() {
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (name) => {
    for (const t of tabs) t.classList.toggle('on', t.dataset.view === name);
    for (const v of document.querySelectorAll('.view')) {
      v.hidden = v.id !== 'view-' + name;
    }
    // Lazy-init: rendering 44 toggles and the log on every panel open is wasted work
    // for someone who only ever uses Memory.
    if (name === 'settings') initSettings();
    // Inbox open = the G5 moment: render marks unseen briefings seen (11e).
    if (name === 'activity') { initActivity(); renderBriefings(true); renderConflicts(); }
    if (name === 'here') setTabDot('here', false);
    if (name === 'memory') setTabDot('memory', false);
    // Ask shows both streams in one log: panel replies and page-dispatched task cards.
    if (name === 'chat') { initChat(); initTasks(); }
  };
  // Opened by the ⌃⇧Y shortcut → land on Ask, where the work is streaming. `how`
  // arrives as a query param (set by setOptions after open) or, when that race loses,
  // from the background's panel context — same fallback the debug block uses.
  if (params.get('how') === 'task') { show('chat'); }
  else {
    try {
      chrome.runtime.sendMessage({ type: 'get_panel_context' }).then((ctx) => {
        if (ctx && ctx.how === 'task' && ctx.at && Date.now() - ctx.at < 5000) show('chat');
      }).catch(() => {});
    } catch (_) { /* */ }
  }
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.view));
  // PLAN-EXT-PANEL-IA — land on Here when the page lane is on: that is the tab
  // with something to say about where the user is. Off (or undecided) lands on
  // Memory, unchanged. Deterministic before first meaningful paint (one storage
  // read), so the view never jumps under the user after load. The ⌃⇧Y task path
  // above already won if it fired.
  try {
    chrome.storage.local.get(['vodou_page_memory_enabled', 'vodou_page_memory_disclosed_v']).then((st) => {
      const on = st && st.vodou_page_memory_enabled === true;
      // A user who has never been asked (or was asked about an older version of
      // what this reads) must LAND on the tab carrying the ask — otherwise the
      // consent card sits on a tab they never click and the feature is
      // undiscoverable. Someone who declined has answered: they boot to Memory
      // and are not nagged. DISCLOSURE_VERSION is mirrored from the page-memory
      // module; a stale mirror only costs one extra visit to Here.
      const unanswered = !st || Number(st.vodou_page_memory_disclosed_v || 0) < 4;
      if (on || unanswered) {
        const memoryStillDefault = !document.getElementById('view-memory')?.hidden;
        if (memoryStillDefault) show('here');
      }
    }).catch(() => {});
  } catch (_) { /* memory stays the default */ }
})();

// The search box grows with its content to ~3 lines (66px), then scrolls —
// seeded drafts are sentences. Enter never inserts a newline: search is live.
try {
  const qEl = document.getElementById('q');
  if (qEl) {
    qEl.addEventListener('input', () => {
      qEl.style.height = 'auto';
      qEl.style.height = Math.min(66, qEl.scrollHeight) + 'px';
    });
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }
} catch (_) { /* */ }

// The site sheet: everything beyond the one visible site row waits behind "more…".
try {
  const more = document.getElementById('site-more');
  const sheet = document.getElementById('site-sheet');
  if (more && sheet) more.addEventListener('click', () => {
    sheet.hidden = !sheet.hidden;
    more.textContent = sheet.hidden ? 'more…' : 'less';
  });
} catch (_) { /* sheet stays closed */ }

// ── Task cards in the Ask stream (PLAN-VODOU-TASKS-CHANNEL Phase 3) ──────────
// Work dispatched from a PAGE (⌃B / ⌃⇧Y) streams here as cards, in the same log as
// panel replies — one surface for everything Vodou does, rather than a second tab
// with a second composer asking the same question. There is no task composer: from
// the panel, asking IS the task (the chat lane already runs tools and skills).
let tasksReady = false;
function initTasks() {
  if (tasksReady) return;
  tasksReady = true;

  const listEl = q('chat-log');     // shared stream with chat replies
  const statusEl = q('chat-status');
  const cards = new Map();          // jobId → { el, steps, seen:Set<seq> }
  const empty = () => {};           // the chat log owns the empty state

  const chipText = (s) => ({ queued: 'queued', running: '⚡ running', done: '✓ done', failed: '⚠ failed', cancelled: '⏹ stopped' }[s] || s);

  function card(jobId, job) {
    let c = cards.get(jobId);
    if (c) return c;
    const el = document.createElement('div');
    el.className = 'taskcard ' + (job?.status || 'running');
    el.innerHTML = '<div class="thead"><span class="ttitle"></span><span class="tchip"></span></div><div class="tsteps"></div>';
    const hint = listEl.querySelector('.askempty');
    if (hint) hint.remove();                           // real work replaces the invitation
    listEl.appendChild(el);                            // newest at the bottom, like a chat
    listEl.scrollTop = listEl.scrollHeight;
    c = { el, steps: 0, seen: new Set() };
    cards.set(jobId, c);
    return c;
  }

  function paint(jobId, job) {
    const c = card(jobId, job);
    c.el.className = 'taskcard ' + (job.status || 'running');
    c.el.querySelector('.ttitle').textContent = job.title || '(task)';
    const secs = job.endedAt && job.startedAt ? ` · ${Math.round((job.endedAt - job.startedAt) / 1000)}s` : '';
    c.el.querySelector('.tchip').textContent = chipText(job.status) + secs;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') finish(jobId, job);
    else ensureStop(jobId, c);
  }

  function step(jobId, text) {
    const c = card(jobId);
    const d = document.createElement('div');
    d.textContent = text;
    const box = c.el.querySelector('.tsteps');
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
    c.steps++;
  }

  function ensureStop(jobId, c) {
    if (c.el.querySelector('.tactions')) return;
    const row = document.createElement('div');
    row.className = 'tactions';
    const stop = document.createElement('button');
    stop.className = 'link'; stop.textContent = '⏹ stop';
    stop.onclick = () => post({ type: 'task_cancel', jobId });
    row.appendChild(stop);
    c.el.appendChild(row);
  }

  function finish(jobId, job, resultText) {
    const c = card(jobId);
    const text = resultText || (job && job.result && job.result.text) || '';
    let res = c.el.querySelector('.tresult');
    if (text) {
      if (!res) { res = document.createElement('div'); res.className = 'tresult'; c.el.appendChild(res); }
      res.textContent = text;
    }
    const old = c.el.querySelector('.tactions');
    if (old) old.remove();
    const row = document.createElement('div');
    row.className = 'tactions';
    if (text) {
      const send = document.createElement('button');
      send.className = 'primary'; send.textContent = '→ send to chat';
      send.onclick = () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab) return;
          chrome.tabs.sendMessage(tab.id, { type: 'vodou_panel_insert', items: [text] }, (r) => {
            statusEl.textContent = (r && r.ok) ? '✓ sent to the chat — review & send' : '✗ open an AI chat tab first';
          });
        });
      };
      const copy = document.createElement('button');
      copy.className = 'link'; copy.textContent = 'copy';
      copy.onclick = () => navigator.clipboard.writeText(text).then(
        () => { statusEl.textContent = '✓ copied'; }, () => { statusEl.textContent = '✗ copy failed'; });
      row.append(send, copy);
    }
    if (job && job.error) {
      const err = document.createElement('span');
      err.className = 'tchip'; err.textContent = String(job.error).slice(0, 80);
      row.appendChild(err);
    }
    c.el.appendChild(row);
  }

  // Long-lived port to the background task lane (auto-reconnects like the Chat port).
  let port = null;
  const connect = () => {
    try { port = chrome.runtime.connect({ name: 'vodou-tasks' }); } catch (_) { port = null; setTimeout(connect, 800); return; }
    port.onMessage.addListener(onFrame);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 800); });
    try { port.postMessage({ type: 'task_list' }); } catch (_) { /* */ }
  };
  const post = (m) => { if (!port) { connect(); return; } try { port.postMessage(m); } catch (_) { port = null; setTimeout(connect, 300); } };
  connect();

  function onFrame(msg) {
    if (msg.cmd === 'bridge_down') { statusEl.textContent = 'connecting to Vodou…'; return; }
    if (msg.cmd === 'task_list_result') {
      // Do NOT clear the log — it is shared with chat replies. Only render jobs we
      // are not already showing, oldest first so they sit in chronological order.
      for (const j of (msg.jobs || []).slice().reverse()) {
        if (!cards.has(j.jobId)) paint(j.jobId, j);
      }
      return;
    }
    if (msg.cmd === 'task_ack' && msg.jobId && msg.accepted) {
      paint(msg.jobId, { title: msg.title || '(task)', status: 'running', startedAt: Date.now() });
      return;
    }
    if (msg.cmd === 'task_event' && msg.jobId) {
      const c = card(msg.jobId);
      if (typeof msg.seq === 'number') { if (c.seen.has(msg.seq)) return; c.seen.add(msg.seq); }
      const e = msg.event || {};
      if (e.type === 'tool_start') { step(msg.jobId, `🔧 ${e.tool || 'tool'}${e.server ? ' · ' + e.server : ''}`); }
      else if (e.type === 'tool_end') step(msg.jobId, `   ${e.success === false ? '✗' : '✓'} ${e.tool || 'tool'}${e.executionTime ? ' · ' + (e.executionTime / 1000).toFixed(1) + 's' : ''}`);
      else if (e.type === 'status' && e.status) { step(msg.jobId, `· ${e.status}`); }
      else if (e.type === 'error') { step(msg.jobId, `✗ ${e.message || 'error'}`); }
      return;
    }
    if (msg.cmd === 'task_done' && msg.jobId) {
      const status = msg.cancelled ? 'cancelled' : (msg.ok ? 'done' : 'failed');
      const c = card(msg.jobId);
      c.el.className = 'taskcard ' + status;
      const chip = c.el.querySelector('.tchip');
      const secs = msg.result && msg.result.elapsed_ms ? ` · ${Math.round(msg.result.elapsed_ms / 1000)}s` : '';
      chip.textContent = chipText(status) + secs;
      finish(msg.jobId, { error: msg.error }, msg.result && msg.result.text);
      return;
    }
  }

  empty();
}

// ── Chat tab (PLAN-BRAIN-INJECT-LANE Phase 3) ────────────────────────────────
// A full gateway-grade agentic chat, streamed over the long-lived `vodou-chat` Port
// in background.js. The same event stream drives the brain visual, so the panel is
// also the visible surface for what the Face is doing.
let chatReady = false;
function initChat() {
  if (chatReady) return;
  chatReady = true;

  const log = q('chat-log');
  const input = q('chat-input');
  const sendBtn = q('chat-send');
  const stopBtn = q('chat-stop');
  const statusEl = q('chat-status');

  let convId = 'panel:main';
  try { chrome.storage.local.get(['vodou_panel_conversation'], (v) => { if (v && v.vodou_panel_conversation) convId = v.vodou_panel_conversation; requestHistory(); }); } catch (_) {}

  let assistantEl = null;               // the open assistant bubble for the current turn
  const toolRows = new Map();           // toolId → <details>
  let lastSeq = 0;

  const scroll = () => { log.scrollTop = log.scrollHeight; };
  // The empty state is an invitation, not content — it goes the moment anything real
  // lands (a reply, or a task card streaming in from a page).
  const clearEmpty = () => { const e = log.querySelector('.askempty'); if (e) e.remove(); };
  const addMsg = (role, text) => { clearEmpty(); const d = document.createElement('div'); d.className = 'msg ' + role; d.textContent = text || ''; log.appendChild(d); scroll(); return d; };

  /**
   * PLAN-INJECT-RECEIPT-UI — render what the turn actually DID: `4 memories · 2 tools · 1 skill`,
   * expandable to the named items.
   *
   * This is the product claim made visible. Every memory competitor retrieves and pastes;
   * only a brain that ACTED has something to report, which is why a retrieve-and-paste
   * product cannot draw this chip at all.
   *
   * Silent when the turn used nothing — the gateway sends `receipt: null` and we draw
   * nothing. Never "0 memories": a zero reads as failure, and the whole point of the
   * silence-when-ignorant rule is that saying nothing beats saying nothing-shaped.
   */
  function renderReceipt(r) {
    if (!r) return;
    const tools = Array.isArray(r.tools) ? r.tools : [];
    const skills = Array.isArray(r.skills) ? r.skills : [];
    // COHERENCE F8 — the counting and pluralisation live in receipt.js, shared
    // with the in-page toast. The panel keeps the NAMES below; only the summary
    // line was being written twice.
    const parts = globalThis.VodouReceipt.parts(r);
    // buildReceipt sends a receipt for a DEGRADED turn even when it used nothing,
    // because "I tried and the context pipeline missed its budget" is information
    // the user needs — staying quiet is how a degraded turn gets mistaken for an
    // empty one. Returning on !parts.length would have thrown exactly that away.
    const degraded = r.degraded || null;
    if (!parts.length && !degraded) return;

    const wrap = document.createElement('details');
    wrap.className = 'receipt';
    const sum = document.createElement('summary');
    const chip = document.createElement('span');
    chip.className = degraded ? 'chip warn' : 'chip good';
    chip.textContent = degraded
      ? (parts.length ? parts.join(' · ') + ' · limited context' : 'answered with limited context')
      : parts.join(' · ');
    sum.appendChild(chip);
    wrap.appendChild(sum);

    const detail = document.createElement('div');
    detail.className = 'detail';
    const line = (label, values) => {
      if (!values.length) return;
      const d = document.createElement('div');
      const b = document.createElement('span');
      b.className = 'lbl';
      b.textContent = label + ' ';
      d.appendChild(b);
      // textContent, never innerHTML: these strings are memory text and tool names
      // that came off the wire, and this panel renders them next to the user's own words.
      d.appendChild(document.createTextNode(values.join(', ')));
      detail.appendChild(d);
    };
    // Memory items arrive as the daemon's `- [path] snippet` lines; show the snippet.
    line('memory:', (r.memories && Array.isArray(r.memories.items) ? r.memories.items : [])
      .map((s) => String(s).replace(/^-\s*\[[^\]]*\]\s*/, '').slice(0, 90)));
    line('tools:', tools);
    line('skills:', skills);
    // COHERENCE-INTENTIONAL: `degraded.scope` is F42's DEPRECATED ALIAS for
    // `stage` — a pipeline stage, not a memory scope, so it must NOT go through
    // scopeLabel(). Read only as the fallback, so this panel keeps working
    // against a gateway that has not updated yet. Remove with the alias.
    if (degraded) line('limited:', [`${degraded.stage || degraded.scope || 'context'} — ${degraded.reason || 'missed its budget'}`]);
    if (detail.childNodes.length) wrap.appendChild(detail);

    log.appendChild(wrap);
    scroll();
  }

  // Long-lived port to the background service worker. The bridge socket can blip
  // (MV3 SW suspend, gateway restart), so the port auto-reconnects and re-requests
  // history on every (re)connect — a momentary "bridge down" must self-heal, not
  // strand the tab on an error screen.
  let port = null;
  let bridgeDown = false;
  const connect = () => {
    try { port = chrome.runtime.connect({ name: 'vodou-chat' }); } catch (_) { port = null; setTimeout(connect, 800); return; }
    port.onMessage.addListener(onFrame);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 800); });
    // A fresh port: pull history and clear any stale "not connected" notice.
    requestHistory();
    if (bridgeDown) { bridgeDown = false; statusEl.textContent = ''; }
  };

  const post = (m) => { if (!port) { connect(); return; } try { port.postMessage(m); } catch (_) { port = null; setTimeout(connect, 300); } };
  const requestHistory = () => { try { port && port.postMessage({ type: 'chat_history', conversationId: convId, limit: 40 }); } catch (_) {} };
  connect();

  function onFrame(msg) {
    if (msg.cmd === 'chat_history_result' && msg.conversationId === convId) {
      // The log is SHARED with task cards, so never wipe it wholesale — replace only
      // the chat bubbles and tool rows, and keep any task still streaming into view.
      for (const el of log.querySelectorAll('.msg, .toolrow')) el.remove();
      const firstCard = log.querySelector('.taskcard');
      for (const m of msg.messages || []) {
        const d = document.createElement('div');
        d.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
        d.textContent = m.text || '';
        log.insertBefore(d, firstCard || null);        // history precedes live work
      }
      if (msg.messages && msg.messages.length) clearEmpty();
      scroll();
      return;
    }
    if (msg.cmd === 'chat_ack') {
      if (!msg.accepted) statusEl.textContent = msg.error || 'busy — try again';
      return;
    }
    if (msg.cmd === 'bridge_down') {
      // The socket is momentarily down (SW suspend / restart). Say "connecting",
      // not "not running", and let the port's own reconnect + server_info resume
      // heal it — a transient blip must not look like a dead product.
      bridgeDown = true;
      statusEl.textContent = 'connecting to Vodou…'; endTurn();
      setTimeout(() => { if (bridgeDown) requestHistory(); }, 1500);
      return;
    }
    if (msg.cmd !== 'chat_event' || msg.conversationId !== convId) return;
    if (typeof msg.seq === 'number') { if (msg.seq <= lastSeq) return; lastSeq = msg.seq; }
    const e = msg.event || {};
    switch (e.type) {
      case 'status': statusEl.textContent = e.status || ''; break;
      case 'chunk':
        // A text echo of structure this panel already drew (§4b). One rule, not
        // a fourth special case: a surface that rendered the card skips the
        // echo; one that did not renders it and loses nothing. Without this the
        // plan appeared twice — once as the `▤ plan` block, once as prose.
        if (e.echoOf === 'graph') break;
        if (!assistantEl) { assistantEl = addMsg('assistant', ''); }
        assistantEl.textContent += e.content || ''; scroll();
        break;
      case 'tool_start': {
        const row = document.createElement('details'); row.className = 'toolrow';
        const sum = document.createElement('summary'); sum.textContent = `🔧 ${e.tool || 'tool'}${e.server ? ' · ' + e.server : ''} …`;
        row.appendChild(sum); log.appendChild(row); scroll();
        if (e.toolId) toolRows.set(e.toolId, row);
        break;
      }
      case 'tool_end': {
        const row = e.toolId && toolRows.get(e.toolId);
        if (row) {
          row.querySelector('summary').textContent = `🔧 ${e.tool || 'tool'}${e.server ? ' · ' + e.server : ''} · ${e.executionTime ? (e.executionTime / 1000).toFixed(1) + 's ' : ''}${e.success === false ? '✗' : '✓'}`;
          const pre = document.createElement('pre'); pre.textContent = String(e.result || '').slice(0, 2000); row.appendChild(pre);
        }
        break;
      }
      case 'approval': {
        const row = addMsg('assistant', `⚠️ Approve running ${e.tool}?`);
        const yes = document.createElement('button'); yes.className = 'primary'; yes.textContent = 'Approve'; yes.style.marginRight = '6px';
        const no = document.createElement('button'); no.className = 'link'; no.textContent = 'Deny';
        yes.onclick = () => { post({ type: 'chat_approve', conversationId: convId, token: e.token, decision: 'approve' }); row.remove(); };
        no.onclick = () => { post({ type: 'chat_approve', conversationId: convId, token: e.token, decision: 'deny' }); row.remove(); };
        row.appendChild(document.createElement('br')); row.append(yes, no);
        break;
      }
      // ── item 12 — the graph lane ────────────────────────────────────
      // The panel is where someone stands while using ANOTHER vendor's AI, so a
      // run that parks for permission has to be answerable here. Every case
      // renders the text the driver sent; nothing is re-derived locally, so the
      // panel cannot describe a plan the gateway did not produce.
      case 'graph_plan': {
        const g = e.graph || {};
        const text = (g.plan && g.plan.text) || '';
        if (!text) break;                       // no canonical text = nothing honest to draw
        const row = document.createElement('details');
        row.className = 'toolrow graphplan';
        row.open = true;
        const sum = document.createElement('summary');
        sum.textContent = `▤ plan${g.skill ? ' · ' + g.skill : ''}`;
        row.appendChild(sum);
        const pre = document.createElement('pre');
        pre.textContent = text;                 // textContent, never innerHTML
        row.appendChild(pre);

        // [Run it] — without this the plan is a dead end here.
        //
        // The panel rendered the offer and gave no way to act on it, so nothing
        // ever ran, so `graph_ask` could never fire and the ask renderer below
        // was unreachable from this surface. Found by opening the panel and
        // watching a correct plan arrive with nowhere to go.
        //
        // Same call the web card makes (`chat.js` [Run once]) — POST the recipe
        // to the driver, NOT `sendMessage('run it')`, because the driver is what
        // enforces the `ask me:` gate this very plan is warning about.
        const recipe = g.plan && g.plan.recipe;
        if (recipe) {
          const run = document.createElement('button');
          run.className = 'primary';
          run.textContent = 'Run it';
          run.style.margin = '6px 0 0';
          run.onclick = async () => {
            run.disabled = true; run.textContent = 'Running…';
            try {
              const res = await fetch(gatewayBase() + '/api/graph/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipe, conversationId: convId }),
              });
              const out = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(out.error || 'run failed');
            } catch (err) {
              run.disabled = false; run.textContent = 'Run it';
              statusEl.textContent = '✗ ' + (err && err.message ? err.message : 'run failed');
            }
          };
          row.appendChild(run);
        }
        // [Save] — the same three things the web form asks for, posted to the
        // same endpoint. Kept SMALL on purpose: a panel is not the place for a
        // long form, but "save this and run it every morning" is the one
        // thing a person most wants to do from wherever they happened to be.
        if (recipe) {
          const saveBtn = document.createElement('button');
          saveBtn.className = 'link';
          saveBtn.style.margin = '6px 0 0 8px';
          saveBtn.textContent = 'Save';
          saveBtn.onclick = () => {
            saveBtn.disabled = true;
            const form = document.createElement('div');
            form.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px';
            // A LABEL above each input, not a placeholder inside it. The first
            // cut used placeholders, and a prefilled value hides its own
            // placeholder — so the two suggested fields rendered as unlabeled
            // boxes containing the word "post". Seen in a screenshot, not a test.
            const field = (label, val, hint) => {
              const wrap = document.createElement('label');
              wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--text-secondary)';
              wrap.textContent = label;
              const i = document.createElement('input');
              i.type = 'text'; i.value = val || ''; i.autocomplete = 'off';
              if (hint) i.placeholder = hint;
              i.style.cssText = 'font-size:12px;padding:4px 6px;border:1px solid var(--line,#2A3441);border-radius:6px;background:transparent;color:inherit';
              wrap.appendChild(i); form.appendChild(wrap); return i;
            };
            // Suggest a name from the step that names the OUTCOME. The synthesis
            // step ("summary", "brief") is the right one when there is one;
            // failing that the last tool that is NOT a send — the send is what
            // the workflow does with the result, not what it is. "post" was the
            // first cut's suggestion, and "post" names nothing.
            const rows = (g.plan && g.plan.rows) || [];
            const real = rows.filter((r) => r.block === 'together' || r.block === 'then');
            const named = real.find((r) => !r.tool) || real.filter((r) => !r.sideEffecting).pop() || real[real.length - 1];
            const suggested = ((named && named.id) || 'my workflow').replace(/[-_]+/g, ' ');
            const nameIn = field('Name', suggested);
            const trigIn = field('Say this to run it', suggested);
            const schedIn = field('Schedule (optional)', '', 'every 1d · at 09:00 · 0 9 * * 1');
            const go = document.createElement('button');
            go.className = 'primary'; go.textContent = 'Save skill';
            const status = document.createElement('div');
            status.style.cssText = 'font-size:11px;color:var(--text-secondary)';
            go.onclick = async () => {
              go.disabled = true; status.textContent = 'Saving…';
              try {
                const res = await fetch(gatewayBase() + '/api/graph/save', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    recipe,
                    name: nameIn.value,
                    triggers: trigIn.value.trim() ? [trigIn.value.trim()] : [],
                    schedule: schedIn.value.trim() || undefined,
                  }),
                });
                const out = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(out.error || 'save failed');
                // Name each part that was created. A schedule that FAILED must be
                // said out loud — the skill is saved, and reporting "done" here
                // would be the convenient lie.
                let msg = 'Saved as “' + out.name + '”. Say “' + ((out.triggers || [])[0] || out.name) + '” to run it.';
                if (out.scheduled) msg += ' Scheduled: ' + out.scheduled + '.';
                if (out.scheduleError) msg += ' The skill saved, but the SCHEDULE did not: ' + out.scheduleError;
                status.textContent = msg;
              } catch (err) {
                go.disabled = false;
                status.textContent = '✗ ' + (err && err.message ? err.message : 'save failed');
              }
            };
            form.append(go, status);
            row.appendChild(form);
            nameIn.focus();
          };
          row.appendChild(saveBtn);
        }
        // "Just answer it" — for when the plan was a wrong guess about a
        // sentence that only MENTIONED a schedule or workflow. Re-sends the
        // same text with the offer suppressed for that one turn.
        if (g.plan && g.plan.sentence) {
          const no = document.createElement('button');
          no.className = 'link';
          no.style.margin = '6px 0 0 8px';
          no.textContent = 'Just answer it';
          no.onclick = () => {
            no.disabled = true;
            input.value = g.plan.sentence;
            send({ skipGraphOffer: true });
          };
          row.appendChild(no);
        }

        log.appendChild(row); clearEmpty(); scroll();
        break;
      }
      case 'graph_branch': {
        const g = e.graph || {};
        const n = Array.isArray(g.branches) ? g.branches.length : (g.width || 0);
        addGraphLine(g.elapsedMs != null
          ? `⋔ ${g.group || 'together'} — ${n} finished in ${(g.elapsedMs / 1000).toFixed(1)}s`
          : `⋔ ${g.group || 'together'} — running ${n} at once`);
        break;
      }
      case 'graph_join': {
        const g = e.graph || {};
        addGraphLine(`⋈ ${g.line || `join — ${g.ok}/${g.expected}`}${g.met === false ? '  ✗' : ''}`);
        break;
      }
      case 'graph_check': {
        const g = e.graph || {};
        addGraphLine(`✓ ${g.line || 'check'}${g.met === false ? '  — REFUSED' : ''}`);
        break;
      }
      case 'graph_ask': {
        const g = e.graph || {};
        const ask = g.ask || {};
        const row = addMsg('assistant', ask.title || 'Vodou needs an answer');
        const opts = Array.isArray(ask.options) ? ask.options : [];
        if (opts.length) {
          // Answer the RUN, not the chat. The first cut sent the number as a
          // chat message on the theory that "typing 1 still works" — but the
          // panel lane has no ask-answer path, so the "1" arrived at chat() as
          // a fresh turn and a model improvised a whole table about it. The web
          // card answers through `/api/graph/runs/:runId/answer`; so does this.
          const wrap = document.createElement('div');
          wrap.style.marginTop = '6px';
          const note = document.createElement('div');
          note.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px';
          for (const o of opts) {
            const b = document.createElement('button');
            b.className = 'link';
            b.style.marginRight = '6px';
            b.textContent = `${o.n}. ${o.label}`;
            b.onclick = async () => {
              for (const x of wrap.querySelectorAll('button')) x.disabled = true;
              if (!g.runId) { note.textContent = '✗ this ask carries no run id — cannot answer it'; return; }
              note.textContent = 'answering…';
              try {
                const res = await fetch(gatewayBase() + '/api/graph/runs/' + encodeURIComponent(g.runId) + '/answer', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ answer: String(o.n), conversationId: convId }),
                });
                const out = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(out.error || 'answer failed');
                note.textContent = '✓ ' + o.label;
              } catch (err) {
                for (const x of wrap.querySelectorAll('button')) x.disabled = false;
                note.textContent = '✗ ' + (err && err.message ? err.message : 'answer failed');
              }
            };
            wrap.appendChild(b);
          }
          wrap.appendChild(note);
          row.appendChild(document.createElement('br'));
          row.appendChild(wrap);
        }
        scroll();
        break;
      }
      case 'graph_done': {
        const g = e.graph || {};
        addGraphLine(`▣ ${g.outcome || 'done'}${g.line ? ' — ' + g.line : ''}`);
        break;
      }
      case 'error': statusEl.textContent = '✗ ' + (e.message || 'error'); endTurn(); break;
      // COHERENCE F30 — the receipt is its OWN frame, emitted just before `done`
      // so it can render against the still-live turn container. This panel used
      // to read `e.receipt` off `done`, where the server has never put it: all
      // 21 `done` emitters in the running build omit the field, so renderReceipt
      // was called with undefined on every turn and returned at its first line.
      // The receipt code was complete and simply never ran.
      case 'turn_receipt':
        renderReceipt(e.receipt);
        break;
      case 'done':
        statusEl.textContent = e.memory && e.memory.used ? `used ${e.memory.used} ${e.memory.used === 1 ? 'memory' : 'memories'} · ${e.activeModel || ''}` : (e.activeModel || 'ready');
        endTurn();
        break;
    }
  }

  // One line in the run's own voice. Kept out of `assistantEl` deliberately: a
  // graph line is a RECORD of what happened, not model prose, and welding it
  // into the bubble would make it part of the saved transcript.
  function addGraphLine(text) {
    const d = document.createElement('div');
    d.className = 'msg assistant graphline';
    d.textContent = text;
    log.appendChild(d); clearEmpty(); scroll();
    return d;
  }

  function startTurn() { assistantEl = null; toolRows.clear(); sendBtn.disabled = true; stopBtn.hidden = false; }
  function endTurn() { sendBtn.disabled = false; stopBtn.hidden = true; }

  const send = (opts) => {
    const text = input.value.trim();
    if (!text) return;
    addMsg('user', text);
    input.value = ''; input.style.height = 'auto';
    startTurn();
    statusEl.textContent = 'thinking…';
    post({ type: 'chat_send', reqId: 'p_' + Date.now().toString(36), conversationId: convId, text,
           ...(opts && opts.skipGraphOffer ? { skipGraphOffer: true } : {}) });
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  stopBtn.addEventListener('click', () => { post({ type: 'chat_stop', conversationId: convId }); endTurn(); });
  q('chat-new').addEventListener('click', (ev) => {
    ev.preventDefault();
    convId = 'panel:main:' + Date.now().toString(36);
    try { chrome.storage.local.set({ vodou_panel_conversation: convId }); } catch (_) {}
    // Clear the CONVERSATION, not the log: a task running in the background is not
    // part of this chat and shouldn't be thrown away because you started a new one.
    for (const el of log.querySelectorAll('.msg, .toolrow')) el.remove();
    lastSeq = 0; statusEl.textContent = 'new chat';
  });
}

/**
 * A single checkbox stored on `vodou_inject_settings`. For options that modify how
 * Vodou behaves rather than WHERE it works — the site list above answers "where", once.
 *
 * Defaults OFF: every option wired through here either sends on the user's behalf or
 * lets Vodou act, so a missing value can only ever mean off.
 * `vals` maps the checkbox to non-boolean storage (e.g. 'all' | 'read').
 */
function simpleToggle(elId, key, vals) {
  const el = q(elId);
  if (!el) return;
  const onVal = vals ? vals.on : true;
  const read = (raw) => (vals ? raw[key] === vals.on : raw[key] === true);
  try {
    chrome.storage.local.get(['vodou_inject_settings'], (v) => {
      el.checked = read((v && v.vodou_inject_settings) || {});
    });
    el.addEventListener('change', () => {
      chrome.storage.local.get(['vodou_inject_settings'], (v) => {
        const raw = (v && v.vodou_inject_settings) || {};
        const next = el.checked ? onVal : (vals ? vals.off : false);
        chrome.storage.local.set({ vodou_inject_settings: Object.assign({}, raw, { [key]: next }) });
      });
    });
  } catch (_) { /* storage unavailable */ }
}

let settingsReady = false;
function initSettings() {
  if (settingsReady) return;
  settingsReady = true;

  // Toggle config for both lanes, from the shared module.
  vodouSiteToggles({
    masterId: 'auto-capture',
    hostId: 'capture-sites',
    keyOf: (s) => s.capture,
    read(cb) {
      try {
        chrome.storage.local.get(['vodou_auto_capture', 'vodou_capture_sites', 'vodou_capture_policy'], (v) => cb({
          master: !!(v && v.vodou_auto_capture),
          sites: (v && v.vodou_capture_sites) || {},
          veto: ((v && v.vodou_capture_policy) || {}).providers || {},
          raw: null,
        }));
      } catch (_) { cb({ master: false, sites: {}, veto: {}, raw: null }); }
    },
    write(master, sites) {
      try { chrome.storage.local.set({ vodou_auto_capture: master, vodou_capture_sites: sites }); } catch (_) {}
    },
  });

  vodouSiteToggles({
    masterId: 'inject-master',
    hostId: 'inject-sites',
    keyOf: (s) => s.key,
    read(cb) {
      try {
        chrome.storage.local.get(['vodou_inject_settings'], (v) => {
          const raw = (v && v.vodou_inject_settings) || {};
          cb({ master: raw.master !== false, sites: raw.sites || {}, raw });
        });
      } catch (_) { cb({ master: true, sites: {}, raw: {} }); }
    },
    write(master, sites, raw) {
      try {
        chrome.storage.local.set({ vodou_inject_settings: Object.assign({}, raw, { master, sites }) });
      } catch (_) {}
    },
  });

  // Auto-attach on send. Lives in the SAME vodou_inject_settings object because it
  // is a property of inject, not a second feature — but under its own keys, so a
  // user who has armed Ctrl+B on ten sites has not thereby armed sending on them.
  //
  // `autoSend !== true` rather than `!== false`: this one defaults OFF and must
  // stay off for anyone who never opens this panel. It is the setting that makes
  // "nothing is sent on your behalf" untrue, so a missing value can only ever mean
  // off — the opposite convention to master above, deliberately.
  // Auto-attach and brain mode are MASTER-ONLY now. They used to carry their own
  // 22-site grids, which meant 88 checkboxes in Settings and three separate answers
  // to "which sites does Vodou work on". One list (inject-sites, above) governs where;
  // these govern what happens there.
  simpleToggle('inject-autosend', 'autoSend');
  simpleToggle('inject-brain', 'brain');
  // PLAN-HISTORY-BACKFILL P1 — same `!== true` convention as autoSend and brain:
  // a missing value can only mean OFF, because this one decides whether years of
  // older conversation get read rather than just the next turn.
  simpleToggle('inject-backfill', 'backfill');
  simpleToggle('inject-brain-act', 'brainTools', { on: 'all', off: 'read' });

  // Task-completion notifications. NOT a vodou_inject_settings key: background.js
  // reads the top-level `vodou_task_notify` and treats only an explicit `false` as
  // off, so this defaults ON — the opposite convention to simpleToggle, which is
  // why it is wired by hand rather than forced through it.
  //
  // It exists because the `notifications` permission shipped with an opt-out that
  // had no surface: background.js honoured the key, nothing ever wrote it. A
  // permission the user cannot decline is not one you can justify to a reviewer.
  (() => {
    const el = q('task-notify');
    if (!el) return;
    try {
      chrome.storage.local.get(['vodou_task_notify'], (v) => {
        el.checked = !(v && v.vodou_task_notify === false);
      });
      el.addEventListener('change', () => {
        try { chrome.storage.local.set({ vodou_task_notify: el.checked }); } catch (_) {}
      });
    } catch (_) { /* storage unavailable */ }
  })();

  // Console Two opt-in. `vodou_console_two` defaults OFF: this panel is the
  // default surface until the new one is finished, so a missing value can only
  // ever mean off — same convention as autoSend, the opposite of the capture
  // master. background.js caches this key and picks the panel page from it at
  // open() time (it cannot read storage there — the user gesture would be spent).
  //
  // The panel cannot repoint itself while it is the open document, so switching
  // takes effect on the NEXT open. The hint says so rather than leaving the user
  // tapping a checkbox that appears to do nothing.
  (() => {
    const el = q('console-two');
    if (!el) return;
    try {
      chrome.storage.local.get(['vodou_console_two'], (v) => {
        el.checked = !!(v && v.vodou_console_two === true);
      });
      el.addEventListener('change', () => {
        try { chrome.storage.local.set({ vodou_console_two: el.checked }); } catch (_) {}
      });
    } catch (_) { /* storage unavailable */ }
  })();

  // Connection, pairing and gateway — the panel is the ONLY settings surface now
  // (the popup retired 2026-07-30). The contracts are background.js's messages:
  // set_enabled / set_gateway_url / set_pair_code / set_allow_custom_gateway.
  const paint = (st) => {
    if (!st) return;
    q('s-gw').textContent = st.gateway_url || 'ws://127.0.0.1:8765/api/vbb';
    const pairedEl = q('s-paired');
    if (pairedEl) {
      pairedEl.textContent = st.paired ? 'paired ✓'
        : st.pairing_required ? 'required — not paired'
        : st.connected ? 'not required' : '—';
    }

    // Pairing surfaces only when the gateway demands it — an always-visible code box
    // invites people to type something into a field that does nothing.
    q('s-pair').hidden = !st.pairing_required;
    const pairLink = q('s-pair-link');
    if (pairLink) pairLink.href = pairCodeUrl(st);

    // Custom gateway is store-build-shaped; these elements are absent elsewhere.
    // Rendered only when the running build actually handles set_allow_custom_gateway —
    // otherwise the checkbox would be a control that silently does nothing. The build
    // tells us: its get_status reports the field, or it does not.
    const allowWrap = q('s-allow-wrap');
    const buildHasLock = st && Object.prototype.hasOwnProperty.call(st, 'allow_custom_gateway');
    if (allowWrap && buildHasLock) {
      const allow = !!st.allow_custom_gateway;
      allowWrap.hidden = false;
      q('s-allow').checked = allow;
      q('s-allow-hint').hidden = allow;
      q('s-gw-edit').hidden = !allow;
      if (allow && q('s-gw-url') && document.activeElement !== q('s-gw-url')) {
        q('s-gw-url').value = st.gateway_url || '';
      }
    } else if (allowWrap) {
      // Sideload: the gateway URL is editable directly, no opt-out gate to show.
      allowWrap.hidden = true;
      q('s-allow-hint').hidden = true;
      q('s-gw-edit').hidden = false;
      if (q('s-gw-url') && document.activeElement !== q('s-gw-url')) {
        q('s-gw-url').value = st.gateway_url || '';
      }
    }

  };

  const refresh = () => chrome.runtime.sendMessage({ type: 'get_status' }).then(paint).catch(() => {});
  refresh();
  // 2s cadence, so a Vodou restart shows up without reopening the panel.
  setInterval(refresh, 2000);

  q('s-pair-save').addEventListener('click', async () => {
    const code = q('s-pair-code').value.trim();
    if (!code) return;
    await chrome.runtime.sendMessage({ type: 'set_pair_code', code }).catch(() => {});
    setTimeout(refresh, 600);
  });

  // Enabling a custom gateway is the one setting that can send chat data off this
  // machine, so it keeps its friction. An inline two-step rather than confirm():
  // a modal dialog in an extension page blocks the surface it is drawn in.
  const allowBox = q('s-allow');
  if (allowBox) {
    allowBox.addEventListener('change', () => {
      if (allowBox.checked) {
        allowBox.checked = false;              // not yet — confirm first
        q('s-allow-confirm').hidden = false;
      } else {
        chrome.runtime.sendMessage({ type: 'set_allow_custom_gateway', allow: false })
          .catch(() => {});
        setTimeout(refresh, 300);
      }
    });
    q('s-allow-yes').addEventListener('click', (e) => {
      e.preventDefault();
      q('s-allow-confirm').hidden = true;
      chrome.runtime.sendMessage({ type: 'set_allow_custom_gateway', allow: true }).catch(() => {});
      setTimeout(refresh, 300);
    });
    q('s-allow-no').addEventListener('click', (e) => {
      e.preventDefault();
      q('s-allow-confirm').hidden = true;
      refresh();
    });
  }

  q('s-gw-save').addEventListener('click', async () => {
    const url = q('s-gw-url').value.trim();
    if (!url) return;
    await chrome.runtime.sendMessage({ type: 'set_gateway_url', url }).catch(() => {});
    setTimeout(refresh, 300);
  });

  q('s-version').textContent = chrome.runtime.getManifest().version;
}

let activityReady = false;
function initActivity() {
  if (activityReady) return;
  activityReady = true;
  vodouActivityLog({ logId: 'activity-log', clearId: 'activity-clear' });
}

// ── PLAN-DOCUMENT-LIBRARY §3.7.1 Lane C-lite ─────────────────────────────────
//
// "Which of my documents are relevant to the page I'm looking at?" — answered
// only while this panel is open.
//
// That scoping IS the design. Full Lane C (matching continuously in the
// background) would need broad host access, which costs a permission prompt, a
// recurring CWS review tax on every future update, and — the real price — it is
// the feature that most resembles surveillance, one of exactly four objections
// the store listing answers. All of that to change only WHEN a card surfaces,
// since asking a question already surfaces one. Opening the panel is already
// intent, so C-lite gets most of the feel for none of the cost.
//
// Only the tab's TITLE and HOST are used as the query. The page body is never
// read here — that is Lane B, and it takes a deliberate click.
// Shared by BOTH page-aware sections — the library lane below and the page-memory
// lane after it. Hoisted out of initDocMatch when P1 added the second consumer:
// PLAN-MEMORY-ON-EVERY-PAGE says to reuse these rather than grow a second copy of
// "where is the gateway", which is exactly the kind of thing that drifts and then
// only one of the two sections can reach a gateway on a non-default port.
function gatewayBase() {
  try {
    const raw = document.getElementById('s-gw')?.textContent || 'ws://127.0.0.1:8765/api/vbb';
    const u = new URL(raw);
    return 'http://' + u.hostname + ':' + (u.port || 8765);
  } catch (_) {
    return 'http://127.0.0.1:8765';
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(function initDocMatch() {
  let docTabId = null;   // the tab the card describes (Attach target)
  const box = document.getElementById('doc-match');
  const list = document.getElementById('doc-match-list');
  if (!box || !list) return;

  let lastQuery = '';
  // Shown at most once per panel session. The condition is permanent until the
  // user updates, and refresh() runs on every tab change — so the honest choice
  // is to say it once, not to hide it forever and not to repeat it on every tab.
  let toldAppTooOld = false;

  async function refresh() {
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) { return; }
    const url = (tab && tab.url) || '';
    if (!/^https?:/i.test(url)) { box.hidden = true; return; }
    docTabId = (tab && tab.id) || null;

    // KEYED ON THE URL, NOT THE TITLE. Two different pages on an SPA routinely
    // share a title ("Notion", "ChatGPT"), so a title-only key made navigation
    // within a site look like "same page, nothing to do" and the box kept showing
    // the previous page's documents.
    const query = [(tab.title || '').trim(), hostOf(url)].filter(Boolean).join(' ').trim();
    const key = [url, query].join('|');
    if (!query || key === lastQuery) return;

    try {
      const res = await fetch(gatewayBase() + '/api/library/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, topK: 3 }),
      });
      if (!res.ok) {
        // A 404 here is not "no documents matched" — /api/library/match answers
        // 400/500 about its subject and never 404s, so a 404 means the route is
        // not mounted: the app predates the Library. Silence would leave the
        // operator waiting for a panel that is never going to fill in.
        if (globalThis.VodouGatewayError?.isMissingRoute(res.status) && !toldAppTooOld) {
          const why = await globalThis.VodouGatewayError.describe(
            new Error('HTTP ' + res.status), res.status, 'document matching', gatewayBase());
          toldAppTooOld = true;
          list.innerHTML = '<div style="font-size:11px;opacity:.6;padding:6px 0">' + esc(why) + '</div>';
          box.hidden = false;
          return;
        }
        box.hidden = true;
        return;
      }
      const data = await res.json();
      // COMMITTED ONLY ON SUCCESS. Marking the page as "already asked" before the
      // request settled meant one failed fetch — a gateway still booting, a dropped
      // connection — permanently silenced this box for that page: every later
      // refresh saw the key unchanged and returned early, so the panel stayed empty
      // until the tab's title happened to change. Silent, and indistinguishable
      // from "no documents matched".
      lastQuery = key;
      render((data && data.matches) || []);
    } catch (_) {
      // Gateway down is not worth shouting about in a passive panel — but it must
      // stay RETRYABLE, hence no key commit here either.
      box.hidden = true;
    }
  }

  function render(matches) {
    if (!matches.length) { box.hidden = true; list.innerHTML = ''; return; }
    list.innerHTML = matches.map(function (m) {
      // A topic hit means "this document DISCUSSES what's on this page", not
      // "this page is about this document". Labelling them identically would
      // overstate the weaker claim, so the badge says which one it is.
      var badge = m.via === 'topic'
        ? '<span style="font-size:9px;opacity:.55;border:1px solid currentColor;border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:1px">mentions</span>'
        : '';
      // Two named actions beat one jargon hint (Chad, 2026-08-20). "click to
      // copy @doc: token" told a newcomer nothing and asked them to paste by
      // hand; the panel already owns an insert lane into the page's composer,
      // and the Library already deep-links per document (/library/#<id>).
      var act = 'font-size:11px;padding:2px 8px;background:transparent;color:inherit;' +
        'border:1px solid var(--border-primary);border-radius:6px;cursor:pointer';
      // `data-slug` is the token the SERVER minted (COHERENCE F13). The panel
      // used to derive it from the name here and again in the page-memory lane;
      // a token computed two ways is two documents.
      return '<div class="doc-hit" data-id="' + m.id + '" data-name="' + esc(m.name) + '" ' +
        'data-slug="' + esc(String(m.slug || m.id)) + '" ' +
        'style="padding:7px 0;border-top:1px solid rgba(255,255,255,.05)">' +
        '<div style="font-size:12px;font-weight:500">' + esc(m.name) + badge + '</div>' +
        (m.why ? '<div style="font-size:11px;opacity:.6;line-height:1.35">' + esc(m.why) + '</div>' : '') +
        '<div style="display:flex;gap:6px;align-items:center;margin-top:5px">' +
        '<button type="button" class="doc-attach" style="' + act + '" ' +
        'title="Put a reference to this document into the message you are writing">Attach to chat</button>' +
        '<button type="button" class="doc-open" style="' + act + '" ' +
        'title="Read this document in your Vodou Library">Open ↗</button>' +
        '<span class="doc-hint" style="font-size:11px;opacity:.55"></span>' +
        '</div>' +
        '</div>';
    }).join('');
    box.hidden = false;
  }

  // Click copies the attach token the server handed us with the row — the same
  // string `doc-attach.ts` will resolve, because it is the string it minted.
  list.addEventListener('click', async function (e) {
    const el = e.target.closest('[data-id]');
    if (!el) return;
    const id = el.getAttribute('data-id');
    const name = el.getAttribute('data-name') || '';
    const slug = el.getAttribute('data-slug') || id;
    const hint = el.querySelector('.doc-hint');
    const say = (msg) => {
      if (!hint) return;
      hint.textContent = msg;
      setTimeout(function () { hint.textContent = ''; }, 2500);
    };

    // Open — the Library already deep-links per document (/library/#<id>, with a
    // hashchange listener, so an already-open Library jumps rather than reloads).
    if (e.target.closest('.doc-open')) {
      window.open(gatewayBase() + '/library/#' + encodeURIComponent(id), '_blank', 'noopener');
      return;
    }

    // Attach — insert the DOCUMENT, not a token.
    //
    // `@doc:<slug>` is resolved server-side at the top of the gateway's chat()
    // (doc-attach.ts), so it means something on every surface where Vodou is
    // listening: the console, Console Two, the ten channels, a skill prompt.
    // This panel inserts into a FOREIGN AI's composer — ChatGPT, Claude,
    // Gemini — where nothing resolves it: OpenAI would receive the literal
    // string and answer that it cannot see the document. So we do here what
    // the gateway does there, and hand over the same payload: the card (the
    // routing summary the model would be given) plus body up to the same
    // INLINE_BUDGET, clearly truncated. One document, one shape, whichever
    // road it travels.
    const INLINE_BUDGET = 12000;
    say('attaching…');
    let payload = '';
    try {
      const r = await fetch(gatewayBase() + '/api/library/' + encodeURIComponent(id), { cache: 'no-store' });
      const d = await r.json();
      const card = (d && d.card ? String(d.card) : '').trim();
      let body = (d && d.body ? String(d.body) : '').trim();
      let truncated = false;
      if (body.length > INLINE_BUDGET) { body = body.slice(0, INLINE_BUDGET); truncated = true; }
      const parts = ['[Document: ' + name + ']'];
      if (card) parts.push(card);
      if (body) parts.push(body);
      if (truncated) parts.push('[…truncated — the full document is in the user\'s Vodou Library]');
      payload = parts.join('\n\n');
    } catch (_) {
      // Vodou unreachable: the token is still the honest fallback for a
      // Vodou-listening destination, and says so rather than pretending.
      payload = '@doc:' + slug;
    }

    if (docTabId) {
      try {
        const resp = await chrome.tabs.sendMessage(docTabId, { type: 'vodou_panel_insert', items: [payload] });
        if (resp && resp.ok) {
          say(payload.startsWith('@doc:') ? 'added the reference (Vodou unreachable)' : '✓ document added to your draft');
          return;
        }
      } catch (_) { /* fall through to the clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(payload);
      say('copied to your clipboard — paste it into your chat');
    } catch (_) {
      say('could not attach here');
    }
  });

  refresh();
  if (chrome.tabs && chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(refresh);
  if (chrome.tabs && chrome.tabs.onUpdated) {
    // `status === 'complete'` alone MISSES SPA NAVIGATION. A pushState route
    // change fires onUpdated with a new `url` and no status transition, so moving
    // between Notion pages or ChatGPT threads never re-queried and the box kept
    // describing the page you left. Both triggers, with the key above making the
    // duplicate call a no-op.
    chrome.tabs.onUpdated.addListener(function (_id, info) {
      if (info.status === 'complete' || info.url) refresh();
    });
  }
})();

// ── Your memory here — PLAN-MEMORY-ON-EVERY-PAGE P1 ─────────────────────────
//
// T1/T2 of the three tiers. The claim is PROVENANCE, not similarity: these rows
// were recorded while you were on this page (T1) or elsewhere on this host (T2),
// which is a fact the database stored, so nothing here is scored or ranked. T3
// ("documents ABOUT this page") is the library lane above, and it is deliberately
// a separate box — merging a fact and an inference into one list would let the
// weaker claim borrow the stronger one's authority.
//
// Like the library lane this is only ever populated while the panel is OPEN,
// which is already the operator expressing intent, so it needs no new permission
// and creates no browsing log. The plan is explicit that a passive timeline is
// never built.
// ── PLAN-MEMORY-ON-EVERY-PAGE P6 — the fill review card ─────────────────────
(function initFillCard() {
  const card = document.getElementById('fill-card');
  const list = document.getElementById('fill-card-list');
  const foot = document.getElementById('fill-card-foot');
  const status = document.getElementById('fill-card-status');
  const applyBtn = document.getElementById('fill-card-apply');
  const countEl = document.getElementById('fill-card-count');
  const learnCb = document.getElementById('fill-card-learn');
  const learnWrap = document.getElementById('fill-card-learn-wrap');
  const closeBtn = document.getElementById('fill-card-close');
  if (!card || !list || !foot || !applyBtn) return;
  let current = null;   // { tabId, model, plan }

  const IDENTITY_AC = /^(name|given-name|family-name|additional-name|honorific|nickname|email|tel|tel-|organization|organization-title|street-address|address-|postal-code|country|bday|username|url|impp|sex|language)/;
  function kindLabel(k) { return k === 'page' ? 'you answered here' : k === 'site' ? 'you answered on this site' : k === 'draft' ? 'drafted from memory' : k === 'memory' ? 'from memory' : ''; }

  function render(state) {
    current = state;
    const model = state.model || { fields: [] };
    const plan = state.plan || { proposals: [] };
    const byId = new Map((plan.proposals || []).map((p) => [p.id, p]));
    const have = (plan.proposals || []).length;
    if (status) status.textContent = state.error ? '' : (state.pending ? (have ? `${have} of ${model.fields.length} answered instantly · asking your memory for the rest…` : 'asking your memory…') : `${have} of ${model.fields.length} fields have an answer`);
    if (state.error) {
      list.innerHTML = '<div style="font-size:11px;opacity:.7;padding:4px 0">' + esc(state.error) + '</div>';
      foot.hidden = true; card.hidden = false; flagHere();
      return;
    }
    const rows = model.fields.map((f) => {
      const p = byId.get(f.id);
      const val = p ? p.value : '';
      const conf = p ? Math.round((p.confidence || 0) * 100) : 0;
      const tick = !!p && (p.confidence || 0) >= 0.5 && !f.hasValue;
      const src = p ? (kindLabel(p.kind) + (p.source ? ' · “' + esc(String(p.source).slice(0, 80)) + '”' : '')) : (f.hasValue ? 'already filled' : 'nothing in memory');
      const multi = !!f.multiline;
      return '<div class="fc-row" data-id="' + esc(f.id) + '" data-sel="' + esc(f.sel || '') + '" data-ac="' + esc(f.autocomplete || '') + '" data-kind="' + esc(p ? p.kind : '') + '" data-proposed="' + esc(val) + '" data-source-id="' + esc(p && p.sourceId ? p.sourceId : '') + '" data-source="' + esc(p && p.source ? String(p.source).slice(0, 300) : '') + '" style="display:grid;grid-template-columns:18px 1fr;gap:6px;padding:5px 0;border-top:1px solid rgba(255,255,255,.05)">'
        + '<input type="checkbox" class="fc-ck" ' + (tick ? 'checked' : '') + ' ' + (p ? '' : 'disabled') + ' style="margin-top:4px">'
        + '<div class="fc-body" style="min-width:0">'
        + '<div class="fc-head" style="font-size:11px;opacity:.7;display:flex;gap:6px;align-items:baseline"><span class="fc-label" style="font-weight:600">' + esc(f.label || f.placeholder || f.name || f.type) + '</span>' + (f.required ? '<span style="opacity:.6">required</span>' : '') + '<span class="fc-conf" style="margin-left:auto;opacity:.6">' + (p ? conf + '%' : '') + '</span></div>'
        + (multi
          ? '<textarea class="fc-val" rows="2" style="width:100%;font-size:12px;padding:3px 5px;border:1px solid var(--line,#2A3441);border-radius:6px;background:transparent;color:inherit;resize:vertical" placeholder="' + (p ? '' : 'nothing proposed — type to fill') + '">' + esc(val) + '</textarea>'
          : '<input class="fc-val" type="text" value="' + esc(val) + '" style="width:100%;font-size:12px;padding:3px 5px;border:1px solid var(--line,#2A3441);border-radius:6px;background:transparent;color:inherit" placeholder="' + (p ? '' : 'nothing proposed — type to fill') + '">')
        + '<div class="fc-meta" style="font-size:10px;opacity:.5;margin-top:2px">' + src + '</div>'
        + '</div></div>';
    }).join('');
    list.innerHTML = rows || '<div style="font-size:11px;opacity:.7">No fillable fields found on this page.</div>';
    // Typing into an unproposed row enables its checkbox.
    const fixWrap = document.getElementById('fill-card-fix-wrap');
    const anyEdited = () => [...list.querySelectorAll('.fc-row')].some((row) => row.dataset.sourceId && row.dataset.kind === 'memory' && (row.querySelector('.fc-val')?.value || '').trim() !== (row.dataset.proposed || '').trim());
    list.querySelectorAll('.fc-row').forEach((row) => {
      const ck = row.querySelector('.fc-ck'); const val = row.querySelector('.fc-val');
      if (val) val.addEventListener('input', () => { if (ck) { ck.disabled = false; ck.checked = !!val.value.trim(); } if (fixWrap) fixWrap.hidden = !anyEdited(); sync(); });
      if (ck) ck.addEventListener('change', sync);
    });
    if (fixWrap) fixWrap.hidden = true;
    const pm = globalThis.__vodouPageMem || {};
    if (learnWrap) learnWrap.hidden = (pm.mode || 'collect') !== 'collect';
    foot.hidden = !model.fields.length;
    card.hidden = false; flagHere();
    sync();
  }
  function sync() {
    const n = list.querySelectorAll('.fc-ck:checked').length;
    applyBtn.disabled = n === 0;
    if (countEl) countEl.textContent = n ? n + ' selected' : '';
  }
  function chosen() {
    return [...list.querySelectorAll('.fc-row')].filter((row) => row.querySelector('.fc-ck')?.checked).map((row) => ({
      id: row.dataset.id, sel: row.dataset.sel, ac: row.dataset.ac, kind: row.dataset.kind,
      proposed: row.dataset.proposed || '', sourceId: row.dataset.sourceId || '', source: row.dataset.source || '',
      label: row.querySelector('.fc-label')?.textContent || '',
      value: (row.querySelector('.fc-val')?.value || '').trim(),
    })).filter((x) => x.value);
  }
  applyBtn.addEventListener('click', async function () {
    if (!current) { if (status) status.textContent = 'no form read yet — right-click the page → Fill this form from Vodou'; return; }
    const items = chosen();
    if (!items.length) { if (status) status.textContent = 'tick at least one field (or type a value) first'; return; }
    applyBtn.disabled = true; const prev = applyBtn.textContent; applyBtn.textContent = 'filling…';
    const payload = { type: 'vodou_apply_fields', items: items.map((i) => ({ id: i.id, sel: i.sel, value: i.value })) };
    // The card may be bound to a tab id that no longer answers (page reopened,
    // extension reloaded — Chad, 2026-08-18: "Fill ticked fields does nothing").
    // Try the card's tab, then the ACTIVE tab if it is the same page, then say
    // exactly which failed.
    let res = null; let why = '';
    try { res = await chrome.tabs.sendMessage(current.tabId, payload); }
    catch (e) { why = 'that tab did not answer'; }
    if (!res) {
      try {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        const same = t && t.url && current.model && current.model.url && new URL(t.url).origin === new URL(current.model.url).origin;
        if (t && t.id && t.id !== current.tabId && same) { res = await chrome.tabs.sendMessage(t.id, payload); if (res) current.tabId = t.id; }
        else if (t && !same) why = 'switch back to the page this form is on';
      } catch (e) { why = why || 'the page did not answer'; }
    }
    const applied = res && res.applied || 0;
    if (status) status.textContent = res
      ? `filled ${applied}${res.failed && res.failed.length ? ` · ${res.failed.length} refused (${res.failed.map((f) => f.why).join(', ')})` : ''}`
      : (why || 'the page did not answer') + ' — reload the page, then right-click → Fill this form from Vodou';
    // Learn-back: accepted answers that memory did not already hold for THIS
    // page (page-tier proposals are already stored) and that are not identity
    // fields (already known as facts).
    const st = globalThis.__vodouPageMem || {};
    if (learnCb && learnCb.checked && !learnWrap.hidden && applied > 0 && current.model && current.model.url) {
      const answers = items.filter((i) => i.kind !== 'page' && !IDENTITY_AC.test(i.ac || '') && i.label && i.value.length <= 500).map((i) => ({ label: i.label, value: i.value }));
      if (answers.length) {
        try {
          const r = await fetch(gatewayBase() + '/api/page-match/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: current.model.url, answers }) });
          const d = await r.json().catch(() => ({}));
          if (status && r.ok && d && d.ok) status.textContent += ` · remembered ${d.stored}`;
          document.dispatchEvent(new CustomEvent('vodou-page-mem-refresh'));
        } catch (_) { /* offline — the fill still happened */ }
      }
    }
    // P6b — "Also fix the memory an edited answer came from": for a memory-
    // backed proposal the user CHANGED, supersede the source fact with the
    // corrected sentence (mem correct — soft, reversible). Off by default: an
    // edit on a form usually means "what I want in THIS form", not "the fact
    // was wrong"; the user says which.
    const fixCb = document.getElementById('fill-card-fix');
    if (fixCb && fixCb.checked && applied > 0) {
      const fixes = items.filter((i) => i.sourceId && i.kind === 'memory' && i.value && i.proposed && i.value !== i.proposed).map((i) => {
        const src = String(i.source || '');
        const right = src && src.includes(i.proposed) ? src.replace(i.proposed, i.value) : `User's ${i.label.replace(/[:*]\s*$/, '').toLowerCase()} is ${i.value}`;
        return { chunkId: i.sourceId, right, wrong: i.proposed };
      });
      if (fixes.length) {
        try {
          const r = await fetch(gatewayBase() + '/api/page-match/correct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: current.model.url, fixes }) });
          const d = await r.json().catch(() => ({}));
          if (status && r.ok && d && d.ok) status.textContent += ` · fixed ${d.corrected} ${d.corrected === 1 ? 'memory' : 'memories'}`;
        } catch (_) { /* offline */ }
      }
    }
    applyBtn.textContent = prev; sync();
    void st;
  });
  if (closeBtn) closeBtn.addEventListener('click', () => { card.hidden = true; list.innerHTML = ''; current = null; });
  // The background pushes plans (menu/shortcut path) and answers a pull on open.
  // Phase 2 merges into the rows the user may already be editing: only rows
  // that are still empty (or untouched proposals) take the model's answer.
  function mergeIn(plan) {
    if (!current || !plan) return;
    const byId = new Map((plan.proposals || []).map((p) => [p.id, p]));
    let added = 0;
    list.querySelectorAll('.fc-row').forEach((row) => {
      const p = byId.get(row.dataset.id);
      if (!p) return;
      const val = row.querySelector('.fc-val'); const ck = row.querySelector('.fc-ck');
      const proposedBefore = (row.dataset.proposed || '').trim();
      // Only rows the user has not touched AND whose answer actually changes.
      // (2026-08-18: this re-wrote every row and, via a `div > div:last-child`
      // selector that matched the row's whole body, replaced label + input with
      // "you answered here" — Chad's screenshot.)
      const untouched = !val || !val.value.trim() || val.value.trim() === proposedBefore;
      if (!untouched) return;
      if (proposedBefore === String(p.value || '').trim()) return;
      if (val) val.value = p.value;
      row.dataset.proposed = p.value; row.dataset.kind = p.kind || ''; row.dataset.sourceId = p.sourceId || ''; row.dataset.source = p.source ? String(p.source).slice(0, 300) : '';
      const meta = row.querySelector('.fc-meta');
      if (meta) meta.textContent = kindLabel(p.kind) + (p.source ? ' · “' + String(p.source).slice(0, 80) + '”' : '');
      const conf = row.querySelector('.fc-conf');
      if (conf) conf.textContent = Math.round((p.confidence || 0) * 100) + '%';
      if (ck) { ck.disabled = false; ck.checked = (p.confidence || 0) >= 0.5; }
      added++;
    });
    current.plan = plan;
    if (status) status.textContent = `${(plan.proposals || []).length} of ${(current.model.fields || []).length} fields have an answer` + (added ? ` · ${added} more just arrived` : '');
    sync();
  }
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== 'fill_plan') return;
    if (Array.isArray(m.applied)) {            // hotkey auto-fill: mark the rows already written into the page
      const ids = new Set(m.applied);
      list.querySelectorAll('.fc-row').forEach((row) => {
        if (!ids.has(row.dataset.id) || row.dataset.filled) return;
        row.dataset.filled = '1';
        const meta = row.querySelector('.fc-meta');
        if (meta) meta.textContent = '\u2713 filled in the page \u00b7 ' + meta.textContent;
      });
      if (status) status.textContent = m.applied.length + ' field' + (m.applied.length === 1 ? '' : 's') + ' filled in the page \u2014 edit a value and Fill again to change it';
      return;
    }
    if (m.phase2 && current && current.model && m.model && current.model.url === m.model.url && !current.error) { mergeIn(m.plan); return; }
    render({ tabId: m.tabId, model: m.model, plan: m.plan, pending: !!m.pending, error: m.error });
    if (m.note && status) status.textContent += ' · ' + m.note;
  });
  try { chrome.runtime.sendMessage({ type: 'get_fill_plan' }, (r) => { void chrome.runtime.lastError; if (r && (r.model || r.error)) render(r); }); } catch (_) {}
})();

(function initPageMem() {
  const box = document.getElementById('page-mem');
  const list = document.getElementById('page-mem-list');
  const foot = document.getElementById('page-mem-foot');
  const hostEl = document.getElementById('page-mem-host');
  const insertBtn = document.getElementById('page-mem-insert');
  const insertAllBtn = document.getElementById('page-mem-insert-all');
  const countEl = document.getElementById('page-mem-count');
  const consent = document.getElementById('page-consent');
  const emptyEl = document.getElementById('page-mem-empty');
  const noteForm = document.getElementById('page-mem-note-form');
  const noteInput = document.getElementById('page-mem-note');
  const noteStatus = document.getElementById('page-mem-note-status');
  const offEl = document.getElementById('page-mem-off');
  const siteRow = document.getElementById('page-mem-site');
  const siteHostEl = document.getElementById('page-mem-site-host');
  const siteModeSel = document.getElementById('page-mem-site-mode');
  const siteWhy = document.getElementById('page-mem-site-why');
  const siteStatus = document.getElementById('page-mem-site-status');
  const forgetBtn = document.getElementById('page-mem-forget');
  if (!box || !list || !foot || !insertBtn) return;

  // Read by the picker (📎 link-to-page on a memory row): whether the lane is
  // on and which page the panel is looking at. Written only by refresh() —
  // the same consent-gated read — so the picker never reads the tab itself.
  globalThis.__vodouPageMem = { enabled: false, url: '', pageKey: '', host: '' };

  // CONSENT GATE — P1 compliance bundle.
  //
  // `PAGE_MEM_KEY` is the setting; `PAGE_MEM_ASKED_KEY` records the disclosure
  // VERSION the user was shown, not a boolean. That is deliberate: the Aug-2026
  // CWS amendments require a changed practice to be re-disclosed to EXISTING
  // installs, and a boolean cannot express "they consented to the old wording".
  // Bump DISCLOSURE_VERSION when what this lane reads changes, and everyone is
  // asked again.
  //
  // DEFAULT IS OFF AND THE DEFAULT IS LOAD-BEARING: until this returns true,
  // refresh() does not run, so nothing reads the tab's URL at all. The feature is
  // not "on but hidden" — it is not running.
  const PAGE_MEM_KEY = 'vodou_page_memory_enabled';
  const PAGE_MEM_ASKED_KEY = 'vodou_page_memory_disclosed_v';
  // v2 (P2b): the disclosure now also names typing suggestions (draft text sent
  // to the local gateway). Anyone who saw v1 is asked again — that is the point
  // of storing a version rather than a boolean.
  // v3 (P6): the disclosure also names "Fill this form from Vodou".
  // v4 (P5): …and per-site "Enable Vodou on this site" + "Also save what I write".
  const DISCLOSURE_VERSION = 4;

  let enabled = false;
  let lastKey = '';
  let activeTabId = null;

  function setEnabled(on) {
    enabled = !!on;
    try {
      chrome.storage.local.set({ [PAGE_MEM_KEY]: enabled, [PAGE_MEM_ASKED_KEY]: DISCLOSURE_VERSION });
    } catch (_) { /* storage unavailable — the session default stays OFF */ }
    const cb = document.getElementById('page-mem-enabled');
    if (cb) cb.checked = enabled;
    if (consent) consent.hidden = true;
    if (!enabled) {
      box.hidden = true;
      foot.hidden = true;
      list.innerHTML = '';
      lastKey = '';
      if (noteForm) noteForm.hidden = true;
      const tb = document.getElementById('typing-mem'); if (tb) tb.hidden = true;
      if (siteRow) siteRow.hidden = true;
      if (accessBox) accessBox.hidden = true;
      globalThis.__vodouPageMem = { enabled: false, url: '', pageKey: '', host: '' };
    } else {
      lastKey = '';
      refresh();
    }
  }

  /** Naive-UTC → "3d". PLAN-TIME-CANON: the column has no zone, so the 'Z' is
   *  appended before parsing. Reading it as LOCAL is what made a sibling surface
   *  render an hour-old row as "in 3h". */
  function ago(s) {
    if (!s) return '';
    const t = Date.parse(String(s).replace(/\s+/, 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    if (!Number.isFinite(t)) return '';
    // DAY-GRANULAR instants render as days, never hours. The gateway returns
    // COALESCE(valid_at, created_at); for a daily-log fact `valid_at` is the LOG
    // DAY — local midnight (PLAN-MEMORY-EVENT-TIME E8) — so at 17:40 an hour-old
    // fact read "18h" (hours since midnight). Live 2026-08-17: the walnut-lantern
    // canary, captured 30 min earlier, showed "on this page · 18h". Exactly-
    // midnight-local is the tell that the value carries no time of day.
    const d = new Date(t);
    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const days = Math.round((today.getTime() - d.getTime()) / 86400000);
      return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + 'd';
    }
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 60) return mins + 'm';
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + 'h';
    return Math.round(hrs / 24) + 'd';
  }

  /** The stored text carries a provenance run (`scope:… project:… page:…`). The
   *  panel shows the FACT, not the bookkeeping.
   *
   *  Two shapes exist and both must be handled. The extractor writes the
   *  canonical `- scope:x page:y | body`, which the bar split covers. But rows
   *  written through other lanes (`mem store`, imports) can carry the tokens
   *  inline with NO bar at all — verified against a live row — and those leaked
   *  `page:example.com/…` into the panel as if it were something the user said. */
  function body(t) {
    const s = String(t || '').replace(/^-\s*/, '');
    const bar = s.indexOf('|');
    const after = bar > 0 && bar < 200 ? s.slice(bar + 1) : s;
    return after.replace(/(^|\s)(?:scope|project|page):[^\s|]+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  }

  function row(r, tier) {
    const txt = body(r.text);
    if (!txt) return '';
    const age = ago(r.at);
    return '<label class="pm-row" style="display:flex;gap:6px;align-items:flex-start;padding:5px 0;border-top:1px solid rgba(255,255,255,.05);cursor:pointer">'
      + '<input type="checkbox" class="pm-ck" data-text="' + esc(txt) + '" style="margin-top:3px">'
      + '<span style="flex:1;min-width:0">'
      + '<span style="font-size:12px;line-height:1.35">' + esc(txt) + '</span>'
      + '<span style="font-size:10px;opacity:.45;margin-left:6px;white-space:nowrap">' + esc(tier) + (age ? ' · ' + esc(age) : '') + '</span>'
      + '</span></label>';
  }

  function syncFoot() {
    const n = list.querySelectorAll('.pm-ck:checked').length;
    insertBtn.disabled = n === 0;
    countEl.textContent = n ? n + ' selected' : '';
  }

  /** A Library document saved FROM this page/site — ONE row, not its chunks
   *  (a saved Wikipedia article is 111 chunks; the fact tier must not become
   *  a document viewer). Click copies the same `@doc:` token the documents
   *  lane below produces, so the two lanes agree on how a document is attached. */
  function docRow(d, tier) {
    const name = String(d.name || d.id || '');
    return '<div class="pm-doc" data-doc-id="' + esc(String(d.id)) + '" data-doc-name="' + esc(name) + '"'
      + ' data-doc-slug="' + esc(String(d.slug || d.id)) + '"'
      + ' style="display:flex;gap:6px;align-items:flex-start;padding:5px 0;border-top:1px solid rgba(255,255,255,.05);cursor:pointer" title="Attach a reference to this document to your draft">'
      + '<span style="margin-top:1px">📄</span>'
      + '<span style="flex:1;min-width:0">'
      + '<span style="font-size:12px;line-height:1.35">' + esc(name) + '</span>'
      + '<span style="font-size:10px;opacity:.45;margin-left:6px;white-space:nowrap">' + esc(tier) + ' · saved page' + (d.chunks ? ' · ' + esc(String(d.chunks)) + ' chunks' : '') + '</span>'
      // Same vocabulary as the documents card: a way to READ the thing, not
      // only a token to paste. One lane teaching two different gestures for
      // the same object is how a UI starts feeling arbitrary.
      + '<button type="button" class="pm-doc-open" title="Read this document in your Vodou Library"'
      + ' style="margin-left:6px;font-size:10px;padding:0 5px;background:transparent;color:inherit;border:1px solid var(--border-primary);border-radius:5px;cursor:pointer">Open ↗</button>'
      + '</span></div>';
  }

  function paintSite(data) {
    const mode = data.mode || 'collect';
    if (siteHostEl) siteHostEl.textContent = data.host || '';
    if (siteModeSel) siteModeSel.value = mode;
    if (siteWhy) siteWhy.textContent = data.modeSource === 'sensitive' ? 'off by default: looks like a bank / health / tax / sign-in site'
      : data.modeSource === 'user' ? 'your setting' : 'default';
    if (siteRow) siteRow.hidden = false;
    paintAccess(data.host || '');
    // Collect-only affordances hide when the site can't be collected from.
    const canCollect = mode === 'collect';
    if (noteForm) noteForm.hidden = !canCollect;
    globalThis.__vodouPageMem = Object.assign({}, globalThis.__vodouPageMem || {}, { mode });
  }

  // COHERENCE F31 — empty must read YOUNG, not BROKEN.
  //
  // Page memory fills forward: there is no backfill (a daily-log chunk carries
  // no URL to recover), so on the audited corpus only 135 of 47,777 chunks had
  // page identity at all. A new user therefore grants a privacy-sensitive
  // permission and meets a blank card — and page memories only accrue while the
  // lane is ON, so an emptiness that reads as failure discourages the very
  // grant that would end it.
  //
  // The invitation already exists one row down (the note field, shown whenever
  // the site is collectable). The copy just never pointed at it, and never said
  // that empty is the expected first state rather than a fault. When the site is
  // suggest-only the note field is hidden, so that branch points at the control
  // that would turn collection on instead of at a field that isn't there.
  function pageEmptyCopy(mode) {
    // Mirror paintSite's defaulting: an ABSENT mode means collect (the note
    // field is shown on the same assumption), so a strict === would tell the
    // majority of users the exact opposite of the truth.
    return ((mode || 'collect') === 'collect')
      ? "Nothing here yet — this fills as you go. Add a note below and it'll be waiting next time you're on this page."
      : "Nothing here yet. Vodou isn't saving on this site, so nothing will accumulate — switch to \u201CSuggest + collect\u201D below to start.";
  }

  function render(data) {
    const page = data.page || [];
    const site = data.site || [];
    const docs = data.docs || [];
    const siteDocs = data.siteDocs || [];
    paintSite(data);
    if (data.mode === 'off') {
      // The gateway did not look at the page. Show only the site control so
      // the user can change their mind here, on the site itself.
      list.innerHTML = '';
      foot.hidden = true;
      if (emptyEl) emptyEl.hidden = true;
      if (offEl) offEl.hidden = false;
      hostEl.textContent = data.host || '';
      box.hidden = false;
      return;
    }
    if (offEl) offEl.hidden = true;
    // P2: the box stays visible on an EMPTY page — that is exactly when the
    // note field earns its place ("nothing here yet; write the first thing").
    if (!page.length && !site.length && !docs.length && !siteDocs.length) {
      list.innerHTML = '';
      foot.hidden = true;
      if (emptyEl) emptyEl.textContent = pageEmptyCopy(data.mode);
      if (emptyEl) emptyEl.hidden = false;
      hostEl.textContent = data.host || '';
      box.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    // Learn-back answers ("Form answer on <host> — <label>: <value>") are FORM
    // memory, not facts to read: collapse them into one line with the count and
    // a Fill button, so the box stays readable and the fill is discoverable on
    // every visit (Chad, 2026-08-18: eight raw "Form answer on httpbin.org…"
    // rows after a reload, and no way to see the card again).
    const isFormAnswer = (r) => /^(?:\[[A-Z_]+\]\s*)?Form answer on /.test(body(r.text));
    const formPage = page.filter(isFormAnswer);
    const pageRest = page.filter((r) => !isFormAnswer(r));
    const formSite = site.filter(isFormAnswer);
    const siteRest = site.filter((r) => !isFormAnswer(r));
    let html = '';
    if (formPage.length || formSite.length) {
      const n = formPage.length;
      const label = n ? (n + ' saved answer' + (n === 1 ? '' : 's') + ' for this form') : (formSite.length + ' saved answer' + (formSite.length === 1 ? '' : 's') + ' on this site');
      html += '<div class="pm-form" style="display:flex;gap:6px;align-items:center;padding:5px 0;border-top:1px solid rgba(255,255,255,.05)">'
        + '<span style="font-size:12px">📝 ' + esc(label) + '</span>'
        + '<button type="button" class="pm-form-fill" style="margin-left:auto;white-space:nowrap;font-size:11px;padding:2px 8px;background:transparent;color:inherit;border:1px solid var(--line,#2A3441);border-radius:6px;cursor:pointer">Fill form…</button>'
        + '</div>';
    }
    if (docs.length) html += docs.map((d) => docRow(d, 'on this page')).join('');
    if (pageRest.length) html += pageRest.map((r) => row(r, 'on this page')).join('');
    if (siteDocs.length) html += siteDocs.map((d) => docRow(d, 'on this site')).join('');
    if (siteRest.length) html += siteRest.map((r) => row(r, 'on this site')).join('');
    list.innerHTML = html;
    const pmFill = list.querySelector('.pm-form-fill');
    if (pmFill) pmFill.addEventListener('click', () => { const b = document.getElementById('page-mem-fill'); if (b) b.click(); });
    hostEl.textContent = data.host || '';
    foot.hidden = false;
    box.hidden = false;
    syncFoot();
  }

  async function refresh() {
    // The gate comes FIRST, before chrome.tabs.query. Checking after the read
    // would still have read the tab, which is the thing consent is about.
    if (!enabled) return;
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) { return; }
    const url = (tab && tab.url) || '';
    activeTabId = (tab && tab.id) || null;
    if (!/^https?:/i.test(url)) {
      box.hidden = true; foot.hidden = true;
      globalThis.__vodouPageMem = { enabled: true, url: '', pageKey: '', host: '' };
      return;
    }
    globalThis.__vodouPageMem = { enabled: true, url: url, pageKey: '', host: '' };
    if (url === lastKey) return;

    try {
      const res = await fetch(gatewayBase() + '/api/page-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, topK: 8 }),
      });
      if (!res.ok) { box.hidden = true; foot.hidden = true; return; }
      const data = await res.json();
      // Same rule as the library lane: commit the key only once an answer
      // actually arrived, so a transient failure stays retryable instead of
      // silencing this page for the life of the panel.
      lastKey = url;
      globalThis.__vodouPageMem = { enabled: true, url: url, pageKey: (data && data.pageKey) || '', host: (data && data.host) || '' };
      render(data || {});
    } catch (_) {
      box.hidden = true;
      foot.hidden = true;
    }
  }

  list.addEventListener('change', function (e) {
    if (e.target && e.target.classList.contains('pm-ck')) syncFoot();
  });
  // Document rows: copy the attach token minted server-side and delivered on
  // the row (COHERENCE F13 — a token computed two ways is two documents).
  list.addEventListener('click', async function (e) {
    const el = e.target && e.target.closest ? e.target.closest('.pm-doc') : null;
    if (!el) return;
    if (e.target.closest('.pm-doc-open')) {
      const did = el.getAttribute('data-doc-id') || '';
      window.open(gatewayBase() + '/library/#' + encodeURIComponent(did), '_blank', 'noopener');
      return;
    }
    const slug = el.getAttribute('data-doc-slug') || el.getAttribute('data-doc-id');
    try {
      await navigator.clipboard.writeText('@doc:' + slug);
      const tag = el.querySelector('span:last-child > span:last-child');
      if (tag) { const prev = tag.textContent; tag.textContent = 'copied @doc:' + slug; setTimeout(function () { tag.textContent = prev; }, 1500); }
    } catch (_) { /* clipboard denied — non-fatal */ }
  });

  // Insert reuses the picker's path — `vodou_panel_insert` with a clipboard
  // fallback — because the page refusing an insert is a known failure mode on
  // rich editors and the text must never be lost either way.
  insertBtn.addEventListener('click', async function () {
    const chosen = [...list.querySelectorAll('.pm-ck:checked')].map((b) => b.dataset.text).filter(Boolean);
    if (!chosen.length) return;
    insertBtn.disabled = true;
    const prev = insertBtn.textContent;
    insertBtn.textContent = 'inserting…';
    let ok = false;
    try {
      const resp = await chrome.tabs.sendMessage(activeTabId, { type: 'vodou_panel_insert', items: (globalThis.__vodouMarkInserted?.(chosen), chosen) });
      ok = !!(resp && resp.ok);
    } catch (_) { ok = false; }
    if (!ok) {
      try { await navigator.clipboard.writeText(chosen.join('; ') + '.'); } catch (_) { /* denied */ }
    }
    insertBtn.textContent = ok ? '✓ inserted' : 'copied instead';
    setTimeout(function () { insertBtn.textContent = prev; syncFoot(); }, 1800);
  });

  // "Insert all" — tick everything, then reuse the one insert path.
  if (insertAllBtn) insertAllBtn.addEventListener('click', function () {
    const boxes = [...list.querySelectorAll('.pm-ck')];
    if (!boxes.length) return;
    boxes.forEach((b) => { b.checked = true; });
    syncFoot();
    insertBtn.click();
  });

  // Note about this page → POST /api/page-match/note → refresh so it appears.
  if (noteForm && noteInput) noteForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    const text = (noteInput.value || '').trim();
    const st = globalThis.__vodouPageMem || {};
    if (!text || !st.url) return;
    const saveBtn = document.getElementById('page-mem-note-save');
    if (saveBtn) saveBtn.disabled = true;
    if (noteStatus) noteStatus.textContent = 'saving…';
    try {
      const res = await fetch(gatewayBase() + '/api/page-match/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: st.url, text: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        noteInput.value = '';
        if (noteStatus) noteStatus.textContent = '✓ saved to this page';
        lastKey = '';           // force a re-read so the note shows up now
        refresh();
      } else {
        // The gateway relays the storage guard's own words (tool-fiction, empty).
        if (noteStatus) noteStatus.textContent = '✗ ' + ((data && data.error) || ('HTTP ' + res.status));
      }
    } catch (_) {
      if (noteStatus) noteStatus.textContent = '✗ Vodou not reachable';
    }
    if (saveBtn) saveBtn.disabled = false;
    setTimeout(function () { if (noteStatus && /^✓/.test(noteStatus.textContent)) noteStatus.textContent = ''; }, 2500);
  });

  // ── P2b: "Related to what you're typing" ─────────────────────────────────
  const tBox = document.getElementById('typing-mem');
  // (typing card removed — PLAN-EXT-PANEL-IA v3: the draft seeds the search
  // box itself. The gateway's prefetch items are discarded; the panel re-runs
  // the SAME retrieval through the same daemon, so results stay consistent.)
  chrome.runtime.onMessage.addListener(function (m, sender) {
    if (!m || m.type !== 'typing_context') return;
    if (!enabled) return;
    const tid = sender && sender.tab && sender.tab.id;
    if (activeTabId && tid && tid !== activeTabId) return;
    if (m.clear) return; // leaving the field keeps the last seed searchable
    if (m.seed && globalThis.__vodouSeedSearch) {
      globalThis.__vodouSeedSearch(m.seed, (globalThis.__vodouPageMem || {}).host || '');
      flagMemory();
    }
  });

  // ── P5 — per-site access (optional host permission) ────────────────────
  const accessBox = document.getElementById('page-mem-access');
  const accessOff = document.getElementById('page-mem-access-off');
  const accessOn = document.getElementById('page-mem-access-on');
  const accessHost = document.getElementById('page-mem-access-host');
  const accessEnable = document.getElementById('page-mem-access-enable');
  const accessDisable = document.getElementById('page-mem-access-disable');
  const accessCapture = document.getElementById('page-mem-access-capture');
  const accessStatus = document.getElementById('page-mem-access-status');
  const AI_HOST_RE = /(^|\.)(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|aistudio\.google\.com|perplexity\.ai|grok\.com|chat\.deepseek\.com|copilot\.microsoft\.com|chat\.mistral\.ai|meta\.ai|manus\.im|x\.com|twitter\.com|qwen\.ai|kimi\.com|kimi\.moonshot\.cn|notebooklm\.google\.com|notebook\.google\.com|poe\.com|duckduckgo\.com|duck\.ai|huggingface\.co|you\.com|chat\.z\.ai|t3\.chat|openrouter\.ai|character\.ai)$/i;
  function siteOriginsFor(host) { const h = String(host || '').replace(/^www\./, ''); return h ? ['https://' + h + '/*', 'https://*.' + h + '/*', 'http://' + h + '/*', 'http://*.' + h + '/*'] : []; }
  async function paintAccess(host) {
    if (!accessBox) return;
    const h = String(host || '').replace(/^www\./, '');
    // Declared AI hosts and localhost already run our scripts; nothing to enable.
    if (!h || AI_HOST_RE.test(h) || /^(localhost|127\.0\.0\.1)$/.test(h) || !chrome.permissions) { accessBox.hidden = true; return; }
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: [siteOriginsFor(h)[0]] }); } catch (_) { granted = false; }
    if (accessHost) accessHost.textContent = h;
    if (accessOff) accessOff.hidden = granted;
    if (accessOn) accessOn.hidden = !granted;
    if (granted && accessCapture) {
      try { chrome.storage.local.get(['vodou_site_capture'], (v) => { accessCapture.checked = !!(v && v.vodou_site_capture && v.vodou_site_capture[h]); }); } catch (_) {}
    }
    accessBox.hidden = false;
  }
  if (accessEnable) accessEnable.addEventListener('click', async function () {
    const st = globalThis.__vodouPageMem || {};
    const h = String(st.host || '').replace(/^www\./, '');
    if (!h) return;
    accessEnable.disabled = true;
    if (accessStatus) accessStatus.textContent = 'asking Chrome…';
    let ok = false;
    try {
      // The user's click IS the gesture; permissions.request must run in this
      // panel context (a message to the background would not carry it).
      ok = await chrome.permissions.request({ origins: siteOriginsFor(h) });
    } catch (e) { ok = false; if (accessStatus) accessStatus.textContent = '✗ ' + (e && e.message || 'Chrome refused'); }
    if (ok) {
      chrome.runtime.sendMessage({ type: 'site_enable', host: h }, (r) => {
        void chrome.runtime.lastError;
        const woke = r && r.injected ? ' (' + r.injected + ' open tab' + (r.injected === 1 ? '' : 's') + ' woken)' : '';
        if (accessStatus) accessStatus.textContent = (r && r.ok) ? ('✓ Vodou is on for ' + h + woke) : ('✗ ' + ((r && r.error) || 'could not enable'));
        paintAccess(h);
        setTimeout(function () { if (accessStatus && /^✓/.test(accessStatus.textContent)) accessStatus.textContent = ''; }, 3000);
      });
    } else if (accessStatus && !/^✗/.test(accessStatus.textContent)) accessStatus.textContent = 'not enabled — you declined Chrome\'s prompt';
    accessEnable.disabled = false;
  });
  if (accessDisable) accessDisable.addEventListener('click', function () {
    const st = globalThis.__vodouPageMem || {};
    const h = String(st.host || '').replace(/^www\./, '');
    if (!h) return;
    chrome.runtime.sendMessage({ type: 'site_disable', host: h }, (r) => {
      void chrome.runtime.lastError;
      if (accessStatus) accessStatus.textContent = r && r.ok ? 'Vodou is off for ' + h + ' — reload its tabs to unload the script' : '✗ could not disable';
      paintAccess(h);
      setTimeout(function () { if (accessStatus) accessStatus.textContent = ''; }, 4000);
    });
  });
  if (accessCapture) accessCapture.addEventListener('change', function () {
    const st = globalThis.__vodouPageMem || {};
    const h = String(st.host || '').replace(/^www\./, '');
    if (!h) return;
    try {
      chrome.storage.local.get(['vodou_site_capture'], (v) => {
        const m = (v && v.vodou_site_capture) || {};
        if (accessCapture.checked) m[h] = true; else delete m[h];
        chrome.storage.local.set({ vodou_site_capture: m }, () => {
          if (accessStatus) accessStatus.textContent = accessCapture.checked ? '✓ saving what you write on ' + h + ' (Enter / Ctrl+Enter in a text box)' : 'not saving what you write on ' + h;
          setTimeout(function () { if (accessStatus) accessStatus.textContent = ''; }, 3500);
        });
      });
    } catch (_) {}
  });

  // P4 — per-site mode: PUT the rule, then re-read the page under the new mode.
  if (siteModeSel) siteModeSel.addEventListener('change', async function () {
    const st = globalThis.__vodouPageMem || {};
    if (!st.url) return;
    if (siteStatus) siteStatus.textContent = 'saving…';
    try {
      const res = await fetch(gatewayBase() + '/api/page-match/site-mode', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: st.url, mode: siteModeSel.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        if (siteStatus) siteStatus.textContent = '✓ ' + (data.host || '') + ': ' + siteModeSel.value;
        // The content script's typing gate + background's probe read this cache.
        try {
          chrome.storage.local.get(['vodou_site_modes'], (v) => {
            const map = (v && v.vodou_site_modes) || {};
            map[data.host] = data.mode;
            chrome.storage.local.set({ vodou_site_modes: map });
          });
        } catch (_) { /* storage unavailable */ }
        lastKey = ''; refresh();
      } else if (siteStatus) siteStatus.textContent = '✗ ' + ((data && data.error) || ('HTTP ' + res.status));
    } catch (_) { if (siteStatus) siteStatus.textContent = '✗ Vodou not reachable'; }
    setTimeout(function () { if (siteStatus && /^✓/.test(siteStatus.textContent)) siteStatus.textContent = ''; }, 2500);
  });

  // P6 — Fill form… from the panel. No activeTab from a panel click, so the
  // background can only read pages Vodou has already opened; elsewhere it
  // answers with the right-click instruction.
  const fillBtn = document.getElementById('page-mem-fill');
  if (fillBtn) fillBtn.addEventListener('click', function () {
    fillBtn.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: 'fill_this_page' }, (r) => {
        void chrome.runtime.lastError;
        fillBtn.disabled = false;
        if (r && r.ok) { if (siteStatus) siteStatus.textContent = 'reading the form…'; }
        else if (siteStatus) siteStatus.textContent = (r && r.error) || 'could not read this page';
        setTimeout(function () { if (siteStatus && /reading the form/.test(siteStatus.textContent)) siteStatus.textContent = ''; }, 3000);
      });
    } catch (_) { fillBtn.disabled = false; }
  });

  // P4 — forget this site: two clicks. First = dry run (shows the count),
  // second within 8 s = do it. Soft: invalid_at, reversible with `mem forget --undo`.
  let forgetArmed = 0;
  if (forgetBtn) forgetBtn.addEventListener('click', async function () {
    const st = globalThis.__vodouPageMem || {};
    if (!st.url) return;
    const now = Date.now();
    const doIt = forgetArmed && now - forgetArmed < 8000;
    forgetBtn.disabled = true;
    try {
      const res = await fetch(gatewayBase() + '/api/page-match/forget-host', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: st.url, dryRun: !doIt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || !data.ok) {
        if (siteStatus) siteStatus.textContent = '✗ ' + ((data && data.error) || ('HTTP ' + res.status));
        forgetArmed = 0;
      } else if (!doIt) {
        forgetArmed = now;
        if (siteStatus) siteStatus.textContent = data.chunksMatched
          ? `This will hide ${data.chunksMatched} ${data.chunksMatched === 1 ? 'memory' : 'memories'} from ${data.host}${data.libraryDocuments ? ` (${data.libraryDocuments} Library document(s) stay)` : ''}. Click again within 8 s to confirm.`
          : `Nothing from ${data.host} to forget.`;
        forgetBtn.textContent = data.chunksMatched ? 'Confirm forget' : 'Forget site…';
      } else {
        forgetArmed = 0;
        if (siteStatus) siteStatus.textContent = `✓ hid ${data.chunksUpdated} from ${data.host} — undo: vodou-core mem forget --host ${data.host} --undo`;
        forgetBtn.textContent = 'Forget site…';
        lastKey = ''; refresh();
      }
    } catch (_) { if (siteStatus) siteStatus.textContent = '✗ Vodou not reachable'; forgetArmed = 0; }
    forgetBtn.disabled = false;
    setTimeout(function () { if (forgetArmed && Date.now() - forgetArmed >= 8000) { forgetArmed = 0; forgetBtn.textContent = 'Forget site…'; if (siteStatus && /Click again/.test(siteStatus.textContent)) siteStatus.textContent = ''; } }, 8200);
  });

  // A memory was linked to this page from the picker — re-read so it shows.
  document.addEventListener('vodou-page-mem-refresh', function () { lastKey = ''; refresh(); });

  const yes = document.getElementById('page-consent-yes');
  const no = document.getElementById('page-consent-no');
  if (yes) yes.addEventListener('click', () => setEnabled(true));
  if (no) {
    // "Not now" still records the disclosure version. Re-asking on every panel
    // open would be nagging, and a user who declined has answered.
    no.addEventListener('click', () => setEnabled(false));
  }
  const cb = document.getElementById('page-mem-enabled');
  if (cb) cb.addEventListener('change', () => setEnabled(cb.checked));

  try {
    chrome.storage.local.get([PAGE_MEM_KEY, PAGE_MEM_ASKED_KEY], (v) => {
      enabled = !!(v && v[PAGE_MEM_KEY]);
      if (cb) cb.checked = enabled;
      const shown = (v && Number(v[PAGE_MEM_ASKED_KEY])) || 0;
      if (shown < DISCLOSURE_VERSION) {
        // Never asked, or asked about an older version of what this reads. Ask
        // BEFORE running: consent precedes the first read, not the second.
        if (consent) consent.hidden = false;
        enabled = false;
        if (cb) cb.checked = false;
        return;
      }
      if (enabled) refresh();
    });
  } catch (_) { /* no storage — stays OFF, and the card stays hidden rather than
                   asking for a consent that could not be recorded */ }

  if (chrome.tabs && chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(refresh);
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(function (_id, info) {
      if (info.status === 'complete' || info.url) refresh();
    });
  }
})();
