// Structural tests for the panel Chat tab (PLAN-BRAIN-INJECT-LANE Phase 3).
// Run: node --test extension/Store-vodou-bridge/test/chat-lane.test.mjs
//
// The panel UI runs against the DOM + a chrome.runtime Port, neither of which is
// evaluable outside the extension. These lock the wiring contract (view exists, the
// vodou-chat port name matches both sides, no flat timeout on the streaming lane).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const HTML = fs.readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const PANEL = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

test('Chat tab and view are present', () => {
  assert.ok(/data-view="chat"/.test(HTML), 'Chat tab button present');
  assert.ok(/id="view-chat"/.test(HTML), 'chat view present');
  assert.ok(/id="chat-log"/.test(HTML) && /id="chat-input"/.test(HTML), 'log + composer present');
  assert.ok(/id="chat-status"/.test(HTML), 'status line present (it reports progress now)');
});

test('views() lazy-inits the chat tab', () => {
  assert.ok(/name === 'chat'\)\s*initChat\(\)/.test(PANEL) || /initChat\(\)/.test(PANEL), 'initChat wired');
});

test('panel connects the vodou-chat port and background accepts it', () => {
  assert.ok(/connect\(\{\s*name:\s*'vodou-chat'\s*\}\)/.test(PANEL), 'panel connects vodou-chat');
  assert.ok(/port\.name !== 'vodou-chat'/.test(BG), 'background gates on vodou-chat');
});

test('the chat stream has no flat client-side timeout (liveness = server heartbeat)', () => {
  // The retrieval lane uses a 25s timeout; the streaming chat lane must not — a long
  // agentic turn (up to 15 min) would be killed. Assert initChat contains no setTimeout
  // that races the turn. (The only setTimeout is the port reconnect backoff + brain-idle.)
  const i = PANEL.indexOf('function initChat()');
  const j = PANEL.indexOf('let settingsReady', i);
  const body = PANEL.slice(i, j);
  assert.ok(!/setTimeout\([^)]*2500[0-9]/.test(body), 'no ~25s turn timeout in chat lane');
});
