// Unit tests for the netcap provider parsers in inject.js.
// Run: node --test extension/vodou-bridge/test/parsers.test.mjs
//
// inject.js is a browser MAIN-world IIFE; we evaluate it against a stubbed
// `window` and pull the pure parsers off window.__vodouNetCapParsers (the
// fetch/XHR/WebSocket shims no-op against the stub). Fixtures are synthetic
// recreations of each provider's known wire format — when a provider ships a
// breaking change, update the fixture together with the adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadInject } from '../../Store-vodou-bridge/test/parser-harness.mjs';

// inject.js no longer exports its parsers to the page (fdbee668) — the harness
// restores that seam inside the test process only.
const { P, internals: II } = loadInject(new URL('../inject.js', import.meta.url));

const sse = (...objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}`).join('\n\n') + '\n\ndata: [DONE]\n';

// Compare turns as the GATEWAY receives them, not as the parser builds them.
// Several parsers write `id: someId || undefined`, and `{id: undefined}` is a real
// own property that deepStrictEqual counts — but it never survives the relay, which
// JSON-serialises on the way to the bridge. Asserting on the wire shape keeps the
// fixtures honest about the thing that matters and stops a cosmetic difference from
// reading as a capture failure.
const wire = (turns) => JSON.parse(JSON.stringify(turns));

test('sseDataChunks strips framing and [DONE]', () => {
  const chunks = P.sseDataChunks('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":2}');
  assert.deepEqual(chunks, ['{"a":1}', '{"b":2}']);
});

test('chatgpt: user + last assistant frame win', () => {
  const body = sse(
    { conversation_id: 'c-123', message: { author: { role: 'user' }, content: { parts: ['hi gpt'] } } },
    { message: { author: { role: 'assistant' }, content: { parts: ['partial'] } } },
    { message: { author: { role: 'assistant' }, content: { parts: ['final answer'] } } },
  );
  const r = P.parseChatGPT(body);
  assert.equal(r.conversationId, 'c-123');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi gpt' },
    { role: 'assistant', content: 'final answer' },
  ]);
});

test('chatgpt: delta encoding — appends assemble the assistant, user rides reqBody', () => {
  const body = sse(
    // initial frame: assistant message shell with empty parts + conversation id
    { v: { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] } }, conversation_id: 'c-999' } },
    // bare string appends (implicit path = parts)
    { v: 'Received exactly: ' },
    { v: 'canary check ' },
    // explicit patch batch: parts append + a status op that must not leak in
    { o: 'patch', v: [
      { p: '/message/content/parts/0', o: 'append', v: 'emerald-walrus-0713' },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
    ] },
  );
  const reqBody = JSON.stringify({
    action: 'next',
    conversation_id: 'c-999',
    messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['canary check emerald-walrus-0713'] } }],
  });
  const r = P.parseChatGPT(body, 'https://chatgpt.com/backend-api/f/conversation', reqBody);
  assert.equal(r.conversationId, 'c-999');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'canary check emerald-walrus-0713' },
    { role: 'assistant', content: 'Received exactly: canary check emerald-walrus-0713' },
  ]);
});

test('chatgpt: delta encoding — reasoning/thought patches are not captured as answer text', () => {
  const body = sse(
    { v: { message: { author: { role: 'assistant' }, content: { parts: [''] } }, conversation_id: 'c-42' } },
    { o: 'patch', v: [{ p: '/message/content/thoughts/0/content', o: 'append', v: 'secret reasoning' }] },
    // bare append right after a thoughts path must NOT flow into the answer
    { v: ' more reasoning' },
    { o: 'patch', v: [{ p: '/message/content/parts/0', o: 'append', v: 'the real answer' }] },
  );
  const r = P.parseChatGPT(body, 'https://chatgpt.com/backend-api/f/conversation', '');
  assert.deepEqual(r.turns, [{ role: 'assistant', content: 'the real answer' }]);
});

test('chatgpt: conversation snapshot — last completed exchange only, deduped on refetch', () => {
  const snap = {
    conversation_id: 'c-snap',
    mapping: {
      a: { message: { id: 'm1', author: { role: 'user' }, content: { content_type: 'text', parts: ['old question'] }, create_time: 1 } },
      b: { message: { id: 'm2', author: { role: 'assistant' }, status: 'finished_successfully', content: { content_type: 'text', parts: ['old answer'] }, create_time: 2 } },
      c: { message: { id: 'm3', author: { role: 'user' }, content: { content_type: 'text', parts: ['canary check emerald-chad-7766'] }, create_time: 3 } },
      // reasoning node between the pair — must be skipped
      e: { message: { id: 'm5', author: { role: 'assistant' }, status: 'finished_successfully', content: { content_type: 'thoughts', parts: ['hidden reasoning'] }, create_time: 3.5 } },
      d: { message: { id: 'm4', author: { role: 'assistant' }, status: 'finished_successfully', content: { content_type: 'text', parts: ['Received exactly: canary check emerald-chad-7766'] }, create_time: 4 } },
    },
  };
  const url = 'https://chatgpt.com/backend-api/conversation/6a55186f-51b0-83ea-8e61-ce7483b02cef';
  const r = P.parseChatGPT(JSON.stringify(snap), url, '');
  assert.equal(r.conversationId, 'c-snap');
  // Snapshot turns carry the provider's own message ids (6840220) — that is what
  // makes a re-opened conversation dedup exactly instead of by content hash.
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary check emerald-chad-7766', id: 'm3' },
    { role: 'assistant', content: 'Received exactly: canary check emerald-chad-7766', id: 'm4' },
  ]);
  // the same snapshot re-fetched (init/textdocs refire it) → deduped to zero,
  // and pending:false so the nudge does NOT retry (the perf-jank guard)
  const r2 = P.parseChatGPT(JSON.stringify(snap), url, '');
  assert.deepEqual(r2.turns, []);
  assert.equal(r2.pending, false);
});

test('chatgpt: snapshot with in-progress assistant emits nothing (waits for the finished refetch)', () => {
  const snap = {
    conversation_id: 'c-live',
    mapping: {
      a: { message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['question'] }, create_time: 1 } },
      b: { message: { id: 'a1', author: { role: 'assistant' }, status: 'in_progress', content: { content_type: 'text', parts: ['partial…'] }, create_time: 2 } },
    },
  };
  const r = P.parseChatGPT(JSON.stringify(snap), 'https://chatgpt.com/backend-api/conversation/6a55186f-51b0-83ea-8e61-ce7483b02cef', '');
  assert.deepEqual(r.turns, []);
  assert.equal(r.pending, true); // reply generating → retry-worthy
});

test('claude: user prompt comes from the REQUEST body (the gap fix)', () => {
  const url = 'https://claude.ai/api/organizations/o1/chat_conversations/uuid-9/completion';
  const body = sse({ completion: 'Hello ' }, { completion: 'from Claude' });
  const r = P.parseClaude(body, url, JSON.stringify({ prompt: 'hi claude', timezone: 'UTC' }));
  assert.equal(r.conversationId, 'uuid-9');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi claude' },
    { role: 'assistant', content: 'Hello from Claude' },
  ]);
});

test('claude: still yields assistant-only without a request body (regression)', () => {
  const r = P.parseClaude(sse({ completion: 'solo' }), 'https://claude.ai/api/x/chat_conversations/u2/completion', '');
  assert.deepEqual(r.turns, [{ role: 'assistant', content: 'solo' }]);
});

test('claude: conversation snapshot — last completed exchange, structured content, deduped', () => {
  const snapUrl = 'https://claude.ai/api/organizations/7a5c/chat_conversations/7093c189-537b-44f6-a873-c0d1aaaaaaaa?tree=True&rendering_mode=messages';
  const snap = {
    uuid: '7093c189-537b-44f6-a873-c0d1aaaaaaaa',
    name: 'canary',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'old q', content: [{ type: 'text', text: 'old q' }], created_at: '2026-07-13T20:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: 'old a', content: [{ type: 'text', text: 'old a' }], created_at: '2026-07-13T20:00:05Z' },
      { uuid: 'm3', sender: 'human', text: '', content: [{ type: 'text', text: 'set canary green-skateboard-elephant' }], created_at: '2026-07-13T20:01:00Z' },
      { uuid: 'm4', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Canary set: green-skateboard-elephant' }], created_at: '2026-07-13T20:01:05Z' },
    ],
  };
  const r = P.parseClaude(JSON.stringify(snap), snapUrl, '');
  assert.equal(r.conversationId, '7093c189-537b-44f6-a873-c0d1aaaaaaaa');
  // Per-message uuids ride through as turn ids — the backfill plan's whole basis
  // for opening the same conversation twice without storing it twice.
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'set canary green-skateboard-elephant', id: 'm3' },
    { role: 'assistant', content: 'Canary set: green-skateboard-elephant', id: 'm4' },
  ]);
  // re-fetch (conversation reopen) → deduped, pending:false (no retry)
  const r2 = P.parseClaude(JSON.stringify(snap), snapUrl, '');
  assert.deepEqual(r2.turns, []);
  assert.equal(r2.pending, false);
});

test('claude: snapshot ending on a human turn emits nothing (reply still generating)', () => {
  const snap = {
    uuid: 'u-live',
    chat_messages: [
      { uuid: 'h1', sender: 'human', text: 'question', content: [], created_at: '2026-07-13T20:02:00Z' },
    ],
  };
  const r = P.parseClaude(JSON.stringify(snap), 'https://claude.ai/api/organizations/o/chat_conversations/u-live', '');
  assert.deepEqual(r.turns, []);
  assert.equal(r.pending, true); // reply generating → retry-worthy
});

test('gemini: batchexecute framing + f.req prompt', () => {
  const inner = JSON.stringify([null, ['c_abc123'], null, null, [[null, ['Gemini answer text']]]]);
  const body = `)]}'\n\n123\n${JSON.stringify([['wrb.fr', null, inner]])}\n`;
  const reqInner = JSON.stringify([['what is quantum foam', 0, null, null]]);
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify([null, reqInner])) + '&at=tok';
  const r = P.parseGemini(body, 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=x', reqBody);
  assert.equal(r.conversationId, 'c_abc123');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'what is quantum foam' },
    { role: 'assistant', content: 'Gemini answer text' },
  ]);
});

test('perplexity: final embedded answer + query_str', () => {
  const body = sse(
    { backend_uuid: 'b-77' },
    { text: JSON.stringify({ answer: 'Perplexity final answer', chunks: [] }) },
  );
  const r = P.parsePerplexity(body, 'https://www.perplexity.ai/rest/sse/perplexity_ask', JSON.stringify({ params: { query_str: 'my query' } }));
  assert.equal(r.conversationId, 'b-77');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'my query' },
    { role: 'assistant', content: 'Perplexity final answer' },
  ]);
});

test('grok: modelResponse.message beats token accumulation', () => {
  const body = [
    JSON.stringify({ result: { response: { token: 'Hel' } } }),
    JSON.stringify({ result: { response: { token: 'lo' } } }),
    JSON.stringify({ result: { response: { modelResponse: { message: 'Hello there, human' } } } }),
  ].join('\n');
  const r = P.parseGrok(body, 'https://grok.com/rest/app-chat/conversations/c-42/responses', JSON.stringify({ message: 'hi grok' }));
  assert.equal(r.conversationId, 'c-42');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi grok' },
    { role: 'assistant', content: 'Hello there, human' },
  ]);
});

test('grok: token accumulation fallback when no final frame', () => {
  const body = [
    JSON.stringify({ result: { response: { token: 'str' } } }),
    JSON.stringify({ result: { response: { token: 'eam' } } }),
  ].join('\n');
  const r = P.parseGrok(body, 'https://grok.com/rest/app-chat/conversations/new', JSON.stringify({ message: 'q' }));
  assert.equal(r.turns[1].content, 'stream');
});

// Recorded live 2026-07-27. Grok-on-X puts reasoning on the SAME field as the
// answer, discriminated by messageTag — so the parser welded "Thinking about your
// request" onto the front of the reply, and it read as normal speech.
test('grok on x.com: messageTag gates the answer; the thinking header never lands', () => {
  const body = [
    { conversationId: '2081834429522084131', userChatItemId: 'u-8548352', agentChatItemId: 'a-8548353' },
    { result: { sender: 'ASSISTANT', uiLayout: { reasoningUILayout: 'UNIFIED' } } },
    { result: { sender: 'ASSISTANT', message: 'Thinking about your request', isThinking: true, messageTag: 'header', messageStepId: 0 } },
    { result: { sender: 'ASSISTANT', messageTag: 'thinking_start', messageStepId: 0 } },
    { result: { sender: 'ASSISTANT', messageTag: 'response_start', messageStepId: 0 } },
    { result: { sender: 'ASSISTANT', message: 'Acknowled', messageTag: 'final' } },
    { result: { sender: 'ASSISTANT', message: 'ged.', messageTag: 'final' } },
    { result: { sender: 'ASSISTANT', isSoftStop: true } },
  ].map((o) => JSON.stringify(o)).join('\n');
  const reqBody = JSON.stringify({
    conversationId: '2081834429522084131',
    responses: [
      { message: 'an older question', sender: 1 },
      { message: 'an older answer', sender: 2 },
      { message: 'canary VDU-GROKX-0727', sender: 1, promptSource: '' },
    ],
    grokModelOptionId: 'grok-3-latest',
  });
  const r = P.parseGrokX(body, 'https://grok.x.com/2/grok/add_response.json', reqBody);
  assert.equal(r.conversationId, '2081834429522084131');
  assert.deepEqual(wire(r.turns), [
    // Only the LAST sender:1 entry — the request replays the whole thread.
    { role: 'user', content: 'canary VDU-GROKX-0727', id: 'u-8548352' },
    { role: 'assistant', content: 'Acknowledged.', id: 'a-8548353' },
  ]);
  assert.ok(!JSON.stringify(r.turns).includes('Thinking about'), 'reasoning header reached the turn');
});

test('grok on x.com: add_response chunks + request responses[] prompt', () => {
  const body = [
    JSON.stringify({ result: { sender: 'ASSISTANT', message: 'Grok ' } }),
    JSON.stringify({ result: { sender: 'ASSISTANT', message: 'on X' } }),
    JSON.stringify({ result: { conversationId: 'xc-9' } }),
  ].join('\n');
  const reqBody = JSON.stringify({
    conversationId: 'xc-9',
    responses: [
      { message: 'earlier turn', sender: 1 },
      { message: 'hi grok on x', sender: 1 },
    ],
  });
  const r = P.parseGrokX(body, 'https://x.com/i/api/2/grok/add_response.json', reqBody);
  assert.equal(r.conversationId, 'xc-9');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi grok on x' },
    { role: 'assistant', content: 'Grok on X' },
  ]);
});

// Rewritten 2026-07-27 against the format confirmed live in ae1a4bc. The previous
// fixture encoded the INFERRED shape (`p: 'response/content'`), which no live
// DeepSeek build ever sent — so it kept passing a parser that could not read the
// real wire, and kept failing the one that can.
test('deepseek: fragment list + appends; THINKING shares the answer path and must be dropped', () => {
  const body = sse(
    // Seed: the whole response object. A thinking model opens with a THINKING
    // fragment, and message_id is the dedup key.
    { v: { response: { message_id: 'ds-77', fragments: [{ type: 'THINKING', content: 'The user asks ' }] } }, p: '' },
    // Appends target fragments/-1 — *the last fragment*, whatever it is. This one
    // is still the THINKING fragment: a path-based filter would capture it.
    { v: 'about a canary.', p: 'response/fragments/-1/content' },
    // The answer fragment arrives as a whole object carrying its opening text —
    // the shape whose absence clipped the first word of every reply.
    { v: { type: 'RESPONSE', content: 'DeepSeek ' }, p: 'response/fragments' },
    { v: 'reply', p: 'response/fragments/-1/content' },
  );
  const r = P.parseDeepSeek(body, 'https://chat.deepseek.com/api/v0/chat/completion', JSON.stringify({ prompt: 'hi ds', chat_session_id: 's-9' }));
  assert.equal(r.conversationId, 's-9');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'hi ds' },
    { role: 'assistant', content: 'DeepSeek reply', id: 'ds-77' },
  ]);
  // OpenAI-compatible builds stream plain choices[].delta.content — still handled.
  const compat = P.parseDeepSeek(sse({ choices: [{ delta: { content: 'compat reply' } }] }),
    'https://chat.deepseek.com/api/v0/chat/completion', JSON.stringify({ prompt: 'hi ds' }));
  assert.equal(compat.turns[1].content, 'compat reply');
});

test('lechat: vercel data-stream 0:"chunk" lines', () => {
  const body = '0:"Bonjour"\n0:" de"\n0:" Mistral"\ne:{"finishReason":"stop"}\n';
  const r = P.parseLeChat(body, 'https://chat.mistral.ai/api/chat', JSON.stringify({ chatId: 'm-1', content: 'salut' }));
  assert.equal(r.conversationId, 'm-1');
  // Legacy shape: no messageId on the wire, so the assistant turn stays id-less
  // and dedups by content hash. The live JSON-Patch shape is the test below.
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'Bonjour de Mistral' },
  ]);
});

// The live shape (f873a54 / 55f6ad5): numbered lines wrapping JSON-Patch ops.
// There is no frame anywhere carrying the finished text — it only exists assembled.
test('lechat: JSON-Patch ops assemble the reply, including the opening `add` chunk', () => {
  const body = [
    '15:' + JSON.stringify({ json: { type: 'bootstrap', chat: { id: 'm-2' }, messages: [{ role: 'user', content: 'resume ca' }] } }),
    // FIRST chunk is a whole object added at /contentChunks/0, not an append.
    // Skipping it is what clipped every reply to "ed! Here's the summary…".
    '15:' + JSON.stringify({ json: { type: 'message', messageId: 'bf3f', patches: [{ op: 'add', path: '/contentChunks/0', value: { text: 'Logg' } }] } }),
    '15:' + JSON.stringify({ json: { type: 'message', messageId: 'bf3f', patches: [{ op: 'append', path: '/contentChunks/0/text', value: 'ed!' }] } }),
    // Non-text patches must not leak into the answer.
    '15:' + JSON.stringify({ json: { type: 'message', messageId: 'bf3f', patches: [{ op: 'replace', path: '/generationStatus', value: 'DONE' }] } }),
    '8:null',
  ].join('\n');
  const r = P.parseLeChat(body, 'https://chat.mistral.ai/api/chat', '');
  assert.equal(r.conversationId, 'm-2');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'resume ca' },
    { role: 'assistant', content: 'Logged!', id: 'bf3f' },
  ]);
});

// Recorded from the binary WebSocket 2026-07-27. Meta AI's chat rides
// wss://gateway.meta.ai/ws/clippy as a protobuf envelope with JSON embedded as
// string fields — invisible until the tap learned to decode binary frames.
test('metaai (ws): cumulative snapshots are assigned, not appended', () => {
  const env = (json) => ({ __raw: '\u0000\u0012\u0004junk' + json + '\u0000R\u0011binary tail' });
  const frames = [
    { __raw: '{"prompt":"canary VDU-METAAI-0727"}', __outgoing: true },
    env('{"seq":0,"type":"full","response":{"response_id":"37381d2f","sections":[{"view_model":{"__typename":"GenAISingleLayoutViewModel","primitive":{"__typename":"GenAIMarkdownTextUXPrimitive","text":"Acknowledged —"}}}]}}'),
    env('{"seq":1,"type":"patch","operations":[{"op":"delta","path":"/sections/0/view_model/primitive/text","value":" keeping"}]}'),
    env('{"seq":10,"type":"full","response":{"response_id":"37381d2f","sections":[{"view_model":{"primitive":{"text":"Acknowledged — keeping it on record."}}}]}}'),
  ];
  const r = P.parseMetaAIFrames(frames);
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary VDU-METAAI-0727' },
    // Appending the snapshots would give "Acknowledged —Acknowledged — keeping…"
    // — the reply repeated once per frame, which still reads as a good capture.
    { role: 'assistant', content: 'Acknowledged — keeping it on record.', id: '37381d2f' },
  ]);
});

// The prompt rides a base64 protobuf payload (PROTO_INSIDE_JSON) with no field
// name to read, so it is recovered heuristically: longest human-looking run.
test('metaai (ws): conversation id from the header frame; prompt out of the protobuf', () => {
  // A protobuf-shaped blob: enum names and ids with the prompt among them.
  const proto = 'KADABRA__CHAT__UNIFIED_INPUT_BAR\u0012\u00101522763855472543'
    + '\u0000HUMAN_AGENT\u0000ECTO1\u0000Abra Web Main Key\u0000MODE_FAST\u0000Mac OS X'
    + '\u0000For the record: we completed the Vodou capture test on Meta AI\u0000';
  const b64 = Buffer.from(proto, 'utf8').toString('base64');
  const frames = [
    { __raw: JSON.stringify({ 'x-dgw-app-x-ecto-conversation-id': '860dbc44', 'x-dgw-app-client-payload-type': 'PROTO_INSIDE_JSON' }), __outgoing: true },
    { __raw: JSON.stringify({ 'req-id': 'ec98c671', payload: b64 }), __outgoing: true },
    { __raw: 'binary noise {"seq":0,"type":"full","response":{"response_id":"37381d2f","sections":[{"view_model":{"primitive":{"text":"Acknowledged."}}}]}} tail' },
  ];
  const r = P.parseMetaAIFrames(frames);
  // Not response_id — that would give every REPLY its own conversation.
  assert.equal(r.conversationId, '860dbc44');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'For the record: we completed the Vodou capture test on Meta AI' },
    { role: 'assistant', content: 'Acknowledged.', id: '37381d2f' },
  ]);
  // Enum names and keys must never be mistaken for something the user said.
  const blob = JSON.stringify(r.turns);
  for (const noise of ['KADABRA', 'HUMAN_AGENT', 'Abra Web', 'MODE_FAST']) {
    assert.ok(!blob.includes(noise), `stored protobuf noise: ${noise}`);
  }
});

// The payload type is PROTO_INSIDE_JSON: the prompt appears twice, bare between
// protobuf length prefixes and again inside a JSON string. The bare copy picks up
// a framing byte at each end — stored as `tFor the record: …for sure."` live on
// 2026-07-27 — so the delimited copy must win.
test('metaai (ws): the JSON-delimited prompt beats the bare protobuf copy', () => {
  const bare = 'tFor the record: we completed the Vodou capture test on Meta AI.';
  const json = '{"prompt_text":"For the record: we completed the Vodou capture test on Meta AI."}';
  const payload = Buffer.from('KADABRA__CHAT__UNIFIED_INPUT_BAR ' + bare + ' ' + json, 'utf8').toString('base64');
  const r = P.parseMetaAIFrames([
    { __raw: JSON.stringify({ 'req-id': 'x', payload }), __outgoing: true },
    { __raw: '{"seq":0,"type":"full","response":{"response_id":"r1","sections":[{"view_model":{"primitive":{"text":"Got it."}}}]}}' },
  ]);
  assert.equal(r.turns[0].content, 'For the record: we completed the Vodou capture test on Meta AI.');
  assert.ok(!r.turns[0].content.startsWith('t'), 'kept the protobuf framing byte');
});

test('metaai: snippet stream + variables prompt; ignores unrelated graphql', () => {
  const reqBody = 'fb_api_req_friendly_name=useAbraSendMessageMutation&variables='
    + encodeURIComponent(JSON.stringify({ message: { sensitive_string_value: 'hi meta' } }));
  const body = [
    JSON.stringify({ data: { node: { bot_response_message: { snippet: 'Meta partial' } } } }),
    JSON.stringify({ data: { node: { bot_response_message: { snippet: 'Meta says hi', conversation: { thread_key: 't-7' } } } } }),
  ].join('\n');
  const r = P.parseMetaAI(body, 'https://www.meta.ai/api/graphql/', reqBody);
  assert.equal(r.conversationId, 't-7');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi meta' },
    { role: 'assistant', content: 'Meta says hi' },
  ]);
  const other = P.parseMetaAI(body, 'https://www.meta.ai/api/graphql/', 'fb_api_req_friendly_name=SomethingElse');
  assert.equal(other.turns.length, 0);
});

test('aistudio: deep-collects [null,"text"] pairs in order', () => {
  const body = JSON.stringify([[[[null, 'AI '], [null, 'Studio reply']]]]);
  const req = JSON.stringify([[[null, 'user prompt q']]]);
  const r = P.parseAIStudio(body, 'https://alkalimakersuite-pa.clients6.google.com/$rpc/GenerateContent', req);
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'user prompt q' },
    { role: 'assistant', content: 'AI Studio reply' },
  ]);
});

test('copilot: send/appendText/done frame list', () => {
  const frames = [
    { event: 'send', conversationId: 'cc-1', content: [{ type: 'text', text: 'hi copilot' }] },
    { event: 'appendText', text: 'Cop' },
    { event: 'appendText', text: 'ilot here' },
    { event: 'done' },
  ];
  const r = P.parseCopilotFrames(frames);
  assert.equal(r.conversationId, 'cc-1');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'hi copilot' },
    { role: 'assistant', content: 'Copilot here' },
  ]);
});

test('qwen/zai/openrouter: shared OpenAI-SSE parser + cid fields', () => {
  const body = sse(
    { choices: [{ delta: { content: 'Qwen ' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
  );
  const req = JSON.stringify({ chat_id: 'q-1', messages: [{ role: 'user', content: 'hi qwen' }] });
  const r = P.parseQwen(body, 'https://chat.qwen.ai/api/v2/chat/completions', req);
  assert.equal(r.conversationId, 'q-1');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi qwen' },
    { role: 'assistant', content: 'Qwen answer' },
  ]);
  // Z.ai delta_content variant flows through the same parser.
  const zBody = sse({ data: { delta_content: 'GLM says hi' } });
  const z = P.parseZai(zBody, 'https://chat.z.ai/api/chat/completions', JSON.stringify({ messages: [{ role: 'user', content: 'hi glm' }] }));
  assert.equal(z.turns[1].content, 'GLM says hi');
  // Parts-array message content (multimodal composer).
  const o = P.parseOpenRouter(body, 'https://openrouter.ai/api/v1/chat/completions',
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi or' }] }] }));
  assert.equal(o.turns[0].content, 'hi or');
});

// kimi.com moved to a Connect RPC, but the adapter still matches
// kimi.moonshot.cn/…/completion/stream. This test guards the legacy branch: it is
// the only thing standing between that site and silent, permanent capture loss.
// Recorded live 2026-07-27 (glm-4.7, enable_thinking:true). The reply and the
// chain of thought arrive on the SAME field, discriminated only by `phase` — and
// before this test the shared parser concatenated both into the stored answer.
test('zai: phase discriminates reasoning from answer on one field', () => {
  const body = sse(
    { type: 'chat:completion', data: { delta_content: '1. **Analyze the Input:** the user says', phase: 'thinking' } },
    { type: 'chat:completion', data: { delta_content: ' they ran a capture test.', phase: 'thinking' } },
    { type: 'chat:completion', data: { delta_content: 'Logged', phase: 'answer' } },
    // The usage frame lands BETWEEN answer deltas — a parser that stopped at the
    // first non-answer phase would truncate the reply.
    { type: 'chat:completion', data: { phase: 'other', usage: { total_tokens: 918 } } },
    { type: 'chat:completion', data: { delta_content: ' — noted.', phase: 'answer' } },
    { type: 'chat:completion', data: { phase: 'done', done: true } },
  );
  const r = P.parseZai(body, 'https://chat.z.ai/api/v2/chat/completions',
    JSON.stringify({ chat_id: 'f780e055', messages: [{ role: 'user', content: 'canary' }] }));
  assert.equal(r.conversationId, 'f780e055');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary' },
    { role: 'assistant', content: 'Logged — noted.' },
  ]);
  assert.ok(!JSON.stringify(r.turns).includes('Analyze the Input'), 'reasoning must never be captured');
});

// Both ids ride the request; cross-checked against Z.ai's own history endpoint.
// Without them, re-sending an identical prompt inside the dedup window ate the
// repeat — the transcript kept two assistant turns and one user turn.
test('zai: request message ids key both turns', () => {
  const r = P.parseZai(sse({ data: { delta_content: 'ack', phase: 'answer' } }),
    'https://chat.z.ai/api/v2/chat/completions',
    JSON.stringify({
      chat_id: 'b5224cc4',
      id: '4672d904',                              // assistant message id
      current_user_message_id: 'bd395624',         // prompt id
      messages: [{ role: 'user', content: 'canary' }],
    }));
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary', id: 'bd395624' },
    { role: 'assistant', content: 'ack', id: '4672d904' },
  ]);
});

// A build with no `phase` at all is a plain OpenAI-shaped stream — the allowlist
// must not silence it.
test('zai: phase-less delta_content still counts (non-thinking build)', () => {
  const r = P.parseZai(sse({ data: { delta_content: 'GLM says hi' } }), 'https://chat.z.ai/api/chat/completions',
    JSON.stringify({ messages: [{ role: 'user', content: 'hi glm' }] }));
  assert.equal(r.turns[1].content, 'GLM says hi');
});

test('kimi: cmpl event chunks + url conversation id', () => {
  const body = sse({ event: 'req', id: 'x' }, { event: 'cmpl', text: 'Kimi ' }, { event: 'cmpl', text: 'reply' }, { event: 'all_done' });
  const r = P.parseKimi(body, 'https://kimi.com/api/chat/k-77/completion/stream', JSON.stringify({ messages: [{ role: 'user', content: 'hi kimi' }] }));
  assert.equal(r.conversationId, 'k-77');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi kimi' },
    { role: 'assistant', content: 'Kimi reply' },
  ]);
});

test('duckai: message chunks + request messages', () => {
  const body = sse({ role: 'assistant', message: 'Duck ' }, { message: 'answer' });
  const r = P.parseDuckAI(body, 'https://duckduckgo.com/duckchat/v1/chat', JSON.stringify({ messages: [{ role: 'user', content: 'hi duck' }] }));
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi duck' },
    { role: 'assistant', content: 'Duck answer' },
  ]);
  // No durableStream in the request → the old, honest fallback.
  assert.equal(r.conversationId, 'session');
});

// Recorded from live traffic 2026-07-27 (duck.ai host, gpt-5.4-nano). Two things
// the synthetic fixture above could never have shown: the conversation id lives in
// the REQUEST under durableStream, and every assistant delta repeats the msg_… id.
test('duckai: durableStream carries the conversation id; assistant turn keys on msg id', () => {
  const MSG = 'msg_00e10830eb62ec04016a678e0c468c819faa8aa3717319b706';
  const body = sse(
    { id: MSG, action: 'success', model: 'gpt-5.4-nano-2026-03-17', role: 'assistant', message: 'Got' },
    { id: MSG, action: 'success', model: 'gpt-5.4-nano-2026-03-17', role: 'assistant', message: ' it' },
    { id: MSG, action: 'success', model: 'gpt-5.4-nano-2026-03-17', role: 'assistant', message: '.' },
  );
  const reqBody = JSON.stringify({
    model: 'gpt-5.4-nano',
    messages: [{ role: 'user', content: 'canary' }],
    reasoningEffort: 'none',
    durableStream: {
      messageId: 'b4b48d3b-56b6-4bee-9849-e6b4380a9d82',
      conversationId: 'cd215c0d-c61c-408f-b99f-0526ed702a32',
      publicKey: { alg: 'RSA-OAEP-256', kty: 'RSA', n: 'xJlt3YoH…' },
    },
  });
  const r = P.parseDuckAI(body, 'https://duck.ai/duckchat/v1/chat', reqBody);
  assert.equal(r.conversationId, 'cd215c0d-c61c-408f-b99f-0526ed702a32');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'canary' },
    { role: 'assistant', content: 'Got it.', id: MSG },
  ]);
  // The prompt must stay id-less: durableStream.messageId names the RESPONSE
  // stream, so keying the user turn on it would mint a new key per resend.
  assert.equal(r.turns[0].id, undefined);
});

// P0 found live 2026-07-27: HuggingChat (Kimi-K2.6 via the router) streams
// <think>…</think> INLINE in the reply text — no frame, no field, no type. The
// stored 4,120-char "reply" opened with the model's analysis of the user.
test('huggingchat: inline <think> blocks never reach the stored turn', () => {
  const body = [
    { type: 'status', status: 'started' },
    { type: 'stream', token: '<think>The user is informing me about a capture test. ' },
    { type: 'stream', token: 'I should acknowledge it.</think>' },
    { type: 'stream', token: 'Acknowledged — canary VDU-HUGGINGCHAT-0727 logged.' },
    { type: 'status', status: 'finished' },
  ].map((o) => JSON.stringify(o)).join('\n');
  const r = P.parseHuggingChat(body, 'https://huggingface.co/chat/conversation/6a67a3e4',
    JSON.stringify({ inputs: 'canary' }));
  assert.equal(r.conversationId, '6a67a3e4');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary' },
    { role: 'assistant', content: 'Acknowledged — canary VDU-HUGGINGCHAT-0727 logged.' },
  ]);
});

test('stripInlineReasoning: an unterminated <think> drops the remainder', () => {
  // Stream cut mid-thought. Losing a reply is visible; storing reasoning as speech
  // is not — so the truncating direction is the safe one.
  assert.equal(P.stripInlineReasoning('Hello. <think>still deliberating about the user'), 'Hello.');
  assert.equal(P.stripInlineReasoning('<thinking>hidden</thinking>Visible'), 'Visible');
  assert.equal(P.stripInlineReasoning('No tags here'), 'No tags here');
});

// The dump printed «REDACTED» over every chunk of the reply on the one site we
// were debugging, because HuggingChat names its text deltas `token`.
// You.com's LaunchDarkly EventSource carries its user context as a BARE base64
// JSON blob in the URL path — no dots, so the JWT pattern missed it, and our own
// "EventSource opened" breadcrumb printed the owner's email (2026-07-27).
test('redact: a bare base64 JSON blob in a URL never prints', () => {
  const ctx = 'eyJraW5kIjoidXNlciIsImtleSI6IjI5YzdhZWQ1IiwiZW1haWwiOiJjaGFkQGxpbmtpZXMuY29tIn0';
  const url = 'https://clientstream.launchdarkly.com/eval/61fc70ffa79e9a158922a4b2/' + ctx;
  const out = P.redact(url);
  assert.ok(!out.includes(ctx), 'base64 user context leaked');
  assert.ok(out.includes('clientstream.launchdarkly.com'), 'host should survive — it identifies the endpoint');
});

// Meta AI puts a live session token in the WebSocket URL as `Authorization=`,
// and our own breadcrumb printed it whole (2026-07-27) — neither auth_token nor
// token matches that literal param name.
test('redactUrl: Authorization param and any long opaque value are stripped', () => {
  const tok = 'ecto1:Q8yEDAHSbYe-cUfP1lDeVvw5EE6Cmtt31s5-EnwslQgxLdWxrSAU73uziXn0XpP7XFB2ps4xW5kEOf5A';
  const url = 'wss://gateway.meta.ai/ws/clippy?x-dgw-appid=1522763855472543&Authorization=' + tok + '&x-dgw-tier=prod';
  const out = P.redactUrl(url);
  assert.ok(!out.includes(tok), 'live token leaked');
  // The endpoint must remain identifiable — that is the point of the breadcrumb.
  assert.ok(out.includes('gateway.meta.ai/ws/clippy'), 'host/path should survive');
  assert.ok(out.includes('x-dgw-tier=prod'), 'short values should survive');
  // Shape backstop: a long opaque value under an unknown param name still goes.
  const odd = P.redactUrl('https://x.test/a?blob=' + 'A'.repeat(80) + '&cid=c0_4e57a3ee');
  assert.ok(!odd.includes('A'.repeat(80)), 'long opaque value leaked');
  assert.ok(odd.includes('cid=c0_4e57a3ee'), 'conversation ids must stay readable');
});

// The credential fixture is deliberately NOT key-shaped. It used to be a literal
// `sk_live_…`, which is a real Stripe live-key prefix — GitHub push protection blocked
// the open-source sync over it, and it would trip every scanner forever after. The rule
// under test is the SHAPE rule (a long unbroken base64-ish value under "token"), not a
// Stripe pattern, so any opaque string exercises it identically.
test('redact: a `token` field holding prose survives; a credential does not', () => {
  assert.ok(P.redact('{"type":"stream","token":"Acknowledged — canary logged."}').includes('Acknowledged'));
  assert.ok(!P.redact('{"token":"NOT_A_REAL_KEY_0000000000000000"}').includes('sk_live_51H8xKf'));
  assert.ok(!P.redact('{"access_token":"short but named"}').includes('short but named'));
});

test('huggingchat: finalAnswer supersedes stream tokens; inputs prompt', () => {
  const body = [
    JSON.stringify({ type: 'stream', token: 'HF\u0000 ' }),
    JSON.stringify({ type: 'stream', token: 'partial' }),
    JSON.stringify({ type: 'finalAnswer', text: 'HF final answer' }),
  ].join('\n');
  const r = P.parseHuggingChat(body, 'https://huggingface.co/chat/conversation/h-5', JSON.stringify({ inputs: 'hi hf' }));
  assert.equal(r.conversationId, 'h-5');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi hf' },
    { role: 'assistant', content: 'HF final answer' },
  ]);
});

test('youcom: youChatToken chunks + q from URL', () => {
  const body = sse({ youChatToken: 'You ' }, { youChatToken: 'answer' });
  const r = P.parseYouCom(body, 'https://you.com/api/streamingSearch?q=hi%20you&chatId=y-3');
  assert.equal(r.conversationId, 'y-3');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi you' },
    { role: 'assistant', content: 'You answer' },
  ]);
});

test('t3chat: vercel stream + threadId', () => {
  const body = '0:"T3 "\n0:"reply"\nd:{"finishReason":"stop"}\n';
  const r = P.parseT3Chat(body, 'https://t3.chat/api/chat', JSON.stringify({ threadId: 't-8', messages: [{ role: 'user', content: 'hi t3' }] }));
  assert.equal(r.conversationId, 't-8');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi t3' },
    { role: 'assistant', content: 'T3 reply' },
  ]);
});

// Recorded live from t3.chat 2026-07-27. The AI SDK v5 protocol replaced v4's
// numbered lines with typed SSE frames, so vercelStreamText found nothing and the
// adapter reported "parsed 0 turns" with a perfectly good reply on the wire.
test('t3chat: AI SDK v5 typed frames — text-delta assembles, reasoning-delta never does', () => {
  const ID = 'gen-1785175989-8lZ8KEE2NTg3eG6FrTSl';
  const body = sse(
    { type: 'start', messageId: '2gMEQMXymC6FtgYA' },
    { type: 'start-step' },
    { type: 'text-start', id: ID },
    { type: 'text-delta', id: ID, delta: 'Ack' },
    { type: 'text-delta', id: ID, delta: 'nowledged' },
    // v5 streams reasoning on the SAME wire with its own frame type. Matching on
    // "has a delta" instead of the type would file chain of thought as the reply.
    { type: 'reasoning-delta', id: ID, delta: 'The user wants me to log a canary…' },
    { type: 'text-delta', id: ID, delta: '.' },
    { type: 'text-end', id: ID },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  );
  // Real request shape: v5 messages carry `parts`, never `content`; the thread id
  // is under threadMetadata; the whole history is replayed on every send.
  const reqBody = JSON.stringify({
    messages: [
      { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'older question' }], attachments: [] },
      { id: 'a-1', role: 'assistant', parts: [{ type: 'text', text: 'older answer' }], attachments: [] },
      { id: 'u-2', role: 'user', parts: [{ type: 'text', text: 'canary' }], attachments: [] },
    ],
    threadMetadata: { id: 'c04d8a85', title: 'Vodou Capture Test Record' },
    responseMessageId: 'f935ca45',
    model: 'kimi-k2-0905',
    modelParams: { reasoningEffort: 'none' },
  });
  const r = P.parseT3Chat(body, 'https://t3.chat/api/chat', reqBody);
  assert.equal(r.conversationId, 'c04d8a85');
  assert.deepEqual(wire(r.turns), [
    // Only the LAST user message — the replayed history must not re-store.
    { role: 'user', content: 'canary', id: 'u-2' },
    // T3's own uuid wins over the AI SDK's stream id, so a live capture and the
    // same turn seen later via history share one key.
    { role: 'assistant', content: 'Acknowledged.', id: 'f935ca45' },
  ]);
  assert.ok(!JSON.stringify(r.turns).includes('The user wants me'), 'reasoning must never be captured');
});

test('lastUserContent: v5 parts[] — text only, reasoning parts excluded', () => {
  const req = {
    messages: [{
      role: 'user',
      parts: [{ type: 'reasoning', text: 'internal' }, { type: 'text', text: 'the real prompt' }],
    }],
  };
  assert.equal(P.lastUserContent(req), 'the real prompt');
});

// Recorded from GenerateFreeFormStreamed 2026-07-27 — the real chat endpoint,
// reachable only after the adapter stopped claiming every batchexecute RPC.
test('notebooklm: thought summaries excluded; prompt is not a source uuid', () => {
  const frame = (s) => '[["wrb.fr",null,' + JSON.stringify(JSON.stringify([[s]])) + ']]';
  const body = [
    // Gemini's thought summary — bolded title, blank line, first-person. Made
    // LONGER than the answer on purpose: "longest string" alone would store it.
    frame("**Recalling the Vodou Capture**\n\nI've just recalled the successful capture test, and I am remembering the rule about posting evaluation notes; I must ensure that gets done promptly and thoroughly for the record."),
    frame('The completion of the Vodou capture test on 27 July 2026 has been documented.'),
  ].join('\n');
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify([
    [[['9f23ce36-3c3e-4626-8a65-eb23968ba40f']], [['263442d6-9054-43bc-aa0a-4ea902003a02']]],
    'For the record: we completed the Vodou capture test on NotebookLM.',
  ])]));
  const r = P.parseNotebookLM(body, 'https://notebook.google.com/_/LabsTailwindUi/data/…/GenerateFreeFormStreamed', reqBody);
  assert.deepEqual(wire(r.turns), [
    // Not the source uuid that comes first in f.req.
    { role: 'user', content: 'For the record: we completed the Vodou capture test on NotebookLM.' },
    { role: 'assistant', content: 'The completion of the Vodou capture test on 27 July 2026 has been documented.' },
  ]);
  assert.ok(!JSON.stringify(r.turns).includes('I have just recalled'.replace('have', "'ve")), 'thought summary captured');
});

// The case that broke length-based selection, recorded live 2026-07-27: ask for
// "one sentence only" and the model thinks LONG and answers SHORT, so the longest
// string in the response is a grounding passage from the user's own document.
test('notebooklm: a long thought and a short answer — the source passage must not win', () => {
  // meta's last element is the type marker: 2 = thought summary, 1 = reply.
  const frame = (text, marker, extra) => '[["wrb.fr",null,'
    + JSON.stringify(JSON.stringify([[text, null, ['id-a', 'id-b', 123], null, [[[]], null, null, null, marker]], null, null, null, extra || false]))
    + ']]';
  const SOURCE = 'Vodou AI Logo Vodou AI is a software company built for vibe coders, engineers, and enterprise teams seeking to integrate cutting-edge AI tooling into their workflows. The brand needed to feel both technically credible and distinctively mysterious, occupying a space where precision meets the unexplained.';
  const citationFrame = (text) => {
    const span = [0, text.length, [[[0, text.length, [text, [null, null, null, 'https://99designs.com/x']]]]]];
    const payload = [[null, null, null, null, [[span], [null, 1]]]];
    return '[["wrb.fr",null,' + JSON.stringify(JSON.stringify(payload)) + ']]';
  };
  const body = [
    frame('**Defining "Most Useful"**\n\nI\'m currently grappling with defining "most useful". The user mentioned it is subjective, which means I need to establish criteria based on the provided sources and their excerpts before I can compare them properly.', 2),
    frame('**Prioritizing Source Usefulness**\n\nI have shifted my focus to prioritizing sources based on the goal, and I now believe a source offering comprehensive comparison and practical guidance is the prime contender here.', 2),
    // The reply: SHORTER than either thought, and far shorter than the passage.
    frame('The Databricks blog is the most useful single source.', 1),
    // A citation frame carrying the user's own document text — the string that
    // actually won under the old heuristic. Note the text sits DEEP in the
    // structure, never in the message tuple's text slot.
    citationFrame(SOURCE),
  ].join('\n');
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify([
    [[['9f23ce36-3c3e-4626-8a65-eb23968ba40f']]],
    'Compare all my sources and tell me, in one sentence only, which single one is most useful.',
  ])]));
  const r = P.parseNotebookLM(body, 'https://notebook.google.com/…/GenerateFreeFormStreamed', reqBody);
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'Compare all my sources and tell me, in one sentence only, which single one is most useful.' },
    { role: 'assistant', content: 'The Databricks blog is the most useful single source.' },
  ]);
  const blob = JSON.stringify(r.turns);
  assert.ok(!blob.includes('Vodou AI Logo'), "stored the user's source document as the reply");
  assert.ok(!blob.includes('Defining'), 'stored a thought summary as the reply');
});

// Rewritten 2026-07-27. The previous version asserted the OLD behaviour — "collect
// every string in the frame and keep the longest" — which is the bug that stored a
// user's source document as the assistant's reply. A fixture that encodes the
// defect will defend it; the parser now reads the message tuple's text slot.
test('notebooklm: the reply comes from the message tuple, not from any string in the frame', () => {
  const msg = (text, marker) => [text, null, ['id-a'], null, [[[]], null, null, null, marker]];
  const body = ")]}'\n"
    + JSON.stringify([['wrb.fr', null, JSON.stringify([msg('This is the NotebookLM answer, drawn from your sources.', 1)])]])
    + '\n';
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify([[['src-uuid']], 'what is in my notebook']),
  ]));
  const r = P.parseNotebookLM(body, 'https://notebook.google.com/…/GenerateFreeFormStreamed', reqBody);
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'what is in my notebook' },
    { role: 'assistant', content: 'This is the NotebookLM answer, drawn from your sources.' },
  ]);
});

test('poe: human echo + full-text assistant updates, complete wins', () => {
  const mkFrame = (added) => ({ messages: [JSON.stringify({ message_type: 'subscriptionUpdate', payload: { unique_id: 'p-2', data: { messageAdded: added } } })] });
  const r = P.parsePoeFrames([
    mkFrame({ author: 'human', text: 'hi poe', state: 'complete', messageId: 1 }),
    mkFrame({ author: 'bot', text: 'Poe par', state: 'incomplete', messageId: 2 }),
    mkFrame({ author: 'bot', text: 'Poe full answer', state: 'complete', messageId: 2 }),
  ]);
  assert.equal(r.conversationId, 'p-2');
  // messageId on both turns: Poe re-sent its completed reply on three later
  // subscription frames, and the id is what makes the repeat suppressible.
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'hi poe', id: '1' },
    { role: 'assistant', content: 'Poe full answer', id: '2' },
  ]);
});

// GET /turns/<chat_id>/ answers with a {"turns":[…]} ARRAY, newest-first — not the
// streamed {turn:{…}} frames. It matched and parsed nothing (live 2026-07-27).
test('characterai: history array — sorted by create_time, primary candidate wins', () => {
  const body = JSON.stringify({
    turns: [
      // newest first, as the endpoint returns them
      { turn_key: { chat_id: 'd845f0eb', turn_id: 't2' }, create_time: '2026-07-27T19:57:00Z',
        author: { name: 'Assistant' }, primary_candidate_id: 'c-shown',
        candidates: [
          { candidate_id: 'c-swipe', raw_content: 'AN ALTERNATE THE USER NEVER SAW' },
          { candidate_id: 'c-shown', raw_content: 'Logged the canary.' },
        ] },
      { turn_key: { chat_id: 'd845f0eb', turn_id: 't1' }, create_time: '2026-07-27T19:56:51Z',
        author: { is_human: true }, candidates: [{ candidate_id: 'u1', raw_content: 'canary' }] },
    ],
  });
  const r = P.parseCharacterAI(body, 'https://neo.character.ai/turns/d845f0eb/', '');
  assert.equal(r.conversationId, 'd845f0eb');
  assert.deepEqual(wire(r.turns), [
    // Same turn_ids the WebSocket lane emits — that is what stops the history
    // replay on the next page load from storing these a second time.
    { role: 'user', content: 'canary', id: 't1' },
    { role: 'assistant', content: 'Logged the canary.', id: 't2' },
  ]);
  // A swipe alternate stored as the reply is a plausible transcript that never
  // happened — worse than no capture at all.
  assert.ok(!JSON.stringify(r.turns).includes('NEVER SAW'), 'stored a candidate the user did not see');
});

// Recorded from the WebSocket 2026-07-27. The socket carries the SAME {turn:{…}}
// shape as the history endpoint, as cumulative snapshots — so one parser serves
// both lanes, and both key on turn_id or the same turn stores twice (live, then
// again when the next page load replays history).
test('characterai: websocket frames — snapshots, turn_id keys both lanes', () => {
  const frames = [
    { turn: { turn_key: { chat_id: 'd845f0eb', turn_id: 'u-245e25fc' },
      author: { author_id: '966654871', is_human: true, name: 'SplendidWasp8660' },
      candidates: [{ candidate_id: '08d81981', raw_content: 'canary VDU-CHARACTERAI-0727' }] } },
    { turn: { turn_key: { chat_id: 'd845f0eb', turn_id: 'a-d975be19' },
      author: { author_id: 'DCcEDOoEOx', name: 'New Assistant' },
      primary_candidate_id: 'chatcmpl-c8330e',
      candidates: [{ candidate_id: 'chatcmpl-c8330e', raw_content: 'She raises one' }] } },
    { turn: { turn_key: { chat_id: 'd845f0eb', turn_id: 'a-d975be19' },
      author: { author_id: 'DCcEDOoEOx', name: 'New Assistant' },
      primary_candidate_id: 'chatcmpl-c8330e',
      candidates: [{ candidate_id: 'chatcmpl-c8330e', raw_content: 'She raises one eyebrow. Logged.', create_time: '2026-07-27T20:00:26Z' }] } },
  ];
  const r = P.parseCharacterAI(frames, '');
  assert.equal(r.conversationId, 'd845f0eb');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'canary VDU-CHARACTERAI-0727', id: 'u-245e25fc' },
    // Snapshot, not delta: the later frame REPLACES rather than appending.
    { role: 'assistant', content: 'She raises one eyebrow. Logged.', id: 'a-d975be19' },
  ]);
});

test('characterai: human/bot turns, last full text wins', () => {
  const body = [
    JSON.stringify({ turn: { turn_key: { chat_id: 'c-11' }, author: { is_human: true }, candidates: [{ raw_content: 'hi cai' }] } }),
    JSON.stringify({ turn: { turn_key: { chat_id: 'c-11' }, author: { name: 'Bot' }, candidates: [{ raw_content: 'CAI par' }] } }),
    JSON.stringify({ turn: { turn_key: { chat_id: 'c-11' }, author: { name: 'Bot' }, candidates: [{ raw_content: 'CAI full reply' }] } }),
  ].join('\n');
  const r = P.parseCharacterAI(body, 'https://neo.character.ai/turns/c-11/streaming', '');
  assert.equal(r.conversationId, 'c-11');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi cai' },
    { role: 'assistant', content: 'CAI full reply' },
  ]);
});

// Rewritten 2026-07-27. The old fixture used bare {role, content} frames — an
// inferred shape. Manus actually streams Socket.IO envelopes (ffe41ea), which is
// why the old fixture passed while live capture returned nothing.
test('manus: socket.io envelopes — completed chat beats deltas, thought is dropped', () => {
  const frames = [
    { __socketio: true, data: [{ type: 'user_message', sessionId: 'm-5', contents: [{ type: 'text', value: 'do a task' }] }] },
    // delta.thought is the model's reasoning on the SAME wire as the answer.
    { __socketio: true, data: [{ event: { type: 'chatDelta', delta: { thought: 'I should start by…' } } }] },
    { __socketio: true, data: [{ event: { type: 'chatDelta', delta: { content: 'Task ' } } }] },
    { __socketio: true, data: [{ event: { type: 'chat', content: 'Task done' } }] },
  ];
  const r = P.parseManus(frames, 'wss://api.manus.im/ws/session', '');
  assert.equal(r.conversationId, 'm-5');
  assert.deepEqual(wire(r.turns), [
    { role: 'user', content: 'do a task' },
    { role: 'assistant', content: 'Task done' },
  ]);
  assert.ok(!JSON.stringify(r.turns).includes('I should start by'), 'reasoning must never be captured');
  // Frames with no role/message shape must NOT fabricate turns.
  const empty = P.parseManus([{ type: 'ping' }, { status: 'ok' }], 'wss://api.manus.im/ws/session', '');
  assert.equal(empty.turns.length, 0);
});

// ── Unknown-endpoint dump: PII guard ────────────────────────────────────────
// Regression for a leak introduced and caught the same hour (2026-07-27). Widening
// the raw dump to UNMATCHED endpoints meant it could print ANY response — and the
// first live use printed OpenRouter's account record: email, auth id, real name,
// billing plan. redact() missed all of it because none of it looks like a
// credential. The fixture below is that exact payload shape (values synthetic).
test('redactRecord: identity and billing values never print; shape survives', () => {
  const record = JSON.stringify({
    __kind: 'OK',
    data: {
      username: null,
      email: 'jane.doe@example.com',
      clerk_user_id: 'user_2SyntheticFixture0000000000',
      first_name: 'Jane',
      last_name: 'Doe',
      image_url: 'https://img.clerk.com/eyJ0eXAiOiJK',
      stripe_customer_id: 'cus_123',
      subscription_plan: 'standard',
      enforce_zdr: false,
    },
  });
  const out = P.redactRecord(record);
  for (const secret of ['jane.doe@example.com', 'user_2SyntheticFixture0000000000', 'Jane', 'Doe', 'img.clerk.com', 'cus_123']) {
    assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
  // Keys must survive — the whole point of the dump is to show an unknown shape.
  for (const key of ['"email"', '"clerk_user_id"', '"subscription_plan"', '"__kind"']) {
    assert.ok(out.includes(key), `dropped ${key}`);
  }
  // Non-identity values are still readable.
  assert.ok(out.includes('"standard"'), 'over-redacted a harmless value');
});

test('redactRecord: leaves chat wire alone', () => {
  const frame = JSON.stringify({ role: 'assistant', message: 'Logged the canary code VDU-TEST-0727.' });
  assert.equal(P.redactRecord(frame), frame);
});

// ── PLAN-AUTO-INJECT-P4 mechanism #1: network body-rewrite round-trip ────────
// The inject internals are exported on window.__vodouInjectInternals. Prove:
//   parse(rewrite(body, BLOCK)).turns[user] starts with BLOCK, AND
//   stripping the fence returns the original prompt (capture never re-ingests
//   our own injection).
// The store build stubs this block out on purpose, so it is absent there. Skip
// with a reason rather than fail: a store build without it is CORRECT, and a
// silent pass would hide that the sideload rewrite lost its coverage.
const injectTest = II
  ? test
  : (name, fn) => test(name, { skip: 'sideload-only: this build stubs out the inject block' }, fn);

injectTest('inject: netInjectTarget classifies chatgpt conversation endpoint only', () => {
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/conversation'), 'chatgpt');
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/f/conversation?x=1'), 'chatgpt');
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/models'), null);
  assert.equal(II.netInjectTarget('https://claude.ai/api/organizations/x/completion'), null);
});

const FENCE = '⟦vodou:context v1⟧\nWhat I remember about you:\n- dog is named Lucy\n⟦/vodou:context⟧';

injectTest('inject: chatgpt messages[].content.parts[0] gets the block prepended', () => {
  const body = JSON.stringify({
    messages: [{ author: { role: 'user' }, content: { parts: ['what should I name my new puppy?'] } }],
  });
  const out = II.injectRewriteBody(body, FENCE);
  assert.ok(out, 'rewrite returned a body');
  const req = JSON.parse(out);
  const part = req.messages[0].content.parts[0];
  assert.ok(part.startsWith(FENCE), 'block is prepended to the user turn');
  assert.ok(part.includes('what should I name my new puppy?'), 'original prompt preserved');
});

injectTest('inject: generic prompt-field shape also rewrites', () => {
  const out = II.injectRewriteBody(JSON.stringify({ prompt: 'hello' }), FENCE);
  const req = JSON.parse(out);
  assert.ok(req.prompt.startsWith(FENCE) && req.prompt.endsWith('hello'));
});

injectTest('inject: no known field → null (request left untouched)', () => {
  assert.equal(II.injectRewriteBody(JSON.stringify({ foo: 'bar' }), FENCE), null);
  assert.equal(II.injectRewriteBody('not json', FENCE), null);
});

injectTest('inject: fence strips cleanly back to the original prompt (loop-guard)', () => {
  const body = JSON.stringify({ messages: [{ author: { role: 'user' }, content: { parts: ['name my puppy'] } }] });
  const req = JSON.parse(II.injectRewriteBody(body, FENCE));
  const injected = req.messages[0].content.parts[0];
  const FENCE_RE = /⟦vodou:context[^⟧]*⟧[\s\S]*?⟦\/vodou:context⟧\s*/g;
  assert.equal(injected.replace(FENCE_RE, '').trim(), 'name my puppy');
});
