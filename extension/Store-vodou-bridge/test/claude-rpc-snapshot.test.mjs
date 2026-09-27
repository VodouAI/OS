// claude.ai capture after the 2026-09 send change.
//
// claude.ai stopped sending through .../chat_conversations/<uuid>/completion;
// a send is now POST /claudeai-rpc/…ConversationService/PerformAction. The
// snapshot endpoint is unchanged, so inject.js treats PerformAction as a
// trigger and pulls .../chat_conversations/<uuid>?tree=True once the send's
// response ends. These tests drive the REAL fetch shim of both shipped builds
// against a fake claude.ai whose snapshot shape was copied from a live chat on
// 2026-09-21, and assert what the extension POSTS to Vodou.
//
// Run: node --test extension/Store-vodou-bridge/test/claude-rpc-snapshot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInjectWithWindow } from './parser-harness.mjs';

const BUILDS = [
  ['Store', new URL('../inject.js', import.meta.url)],
  ['vodou-bridge', new URL('../../vodou-bridge/inject.js', import.meta.url)],
];

const ORG = '7a5c6c9b-fde4-4064-977b-679707653cc1';
const CHAT = 'c2ec528e-1505-4683-986b-150498b36ed0';
const RPC = 'https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const human = (uuid, text) => ({ uuid, sender: 'human', text: '', content: [{ type: 'text', text, citations: [] }], created_at: '2026-09-22T00:29:31.845318Z' });
const assistant = (uuid, text) => ({ uuid, sender: 'assistant', text: '', content: [{ type: 'text', text, citations: [] }], stop_reason: 'end_turn', created_at: '2026-09-22T00:29:33.015085Z' });

// A fake claude.ai. `snapshots` is the sequence of chat_messages the snapshot
// endpoint returns on successive reads (the last one repeats).
function fakeClaude({ snapshots, path = `/chat/${CHAT}` }) {
  const calls = [];
  let reads = 0;
  const loc = { href: 'https://claude.ai' + path, hostname: 'claude.ai', pathname: path };
  const res = (text) => ({
    ok: true, status: 200, body: null,
    text: async () => text, json: async () => JSON.parse(text), clone() { return res(text); },
  });
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET' });
    if (url.includes('/chat_conversations/')) {
      const msgs = snapshots[Math.min(reads, snapshots.length - 1)];
      reads += 1;
      return res(JSON.stringify({ uuid: CHAT, chat_messages: msgs }));
    }
    if (url.includes('PerformAction')) return res('\u0000\u0000\u0000\u0000\u0002{}');  // Connect-RPC stream frame
    return res('{}');
  };
  return { fetch, calls, loc };
}

function boot(injectUrl, site) {
  const posted = [];
  const win = { postMessage(m) { posted.push(m); }, fetch: site.fetch, location: site.loc };
  const { P, window: shimmed } = loadInjectWithWindow(injectUrl, win);
  P.__acceptNonce('test-nonce');
  return { win: shimmed, posted, captures: () => posted.filter((m) => m && m.source === 'vodou-netcap') };
}

const DONE = [human('m1', 'Vodou capture test: name one ocean, one word only'), assistant('m2', 'Pacific'),
  human('m3', 'and one sea, one word only'), assistant('m4', 'Mediterranean')];

for (const [name, injectUrl] of BUILDS) {
  test(`${name}: a PerformAction send captures the finished exchange from the snapshot`, async () => {
    const site = fakeClaude({ snapshots: [DONE] });
    const { win, captures, posted } = boot(injectUrl, site);
    // The page's own traffic names the org before any send.
    await win.fetch(`https://claude.ai/api/organizations/${ORG}/projects_v2?limit=30`);
    await win.fetch(RPC, { method: 'POST', body: new Uint8Array([31, 139]) });
    await sleep(5500);
    const caps = captures();
    assert.equal(caps.length, 1, 'exactly one capture per send');
    assert.equal(caps[0].provider, 'claude');
    assert.equal(caps[0].conversationId, CHAT);
    assert.deepEqual(caps[0].turns.map((t) => [t.role, t.content]), [
      ['user', 'and one sea, one word only'],
      ['assistant', 'Mediterranean'],
    ]);
    const snap = site.calls.find((c) => c.url.includes('/chat_conversations/'));
    assert.ok(snap.url.includes(`/api/organizations/${ORG}/chat_conversations/${CHAT}?tree=True`), snap.url);
    assert.ok(!posted.some((m) => m && m.source === 'vodou-netcap-miss'), 'PerformAction is claimed, not reported as drift');
  });

  test(`${name}: a reply still generating is retried and captured once, in full`, async () => {
    const site = fakeClaude({ snapshots: [DONE.slice(0, 3), DONE] });
    const { win, captures } = boot(injectUrl, site);
    await win.fetch(`https://claude.ai/api/organizations/${ORG}/projects_v2`);
    await win.fetch(RPC, { method: 'POST', body: '{}' });
    await sleep(5500);
    assert.equal(captures().length, 0, 'the snapshot ends on the human turn — nothing yet');
    await sleep(5500);
    const caps = captures();
    assert.equal(caps.length, 1);
    assert.equal(caps[0].turns[1].content, 'Mediterranean');
  });

  test(`${name}: a new chat's first send (on /new) waits for the /chat/<uuid> url`, async () => {
    const site = fakeClaude({ snapshots: [DONE.slice(0, 2)], path: '/new' });
    const { win, captures } = boot(injectUrl, site);
    await win.fetch(`https://claude.ai/api/organizations/${ORG}/projects_v2`);
    await win.fetch(RPC, { method: 'POST', body: '{}' });
    await sleep(1500);
    site.loc.pathname = `/chat/${CHAT}`;
    site.loc.href = `https://claude.ai/chat/${CHAT}`;
    await sleep(7000);
    const caps = captures();
    assert.equal(caps.length, 1);
    assert.deepEqual(caps[0].turns.map((t) => t.content), ['Vodou capture test: name one ocean, one word only', 'Pacific']);
  });

  test(`${name}: nothing is pulled without a PerformAction POST`, async () => {
    const site = fakeClaude({ snapshots: [DONE] });
    const { win, captures } = boot(injectUrl, site);
    await win.fetch(`https://claude.ai/api/organizations/${ORG}/projects_v2`);
    await win.fetch(RPC);                                                       // a GET
    await win.fetch('https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ListThings', { method: 'POST', body: '{}' });
    await win.fetch('https://claude.ai/api/event_logging/v2/batch', { method: 'POST', body: '{}' });
    await sleep(5500);
    assert.ok(!site.calls.some((c) => c.url.includes('/chat_conversations/')), 'only a PerformAction POST is a send');
    assert.equal(captures().length, 0);
  });
}
