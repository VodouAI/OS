import { DatabaseSync } from 'node:sqlite';
const f = process.argv[2];
const db = new DatabaseSync(f);
const ic = () => { try { db.exec(`INSERT INTO gateway_messages_fts(gateway_messages_fts, rank) VALUES('integrity-check', 1)`); return 'ok'; } catch (e) { return 'BAD: ' + e.message; } };
console.log(`  fresh connection to ${f.split('/').pop()}`);
console.log(`    PRAGMA quick_check      : ${db.prepare('PRAGMA quick_check').get().quick_check}`);
console.log(`    PRAGMA integrity_check  : ${db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check).join(' | ').slice(0,200)}`);
console.log(`    FTS5 integrity-check    : ${ic()}`);
try { console.log(`    MATCH 'memory'          : ${db.prepare(`SELECT COUNT(*) n FROM gateway_messages_fts WHERE content MATCH 'memory'`).get().n} hits`); }
catch (e) { console.log(`    MATCH 'memory'          : THREW ${e.message}`); }
db.close();
