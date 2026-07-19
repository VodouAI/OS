#!/usr/bin/env node
// Vodou-Board needs Node 24+: node:sqlite must ship with FTS5 (Node 22 omits it).
// Fails the test run early with a clear message instead of letting vitest surface
// a confusing "no such module: fts5" deep inside a migration.

import { DatabaseSync } from 'node:sqlite';

const major = Number(process.versions.node.split('.')[0]);
const db = new DatabaseSync(':memory:');
try {
  db.exec('CREATE VIRTUAL TABLE _probe USING fts5(x)');
} catch (e) {
  console.error('');
  console.error('❌ Vodou-Board tests require Node 24+ (FTS5 in node:sqlite).');
  console.error(`   Detected: Node ${process.versions.node} — FTS5 missing.`);
  console.error('');
  console.error('   Fix one of:');
  console.error('     • Use the bundled Node: PATH="$(pwd)/../../.build/node-cache/node-v24.15.0-darwin-arm64/bin:$PATH" npm test');
  console.error('     • Install Node 24+:    nvm install 24 && nvm use 24');
  console.error('');
  process.exit(1);
}
db.close();
if (major < 24) {
  console.error(`⚠️  Node ${process.versions.node} has FTS5 but Vodou-Board officially targets Node 24+. Proceeding.`);
}
