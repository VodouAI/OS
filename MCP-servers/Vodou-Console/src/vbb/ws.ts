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

const ALLOWED_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
];

export function mountBridgeWss(httpServer: any): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: any, socket: any, head: any) => {
    if (req.url !== '/api/vbb') return;
    // Origin check — only accept extension contexts or explicit localhost dev
    const origin = req.headers.origin || '';
    const allowed =
      ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p)) ||
      origin === '' ||
      origin === `http://localhost:${process.env.WEB_PORT || '8765'}` ||
      process.env.VODOU_VBB_ALLOW_ANY_ORIGIN === '1';
    if (!allowed) {
      console.warn('[vbb] rejecting WS upgrade from origin', origin);
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
