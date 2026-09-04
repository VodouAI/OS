/**
 * Vodou Browser Bridge — WebSocket server.
 *
 * Attached to the gateway's HTTP server at the path `/api/vbb`.
 * The Chrome extension connects here from `ws://localhost:<gateway-port>/api/vbb`.
 *
 * Single-connection model for MVP: most recent connection wins. The
 * bridge.ts singleton holds the active socket; multiple extension
 * instances would clobber each other (acceptable trade-off for MVP).
 */

import { WebSocketServer } from 'ws';
import { attachBridge } from './bridge.js';
import { getSetting } from '../db.js';

const ALLOWED_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
];

/**
 * SEC-3 (ALPHA-READINESS §9 A) — the id of the extension that has actually
 * paired with this gateway, or '' if none ever has.
 *
 * `bridge_ext_id` is written by bridge.ts on a successful `bridge_ready`. Until
 * this check existed it was written and never read back for access control: any
 * `chrome-extension://` origin passed the upgrade, and with pairing off (the
 * default) `verified` was set true at attach — so ANY extension the user had
 * installed, from any publisher, could open ws://localhost:8765/api/vbb, send
 * `chat_request`, and drive an agent that on the Claude CLI provider carries
 * Bash. The user installs one unrelated extension and that extension inherits
 * the machine.
 *
 * Read fresh on every upgrade rather than cached: pairing can happen while the
 * gateway is up, and a stale empty read would keep the door open for the rest
 * of the process's life.
 */
function pairedExtensionId(): string {
  try {
    // Static import is safe here: index.ts already imports db.js before it calls
    // mountBridgeWss, and this only runs inside the upgrade handler — long after
    // init. (This package is ESM; `require` would throw.) The catch covers a
    // settings store that is not readable, in which case we fall back to the
    // shape check alone rather than locking the user out of their own bridge.
    return String(getSetting('bridge_ext_id') || '').trim();
  } catch {
    return '';
  }
}

export function mountBridgeWss(httpServer: any): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.url !== '/api/vbb') return;
    // Origin check — only accept extension contexts or explicit localhost dev
    const origin = req.headers.origin || '';

    // SEC-3 — once ONE extension has paired, it is the only extension.
    //
    // Before this, the allowlist was shape-based ("starts with chrome-extension://")
    // and therefore satisfied by every extension on the machine. Now the shape
    // check is the FLOOR and identity is the gate: an install that has paired
    // accepts that id and no other. An install that has never paired still
    // accepts the first extension to arrive — that is what first-run pairing
    // needs, and it is the same trust-on-first-use the 6-digit code formalises.
    const paired = pairedExtensionId();
    const isExtensionOrigin = ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p));
    if (paired && isExtensionOrigin && origin !== `chrome-extension://${paired}` && origin !== `moz-extension://${paired}`) {
      console.warn(`[vbb] rejecting WS upgrade: origin ${origin} is not the paired extension (${paired})`);
      socket.destroy();
      return;
    }

    const allowed =
      isExtensionOrigin ||
      // An EMPTY Origin used to pass here. Browsers always send one from an
      // extension context; the requests that do not are non-browser clients —
      // a script, curl --no-origin, another process on the box. That is the
      // cheapest possible way to reach `chat_request`, and it was open.
      // Kept only behind the explicit dev escape hatch below.
      origin === `http://localhost:${process.env.WEB_PORT || '8765'}` ||
      process.env.VODOU_VBB_ALLOW_ANY_ORIGIN === '1';
    if (!allowed) {
      console.warn('[vbb] rejecting WS upgrade from origin', origin || '(empty)');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // No per-upgrade log: a second extension install fighting for the slot
      // produced 15k+ "bridge connected" lines. attach()/bridge_ready log the
      // meaningful outcomes (accepted, replaced, throttled reject summary).
      attachBridge(ws, String(origin || '(empty)'));
    });
  });
}
