// Console Two panel host — frame + page-lane relay (PLAN-CONSOLE-TWO §5.2).
//
// The ONLY extension-context code in Console Two. Chat does NOT pass through
// here — the framed shell is same-origin with the gateway and speaks the
// web-chat WS itself. This relay carries exactly what needs chrome.* APIs:
//   page_meta  → active tab url/title/favicon + adapter info + title_probe dot
//   page_read  → on-demand executeScript page text (§6.1 rules)
//   page_save  → the EXISTING manual-capture lane (trigger_capture)
//
// Trust: replies go to the gateway origin only; requests are accepted only
// from the frame we created ourselves.

// EX-4 — the gateway origin is READ, not assumed.
//
// This was `const GW = 'http://127.0.0.1:8765'`, hardcoded. The installer
// auto-assigns a free port when 8765 is taken (a second Vodou install, or
// anything else holding it), and `sidepanel.js` has always read `gateway_url`
// from storage for exactly that reason. Console Two did not, so on any install
// whose gateway had moved, the preview framed a dead port — and, worse, used
// that wrong origin as its postMessage target AND its inbound origin check, so
// the relay was silently deaf as well as blank.
//
// Everything below depends on GW, including an origin comparison, so the whole
// wiring waits for the resolved value rather than starting on a guess.
const GW_FALLBACK = 'http://127.0.0.1:8765';

/** The gateway's http origin, from the same `gateway_url` sidepanel.js reads. */
function gatewayOrigin(st) {
  try {
    const u = new URL((st && st.gateway_url) || 'ws://127.0.0.1:8765/api/vbb');
    return `http://${u.hostname}:${u.port || 8765}`;
  } catch (_) {
    return GW_FALLBACK;
  }
}

const frame = document.getElementById('f');

// Leave the preview. Clears the opt-in and navigates this panel document back to
// the classic panel, so the switch is immediate rather than "next time you open
// it" — the direction that matters most, because it is the one someone reaches
// for when the preview is misbehaving. background.js picks up the cleared key
// through its storage listener and every later open follows.
const back = document.getElementById('back');
if (back) {
  back.addEventListener('click', () => {
    try {
      chrome.storage.local.set({ vodou_console_two: false }, () => {
        const p = new URLSearchParams(location.search);
        const q = p.get('tabId') ? `?tabId=${encodeURIComponent(p.get('tabId'))}&how=classic-switch` : '';
        location.replace(`sidepanel.html${q}`);
      });
    } catch (_) {
      location.replace('sidepanel.html');
    }
  });
}

chrome.storage.local.get(['vodou_bridge_token', 'gateway_url'], (v) => {
  const GW = gatewayOrigin(v);
  const t = v && v.vodou_bridge_token ? String(v.vodou_bridge_token) : '';
  // /ext-session mints the partitioned admin cookie then bounces to /panel/;
  // for the SHELL we want /two/, so pass the fragment through a direct load —
  // the cookie matters only for panes, which the shell opens later. Mint it
  // eagerly anyway (hidden fetch is blocked by redirect+cookie semantics, so
  // load it once as the frame src, then go to the shell).
  frame.src = t ? `${GW}/ext-session?t=${encodeURIComponent(t)}` : `${GW}/two/`;
  if (t) {
    // After the 302 lands on /panel/, swap to the shell. One hop, once.
    const swap = () => { frame.removeEventListener('load', swap); frame.src = `${GW}/two/`; };
    frame.addEventListener('load', swap);
  }

  // Inside the callback, so the relay is wired against the SAME resolved origin
  // the frame was loaded from. Wiring it outside would have raced the storage
  // read and compared against the fallback.
  const port = chrome.runtime.connect({ name: 'vodou-two' });
  port.onMessage.addListener((m) => {
    try { frame.contentWindow.postMessage({ vodouTwo: m }, GW); } catch { /* frame navigating */ }
  });
  window.addEventListener('message', (ev) => {
    if (ev.origin !== GW || !ev.data || !ev.data.vodouTwo) return;
    if (ev.source !== frame.contentWindow) return;
    try { port.postMessage(ev.data.vodouTwo); } catch { /* SW asleep — it wakes on connect */ }
  });
});
