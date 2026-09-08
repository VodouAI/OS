// DI-2 Experiment 4 — deliberate reproduction.
// "a loop of insert/update/delete against a copy on both Node 22 and 24,
//  with integrity_check between rounds."  (.build/DI-2-GATEWAY-DB-CORRUPTION.md)
//
// Runs against a THROWAWAY db in the scratchpad. Never touches gateway.db.
// Schema, triggers and driver are copied byte-for-byte from the shipped ones
// (db.ts:585-601, `.schema gateway_messages` off the live file).

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

const MODE   = process.argv[2] || 'faithful';      // faithful | desync
const ROUNDS = Number(process.argv[3] || 40);
const SEED   = Number(process.argv[4] || 4000);
const DIR    = process.argv[5];
const DB     = path.join(DIR, `exp4-${MODE}-node${process.versions.node.split('.')[0]}.db`);

for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE gateway_conversations (id TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE gateway_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, principal_id TEXT, sender_label TEXT,
    skill_name TEXT, excluded_from_context INTEGER DEFAULT 0, dedupe_key TEXT,
    source_msg_id TEXT, model TEXT, page_url TEXT, turn_id TEXT,
    FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX idx_gw_messages_dedupe ON gateway_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX idx_gw_messages_conv ON gateway_messages(conversation_id);
  CREATE INDEX idx_gw_messages_principal ON gateway_messages(principal_id);
  CREATE INDEX idx_gw_messages_role ON gateway_messages(role);
  CREATE INDEX idx_gw_messages_skill ON gateway_messages(skill_name) WHERE skill_name IS NOT NULL;
  CREATE INDEX idx_gw_messages_turn ON gateway_messages(turn_id) WHERE turn_id IS NOT NULL;
`);

// ---- seed BEFORE the index, then rebuild: the real history (78k rows existed
//      when FTS5 landed 2026-05-15).
const convs = ['c-alpha', 'c-beta', 'c-gamma', 'c-delta'];
const icv = db.prepare('INSERT INTO gateway_conversations(id,title) VALUES (?,?)');
for (const c of convs) icv.run(c, c);

const WORDS = ('the a of and to in that is for it with as was on are this but be at have from or one had by word not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil now find long down day did get come made may part vodou memory gateway console channel skill daemon reranker credential extraction turn receipt'
).split(' ');
let rnd = 1234567;
const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const text = (n) => Array.from({ length: n }, () => WORDS[(rand() * WORDS.length) | 0]).join(' ');

const ins = db.prepare('INSERT INTO gateway_messages(conversation_id,role,content,skill_name,dedupe_key,turn_id) VALUES (?,?,?,?,?,?)');
const insert = (i) => ins.run(
  convs[(rand() * convs.length) | 0],
  rand() < 0.5 ? 'user' : 'assistant',
  text(8 + ((rand() * 120) | 0)),
  rand() < 0.15 ? 'daily-brief' : null,
  rand() < 0.7 ? `dk-${i}-${(rand() * 1e9) | 0}` : null,
  `t-${i}`
);
for (let i = 0; i < SEED; i++) insert(i);

db.exec(`
  CREATE VIRTUAL TABLE gateway_messages_fts USING fts5(
    content, content='gateway_messages', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER gateway_messages_fts_ai AFTER INSERT ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER gateway_messages_fts_ad AFTER DELETE ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  END;
  CREATE TRIGGER gateway_messages_fts_au AFTER UPDATE ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);
db.exec(`INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('rebuild')`);

// ---- checks
const quick = () => { try { return db.prepare('PRAGMA quick_check').get().quick_check; } catch (e) { return 'THREW: ' + e.message; } };
const full  = () => { try { return db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check).join(' | ').slice(0, 400); } catch (e) { return 'THREW: ' + e.message; } };
const ftsIc = () => { try { db.exec(`INSERT INTO gateway_messages_fts(gateway_messages_fts, rank) VALUES('integrity-check', 1)`); return 'ok'; } catch (e) { return 'FTS-BAD: ' + e.message; } };
const match = () => { try { return db.prepare(`SELECT COUNT(*) n FROM gateway_messages_fts WHERE content MATCH 'memory OR gateway'`).get().n; } catch (e) { return 'MATCH-THREW: ' + e.message; } };

const base = { quick: quick(), fts: ftsIc(), match: match() };
console.log(`[node ${process.versions.node}] mode=${MODE} rounds=${ROUNDS} seed=${SEED}`);
console.log(`  baseline: quick=${base.quick} fts=${base.fts} match=${base.match}`);

// ---- mode 'desync': make the index disagree with the table exactly the way
// the audit says it can — an UPDATE that never reaches the trigger. Nothing in
// the gateway does this deliberately; it is the state a failed/partial trigger,
// a rebuild-skipped row, or a REPLACE would leave behind.
if (MODE === 'desync') {
  db.exec('DROP TRIGGER gateway_messages_fts_au');
  db.prepare(`UPDATE gateway_messages SET content = content || ' zzz-unindexed-token' WHERE id % 7 = 0`).run();
  db.exec(`CREATE TRIGGER gateway_messages_fts_au AFTER UPDATE ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
  END;`);
  console.log(`  desync planted: index and table now disagree on every 7th row (fts=${ftsIc()})`);
}

// ---- the six real mutation sites (fts-audit.ts names them)
const sites = {
  'saveMessage:adopt-claim': () => db.prepare(
    `UPDATE gateway_messages SET dedupe_key = ?, source_msg_id = ? WHERE rowid = (
       SELECT rowid FROM gateway_messages WHERE conversation_id = ? AND role = ?
        AND (source_msg_id IS NULL OR source_msg_id = '') ORDER BY id DESC LIMIT 1)`
  ).run(`adopt-${(rand()*1e9)|0}`, `smid-${(rand()*1e9)|0}`, convs[(rand()*convs.length)|0], rand() < .5 ? 'user' : 'assistant'),

  'saveMessage:upgrade-truncated': () => {
    const row = db.prepare(`SELECT id FROM gateway_messages ORDER BY id DESC LIMIT 1 OFFSET ?`).get((rand()*200)|0);
    return row ? db.prepare('UPDATE gateway_messages SET content = ? WHERE id = ?').run(text(60 + ((rand()*200)|0)), row.id) : { changes: 0 };
  },

  'excludeSkillMessages:by-tag': () =>
    db.prepare('UPDATE gateway_messages SET excluded_from_context = 1 WHERE skill_name = ? AND excluded_from_context = 0').run('daily-brief'),

  'excludeSkillMessages:by-content-pattern': () =>
    db.prepare("UPDATE gateway_messages SET excluded_from_context = 1, skill_name = COALESCE(skill_name, ?) WHERE role = 'assistant' AND excluded_from_context = 0 AND content LIKE ?").run('pattern', '%vodou%'),

  'feed:delete-captures': () => {
    const ids = db.prepare('SELECT id FROM gateway_messages ORDER BY id LIMIT ?').all(5 + ((rand()*40)|0)).map(r => r.id);
    return ids.length ? db.prepare(`DELETE FROM gateway_messages WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids) : { changes: 0 };
  },

  'cascade:delete-conversation': () => {
    const c = `c-tmp-${(rand()*1e9)|0}`;
    icv.run(c, c);
    for (let i = 0; i < 30; i++) ins.run(c, 'user', text(20), null, null, `t-${c}-${i}`);
    return db.prepare('DELETE FROM gateway_conversations WHERE id = ?').run(c);
  },
};

let firstBad = null, totalRows = 0, errs = 0;
for (let r = 1; r <= ROUNDS; r++) {
  for (let i = 0; i < 200; i++) insert(1e6 + r * 1000 + i);
  for (const [name, fn] of Object.entries(sites)) {
    let res;
    try { res = fn(); } catch (e) { errs++; res = { changes: 0 }; }
    totalRows += Number(res?.changes || 0);
    if (!firstBad) {
      const f = ftsIc();
      if (f !== 'ok') { firstBad = { round: r, site: name, fts: f, quick: quick() }; }
    }
  }
  const q = quick(), f = ftsIc();
  if (q !== 'ok' || f !== 'ok' || r % 10 === 0 || r === ROUNDS) {
    console.log(`  round ${String(r).padStart(3)}: quick=${q} fts=${f} match=${match()} mutated=${totalRows} errs=${errs}`);
  }
  if (q !== 'ok') { console.log(`  FILE DAMAGE at round ${r}:\n    ${full()}`); break; }
}

console.log(`  final:    quick=${quick()} fts=${ftsIc()} match=${match()}`);
console.log(`  full integrity_check: ${full()}`);
console.log(`  rows now: ${db.prepare('SELECT COUNT(*) n FROM gateway_messages').get().n}, mutated across run: ${totalRows}`);
console.log(`  first FTS failure: ${firstBad ? JSON.stringify(firstBad) : 'none'}`);
db.close();
