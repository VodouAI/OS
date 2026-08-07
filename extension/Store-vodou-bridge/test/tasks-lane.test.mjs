// Structural tests for the async Tasks lane (PLAN-VODOU-TASKS-CHANNEL Phase 2).
// Run: node --test extension/Store-vodou-bridge/test/tasks-lane.test.mjs
//
// The lane spans a service worker, a content script and the manifest — none of which
// can be evaluated outside the extension — so these lock the CONTRACTS that break
// silently: message types wired on both sides, the gesture ordering that makes
// sidePanel.open() legal, and the draft guard that prevents clobbering a live draft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BG = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const CONTENT = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('manifest declares the run-task command with a legal key', () => {
  const cmd = MANIFEST.commands['run-task'];
  assert.ok(cmd, 'run-task command present');
  const keys = cmd.suggested_key;
  // Enter/Return is NOT a legal Chrome command key — only modifier + letter/digit/F-key.
  assert.ok(!/Enter|Return|Space/i.test(JSON.stringify(keys)), 'must not bind Enter/Return/Space');
  assert.match(keys.default, /^(Ctrl|Alt|Command|MacCtrl)\+/, 'has a modifier');
  // Mac trap: "Ctrl" in suggested_key means COMMAND; literal Control needs MacCtrl.
  assert.match(keys.mac, /^MacCtrl\+/, 'mac binding uses MacCtrl (literal Control)');
});

test('notifications permission is declared (task-done alerts)', () => {
  assert.ok(MANIFEST.permissions.includes('notifications'));
});

test('run-task opens the panel BEFORE any await (the gesture must not be spent)', () => {
  const i = BG.indexOf("command === 'run-task'");
  assert.ok(i > 0, 'run-task handler present');
  const block = BG.slice(i, i + 1400);
  const openAt = block.indexOf('openVodouPanel(');
  const asyncAt = Math.min(
    ...['await ', '.then(', 'sendMessage('].map((t) => {
      const p = block.indexOf(t);
      return p < 0 ? Number.MAX_SAFE_INTEGER : p;
    }),
  );
  assert.ok(openAt > 0, 'calls openVodouPanel');
  assert.ok(openAt < asyncAt, 'openVodouPanel must precede any async work (gesture dies on await)');
});

test('task frames are demuxed before the handleCmd fallthrough', () => {
  const taskAt = BG.indexOf("msg.cmd === 'task_event'");
  const handleAt = BG.indexOf('handleCmd(msg);');
  assert.ok(taskAt > 0 && handleAt > 0);
  assert.ok(taskAt < handleAt, 'task_* branch must precede handleCmd (else UNKNOWN_CMD)');
});

test('dispatch acks without awaiting the work (async contract)', () => {
  const i = BG.indexOf('function dispatchTask(');
  assert.ok(i > 0, 'dispatchTask present');
  const block = BG.slice(i, i + 1200);
  assert.ok(!/\bawait\b/.test(block), 'dispatchTask must not await — it returns a jobId immediately');
  assert.match(block, /return \{ ok: true, jobId \}/, 'returns the jobId synchronously');
});

test('delivery is GUARDED by the dispatch-time draft (never clobber a live draft)', () => {
  const i = CONTENT.indexOf("msg.type === 'vodou_task_deliver'");
  assert.ok(i > 0, 'deliver handler present');
  const block = CONTENT.slice(i, i + 1400);
  assert.match(block, /expectDraft/, 'reads the expected draft');
  assert.match(block, /not injecting|composer changed/, 'refuses when the composer moved on');
  // the guard must come BEFORE any insert
  const guardAt = block.indexOf('not injecting');
  const insertAt = block.indexOf('insertTextVerified');
  assert.ok(guardAt > 0 && insertAt > 0 && guardAt < insertAt, 'guard precedes the insert');
});

test('background sends expectDraft so the guard has something to check', () => {
  assert.match(BG, /expectDraft:\s*msg\.draftAtDispatch/, 'passes draftAtDispatch through as expectDraft');
});

test('a notification click opens the panel (a click IS a legal gesture)', () => {
  assert.match(BG, /notifications\?\.onClicked/, 'listens for notification clicks');
  const i = BG.indexOf('notifications?.onClicked');
  assert.match(BG.slice(i, i + 600), /openVodouPanel\(/, 'opens the panel from the click');
});

test('manual triggers use the async task lane ONLY when Brain mode is on', () => {
  // 2026-08-05 (Chad): manual used to run the full brain unconditionally —
  // 5-22s and real money per "add my memory" with every toggle off, while the
  // settings copy promised a plain lookup. The Brain toggle now gates BOTH
  // lanes; with it off, manual rides the fast retrieval path.
  const i = CONTENT.indexOf('if (manual && brainModeEnabled(site)) {');
  assert.ok(i > 0, 'manual branch present and gated on the Brain toggle');
  const block = CONTENT.slice(i, i + 1600);
  assert.match(block, /run_task_from_page/, 'manual+brain dispatches a task');
  assert.match(block, /taskPill\.start/, 'shows the in-page pill');
  assert.ok(!/if \(manual\) \{/.test(CONTENT), 'no ungated manual branch survives');
});

test('the auto-send (enrichment) lane still holds the send — pack, not task', () => {
  const i = CONTENT.indexOf('if (brainModeEnabled(site)) {');
  assert.ok(i > 0);
  const block = CONTENT.slice(i, i + 4000);   // the dispatch sits ~50 lines into the branch
  assert.match(block, /intent: 'pack'/, 'auto-send uses the pack intent');
  assert.ok(!/run_task_from_page/.test(block), 'auto-send must NOT go async — it holds the send');
});

test('no stale wantAnswer/stopBrainTick references survive the refactor', () => {
  assert.ok(!/wantAnswer/.test(CONTENT), 'wantAnswer fully removed');
  assert.ok(!/stopBrainTick/.test(CONTENT), 'stopBrainTick fully removed');
});

// ── Phase 3: the panel Tasks view ────────────────────────────────────────────
const HTML = fs.readFileSync(new URL('../sidepanel.html', import.meta.url), 'utf8');
const PANEL = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

test('one Ask surface — no second tab or composer duplicating it', () => {
  assert.match(HTML, /data-view="chat"[^>]*>Ask</, 'the Ask tab exists');
  // The Tasks tab was a second composer asking the same question. Task cards now
  // stream into the Ask log; a page dispatches work, the panel does not need its own.
  assert.ok(!/data-view="tasks"/.test(HTML), 'no separate Tasks tab');
  assert.ok(!/id="view-tasks"|id="task-input"|id="task-run"/.test(HTML), 'no second composer');
  assert.match(HTML, /id="chat-log"/, 'the shared stream exists');
  assert.ok(!/id="chat-addbrain"/.test(HTML), 'the misplaced page-action button is gone');
});

test('the Ask tab starts both streams (replies and task cards share one log)', () => {
  assert.match(PANEL, /name === 'chat'\)\s*\{\s*initChat\(\);\s*initTasks\(\);/, 'Ask inits both');
  const i = PANEL.indexOf('function initTasks(');
  assert.match(PANEL.slice(i, i + 600), /q\('chat-log'\)/, 'cards render into the chat log');
});

test('a shared log is never wiped wholesale (task cards survive history + new chat)', () => {
  // Both paths used to call log.innerHTML = '' — which would delete a task card that
  // was still streaming, because the log is now shared.
  const i = PANEL.indexOf('function initChat(');
  const block = PANEL.slice(i, i + 9000);
  assert.ok(!/log\.innerHTML = ''/.test(block), 'no wholesale clears of the shared log');
  assert.match(block, /querySelectorAll\('\.msg, \.toolrow'\)/, 'clears only chat nodes');
});

test('no #view-* display rule can out-specify .view[hidden]', () => {
  // `#view-chat { display: flex }` (specificity 100) beats `.view[hidden]{display:none}`
  // (20), so the view stayed rendered on every other tab and "new chat" bled through
  // onto Activity/Settings. Any id-scoped view rule that sets display must be guarded
  // with :not([hidden]).
  // Parse selector + body per rule rather than using a lookahead: a greedy `[a-z]+`
  // will happily backtrack to dodge a negative lookahead and flag the fixed rule too.
  const css = HTML.replace(/\/\*[\s\S]*?\*\//g, '');   // comments mention #view-*, don't scan them
  const bad = [...css.matchAll(/(#view-[^{}]*)\{([^}]*)\}/g)]
    .filter(([, sel, body]) => /display\s*:/.test(body) && !sel.includes(':not([hidden])'))
    .map(([, sel]) => sel.trim());
  assert.deepEqual(bad, [], `these would never hide: ${bad.join(', ')}`);
});

test('progress is reported by the cards and status line, not a decorative brain', () => {
  // The brain SVG restated — abstractly, in ~60px of a 400px panel — what the task
  // card already says precisely: a ⚡running chip and the name of each tool as it
  // fires. Removed; these are the surfaces that actually carry the information.
  assert.ok(!/brainviz|brainwrap|brain-state/.test(HTML), 'no brain markup');
  assert.ok(!/brainViz|setBrain/.test(PANEL), 'no brain code left behind');
  const i = PANEL.indexOf('function initTasks(');
  const tasks = PANEL.slice(i, i + 9000);
  assert.match(tasks, /step\(msg\.jobId, `🔧/, 'each tool call is named in the card');
  assert.match(tasks, /chipText/, 'the card chip carries running/done state');
});

test('Settings collapsed the per-lane site grids into one list', () => {
  // Four 22-site grids (capture / inject / autosend / brain) meant 88 checkboxes and
  // three different answers to "where does Vodou work". One list answers it now.
  assert.ok(!/id="autosend-sites"|id="brain-sites"/.test(HTML), 'per-lane grids removed');
  assert.match(HTML, /id="capture-sites"/, 'capture list kept');
  assert.match(HTML, /id="inject-sites"/, 'one in-chat site list kept');
  assert.match(PANEL, /simpleToggle\('inject-autosend'/, 'auto-attach is a plain toggle');
  assert.match(PANEL, /simpleToggle\('inject-brain'/, 'brain mode is a plain toggle');
});

test('retired per-site maps are no longer read (no invisible disabled state)', () => {
  // Match actual reads, not the comment that explains why we stopped reading them.
  assert.ok(!/injectSettings\.(autoSendSites|brainSites)|\(injectSettings\.autoSendSites/.test(CONTENT),
    'content.js must not honour maps whose UI is gone — a site could be off with no way to see it');
});

test('panel connects the vodou-tasks port and background accepts it', () => {
  assert.match(PANEL, /connect\(\{\s*name:\s*'vodou-tasks'\s*\}\)/, 'panel connects vodou-tasks');
  assert.match(BG, /port\.name === 'vodou-tasks'/, 'background accepts vodou-tasks');
});

test('opening via the run-task shortcut lands on Ask, where the work streams', () => {
  assert.match(PANEL, /params\.get\('how'\) === 'task'/, 'reads the how=task param');
  const i = PANEL.indexOf("params.get('how') === 'task'");
  assert.match(PANEL.slice(i, i + 500), /show\('chat'\)/, 'shows the Ask view');
});

test('the Tasks view hydrates on connect and dedupes replayed events', () => {
  const i = PANEL.indexOf('function initTasks(');
  const block = PANEL.slice(i, i + 9000);
  assert.match(block, /type: 'task_list'/, 'requests task_list on connect');
  assert.match(block, /seen\.has\(msg\.seq\)/, 'dedupes by seq (replay-safe)');
});

test('a finished card can re-send its result to the chat', () => {
  const i = PANEL.indexOf('function finish(');
  const block = PANEL.slice(i, i + 2000);
  assert.match(block, /send to chat/, 'offers send-to-chat');
  assert.match(block, /vodou_panel_insert/, 'uses the proven insert path');
});

test('the ack is enriched with the title for page-dispatched tasks', () => {
  assert.match(BG, /title: job\.title/, 'background attaches the recorded title');
});

// ── PLAN-INJECT-FAST-LANE P0 — retrieval-lane prefetch-while-typing ──────────

test('typing warms the retrieval context cache when Brain mode is off', () => {
  const i = CONTENT.indexOf('function scheduleCtxPrefetch(');
  assert.ok(i > 0, 'retrieval prefetch scheduler present');
  const block = CONTENT.slice(i, i + 1600);
  assert.match(block, /if \(brainModeEnabled\(site\)\) return;/, 'self-gates: brain lane has its own prefetch');
  assert.match(block, /fetchCandidates\(seed, 'all'/, 'warms via the normal get_context path');
  assert.ok(!/get_brain_context/.test(block), 'never dispatches a brain turn');
  // The input listener routes to one scheduler per lane.
  const l = CONTENT.indexOf("document.addEventListener('input'");
  const listener = CONTENT.slice(l, l + 700);
  assert.match(listener, /scheduleCtxPrefetch\(site, composer\)/, 'input listener feeds the retrieval warm');
});

test('runRetrievalInject consumes the warm cache before hitting the gateway', () => {
  const i = CONTENT.indexOf('function runRetrievalInject(');
  const block = CONTENT.slice(i, i + 6000);
  const take = block.indexOf('ctxPrefetchTake(');
  const fetch = block.indexOf("fetchCandidates(seed, 'all'");
  assert.ok(take > 0, 'consumes the prefetch cache');
  assert.ok(fetch > take, 'cache checked BEFORE the gateway round-trip');
  assert.match(block, /handleResp\(warm, true\)/, 'cache hit runs the same handler, marked prefetched');
});
