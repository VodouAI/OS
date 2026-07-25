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
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../inject.js', import.meta.url), 'utf8');
const windowStub = {
  addEventListener() {},
  postMessage() {},
  fetch: async () => ({}),
  XMLHttpRequest: undefined,
  WebSocket: undefined,
};
new Function('window', src)(windowStub);
const P = windowStub.__vodouNetCapParsers;

const sse = (...objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}`).join('\n\n') + '\n\ndata: [DONE]\n';

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
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'canary check emerald-chad-7766' },
    { role: 'assistant', content: 'Received exactly: canary check emerald-chad-7766' },
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
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'set canary green-skateboard-elephant' },
    { role: 'assistant', content: 'Canary set: green-skateboard-elephant' },
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

test('deepseek: openai-style deltas + compact {v} patches + session id', () => {
  const body = sse(
    { choices: [{ delta: { content: 'Deep' } }] },
    { v: 'Seek', p: 'response/content' },
    { v: ' reply' },
    { v: 'THINKING', p: 'response/thinking_content' }, // non-content path — ignored
  );
  const r = P.parseDeepSeek(body, 'https://chat.deepseek.com/api/v0/chat/completion', JSON.stringify({ prompt: 'hi ds', chat_session_id: 's-9' }));
  assert.equal(r.conversationId, 's-9');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi ds' },
    { role: 'assistant', content: 'DeepSeek reply' },
  ]);
});

test('lechat: vercel data-stream 0:"chunk" lines', () => {
  const body = '0:"Bonjour"\n0:" de"\n0:" Mistral"\ne:{"finishReason":"stop"}\n';
  const r = P.parseLeChat(body, 'https://chat.mistral.ai/api/chat', JSON.stringify({ chatId: 'm-1', content: 'salut' }));
  assert.equal(r.conversationId, 'm-1');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'Bonjour de Mistral' },
  ]);
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
  assert.deepEqual(r.turns, [
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

test('notebooklm: longest wrb.fr string wins (heuristic)', () => {
  const inner = JSON.stringify(['meta', ['short', 'This is a sufficiently long NotebookLM answer that should be selected as the assistant text.']]);
  const body = `)]}'\n${JSON.stringify([['wrb.fr', null, inner]])}\n`;
  const reqBody = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify([['what is in my notebook']])]));
  const r = P.parseNotebookLM(body, 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute', reqBody);
  assert.equal(r.turns.length, 2);
  assert.equal(r.turns[0].content, 'what is in my notebook');
  assert.match(r.turns[1].content, /sufficiently long NotebookLM answer/);
});

test('poe: human echo + full-text assistant updates, complete wins', () => {
  const mkFrame = (added) => ({ messages: [JSON.stringify({ message_type: 'subscriptionUpdate', payload: { unique_id: 'p-2', data: { messageAdded: added } } })] });
  const r = P.parsePoeFrames([
    mkFrame({ author: 'human', text: 'hi poe', state: 'complete', messageId: 1 }),
    mkFrame({ author: 'bot', text: 'Poe par', state: 'incomplete', messageId: 2 }),
    mkFrame({ author: 'bot', text: 'Poe full answer', state: 'complete', messageId: 2 }),
  ]);
  assert.equal(r.conversationId, 'p-2');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'hi poe' },
    { role: 'assistant', content: 'Poe full answer' },
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

test('manus: role-shaped frames win; conservative otherwise', () => {
  const frames = [
    { role: 'user', content: 'do a task' },
    { role: 'assistant', content: 'Task done', session_id: 'm-5' },
  ];
  const r = P.parseManus(frames, 'wss://api.manus.im/ws/session', '');
  assert.equal(r.conversationId, 'm-5');
  assert.deepEqual(r.turns, [
    { role: 'user', content: 'do a task' },
    { role: 'assistant', content: 'Task done' },
  ]);
  // Frames with no role/message shape must NOT fabricate turns.
  const empty = P.parseManus([{ type: 'ping' }, { status: 'ok' }], 'wss://api.manus.im/ws/session', '');
  assert.equal(empty.turns.length, 0);
});

// ── PLAN-AUTO-INJECT-P4 mechanism #1: network body-rewrite round-trip ────────
// The inject internals are exported on window.__vodouInjectInternals. Prove:
//   parse(rewrite(body, BLOCK)).turns[user] starts with BLOCK, AND
//   stripping the fence returns the original prompt (capture never re-ingests
//   our own injection).
const II = windowStub.__vodouInjectInternals;

test('inject: netInjectTarget classifies chatgpt conversation endpoint only', () => {
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/conversation'), 'chatgpt');
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/f/conversation?x=1'), 'chatgpt');
  assert.equal(II.netInjectTarget('https://chatgpt.com/backend-api/models'), null);
  assert.equal(II.netInjectTarget('https://claude.ai/api/organizations/x/completion'), null);
});

const FENCE = '⟦vodou:context v1⟧\nWhat I remember about you:\n- dog is named Lucy\n⟦/vodou:context⟧';

test('inject: chatgpt messages[].content.parts[0] gets the block prepended', () => {
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

test('inject: generic prompt-field shape also rewrites', () => {
  const out = II.injectRewriteBody(JSON.stringify({ prompt: 'hello' }), FENCE);
  const req = JSON.parse(out);
  assert.ok(req.prompt.startsWith(FENCE) && req.prompt.endsWith('hello'));
});

test('inject: no known field → null (request left untouched)', () => {
  assert.equal(II.injectRewriteBody(JSON.stringify({ foo: 'bar' }), FENCE), null);
  assert.equal(II.injectRewriteBody('not json', FENCE), null);
});

test('inject: fence strips cleanly back to the original prompt (loop-guard)', () => {
  const body = JSON.stringify({ messages: [{ author: { role: 'user' }, content: { parts: ['name my puppy'] } }] });
  const req = JSON.parse(II.injectRewriteBody(body, FENCE));
  const injected = req.messages[0].content.parts[0];
  const FENCE_RE = /⟦vodou:context[^⟧]*⟧[\s\S]*?⟦\/vodou:context⟧\s*/g;
  assert.equal(injected.replace(FENCE_RE, '').trim(), 'name my puppy');
});
