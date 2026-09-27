// Grok capture after the 2026-09 wire change.
//
// Grok stopped sending chats through /rest/app-chat/.../responses; a send is
// now a Next.js server action POSTed to the page url. inject.js no longer
// parses the send — it notices it, waits for the reply, then pulls the
// transcript through the two endpoints that did not change:
//   GET  /rest/app-chat/conversations/<id>/response-node  → ids + inflight
//   POST /rest/app-chat/conversations/<id>/load-responses → the turns
// These tests drive the real fetch shim of both shipped builds (the Web Store
// build and extension/vodou-bridge, the sideload build the pack script diffs
// it against) against a fake Grok and
// assert what the extension POSTS to Vodou. The fixture shapes are copied from
// a live grok.com session on 2026-09-21 (a two-exchange chat).
//
// Run: node --test extension/Store-vodou-bridge/test/grok-snapshot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInjectWithWindow } from './parser-harness.mjs';

const BUILDS = [
  ['Store', new URL('../inject.js', import.meta.url)],
  ['vodou-bridge', new URL('../../vodou-bridge/inject.js', import.meta.url)],
];

const CID = 'ebcdebc5-805a-4675-ab9b-df8ef753da46';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Live shapes, 2026-09-21.
const RESPONSES = [
  { responseId: 'r1', sender: 'human', message: 'hi, reply with one word', createTime: '2026-09-21T23:27:03.106Z', parentResponseId: 'p0' },
  { responseId: 'r2', sender: 'assistant', message: 'Hi', createTime: '2026-09-21T23:27:03.133Z', parentResponseId: 'r1',
    steps: [{ header: 'Thinking about your request' }, { header: 'Replying' }] },
  { responseId: 'r3', sender: 'human', message: 'and one more word please', createTime: '2026-09-21T23:27:20.081Z', parentResponseId: 'r2' },
  { responseId: 'r4', sender: 'assistant', message: 'Hello', createTime: '2026-09-21T23:27:20.106Z', parentResponseId: 'r3',
    steps: [{ header: 'Considering a follow-up' }, { header: 'Replying' }] },
];

// A fake grok.com. `inflightFor` = how many response-node reads report the
// reply as still being written before it completes.
function fakeGrok({ inflightFor = 0, path = `/c/${CID}` } = {}) {
  const calls = [];
  let nodeReads = 0;
  const loc = { href: 'https://grok.com' + path, hostname: 'grok.com', pathname: path };
  const res = (text, extra = {}) => ({
    ok: true, status: 200, body: null,
    text: async () => text, json: async () => JSON.parse(text),
    clone() { return res(text, extra); }, ...extra,
  });
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body });
    if (url.includes('/response-node')) {
      nodeReads += 1;
      const inflight = nodeReads <= inflightFor ? [{ responseId: 'r4' }] : [];
      return res(JSON.stringify({ responseNodes: RESPONSES.map((r) => ({ responseId: r.responseId, sender: r.sender })), inflightResponses: inflight }));
    }
    if (url.includes('/load-responses')) {
      const ids = JSON.parse(init.body || '{}').responseIds || [];
      return res(JSON.stringify({ responses: RESPONSES.filter((r) => ids.includes(r.responseId)) }));
    }
    // The send itself: a server action streaming Grok's private format.
    return res('0:["$@1",["x"]]\n1:{"ok":true}\n');
  };
  return { fetch, calls, loc };
}

function boot(injectUrl, grok) {
  const posted = [];
  const win = { postMessage(m) { posted.push(m); }, fetch: grok.fetch, location: grok.loc };
  const { P, window: shimmed } = loadInjectWithWindow(injectUrl, win);
  P.__acceptNonce('test-nonce');
  // `shimmed.fetch` is inject.js's tap; `grok.fetch` stays the fake behind it.
  return { win: shimmed, posted, captures: () => posted.filter((m) => m && m.source === 'vodou-netcap') };
}

for (const [name, injectUrl] of BUILDS) {
  test(`${name}: a Grok send captures the finished exchange through load-responses`, async () => {
    const grok = fakeGrok();
    const { win, captures, posted } = boot(injectUrl, grok);
    await win.fetch(`https://grok.com/c/${CID}`, { method: 'POST', body: '["x"]' });
    await sleep(2500);
    const caps = captures();
    assert.equal(caps.length, 1, 'exactly one capture per send');
    assert.equal(caps[0].provider, 'grok');
    assert.equal(caps[0].conversationId, CID);
    assert.deepEqual(caps[0].turns.map((t) => [t.role, t.content]), [
      ['user', 'and one more word please'],
      ['assistant', 'Hello'],
    ], 'forward-only: the last completed exchange, and the reply is `message`, never the reasoning steps');
    const lr = grok.calls.find((c) => c.url.includes('/load-responses'));
    assert.deepEqual(JSON.parse(lr.body).responseIds, ['r1', 'r2', 'r3', 'r4']);
    assert.ok(!posted.some((m) => m && m.source === 'vodou-netcap-miss'), 'a Grok send is claimed, not reported as drift');
  });

  test(`${name}: a reply still being written is retried, and captured once, in full`, async () => {
    const grok = fakeGrok({ inflightFor: 1 });
    const { win, captures } = boot(injectUrl, grok);
    await win.fetch(`https://grok.com/c/${CID}`, { method: 'POST', body: '["x"]' });
    await sleep(2500);
    assert.equal(captures().length, 0, 'nothing is captured while Grok reports the reply in flight');
    assert.ok(!grok.calls.some((c) => c.url.includes('/load-responses')), 'no load while in flight — it would capture a truncated reply');
    await sleep(3500);
    const caps = captures();
    assert.equal(caps.length, 1);
    assert.equal(caps[0].turns[1].content, 'Hello');
  });

  test(`${name}: a new chat's first send (on "/") waits for the /c/<id> url`, async () => {
    const grok = fakeGrok({ path: '/' });
    const { win, captures } = boot(injectUrl, grok);
    await win.fetch('https://grok.com/', { method: 'POST', body: '["x"]' });
    await sleep(2500);
    assert.equal(captures().length, 0, 'no conversation id yet');
    // Grok creates the conversation and moves the page.
    grok.loc.pathname = `/c/${CID}`;
    grok.loc.href = `https://grok.com/c/${CID}?rid=r3`;
    await sleep(3500);
    assert.equal(captures().length, 1);
    assert.equal(captures()[0].conversationId, CID);
  });

  test(`${name}: a follow-up (sent over Grok's socket, no http send) is captured from the thread refresh`, async () => {
    // Live 2026-09-21: a follow-up produced no POST at all; the only http
    // trace of it was Grok refreshing the thread once the reply landed.
    const grok = fakeGrok();
    const { win, captures, posted } = boot(injectUrl, grok);
    await win.fetch(`https://grok.com/rest/app-chat/conversations_v2/${CID}?includeWorkspaces=true&includeTaskResult=true`);
    await sleep(2500);
    const caps = captures();
    assert.equal(caps.length, 1);
    assert.equal(caps[0].conversationId, CID);
    assert.deepEqual(caps[0].turns.map((t) => t.content), ['and one more word please', 'Hello']);
    assert.ok(!posted.some((m) => m && m.source === 'vodou-netcap-miss'), 'the refresh is claimed, not reported as drift');
  });

  test(`${name}: the sharing refresh triggers too, and a burst of refreshes pulls once`, async () => {
    const grok = fakeGrok();
    const { win, captures } = boot(injectUrl, grok);
    await win.fetch(`https://grok.com/rest/app-chat/conversations/${CID}/sharing?responseId=r4`);
    await win.fetch(`https://grok.com/rest/app-chat/conversations_v2/${CID}?includeWorkspaces=true`);
    await sleep(2500);
    assert.equal(grok.calls.filter((c) => c.url.includes('/load-responses')).length, 1, 'debounced to one pull');
    assert.equal(captures().length, 1);
    // A second refresh of the same, already-captured thread adds nothing.
    await win.fetch(`https://grok.com/rest/app-chat/conversations_v2/${CID}`);
    await sleep(2500);
    assert.equal(captures().length, 1, 'no duplicate capture for an unchanged thread');
  });

  test(`${name}: other Grok requests do not trigger a pull`, async () => {
    const grok = fakeGrok();
    const { win, captures } = boot(injectUrl, grok);
    await win.fetch('https://grok.com/rest/skills', { method: 'POST', body: '{}' });
    await win.fetch(`https://grok.com/c/${CID}`);                // a GET page load
    await win.fetch('https://grok.com/_data/v1/a/t/', { method: 'POST', body: '{}' });
    await win.fetch('https://grok.com/rest/app-chat/conversations?pageSize=60');      // the sidebar list
    await win.fetch(`https://grok.com/rest/app-chat/conversations_v2/${CID}`, { method: 'POST', body: '{}' });
    await sleep(2500);
    assert.ok(!grok.calls.some((c) => c.url.includes('/response-node')), 'only a POST to a page url is a send');
    assert.equal(captures().length, 0);
  });
}
