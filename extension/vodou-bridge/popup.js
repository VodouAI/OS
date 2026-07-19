// Vodou Bridge — popup UI.
let lastStatus = { connected: false, enabled: true, gateway_url: '' };

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
  const logEl = document.getElementById('inject-log');
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
  // Injection log — last few events, newest first.
  try {
    chrome.storage.local.get(['vodou_injection_log'], (v) => {
      const log = (v && v.vodou_injection_log) || [];
      if (!logEl) return;
      if (!log.length) { logEl.textContent = 'No injections yet.'; return; }
      logEl.innerHTML = log.slice(0, 6).map((e) => {
        const when = e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const what = e.status === 'injected' ? 'sent (invisible)' : e.status === 'inserted' ? 'added to draft' : e.status || '';
        const n = e.items != null ? `${e.items} mem${e.profile ? '+profile' : ''}` : (e.profile ? 'profile' : '');
        return `<div>${when} · ${e.site || '?'} · ${what}${n ? ' · ' + n : ''}</div>`;
      }).join('');
    });
  } catch (_) { /* ignore */ }
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
