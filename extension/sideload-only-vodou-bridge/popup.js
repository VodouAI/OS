// Vodou Bridge — popup UI.
let lastStatus = { connected: false, enabled: true, gateway_url: '' };

// Fallback brain mini console port. The gateway reports the real one (it owns
// BRAIN_PORT) in its server_info frame — status.brain_port — and this is only
// used until that lands, or against a gateway too old to send it.
const BRAIN_PORT_FALLBACK = 8767;
// Origins we've already probed this popup session — keyed by origin string so a
// 2s refresh tick doesn't re-hammer localhost.
let lastProbedOrigins = '';

// Resolve to true if *anything* answers (any HTTP status counts — only a network
// failure rejects), false on refusal/timeout.
async function reachable(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    await fetch(url, { method: 'GET', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// Point the quick links at whichever host the bridge connects to, then gray out
// whatever isn't listening so a click doesn't dead-end on ERR_CONNECTION_REFUSED.
function paintLinks(gwOrigin, brainOrigin) {
  const targets = [
    ['open-gateway', gwOrigin, '/api/health', 'Vodou console'],
    ['open-brain', brainOrigin, '/api/appearance', 'Brain console'],
  ];
  for (const [id, origin, probePath, name] of targets) {
    const a = document.getElementById(id);
    if (!a) continue;
    a.href = origin + '/';
    reachable(origin + probePath).then((up) => {
      a.classList.toggle('down', !up);
      a.title = up ? origin : `${name} not running at ${origin} — start Vodou services`;
    });
  }
  const pairLink = document.getElementById('pair-settings-link');
  if (pairLink) pairLink.href = `${gwOrigin}/#/settings?tab=memory`;
}

function render() {
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const dot = statusEl.querySelector('.dot');
  const toggleBtn = document.getElementById('toggle-btn');
  const saveBtn = document.getElementById('save-url-btn');

  if (lastStatus.connected) {
    statusEl.className = 'status connected';
    dot.className = 'dot green';
    statusText.textContent = 'Connected to Vodou';
    toggleBtn.textContent = 'Disconnect';
    toggleBtn.className = 'danger';
  } else {
    statusEl.className = 'status disconnected';
    dot.className = 'dot red';
    statusText.textContent = !lastStatus.enabled ? 'Disabled'
      : lastStatus.slot_standby ? 'Another window holds the Vodou connection — close it (or incognito), then Connect'
      : 'Disconnected — start Vodou?';
    toggleBtn.textContent = 'Connect';
    toggleBtn.className = 'primary';
  }

  // Only show "Save URL" button if the input differs from the stored URL.
  const input = document.getElementById('gateway-url');
  const dirty = input.value.trim() && input.value.trim() !== lastStatus.gateway_url;
  saveBtn.style.display = dirty ? 'block' : 'none';

  // "Import this chat" only when connected — the button forwards to the gateway
  // over the WS (CSRF-safe), which reads the active chat tab and ingests it.
  const importBtn = document.getElementById('import-btn');
  if (importBtn) importBtn.style.display = lastStatus.connected ? 'block' : 'none';

  // Pairing (PLAN-MEMORY-EVERYWHERE-FRONTEND P4): reveal the pair-code field
  // when the gateway rejected us for a missing/wrong code.
  const needPair = !!lastStatus.pairing_required;
  for (const id of ['pair-warning', 'pair-label', 'pair-code', 'save-pair-btn']) {
    const el = document.getElementById(id);
    if (el) el.style.display = needPair ? 'block' : 'none';
  }
  if (needPair) {
    const statusText2 = document.getElementById('status-text');
    if (statusText2) statusText2.textContent = 'Pairing required';
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (st) => {
    if (!st) return;
    lastStatus = st;
    const input = document.getElementById('gateway-url');
    // Don't clobber what the user is editing.
    if (document.activeElement !== input) input.value = st.gateway_url || 'ws://127.0.0.1:8765/api/vbb';
    // Point docs link at whichever gateway host the user is connecting to.
    try {
      const u = new URL(st.gateway_url || 'ws://127.0.0.1:8765/api/vbb');
      const docs = document.getElementById('docs-link');
      if (docs) docs.href = `http://${u.host}/#/docs?doc=vodou-bridge.md`;
      const gwOrigin = `http://${u.host}`;
      const brainOrigin = `http://${u.hostname}:${st.brain_port || BRAIN_PORT_FALLBACK}`;
      const key = gwOrigin + '|' + brainOrigin;
      if (key !== lastProbedOrigins) {
        lastProbedOrigins = key;
        paintLinks(gwOrigin, brainOrigin);
      }
    } catch {}
    render();
  });
}

document.getElementById('toggle-btn').addEventListener('click', () => {
  const wantEnabled = !lastStatus.connected;
  chrome.runtime.sendMessage({ type: 'set_enabled', enabled: wantEnabled }, () => {
    setTimeout(refresh, 300);
  });
});

// W2a — passive auto-capture toggle (stored flag content.js reads; default off).
(function () {
  const box = document.getElementById('auto-capture');
  if (!box) return;
  try {
    chrome.storage.local.get(['vodou_auto_capture'], (v) => { box.checked = !!(v && v.vodou_auto_capture); });
  } catch (_) { /* ignore */ }
  box.addEventListener('change', () => {
    try { chrome.storage.local.set({ vodou_auto_capture: box.checked }); } catch (_) { /* ignore */ }
  });
})();

// PLAN-AUTO-INJECT-P4 — auto-inject master + per-site toggles + injection log.
(function () {
  const master = document.getElementById('inject-master');
  const gpt = document.getElementById('inject-chatgpt');
  const claude = document.getElementById('inject-claude');
  if (!master || !gpt || !claude) return;
  const DEFAULT = { master: true, sites: { chatgpt: true, claude: true } };
  function read(cb) {
    try {
      chrome.storage.local.get(['vodou_inject_settings'], (v) => cb(Object.assign({}, DEFAULT, (v && v.vodou_inject_settings) || {}, { sites: Object.assign({}, DEFAULT.sites, ((v && v.vodou_inject_settings) || {}).sites || {}) })));
    } catch (_) { cb(DEFAULT); }
  }
  function paint(s) {
    master.checked = s.master !== false;
    gpt.checked = s.sites.chatgpt !== false;
    claude.checked = s.sites.claude !== false;
    gpt.disabled = claude.disabled = !master.checked;
  }
  function save() {
    const s = { master: master.checked, sites: { chatgpt: gpt.checked, claude: claude.checked } };
    try { chrome.storage.local.set({ vodou_inject_settings: s }); } catch (_) { /* ignore */ }
    gpt.disabled = claude.disabled = !master.checked;
  }
  read(paint);
  [master, gpt, claude].forEach((el) => el.addEventListener('change', save));
})();

// Recent activity — both directions of the bridge in one feed. Every row answers
// one of the only two questions a user actually has: did my memory reach the AI,
// and did this chat get saved. Counts are what was really sent/stored (the
// entries carry post-hoc numbers, never "what was available").
(function () {
  const logEl = document.getElementById('activity-log');
  const clearEl = document.getElementById('activity-clear');
  if (!logEl) return;

  const SITE_NAMES = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok', perplexity: 'Perplexity' };
  const siteName = (s) => SITE_NAMES[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'this chat');

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  // "3 memories + 2 profile facts" — omits whatever wasn't actually included.
  function payload(e) {
    const parts = [];
    if (e.facts) parts.push(`${e.facts} ${e.facts === 1 ? 'memory' : 'memories'}`);
    if (e.profileLines) parts.push(`${e.profileLines} profile ${e.profileLines === 1 ? 'fact' : 'facts'}`);
    return parts.join(' + ');
  }

  function describe(e) {
    const who = siteName(e.site || e.provider);
    if (e.kind === 'capture') {
      const n = e.messages || 0;
      if (!e.ok) return { icon: '✗', tone: 'bad', text: `Couldn't save your ${who} chat — ${e.error || 'failed'}` };
      const msgs = `${n} ${n === 1 ? 'message' : 'messages'}`;
      return e.mode === 'manual'
        ? { icon: '↓', tone: 'save', text: `Saved your ${who} chat to memory — ${msgs}` }
        : { icon: '↓', tone: 'save', text: `Saved ${msgs} from ${who} to memory` };
    }
    const what = payload(e);
    switch (e.status) {
      case 'injected':
        return { icon: '↑', tone: 'send', text: `Sent ${what} to ${who} — invisibly, inside your message` };
      case 'armed':
        return { icon: '⏱', tone: 'wait', text: `${what} ready — attaches to your next ${who} message` };
      case 'inserted':
        return { icon: '↑', tone: 'send', text: `Added ${what} to your ${who} draft` };
      case 'clipboard':
        return { icon: '!', tone: 'warn', text: `Couldn't type into ${who} — ${what} copied, paste it yourself` };
      case 'nothing':
        return { icon: '–', tone: 'muted', text: `Nothing in your memory matched this ${who} chat — nothing sent` };
      default:
        return { icon: '·', tone: 'muted', text: `${who} — ${e.status || 'unknown'}` };
    }
  }

  const TONE = { send: '#4ade80', save: '#60a5fa', wait: '#fbbf24', warn: '#fbbf24', bad: '#f87171', muted: '#6b7280' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function paintLog() {
    chrome.storage.local.get(['vodou_activity_log'], (v) => {
      const log = (v && v.vodou_activity_log) || [];
      if (!log.length) {
        logEl.innerHTML = '<div style="color:#6b7280;">Nothing yet. Press <b>Ctrl+B</b> in a chat to send your memory, or turn on auto-capture to save chats.</div>';
        return;
      }
      logEl.innerHTML = log.slice(0, 8).map((e) => {
        const d = describe(e);
        return `<div style="display:flex;gap:6px;align-items:baseline;margin-bottom:4px;">`
          + `<span style="color:${TONE[d.tone]};width:10px;flex:none;">${d.icon}</span>`
          + `<span style="color:#d1d5db;flex:1;">${esc(d.text)}</span>`
          + `<span style="color:#6b7280;flex:none;font-size:10px;">${esc(ago(e.at))}</span>`
          + `</div>`;
      }).join('');
    });
  }

  if (clearEl) {
    clearEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      try { chrome.storage.local.remove('vodou_activity_log', paintLog); } catch (_) { paintLog(); }
    });
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.vodou_activity_log) paintLog();
    });
  } catch (_) { /* ignore */ }
  paintLog();
})();

document.getElementById('save-url-btn').addEventListener('click', () => {
  const url = document.getElementById('gateway-url').value.trim();
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    alert('URL must start with ws:// or wss://');
    return;
  }
  chrome.runtime.sendMessage({ type: 'set_gateway_url', url }, () => {
    setTimeout(refresh, 500);
  });
});

document.getElementById('import-btn').addEventListener('click', async () => {
  const btn = document.getElementById('import-btn');
  const out = document.getElementById('import-result');
  btn.disabled = true;
  out.textContent = 'Importing…';
  let url = '';
  try {
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    url = tab?.url || '';
  } catch {}
  chrome.runtime.sendMessage({ type: 'trigger_capture', url, extract: 'background' }, (resp) => {
    btn.disabled = false;
    if (chrome.runtime.lastError) { out.textContent = '✗ ' + chrome.runtime.lastError.message; return; }
    if (resp && resp.ok) {
      const r = resp.result || {};
      out.textContent = `✓ Imported ${r.title || 'chat'} (${r.messages ?? '?'} msgs)`;
    } else {
      out.textContent = '✗ ' + ((resp && resp.error) || 'import failed');
    }
  });
});

document.getElementById('save-pair-btn').addEventListener('click', () => {
  const code = document.getElementById('pair-code').value.trim();
  if (!code) return;
  chrome.runtime.sendMessage({ type: 'set_pair_code', code }, () => {
    setTimeout(refresh, 600);
  });
});

document.getElementById('gateway-url').addEventListener('input', render);

document.getElementById('version').textContent = chrome.runtime.getManifest().version;
refresh();
setInterval(refresh, 2000);
