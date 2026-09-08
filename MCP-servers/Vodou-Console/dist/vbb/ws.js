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
const WS_MAX_PAYLOAD = (() => {
    const n = parseInt(process.env.VODOU_WS_MAX_PAYLOAD_BYTES || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 4 * 1024 * 1024;
})();
const ALLOWED_ORIGIN_PREFIXES = [
    'chrome-extension://',
    'moz-extension://',
];
/**
 * SEC-3 (ALPHA-READINESS §9 A) — the id of the extension this gateway is pinned
 * to, or '' when id-pinning is not in force.
 *
 * `bridge_ext_id` is written automatically by bridge.ts on a successful
 * `bridge_ready` — no user action, no prompt. It was written and never read back
 * for access control, so any `chrome-extension://` origin passed the upgrade and
 * any extension the user happened to install could open ws://…/api/vbb, send
 * `chat_request`, and drive an agent that on the Claude CLI provider carries Bash.
 *
 * v0.6.28 pinned to that id unconditionally, and that was wrong. The id is
 * per-browser and per-build: Chrome and Firefox have different ids, and so do an
 * unpacked dev build and the Web Store build. Whichever connected FIRST won, and
 * every other browser on the machine was refused permanently, with no UI saying
 * why and no way to clear it short of editing gateway_settings by hand. A silent
 * unrecoverable lockout is a worse failure than the risk it was closing.
 *
 * So id-pinning now applies only when the operator has deliberately turned
 * pairing on (`bridge_require_token`) — the same switch that gates the 6-digit
 * code. With pairing off, which is the default, the shape check below is the
 * floor and first-seen-wins trust is preserved.
 *
 * The half that is NOT conditional is the empty-Origin rejection below. That was
 * the wider hole and it has no legitimate caller: a browser always sends an
 * Origin from an extension context, so a request without one is a script or
 * another local process, and it was the cheapest possible route to `chat_request`.
 *
 * Read fresh on every upgrade: pairing can be switched on while the gateway is
 * up, and a stale read would keep the door open for the rest of the process.
 */
function pairedExtensionId() {
    try {
        // Static import is safe here: index.ts already imports db.js before it calls
        // mountBridgeWss, and this only runs inside the upgrade handler — long after
        // init. (This package is ESM; `require` would throw.) The catch covers a
        // settings store that is not readable, in which case we fall back to the
        // shape check alone rather than locking the user out of their own bridge.
        //
        // Env override first, matching bridge.ts's own resolution order for the same
        // setting, so an operator can enforce without touching the database.
        const env = process.env.VODOU_VBB_REQUIRE_TOKEN;
        const pinning = env !== undefined && env.trim() !== ''
            ? env.trim() === '1'
            : getSetting('bridge_require_token') === '1';
        if (!pinning)
            return '';
        // PLAN-BRIDGE-UNPAIR P2 — prefer the full recorded origin. Falls back to the
        // bare Chrome id for installs that paired before bridge_ext_origin existed,
        // so an upgrade does not silently unpin a machine that meant to be pinned.
        const originPin = String(getSetting('bridge_ext_origin') || '').trim();
        if (originPin)
            return originPin;
        const legacyId = String(getSetting('bridge_ext_id') || '').trim();
        return legacyId ? `chrome-extension://${legacyId}` : '';
    }
    catch {
        return '';
    }
}
export function mountBridgeWss(httpServer) {
    // GW-13 — cap the frame size.
    //
    // `ws` defaults maxPayload to 100 MiB, and neither server set it. One client
    // could hand the gateway a 100 MB frame and it would be buffered whole before
    // any of our code saw it — a memory exhaustion an unauthenticated peer can
    // trigger by connecting and typing.
    //
    // 4 MiB is generous for what actually crosses these sockets: chat turns,
    // capture payloads and control messages. The largest legitimate traffic
    // (documents, media) goes over HTTP, not here. VODOU_WS_MAX_PAYLOAD_BYTES if an
    // install genuinely needs more.
    const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
    httpServer.on('upgrade', (req, socket, head) => {
        if (req.url !== '/api/vbb')
            return;
        // Origin check — only accept extension contexts or explicit localhost dev
        const origin = req.headers.origin || '';
        // SEC-3 — with pairing ON, the paired extension is the only extension.
        //
        // With pairing off (the default) this is inert and the shape check below is
        // the floor: first-seen-wins, no prompt, no extra step for anyone installing
        // the extension normally. Turning pairing on is what says "this machine has
        // one bridge and I mean it", and only then does the id become a gate.
        // `paired` is now a full origin (scheme included), so this is one comparison
        // rather than two guesses about which scheme the stored id belonged to.
        const paired = pairedExtensionId();
        const isExtensionOrigin = ALLOWED_ORIGIN_PREFIXES.some(p => origin.startsWith(p));
        if (paired && isExtensionOrigin && origin !== paired) {
            console.warn(`[vbb] rejecting WS upgrade: origin ${origin} is not the paired bridge (${paired}). Un-pair in Settings → Connect to allow a different browser.`);
            // PLAN-BRIDGE-UNPAIR — tell the extension WHY, the way the pair-code path
            // already does.
            //
            // `socket.destroy()` here drops the TCP connection before the WebSocket
            // handshake completes, so the extension sees an indistinguishable network
            // failure and its panel says Vodou is not running. That is a lie, and it
            // sends someone to restart services for a problem restarting cannot fix.
            // bridge.ts solved the same problem for the pair code by completing the
            // handshake and closing with 4403, which background.js reads and the panel
            // renders. Same shape here with a distinct code.
            //
            // Completing the handshake is not a widened door: attachBridge is never
            // called, so this socket can never send a command. It exists for exactly
            // long enough to carry a reason.
            wss.handleUpgrade(req, socket, head, (ws) => {
                try {
                    ws.close(4404, 'not the pinned browser');
                }
                catch {
                    socket.destroy();
                }
            });
            return;
        }
        const allowed = isExtensionOrigin ||
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
