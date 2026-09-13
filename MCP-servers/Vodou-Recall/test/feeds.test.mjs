// Feed tools against temp copies of the three owners' schemas. Runs with
// `node --test` (node 24: node:sqlite + node:test, no deps). The Rust side
// pins the same shapes in `automations::feed_contract_tests`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { feedCaptures, feedMemories, feedContradictions, feedExtractionFailures, feedJsonFile, FEED_TOOLS } from '../dist/feeds.js';
import { writeFileSync } from 'node:fs';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'recall-feeds-'));
  const paths = {
    gatewayDb: path.join(dir, 'gateway.db'),
    memoryDb: path.join(dir, 'memory.db'),
    coreDb: path.join(dir, 'vodou-core.db'),
  };
  const gw = new DatabaseSync(paths.gatewayDb);
  gw.exec(`
    CREATE TABLE gateway_conversations (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, source TEXT, deleted_at TEXT, source_url TEXT);
    CREATE TABLE gateway_messages (id INTEGER PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT);
    INSERT INTO gateway_conversations VALUES
      ('web:chatgpt:a', 'pricing copy',   '2026-09-09 21:00:00', NULL, 'capture:web:chatgpt',    NULL, 'https://chatgpt.com/c/a'),
      ('ide:cc:b',      'plan review',    '2026-09-09 23:16:26', NULL, 'capture:ide:claude-code', NULL, NULL),
      ('web:claude:c',  'deleted one',    '2026-09-09 23:30:00', NULL, 'capture:web:claude',      '2026-09-09 23:31:00', NULL),
      ('plain-chat',    'not a capture',  '2026-09-09 23:40:00', NULL, 'web',                     NULL, NULL),
      ('web:chatgpt:d', 'later',          '2026-09-10 01:00:00', NULL, 'capture:web:chatgpt',    NULL, NULL);
    INSERT INTO gateway_messages (conversation_id, role, content) VALUES ('web:chatgpt:a','user','x'),('web:chatgpt:a','assistant','y');
  `);
  gw.close();
  const mem = new DatabaseSync(paths.memoryDb);
  mem.exec(`
    CREATE TABLE memory_chunks (id TEXT PRIMARY KEY, text TEXT, archived INTEGER DEFAULT 0, created_at TEXT, scope TEXT, chunk_tag TEXT, pinned INTEGER DEFAULT 0, importance INTEGER, source_url TEXT);
    INSERT INTO memory_chunks (id, text, archived, created_at, scope, chunk_tag, pinned, importance) VALUES
      ('m1', 'we ship feeds on Recall', 0, '2026-09-10 02:52:55', 'capture:web:claude', 'DECISION', 0, 8),
      ('m2', 'archived',               1, '2026-09-10 02:53:00', 'capture:web:claude', 'DECISION', 0, 9),
      ('m3', 'a gotcha',               0, '2026-09-10 02:54:00', 'capture:ide:claude-code', 'GOTCHA', 0, 3),
      ('m4', 'low importance decision',0, '2026-09-10 02:55:00', 'capture:web:chatgpt', 'DECISION', 0, 2);
    CREATE TABLE memory_contradictions (id INTEGER PRIMARY KEY, slot TEXT, import_value TEXT, native_value TEXT, import_scope TEXT, native_scope TEXT, cosine REAL, status TEXT DEFAULT 'open', created_at TEXT, resolved_at TEXT);
    INSERT INTO memory_contradictions (slot, import_value, native_value, import_scope, native_scope, cosine, status, created_at, resolved_at) VALUES
      ('client.acme.contact', 'Jane', 'Joan', 'import:obsidian', 'web', 0.91, 'open', '2026-09-01 10:00:00', NULL),
      ('client.acme.contact', 'old',  'x',    'import:obsidian', 'web', 0.90, 'resolved', '2026-09-01 09:00:00', '2026-09-02 00:00:00'),
      ('user.coffee',         'oat',  'dairy','import:obsidian', 'web', 0.80, 'open', '2026-09-03 10:00:00', NULL);
  `);
  mem.close();
  const core = new DatabaseSync(paths.coreDb);
  core.exec(`
    CREATE TABLE extraction_queue (source TEXT NOT NULL, conversation_id TEXT NOT NULL, span_start INTEGER, span_end INTEGER, state TEXT, attempts INTEGER, last_error TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO extraction_queue VALUES
      ('gateway', 'workbench:skill-console:qa-nightly', 40, 52, 'failed', 3, 'exit 124', '2026-09-09 19:00:00', '2026-09-09 19:30:00'),
      ('gateway', 'workbench:skill-console:qa-nightly', 52, 60, 'done',   1, NULL,       '2026-09-09 19:00:00', '2026-09-09 19:31:00'),
      ('capture:web', 'web:chatgpt:a',                  0,  9,  'failed', 2, 'timeout',  '2026-09-09 19:00:00', '2026-09-09 19:30:00');
  `);
  core.close();
  return paths;
}

test('the four tools are listed with the shared cursor args', () => {
  assert.deepEqual(FEED_TOOLS.map((t) => t.name), ['feed_captures', 'feed_memories', 'feed_contradictions', 'feed_json_file', 'feed_extraction_failures']);
  for (const t of FEED_TOOLS) {
    assert.ok(t.inputSchema.properties.since_cursor, `${t.name} has since_cursor`);
    assert.ok(t.inputSchema.properties.limit, `${t.name} has limit`);
  }
});

test('feed_captures: newest first run, then only what is after the cursor; deleted and non-capture rows excluded', () => {
  const p = fixture();
  const first = feedCaptures(p, { limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id), ['ide:cc:b', 'web:chatgpt:d'], 'newest two, oldest-first order');
  assert.equal(first.items[0].at, '2026-09-09 23:16:26');
  assert.equal(first.cursor, '2026-09-10 01:00:00|web:chatgpt:d');
  const again = feedCaptures(p, { since_cursor: first.cursor });
  assert.equal(again.count, 0, 'nothing after the cursor yet');
  assert.equal(again.cursor, null);
  const all = feedCaptures(p, { limit: 100 });
  assert.deepEqual(all.items.map((i) => i.id), ['web:chatgpt:a', 'ide:cc:b', 'web:chatgpt:d'], 'deleted + plain chat excluded');
  assert.equal(all.items[0].message_count, 2);
  const web = feedCaptures(p, { source_glob: 'capture:web:*' });
  assert.deepEqual(web.items.map((i) => i.id), ['web:chatgpt:a', 'web:chatgpt:d']);
  const after = feedCaptures(p, { since_cursor: '2026-09-09 21:00:00|web:chatgpt:a' });
  assert.deepEqual(after.items.map((i) => i.id), ['ide:cc:b', 'web:chatgpt:d'], 'strictly after the cursor');
});

test('feed_memories: filters by tag, scope glob, importance; archived never appears', () => {
  const p = fixture();
  const decisions = feedMemories(p, { tag: 'DECISION' });
  assert.deepEqual(decisions.items.map((i) => i.id), ['m1', 'm4']);
  const important = feedMemories(p, { tag: 'DECISION', scope_glob: 'capture:web:*', min_importance: 7 });
  assert.deepEqual(important.items.map((i) => i.id), ['m1']);
  assert.equal(important.items[0].tag, 'DECISION');
  assert.equal(important.cursor, '2026-09-10 02:52:55|m1');
  const next = feedMemories(p, { since_cursor: important.cursor });
  assert.deepEqual(next.items.map((i) => i.id), ['m3', 'm4']);
});

test('feed_contradictions: open only, slot glob, id is the row id as a string', () => {
  const p = fixture();
  const open = feedContradictions(p, {});
  assert.deepEqual(open.items.map((i) => i.slot), ['client.acme.contact', 'user.coffee']);
  assert.equal(typeof open.items[0].id, 'string');
  const clients = feedContradictions(p, { slot_glob: 'client.*' });
  assert.equal(clients.count, 1);
  assert.equal(clients.items[0].import_value, 'Jane');
});

test('feed_extraction_failures: failed only, span identity as id, pages on rowid', () => {
  const p = fixture();
  const r = feedExtractionFailures(p, {});
  assert.deepEqual(r.items.map((i) => i.id), ['gateway|workbench:skill-console:qa-nightly|40', 'capture:web|web:chatgpt:a|0']);
  assert.equal(r.cursor, '2026-09-09 19:30:00|3', 'cursor carries the rowid, not the span id');
  const none = feedExtractionFailures(p, { since_cursor: r.cursor });
  assert.equal(none.count, 0);
});

test('a missing owner file is a note, not a throw', () => {
  const r = feedCaptures({ gatewayDb: '/nonexistent/gateway.db', memoryDb: '', coreDb: '' }, {});
  assert.equal(r.count, 0);
  assert.match(r.note, /gateway\.db not found/);
});

test('feed_json_file: a ledger the hunt writes, paged by (found_at, id), root-locked', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-ledger-'));
  writeFileSync(path.join(root, 'leads.json'), JSON.stringify({ updated_at: 'x', leads: [
    { id: 'b', found_at: '2026-09-09T11:00:50+00:00', title: 'newest', url: 'https://x/b' },
    { id: 'a', found_at: '2026-09-08T15:55:54+00:00', title: 'older', url: 'https://x/a' },
    { id: 'c', found_at: '2026-09-09T11:00:50+00:00', title: 'same second', url: 'https://x/c' },
    { title: 'no id' },
  ] }));
  const p = { gatewayDb: '', memoryDb: '', coreDb: '', projectRoot: root };
  const first = feedJsonFile(p, { path: 'leads.json', items_path: 'leads', at_field: 'found_at', limit: 2 });
  assert.deepEqual(first.items.map((i) => i.id), ['b', 'c'], 'newest two, oldest-first, ties broken by id');
  assert.equal(first.items[0].title, 'newest');
  assert.equal(first.cursor, '2026-09-09T11:00:50+00:00|c');
  assert.equal(feedJsonFile(p, { path: 'leads.json', items_path: 'leads', at_field: 'found_at', since_cursor: first.cursor }).count, 0);
  const after = feedJsonFile(p, { path: 'leads.json', items_path: 'leads', at_field: 'found_at', since_cursor: '2026-09-08T15:55:54+00:00|a' });
  assert.deepEqual(after.items.map((i) => i.id), ['b', 'c']);
  writeFileSync(path.join(root, 'ledger2.json'), JSON.stringify({ leads: [
    { id: 'n1', found_at: '2026-09-10T03:49:06+00:00', status: 'new', score: 7 },
    { id: 's1', found_at: '2026-09-10T03:49:06+00:00', status: 'stale', score: 9 },
    { id: 'n2', found_at: '2026-09-10T03:49:07+00:00', status: 'new', score: 2 },
  ] }));
  const onlyNew = feedJsonFile(p, { path: 'ledger2.json', items_path: 'leads', at_field: 'found_at', where: { status: 'new' } });
  assert.deepEqual(onlyNew.items.map((i) => i.id), ['n1', 'n2'], 'where filters before paging');
  assert.equal(onlyNew.cursor, '2026-09-10T03:49:07+00:00|n2');
  const outside = feedJsonFile(p, { path: '../etc/passwd' });
  assert.match(outside.note, /inside the project root/);
  const gone = feedJsonFile(p, { path: 'nope.json' });
  assert.match(gone.note, /not found/);
});

test('feed_json_file: numeric min/max bound a field the equality filter cannot', () => {
  // PLAN-AUTOMATIONS §9.2 item 4. The live growth run spent an LLM turn on a
  // `status: new` lead scoring 0.0; `where` is equality-only and could not
  // express "score >= 5". These are the bounds that cut it.
  const root = mkdtempSync(path.join(tmpdir(), 'recall-bounds-'));
  writeFileSync(path.join(root, 'l.json'), JSON.stringify({ leads: [
    { id: 'hot',     at: '2026-09-10T01:00:00Z', status: 'new',   score: 7,     age_days: 3   },
    { id: 'cold',    at: '2026-09-10T02:00:00Z', status: 'new',   score: 0.0,   age_days: 3   },
    { id: 'stale',   at: '2026-09-10T03:00:00Z', status: 'new',   score: 9,     age_days: 465 },
    { id: 'strnum',  at: '2026-09-10T04:00:00Z', status: 'new',   score: '6',   age_days: 1   },
    { id: 'noscore', at: '2026-09-10T05:00:00Z', status: 'new',                 age_days: 1   },
    { id: 'nullsc',  at: '2026-09-10T06:00:00Z', status: 'new',   score: null,  age_days: 1   },
    { id: 'words',   at: '2026-09-10T07:00:00Z', status: 'new',   score: 'high',age_days: 1   },
    { id: 'shut',    at: '2026-09-10T08:00:00Z', status: 'stale', score: 8,     age_days: 2   },
  ] }));
  const p = { gatewayDb: '', memoryDb: '', coreDb: '', projectRoot: root };
  const f = (args) => feedJsonFile(p, { path: 'l.json', items_path: 'leads', ...args }).items.map((i) => i.id);

  assert.deepEqual(f({ min: { score: 5 } }), ['hot', 'stale', 'strnum', 'shut'],
    'a floor keeps numbers and numeric strings at or above it');
  assert.deepEqual(f({ max: { age_days: 60 } }), ['hot', 'cold', 'strnum', 'noscore', 'nullsc', 'words', 'shut'],
    'a ceiling keeps everything at or below it, including a 0.0 score');
  assert.deepEqual(f({ min: { score: 5 }, max: { age_days: 60 }, where: { status: 'new' } }), ['hot', 'strnum'],
    'bounds and equality compose — this is the filter the growth lane wanted');

  // The rule that makes a floor mean something: no number, no pass.
  assert.equal(f({ min: { score: 0 } }).includes('noscore'), false, 'a missing field fails even a zero floor');
  assert.equal(f({ min: { score: 0 } }).includes('nullsc'), false, 'null is not zero');
  assert.equal(f({ min: { score: 0 } }).includes('words'), false, 'a non-numeric string fails a floor');
  assert.deepEqual(f({ min: { score: 0 } }), ['hot', 'cold', 'stale', 'strnum', 'shut'],
    'and everything carrying a real number passes it');

  // A bound whose own value is not a number is dropped, not applied as NaN —
  // otherwise one bad argument would silently empty the feed.
  assert.deepEqual(f({ min: { score: 'five' } }), f({}), 'a non-numeric bound is ignored, not fatal');
  assert.deepEqual(f({ min: {} }), f({}), 'an empty bound object filters nothing');
});
