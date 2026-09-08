/**
 * ALPHA-READINESS §9.2 row 12 — can a browser extension that is NOT ours drive
 * the bridge?
 *
 * The audit's wording is "a throwaway unpacked extension opens ws://…/api/vbb,
 * sends bridge_ready then chat_request". What makes such an extension foreign is
 * exactly one thing on the wire: its `Origin` header, `chrome-extension://<its
 * own id>`. A real WS client sending that header reproduces it faithfully —
 * which is the point, because curl proves almost nothing about a protocol
 * server (it cannot complete the handshake, so it can never tell you what the
 * server does with a client that can).
 *
 * Three cases, because "rejected at upgrade" is only true for two of them and
 * saying otherwise would misreport the shipped default:
 *
 *   empty      no Origin at all — a script or another local process. Rejected
 *              unconditionally; this was the widest hole and has no legitimate
 *              caller.
 *   foreign    a different chrome-extension:// id, pairing OFF (the default).
 *              ACCEPTED, deliberately: first-seen-wins, no prompt for anyone
 *              installing the extension normally.
 *   pinned     the same foreign id, pairing ON and the gateway pinned to some
 *              other origin. Rejected with close code 4404 and a reason, rather
 *              than a destroyed socket that the panel would render as "Vodou is
 *              not running".
 *
 * On an ACCEPTED socket it goes further and actually sends `bridge_ready` then
 * `chat_request`, because "the upgrade succeeded" and "an agent ran" are
 * different claims and only the second one is the risk.
 *
 * Usage: node scripts/qa/rogue-bridge-client.mjs <port> <empty|foreign|pinned>
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('../../MCP-servers/Vodou-Console/node_modules/ws');

const port = process.argv[2];
const mode = process.argv[3] || 'foreign';
const ROGUE = 'chrome-extension://rogueaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const headers = mode === 'empty' ? {} : { Origin: ROGUE };
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vbb`, { headers });

const out = (verdict, detail) => {
  console.log(JSON.stringify({ mode, verdict, detail }));
  process.exit(0);
};

// A server that neither opens nor closes is its own finding — a hang is not a
// rejection, and reporting it as one would turn a bug into a pass.
const timer = setTimeout(() => out('HUNG', 'no open, no close, no error within 8s'), 8000);

ws.on('unexpected-response', (_req, res) => {
  clearTimeout(timer);
  out('REJECTED', `HTTP ${res.statusCode} — upgrade refused before the handshake`);
});

ws.on('error', (err) => {
  clearTimeout(timer);
  // A destroyed socket surfaces here: ECONNRESET / "socket hang up".
  out('REJECTED', `transport: ${err.message}`);
});

ws.on('close', (code, reason) => {
  clearTimeout(timer);
  out(code === 4404 ? 'REJECTED' : 'CLOSED',
      `close ${code}${reason?.length ? ` "${reason}"` : ''}`);
});

ws.on('open', () => {
  // Accepted. Now find out whether it can actually DRIVE anything — that is the
  // exposure, not the handshake.
  ws.send(JSON.stringify({ type: 'bridge_ready', build: 'rogue-lab', channel: 'full' }));
  ws.send(JSON.stringify({
    type: 'chat_request',
    id: 'rogue-1',
    conversationId: 'rogue-lab',
    text: 'echo ROGUE_REACHED_THE_AGENT',
  }));
  let sawReply = false;
  ws.on('message', (raw) => {
    const s = String(raw).slice(0, 200);
    if (/chat_|reply|token|stream|error/i.test(s)) sawReply = true;
  });
  setTimeout(() => {
    clearTimeout(timer);
    out('ACCEPTED', sawReply
      ? 'upgrade allowed AND the socket got a response to chat_request'
      : 'upgrade allowed; chat_request drew no response within 6s');
  }, 6000);
});
