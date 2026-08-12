// PLAN-HISTORY-BACKFILL P1 — the Claude history lane.
//
// The parser that reads Claude's conversation snapshot already produced the FULL
// transcript; forward-only capture then threw all but the last exchange away.
// Backfill emits the lot — but ONLY when the user has armed it, and only once per
// transcript. These tests pin all three halves of that: default OFF, on-when-armed,
// and idempotent.
//
// The config arrives by postMessage from the content script (inject.js runs in the
// MAIN world and cannot read chrome.storage), so the window stub here has to be a
// real message bus rather than the no-op the shared harness uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT = path.join(HERE, '..', 'inject.js');

/** Load inject.js with a window stub whose postMessage can be driven by the test. */
function loadWithBus() {
  const src = fs.readFileSync(INJECT, 'utf8');
  const close = src.lastIndexOf('})();');
  assert.ok(close > 0, 'could not find the inject.js IIFE close');
  const shim = '\n  try { window.__vodouNetCapParsers = { parseClaude, parseChatGPT, parseCopilotHistory, parseGrok }; } catch (e) {}\n';
  const patched = src.slice(0, close) + shim + src.slice(close);

  const listeners = [];
  const sent = [];
  const windowStub = {
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) { sent.push(data); },
    fetch: async () => ({}),
    XMLHttpRequest: undefined,
    WebSocket: undefined,
  };
  new Function('window', patched)(windowStub);
  // Deliver a message as the page would: ev.source must be window itself.
  const deliver = (data) => { for (const fn of listeners) fn({ source: windowStub, data }); };
  return { P: windowStub.__vodouNetCapParsers, deliver, sent };
}

/** Two exchanges, in Claude's real snapshot shape (text lives in content[], not text). */
function snapshot() {
  return JSON.stringify({
    uuid: 'e6c29fff-1111-2222-3333-444455556666',
    name: 'Backfill fixture',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: '', content: [{ type: 'text', text: 'first question' }], created_at: '2026-01-01T00:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'first answer' }], created_at: '2026-01-01T00:00:01Z' },
      { uuid: 'm3', sender: 'human', text: '', content: [{ type: 'text', text: 'second question' }], created_at: '2026-01-02T00:00:00Z' },
      { uuid: 'm4', sender: 'assistant', text: '', content: [{ type: 'text', text: 'second answer' }], created_at: '2026-01-02T00:00:01Z' },
    ],
  });
}

const URL_SNAP = 'https://claude.ai/api/organizations/org-1/chat_conversations/e6c29fff-1111-2222-3333-444455556666?tree=True&rendering_mode=messages';

test('default: backfill OFF — only the last exchange, capture stays forward-only', () => {
  const { P } = loadWithBus();
  const out = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(out.backfill, undefined, 'must not claim to be a backfill emit');
  assert.deepEqual(out.turns.map((t) => t.content), ['second question', 'second answer']);
});

test('armed: emits the WHOLE transcript, oldest first, each with its provider uuid', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  const out = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(out.backfill, true);
  assert.deepEqual(out.turns.map((t) => t.content),
    ['first question', 'first answer', 'second question', 'second answer']);
  // The uuid IS P0's dedup key — without it every re-open would re-store the thread.
  assert.deepEqual(out.turns.map((t) => t.id), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(out.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
});

test('armed: the same transcript is emitted ONCE, not on every conversation open', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  const first = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(first.turns.length, 4);
  const second = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(second.turns.length, 0, 're-open must not re-emit the same transcript');
  assert.equal(second.quiet, true, 'and must be quiet, not a parse failure');
});

test('armed: a thread that GREW re-emits, so new turns are not stranded', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  P.parseClaude(snapshot(), URL_SNAP, null);
  const grown = JSON.parse(snapshot());
  grown.chat_messages.push(
    { uuid: 'm5', sender: 'human', text: '', content: [{ type: 'text', text: 'third question' }], created_at: '2026-01-03T00:00:00Z' },
    { uuid: 'm6', sender: 'assistant', text: '', content: [{ type: 'text', text: 'third answer' }], created_at: '2026-01-03T00:00:01Z' },
  );
  const out = P.parseClaude(JSON.stringify(grown), URL_SNAP, null);
  assert.equal(out.turns.length, 6, 'a grown transcript must re-emit in full');
  assert.equal(out.turns[5].content, 'third answer');
});

test('per-site opt-out wins even when the master switch is on', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: { claude: false } });
  const out = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(out.backfill, undefined);
  assert.deepEqual(out.turns.map((t) => t.content), ['second question', 'second answer']);
});

test('turning backfill back OFF returns capture to forward-only', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  deliver({ source: 'vodou-netcap-config', backfill: false, backfillSites: {} });
  const out = P.parseClaude(snapshot(), URL_SNAP, null);
  assert.equal(out.backfill, undefined);
  assert.equal(out.turns.length, 2);
});

test('the shim asks for config on load, so the two scripts can start in either order', () => {
  const { sent } = loadWithBus();
  assert.ok(
    sent.some((m) => m && m.source === 'vodou-netcap-config-request'),
    'inject.js must request the config; otherwise whichever script starts second misses it',
  );
});

// ── ChatGPT (the biggest catalogue) ───────────────────────────────────────────
// The plan listed this endpoint as "still not identified". It was already being
// read: GET /backend-api/conversation/<uuid>, parsed from `mapping` into the whole
// tree, then all but the last exchange thrown away.

function gptSnapshot() {
  const mk = (id, role, text, t) => [id, { message: { id, author: { role }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', create_time: t } }];
  return JSON.stringify({
    conversation_id: 'c-1',
    mapping: Object.fromEntries([
      mk('g1', 'user', 'gpt first question', 100),
      mk('g2', 'assistant', 'gpt first answer', 101),
      mk('g3', 'user', 'gpt second question', 200),
      mk('g4', 'assistant', 'gpt second answer', 201),
    ]),
  });
}
const GPT_URL = 'https://chatgpt.com/backend-api/conversation/11111111-2222-3333-4444-555555555555';

test('chatgpt: default OFF — last exchange only', () => {
  const { P } = loadWithBus();
  const out = P.parseChatGPT(gptSnapshot(), GPT_URL, null);
  assert.deepEqual(out.turns.map((t) => t.content), ['gpt second question', 'gpt second answer']);
});

test('chatgpt: armed — whole tree, oldest first, message ids intact', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  const out = P.parseChatGPT(gptSnapshot(), GPT_URL, null);
  assert.equal(out.backfill, true);
  assert.deepEqual(out.turns.map((t) => t.content),
    ['gpt first question', 'gpt first answer', 'gpt second question', 'gpt second answer']);
  assert.deepEqual(out.turns.map((t) => t.id), ['g1', 'g2', 'g3', 'g4']);
});

test('chatgpt: emitted once — the 10x-duplicate thread must not recur', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  assert.equal(P.parseChatGPT(gptSnapshot(), GPT_URL, null).turns.length, 4);
  assert.equal(P.parseChatGPT(gptSnapshot(), GPT_URL, null).turns.length, 0);
});

// ── Copilot history (a genuinely different shape from its stream) ─────────────

function copilotHistory(next = null) {
  // Deliberately NEWEST-FIRST, as the live endpoint returns it.
  return JSON.stringify({
    next,
    results: [
      { id: 'c4', author: { type: 'ai' }, createdAt: '2026-01-02T00:00:01Z', content: [{ type: 'text', text: 'second ' }, { type: 'text', text: 'answer' }] },
      { id: 'c3', author: { type: 'human' }, createdAt: '2026-01-02T00:00:00Z', content: [{ type: 'text', text: 'second question' }] },
      { id: 'c2', author: { type: 'ai' }, createdAt: '2026-01-01T00:00:01Z', content: [{ type: 'text', text: 'first answer' }] },
      { id: 'c1', author: { type: 'human' }, createdAt: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: 'first question' }] },
    ],
  });
}
const COPILOT_URL = 'https://copilot.microsoft.com/c/api/conversations/abc123/history?api-version=2';

test('copilot: newest-first input is re-sorted oldest-first, or the transcript reads backwards', () => {
  const { P } = loadWithBus();
  const out = P.parseCopilotHistory(copilotHistory(), COPILOT_URL);
  assert.deepEqual(out.turns.map((t) => t.content),
    ['first question', 'first answer', 'second question', 'second answer']);
});

test('copilot: role comes from author.type, never from position', () => {
  const { P } = loadWithBus();
  const out = P.parseCopilotHistory(copilotHistory(), COPILOT_URL);
  assert.deepEqual(out.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
});

test('copilot: multi-part replies are joined in order, not truncated to the first part', () => {
  const { P } = loadWithBus();
  const out = P.parseCopilotHistory(copilotHistory(), COPILOT_URL);
  assert.equal(out.turns[3].content, 'second answer');
});

test('copilot: conversation id comes from the URL, and ids are the dedup key', () => {
  const { P } = loadWithBus();
  const out = P.parseCopilotHistory(copilotHistory(), COPILOT_URL);
  assert.equal(out.conversationId, 'abc123');
  assert.deepEqual(out.turns.map((t) => t.id), ['c1', 'c2', 'c3', 'c4']);
});

test('copilot: emitted once per transcript', () => {
  const { P } = loadWithBus();
  assert.equal(P.parseCopilotHistory(copilotHistory(), COPILOT_URL).turns.length, 4);
  assert.equal(P.parseCopilotHistory(copilotHistory(), COPILOT_URL).turns.length, 0);
});

test('copilot: a non-history body returns null so the streaming parser still gets it', () => {
  const { P } = loadWithBus();
  assert.equal(P.parseCopilotHistory('{"event":"appendText","text":"hi"}', COPILOT_URL), null);
  assert.equal(P.parseCopilotHistory('not json at all', COPILOT_URL), null);
});

// ── The flag has to SURVIVE the trip, or the gateway silently runs the live claim ──
// It lived only inside the parser until 2026-08-09 and died at POST(). The gateway
// then used its 600-second live window on rows that are weeks old, and adopt-in-place
// could not fire — which is how a forward-only-captured turn got duplicated by
// backfill on Copilot. Source-level, because the hop crosses three files and two
// worlds and nothing else checks it.
const READ = (f) => fs.readFileSync(path.join(HERE, '..', f), 'utf8');

test('inject.js forwards backfill from the parse result through POST to the page', () => {
  const s = READ('inject.js');
  assert.ok(/const \{ conversationId, turns, pending, quiet, backfill \}/.test(s),
    'the parse result must be destructured with backfill');
  assert.ok(/POST\(adapter\.name, conversationId \|\| 'session', good, !!backfill\)/.test(s),
    'POST must receive the flag');
  assert.ok(/source: 'vodou-netcap'[^}]*backfill: !!backfill/.test(s),
    'the page message must carry it');
});

test('content.js forwards it to the extension worker', () => {
  assert.ok(/backfill: !!d\.backfill/.test(READ('content.js')),
    'content.js must pass backfill on the net_capture message');
});

test('background.js carries it on EVERY batch path, including the queued ones', () => {
  const s = READ('background.js');
  const hits = (s.match(/backfill: !!msg\.backfill/g) || []).length;
  // Three: the direct send plus both queueCapture paths. A queued batch that loses
  // the flag re-duplicates when the bridge comes back — the failure would only show
  // up after an outage, which is the worst time to discover it.
  assert.equal(hits, 3, `expected the flag on all 3 batch paths, found ${hits}`);
});

// ── The copilot adapter must not match Copilot's non-transcript endpoints ─────
// Matching them meant "wire format may have changed" printed once per KEYSTROKE
// (autosuggest), which buries the warning that is supposed to mean an adapter died.
function copilotMatcher() {
  const s = READ('inject.js');
  const i = s.indexOf("name: 'copilot',");
  assert.ok(i > 0, 'copilot adapter not found');
  // Take the matcher's BODY and run it directly — no string surgery on the arrow
  // wrapper, which is what makes this kind of extraction brittle.
  const open = s.indexOf('match: (url) => {', i);
  assert.ok(open > 0, 'copilot matcher not found (shape changed?)');
  const bodyStart = s.indexOf('{', open + 'match: (url) => '.length);
  let depth = 0, end = -1;
  for (let j = bodyStart; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  assert.ok(end > bodyStart, 'could not find the end of the matcher body');
  return new Function('url', s.slice(bodyStart + 1, end));
}

test('copilot adapter: matches transcripts and the live stream, not the noise', () => {
  const match = copilotMatcher();
  const C = 'https://copilot.microsoft.com';
  // Must match
  assert.equal(!!match(`${C}/c/api/conversations/abc123/history?api-version=2`), true, 'history is the transcript');
  assert.equal(!!match(`${C}/c/api/chat?api-version=2`), true, 'the live stream');
  assert.equal(!!match('wss://copilot.microsoft.com/c/api/chat?api-version=2'), true, 'the WS stream');
  // Must NOT match — every one of these produced a false drift warning
  assert.equal(!!match(`${C}/c/api/conversations/abc123/autosuggest?query=what+do`), false, 'typeahead, once per keystroke');
  assert.equal(!!match(`${C}/c/api/conversations/search/status`), false, 'search status');
  assert.equal(!!match(`${C}/c/api/conversations?types=chat`), false, 'the conversation LIST');
  assert.equal(!!match(`${C}/c/api/conversations`), false, 'the bare list');
  assert.equal(!!match(`${C}/c/api/activation/homepage`), false, 'activation');
  assert.equal(!!match('https://example.com/c/api/chat'), false, 'wrong host');
});

// ── Grok (P1c) ────────────────────────────────────────────────────────────────
// Grok arrived at this work ALREADY emitting whole transcripts, because
// /load-responses returns the whole conversation and the branch never trimmed it.
// That ignored the opt-in toggle — the consent boundary for reading pre-install
// history — and re-sent the full history on every page load.

function grokTranscript(n = 3) {
  const responses = [];
  for (let i = 1; i <= n; i++) {
    responses.push({ responseId: `r${i}a`, sender: 'human', message: `question ${i}`, createTime: `2026-01-0${i}T00:00:00Z`, steps: [{ text: 'Thinking about your request' }] });
    responses.push({ responseId: `r${i}b`, sender: 'assistant', message: `answer ${i}`, createTime: `2026-01-0${i}T00:00:01Z`, steps: [{ text: 'Acknowledging' }] });
  }
  return JSON.stringify({ responses });
}
const GROK_URL = 'https://grok.com/rest/app-chat/conversations/abc-123/load-responses';

test('grok: default OFF — forward-only, last exchange only (was: whole history, unasked)', () => {
  const { P } = loadWithBus();
  const out = P.parseGrok(grokTranscript(3), GROK_URL, null);
  assert.equal(out.backfill, undefined);
  assert.deepEqual(out.turns.map((t) => t.content), ['question 3', 'answer 3']);
});

test('grok: armed — the whole transcript, oldest first, responseId as the dedup key', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  const out = P.parseGrok(grokTranscript(3), GROK_URL, null);
  assert.equal(out.backfill, true);
  assert.deepEqual(out.turns.map((t) => t.content),
    ['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3']);
  assert.deepEqual(out.turns.map((t) => t.id), ['r1a', 'r1b', 'r2a', 'r2b', 'r3a', 'r3b']);
});

test('grok: reasoning stays out — steps[] is deliberation, not speech to the user', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  const out = P.parseGrok(grokTranscript(2), GROK_URL, null);
  assert.ok(!JSON.stringify(out.turns).includes('Thinking about your request'));
  assert.ok(!JSON.stringify(out.turns).includes('Acknowledging'));
});

test('grok: emitted ONCE — /load-responses fires on every page load', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: {} });
  assert.equal(P.parseGrok(grokTranscript(3), GROK_URL, null).turns.length, 6);
  assert.equal(P.parseGrok(grokTranscript(3), GROK_URL, null).turns.length, 0);
});

test('grok: forward-only mode also emits once, and waits for an unfinished reply', () => {
  const { P } = loadWithBus();
  assert.equal(P.parseGrok(grokTranscript(2), GROK_URL, null).turns.length, 2);
  assert.equal(P.parseGrok(grokTranscript(2), GROK_URL, null).turns.length, 0);
  // A trailing user turn means the answer is still generating — retry-worthy.
  const pending = JSON.stringify({ responses: [
    { responseId: 'p1', sender: 'human', message: 'unanswered', createTime: '2026-02-01T00:00:00Z' },
  ] });
  assert.equal(P.parseGrok(pending, GROK_URL, null).pending, true);
});

test('grok: per-site opt-out beats the master switch', () => {
  const { P, deliver } = loadWithBus();
  deliver({ source: 'vodou-netcap-config', backfill: true, backfillSites: { grok: false } });
  const out = P.parseGrok(grokTranscript(3), GROK_URL, null);
  assert.equal(out.backfill, undefined);
  assert.equal(out.turns.length, 2);
});
