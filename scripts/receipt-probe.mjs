// F30 verification — watch the WIRE, not the source.
//
// This finding exists precisely because every prior reading of the receipt lane
// was done from source: renderReceipt looked complete, so the panel was credited
// with showing tools and skills. It never ran, because the field it reads has
// never existed on the frame it reads it from. So the only acceptable proof here
// is a real client on a real turn, per the standing "curl is not a client" rule:
// a held session, real frames, in order.
//
// Sends ONE benign turn and records which frames arrive and what they carry.
//
// Usage: node scripts/receipt-probe.mjs   (gateway must be healthy on :8765)
// Node 22 ships a global WebSocket (undici), so no dependency is needed --
// and CLAUDE.md forbids npm-installing by name inside MCP-servers/.

const URL = 'ws://127.0.0.1:8765/';
const convId = 'f30-probe-' + process.pid;
const seen = [];
let receipt = null;
let doneFrame = null;

const ws = new WebSocket(URL);
const finish = (why) => {
  console.log(`\n--- ${why} ---`);
  console.log('frame types, in order:');
  console.log('  ' + seen.join(' → '));
  console.log('\nturn_receipt arrived:', receipt ? 'YES' : 'NO');
  if (receipt) {
    console.log('  memories:', receipt.memories && receipt.memories.used);
    console.log('  tools   :', JSON.stringify(receipt.tools));
    console.log('  skills  :', JSON.stringify(receipt.skills));
    console.log('  degraded:', JSON.stringify(receipt.degraded));
  }
  console.log('\ndone frame carried a `receipt` field:',
    doneFrame ? (Object.prototype.hasOwnProperty.call(doneFrame, 'receipt') ? 'YES' : 'NO — the panel read undefined here') : 'no done frame');
  try { ws.close(); } catch {}
  process.exit(0);
};

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'switch_conversation', conversationId: convId }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: 'message', content: 'Reply with exactly: ok', conversationId: convId }));
  }, 400);
});

ws.addEventListener('message', (ev) => {
  let f; try { f = JSON.parse(ev.data); } catch { return; }
  if (f.conversationId && f.conversationId !== convId) return;
  if (f.type && f.type !== 'chunk') seen.push(f.type);
  if (f.type === 'turn_receipt') receipt = f.receipt;
  if (f.type === 'done') { doneFrame = f; setTimeout(() => finish('turn complete'), 300); }
  if (f.type === 'error') finish('error: ' + (f.message || '?'));
});

ws.addEventListener('error', (e) => { console.log('socket error:', e.message || 'refused'); process.exit(1); });
setTimeout(() => finish('timeout (120s)'), 120000);
