#!/usr/bin/env node
// Smoke test for the node:sqlite adapter.
// Run: node MCP-servers/_shared/db-smoke.test.mjs
//
// Validates: open, CREATE TABLE, prepare/run/get/all/iterate, transaction,
// BLOB round-trip, persistence across close+reopen.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `vodou-smoke-${Date.now()}.db`);
let pass = 0, fail = 0;

function assert(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log(`Node ${process.version}\nDB: ${tmp}\n`);

// 1. Open + create
let db = new DatabaseSync(tmp);
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, blob BLOB);
  CREATE INDEX idx_users_name ON users(name);
`);
assert('CREATE TABLE persists', db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
).get()?.name === 'users');

// 2. Insert + lastInsertRowid
const ins = db.prepare('INSERT INTO users (name, blob) VALUES (?, ?)');
const r1 = ins.run('alice', new Uint8Array([1,2,3]));
assert('run() returns changes=1', r1.changes === 1);
assert('run() returns lastInsertRowid=1', Number(r1.lastInsertRowid) === 1);

// 3. get / all
ins.run('bob', new Uint8Array([4,5,6]));
ins.run('carol', new Uint8Array([7,8,9]));
const row = db.prepare('SELECT * FROM users WHERE id = ?').get(2);
assert('get() returns row', row?.name === 'bob');
const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
assert('all() returns 3 rows', rows.length === 3);

// 4. iterate
let count = 0;
for (const _ of db.prepare('SELECT id FROM users').iterate()) count++;
assert('iterate() yields 3 rows', count === 3);

// 5. BLOB round-trip
assert('BLOB round-trip', row?.blob instanceof Uint8Array && row.blob[0] === 4);

// 6. Transaction (manual BEGIN/COMMIT/ROLLBACK)
db.exec('BEGIN');
db.prepare('INSERT INTO users (name) VALUES (?)').run('dan');
db.exec('ROLLBACK');
assert('ROLLBACK leaves 3 rows', db.prepare('SELECT COUNT(*) c FROM users').get().c === 3);

db.exec('BEGIN');
db.prepare('INSERT INTO users (name) VALUES (?)').run('eve');
db.exec('COMMIT');
assert('COMMIT yields 4 rows', db.prepare('SELECT COUNT(*) c FROM users').get().c === 4);

// 7. Burst writes
const burst = db.prepare('INSERT INTO users (name) VALUES (?)');
db.exec('BEGIN');
for (let i = 0; i < 100; i++) burst.run(`u${i}`);
db.exec('COMMIT');
assert('100 burst writes all persisted', db.prepare('SELECT COUNT(*) c FROM users').get().c === 104);

// 8. Close + reopen persistence
db.close();
db = new DatabaseSync(tmp);
assert('persisted across close+reopen', db.prepare('SELECT COUNT(*) c FROM users').get().c === 104);
db.close();

// 9. Read-only mode
const ro = new DatabaseSync(tmp, { readOnly: true });
assert('read-only open works', ro.prepare('SELECT COUNT(*) c FROM users').get().c === 104);
let threw = false;
try { ro.prepare('INSERT INTO users (name) VALUES (?)').run('zed'); } catch { threw = true; }
assert('read-only blocks writes', threw);
ro.close();

fs.unlinkSync(tmp);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
