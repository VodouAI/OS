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
function sourceLabel(scope) {
  if (!scope) return '';
  const m = /^capture:(?:web|ide|byok):([a-z0-9-]+)/.exec(scope) || /^import:([a-z0-9-]+)/.exec(scope);
  if (m) return m[1];
  if (/^capture:manual/.test(scope)) return 'manual';
  return scope.split(':')[0];
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

function startStatusPolling(site, initialLanes) {
  let lanes = initialLanes;
  const dot = q('d-conn');
  const paint = (st) => {
    const ok = !!(st && st.connected);
    dot.className = 'dot ' + (ok ? 'on' : (st && st.enabled) ? 'bad' : 'off');
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
        line.textContent = !st ? 'no answer from the extension'
          : !st.enabled ? 'disconnected — you turned Vodou off'
          : st.slot_standby ? 'another window holds the connection'
          : 'Vodou isn\u2019t running';
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
        q('s-link-brain').href = `http://${u.hostname}:${st.brain_port || 8767}/`;
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
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !LANE_KEYS.some((k) => k in changes)) return;
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
    const src = sourceLabel(item.scope); if (src) chips.appendChild(chip(src, 'src'));
    const age = ageLabel(item.created_at); if (age) chips.appendChild(chip(age));
    if (!item.in_vault) chips.appendChild(chip('🔒 private', 'priv'));
    body.append(txt, chips);
    row.append(cb, body);
    list.appendChild(row);
  }

  const priv = sorted.filter((i) => !i.in_vault).length;
  // Empty states say what was searched and what to do — a blank box is not an answer.
  if (!sorted.length) {
    q('status').textContent = picker.scope === 'all'
      ? 'nothing matched — try different words'
      : `nothing in vault "${picker.scope}" matched — try all memory`;
  } else if (picker.scope !== 'all') {
    q('status').textContent = `${sorted.length} in vault "${picker.scope}"`;
  } else {
    q('status').textContent = `${sorted.length} memories · ${priv} private (🔒 = outside your shared vault; tick to include)`;
  }
  syncFoot();
}

function search(query) {
  q('status').textContent = 'searching…';
  const all = picker.scope === 'all';
  chrome.runtime.sendMessage({
    type: 'get_context',
    query,
    host: (picker.page && picker.page.host) || '',
    all_memory: all,
    vault: all ? '' : picker.scope,
    conv_id: (picker.page && picker.page.convId) || '',
    provider: (picker.page && picker.page.provider) || '',
  }).then((r) => {
    if (!r || !r.ok || !Array.isArray(r.items)) {
      q('status').textContent = '✗ ' + ((r && r.error) || 'search failed — is Vodou running?');
      return;
    }
    // Vault list arrives with the first response; populate the scope selector once.
    const sel = q('scope');
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

async function initPicker(tabId, page) {
  picker.tabId = tabId;
  picker.page = page;
  const seed = (page && page.seed) || '';
  if (seed && seed.length < 80) q('q').value = seed;

  q('q').addEventListener('input', () => {
    clearTimeout(picker.timer);
    const v = q('q').value.trim();
    if (v.length < 2) return;
    picker.timer = setTimeout(() => search(v), 300);
  });
  q('scope').addEventListener('change', () => {
    picker.scope = q('scope').value;
    q('q').placeholder = picker.scope === 'all' ? 'Search all your memory…' : `Search vault: ${picker.scope}…`;
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
      const resp = await chrome.tabs.sendMessage(picker.tabId, { type: 'vodou_panel_insert', items: chosen });
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
    if (name === 'activity') initActivity();
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.view));
})();

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
