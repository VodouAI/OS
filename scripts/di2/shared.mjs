// Shared: the gateway's schema + the six mutation sites, over one file.
import { DatabaseSync } from 'node:sqlite';
export const WORDS = ('the a of and to in that is for it with as was on are this but be at have from or one had by word not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil now find long down day did get come made may part vodou memory gateway console channel skill daemon reranker credential extraction turn receipt').split(' ');
export function open(f) { const db = new DatabaseSync(f, { timeout: 15000 }); db.exec('PRAGMA busy_timeout = 15000'); try { db.exec('PRAGMA journal_mode = WAL'); } catch {} return db; }
export function mkrand(s) { let r = s; return () => (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }
export const ftsIc = (db) => { try { db.exec(`INSERT INTO gateway_messages_fts(gateway_messages_fts, rank) VALUES('integrity-check', 1)`); return 'ok'; } catch (e) { return 'BAD: ' + e.message; } };
export const quick = (db) => { try { return db.prepare('PRAGMA quick_check').get().quick_check; } catch (e) { return 'THREW: ' + e.message; } };
export const SCHEMA = `
  CREATE TABLE gateway_conversations (id TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE gateway_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, principal_id TEXT,
    sender_label TEXT, skill_name TEXT, excluded_from_context INTEGER DEFAULT 0, dedupe_key TEXT,
    source_msg_id TEXT, model TEXT, page_url TEXT, turn_id TEXT,
    FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE);
  CREATE UNIQUE INDEX idx_gw_messages_dedupe ON gateway_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX idx_gw_messages_conv ON gateway_messages(conversation_id);
  CREATE INDEX idx_gw_messages_role ON gateway_messages(role);
  CREATE INDEX idx_gw_messages_skill ON gateway_messages(skill_name) WHERE skill_name IS NOT NULL;
  CREATE VIRTUAL TABLE gateway_messages_fts USING fts5(content, content='gateway_messages', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER gateway_messages_fts_ai AFTER INSERT ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content); END;
  CREATE TRIGGER gateway_messages_fts_ad AFTER DELETE ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content); END;
  CREATE TRIGGER gateway_messages_fts_au AFTER UPDATE ON gateway_messages BEGIN
    INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content); END;`;
