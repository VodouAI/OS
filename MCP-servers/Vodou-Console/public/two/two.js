/**
 * Console Two boot — rail, panes, seam (PLAN-CONSOLE-TWO §4.2, §5).
 *
 * The rail is a literal route table (launch-short, §4.2). A pane is an iframe
 * over the chat column — chat is never unmounted. The seam is the only
 * decorative element and the only status indicator: breathing = daemon alive,
 * pulsing = a turn is running, dark = gateway unreachable (§4.5.6).
 */

import { makeTransport } from '/two/transport.js';
import { initChat } from '/two/chat.js';

// ── Route table — adding a screen is one line (§4.2) ─────────────────────────
const PANES = {
  '/memory': 'Memory',
  '/apps': 'Apps',
  '/capabilities?tab=skills': 'Skills',
  '/settings?tab=profile': 'Settings',
};

const transport = makeTransport();

// ── Seam ─────────────────────────────────────────────────────────────────────
const seam = document.getElementById('seam');
const ui = {
  seamLive(on) {
    seam.classList.toggle('is-live', on);
    if (!on) seam.classList.add('is-breathing');
  },
  seamAlive(alive) {
    seam.classList.toggle('is-dark', !alive);
    seam.classList.toggle('is-breathing', alive);
  },
};
seam.classList.add('is-breathing');

// Heartbeat (§4.5.6): the WS state is the fast signal; a slow /health poll
// catches the gateway-half-up case (HTTP alive, WS refused) and first boot.
setInterval(async () => { ui.seamAlive(await transport.health()); }, 20000);
transport.health().then((ok) => ui.seamAlive(ok));

// ── Page strip (§6.1, panel host only) ───────────────────────────────────────
// Shows only what the browser gives for free (favicon/title/host) until a verb
// is pressed. `Use` arms a one-turn page read; `Save` is the manual-save lane
// (capture_request via the extension relay). The dot is the §4.5.2 anticipation
// signal, computed extension-side over vbb title_probe — metadata only.
const strip = document.getElementById('page-strip');
const psUse = document.getElementById('ps-use');
const psSave = document.getElementById('ps-save');
const psDot = document.getElementById('ps-dot');
let useArmed = false;
ui.pageUseArmed = () => useArmed;

let stripMeta = null; // last page_meta — Track reads it so it never re-asks

async function refreshStrip() {
  const meta = await transport.pageMeta();
  if (!meta || !meta.url || !/^https?:/.test(meta.url)) { strip.classList.add('is-hidden'); stripMeta = null; return; }
  stripMeta = meta;
  document.getElementById('ps-icon').src = meta.favIconUrl || '';
  document.getElementById('ps-title').textContent = meta.title || new URL(meta.url).hostname;
  // §4.5.4 V1 — on chat sites the page IS the conversation, so `Use` is
  // adoption: ask your brain about the chat you're inside.
  psUse.textContent = meta.siteKey ? 'Use chat' : 'Use';
  psUse.title = meta.siteKey
    ? 'Ask Vodou about this conversation — read for the next message only, never stored'
    : 'Read this page for the next message only — never stored';
  // Save today = the existing chat-site capture lane. Deferral rules (§6.1
  // rule 5): auto-captured sites don't double-write; non-chat sites wait for
  // the generic importer (P3/Track work).
  psSave.disabled = !meta.siteKey || !!meta.autoCaptured;
  psSave.title = meta.autoCaptured ? 'Auto-capture is on here'
    : meta.siteKey ? 'Save this chat into your memory'
    : 'Save works on chat sites for now';
  if (meta.probe && meta.probe.hit) {
    psDot.classList.remove('is-hidden');
    psDot.title = 'Related to what you know: ' + (meta.probe.label || 'memory match');
  } else {
    psDot.classList.add('is-hidden');
  }
  strip.classList.remove('is-hidden');
}
psUse.addEventListener('click', () => {
  useArmed = !useArmed;
  psUse.classList.toggle('is-armed', useArmed);
});
psSave.addEventListener('click', async () => {
  psSave.disabled = true;
  const r = await transport.pageSave();
  psSave.disabled = false;
  psSave.textContent = r && r.ok ? 'Saved ✓' : 'Save';
  if (r && r.ok) setTimeout(() => { psSave.textContent = 'Save'; }, 2500);
});

// Track (§4.5.7) — metadata only (title + url), into the research lane via the
// existing manual-capture endpoint. Same-origin, so no extension hop at all;
// works on ANY page. The list view is the Memory pane filtered to 'research'.
const psTrack = document.getElementById('ps-track');
psTrack.addEventListener('click', async () => {
  if (!stripMeta) return;
  psTrack.disabled = true;
  try {
    const r = await fetch('/api/capture/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'research',
        text: `[TRACK] ${stripMeta.title || stripMeta.url}\n${stripMeta.url}`,
      }),
    });
    psTrack.textContent = r.ok ? 'Tracked ✓' : 'Track';
    if (r.ok) setTimeout(() => { psTrack.textContent = 'Track'; }, 2500);
  } catch {
    psTrack.textContent = 'Track';
  }
  psTrack.disabled = false;
});
if (transport.host === 'panel') {
  refreshStrip();
  window.addEventListener('focus', refreshStrip);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStrip(); });
}

// ── Chat ─────────────────────────────────────────────────────────────────────
const chat = initChat(transport, ui);

// ── Rail + panes ─────────────────────────────────────────────────────────────
const pane = document.getElementById('pane');
const paneFrame = document.getElementById('pane-frame');
const paneTitle = document.getElementById('pane-title');
const paneNewtab = document.getElementById('pane-newtab');
const railItems = [...document.querySelectorAll('.rail-item[data-dest]')];

function activate(btn) {
  for (const b of railItems) b.classList.toggle('is-active', b === btn);
}

// Native Extension section (§10 Q2) — settings only an extension page can
// write (Brain mode lives here; the framed console cannot arm it).
const paneNative = document.getElementById('pane-native');
async function refreshNativeSettings() {
  const s = await transport.extSettingsGet();
  if (!s) { paneNative.classList.add('is-hidden'); return; }
  for (const box of paneNative.querySelectorAll('input[data-ext-key]')) {
    box.checked = !!s[box.dataset.extKey];
  }
  const adv = document.getElementById('pn-advanced');
  if (s.sidepanelUrl) { adv.href = s.sidepanelUrl; adv.style.display = ''; }
  else adv.style.display = 'none';
  paneNative.classList.remove('is-hidden');
}
for (const box of document.querySelectorAll('#pane-native input[data-ext-key]')) {
  box.addEventListener('change', () => {
    transport.extSettingsSet(box.dataset.extKey, box.checked);
  });
}

function openPane(route, btn) {
  const src = transport.paneSrc(route);
  if (paneFrame.getAttribute('src') !== src) paneFrame.src = src;
  paneTitle.textContent = PANES[route] || '';
  paneNewtab.href = transport.tabHref(route);
  const narrow = !framesPanes();
  if (route.startsWith('/settings') && transport.host === 'panel') refreshNativeSettings();
  else paneNative.classList.add('is-hidden');
  // Narrow host: show the native block alone — the framed desktop console is
  // unreadable at this width, and "open in tab ↗" in the bar is the way to it.
  paneFrame.classList.toggle('is-hidden', narrow);
  pane.classList.remove('is-hidden');
  activate(btn);
}

function closePane() {
  pane.classList.add('is-hidden');
  activate(railItems.find((b) => b.dataset.dest === 'chat'));
  document.getElementById('input').focus();
}

// Where a console screen opens (2026-08-20). Memory / Apps / Skills / Settings
// are the FULL console — a desktop layout with its own header, filters and
// tables. Framing that inside a ~400px side panel produced exactly what it
// sounds like: the console's own chrome squeezed to nothing and content cut
// off mid-word. The panel is the chat surface; screens that want room open
// where the room is. A tab host still frames them inline, unchanged.
const PANEL_MAX = 560;
const framesPanes = () => transport.host !== 'panel' && window.innerWidth > PANEL_MAX;

for (const btn of railItems) {
  btn.addEventListener('click', () => {
    if (btn.dataset.dest === 'chat') { closePane(); return; }
    if (!framesPanes()) {
      // Settings is the exception: its panel-native toggles (chrome.storage
      // keys the framed console cannot reach) are the whole reason a panel
      // user opens it, and they render natively here rather than in the frame.
      if (btn.dataset.route.startsWith('/settings')) { openPane(btn.dataset.route, btn); return; }
      window.open(transport.tabHref(btn.dataset.route), '_blank', 'noopener');
      return;
    }
    openPane(btn.dataset.route, btn);
  });
}
document.getElementById('pane-back').addEventListener('click', closePane);
document.getElementById('rail-new').addEventListener('click', () => {
  closePane();
  chat.newConversation();
});

// Esc from anywhere returns to chat.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !pane.classList.contains('is-hidden')) closePane();
});

document.getElementById('input').focus();
