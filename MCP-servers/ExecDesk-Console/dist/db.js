/**
 * Database wrapper for admin dashboard
 * Direct SQLite access to vodou-core.db via node:sqlite (built into bundled Node 24).
 * Loads project root .env so VODOU_PROJECT_PATH is used everywhere.
 */
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Derive project root from gateway's own location (always correct)
const DERIVED_ROOT = path.resolve(__dirname, '../../..');
// Load .env from our known location (not from potentially stale VODOU_PROJECT_PATH)
dotenv.config({ path: path.resolve(DERIVED_ROOT, '.env') });
// Trust VODOU_PROJECT_PATH only if the directory actually has vodou-core.db,
// otherwise use our derived location. Prevents stale env paths (e.g. "folder 2") from breaking things.
const envRoot = process.env.VODOU_PROJECT_PATH;
const PROJECT_ROOT = (envRoot && existsSync(path.join(envRoot, 'vodou-core.db')))
    ? envRoot
    : DERIVED_ROOT;
const DB_PATH = path.join(PROJECT_ROOT, 'vodou-core.db');
const MEMORY_DB_PATH = path.join(PROJECT_ROOT, 'memory.db');
const GATEWAY_DB_PATH = process.env.GATEWAY_DB_PATH?.trim()
    || path.join(PROJECT_ROOT, 'MCP-servers', 'Vodou-Console', 'gateway.db');
let db = null;
let memDb = null;
let gatewayDb = null;
let thinkingDb = null;
/**
 * Get the main vodou-core database connection
 */
export function getDb() {
    if (!db) {
        db = new DatabaseSync(DB_PATH, { readOnly: false, timeout: 5000 });
        db.exec('PRAGMA journal_mode = WAL');
    }
    return db;
}
/**
 * Get the memory database connection (read-only)
 */
export function getMemoryDb() {
    if (!memDb) {
        try {
            memDb = new DatabaseSync(MEMORY_DB_PATH, { readOnly: true, timeout: 5000 });
        }
        catch {
            // memory.db may not exist yet
            return null;
        }
    }
    return memDb;
}
/**
 * Get the Vodou-Enhanced-Thinking database connection (read-only)
 */
export function getThinkingDb() {
    if (!thinkingDb) {
        const thinkingDbPath = path.join(PROJECT_ROOT, 'MCP-servers', 'Vodou-Enhanced-Thinking', 'thinking.db');
        try {
            thinkingDb = new DatabaseSync(thinkingDbPath, { readOnly: true, timeout: 5000 });
        }
        catch {
            console.error('[DB] thinking.db not found at', thinkingDbPath, '— deep thinking history unavailable');
            return null;
        }
    }
    return thinkingDb;
}
/**
 * Get the gateway's own database (conversations, settings)
 */
export function getGatewayDb() {
    if (!gatewayDb) {
        gatewayDb = new DatabaseSync(GATEWAY_DB_PATH, { readOnly: false, timeout: 5000 });
        gatewayDb.exec('PRAGMA journal_mode = WAL');
        initGatewaySchema(gatewayDb);
    }
    return gatewayDb;
}
function initGatewaySchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_conversations (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT 'New Chat',
      source TEXT DEFAULT 'web',
      sender_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gateway_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gw_messages_conv ON gateway_messages(conversation_id);

    CREATE TABLE IF NOT EXISTS gateway_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gateway_skill_state (
      conversation_id TEXT PRIMARY KEY,
      skill_name TEXT NOT NULL,
      oi_context TEXT,
      loaded_at INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES gateway_conversations(id) ON DELETE CASCADE
    );
  `);
    // Migration: add source/sender_name columns if missing (existing DBs)
    try {
        db.prepare('SELECT source FROM gateway_conversations LIMIT 0').get();
    }
    catch {
        db.exec('ALTER TABLE gateway_conversations ADD COLUMN source TEXT DEFAULT \'web\'');
        db.exec('ALTER TABLE gateway_conversations ADD COLUMN sender_name TEXT');
    }
    // Migration: add deleted_at for soft-delete (existing DBs)
    try {
        db.prepare('SELECT deleted_at FROM gateway_conversations LIMIT 0').get();
    }
    catch {
        db.exec('ALTER TABLE gateway_conversations ADD COLUMN deleted_at DATETIME');
    }
    // Usage tracking table (API cost tracking)
    db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_create_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gw_usage_conv ON gateway_usage(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_gw_usage_date ON gateway_usage(created_at);
  `);
    // Drop legacy oauth_tokens table — OAuth state now lives in vodou-core.db
    // (oauth_configs + server_credentials + mcp_servers) so gateway UI and CLI share state.
    // Idempotent: no-op if the table was never created on this install.
    db.exec(`DROP TABLE IF EXISTS oauth_tokens;`);
}
/**
 * Record API usage for a conversation turn
 */
export function saveUsage(conversationId, provider, model, usage) {
    try {
        const db = getGatewayDb();
        db.prepare(`INSERT INTO gateway_usage (conversation_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, provider, model, usage.inputTokens || 0, usage.outputTokens || 0, usage.cacheReadTokens || 0, usage.cacheCreateTokens || 0, usage.costUsd || 0, usage.durationMs || 0);
    }
    catch (e) {
        console.error('[Usage] Failed to save:', e.message);
    }
}
/**
 * Get usage summary (aggregated by day, optionally filtered)
 */
export function getUsageSummary(options) {
    const db = getGatewayDb();
    const days = options?.days || 30;
    const conditions = [`created_at >= datetime('now', '-${days} days')`];
    const params = [];
    if (options?.conversationId) {
        conditions.push('conversation_id = ?');
        params.push(options.conversationId);
    }
    if (options?.provider) {
        conditions.push('provider = ?');
        params.push(options.provider);
    }
    return db.prepare(`SELECT date(created_at) as day, provider, model,
            COUNT(*) as requests,
            SUM(input_tokens) as total_input_tokens,
            SUM(output_tokens) as total_output_tokens,
            SUM(cache_read_tokens) as total_cache_read,
            SUM(cost_usd) as total_cost_usd,
            AVG(duration_ms) as avg_duration_ms
     FROM gateway_usage
     WHERE ${conditions.join(' AND ')}
     GROUP BY day, provider, model
     ORDER BY day DESC`).all(...params);
}
/**
 * Get a setting from gateway_settings
 */
export function getSetting(key) {
    const db = getGatewayDb();
    const row = db.prepare('SELECT value FROM gateway_settings WHERE key = ?').get(key);
    return row?.value ?? null;
}
/**
 * Set a setting in gateway_settings
 */
export function setSetting(key, value) {
    const db = getGatewayDb();
    db.prepare('INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, value);
}
/**
 * Get all settings as a key-value object
 */
export function getAllSettings() {
    const db = getGatewayDb();
    const rows = db.prepare('SELECT key, value FROM gateway_settings').all();
    const result = {};
    for (const row of rows)
        result[row.key] = row.value;
    return result;
}
/**
 * Close all database connections
 */
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
    if (memDb) {
        memDb.close();
        memDb = null;
    }
    if (gatewayDb) {
        gatewayDb.close();
        gatewayDb = null;
    }
    if (thinkingDb) {
        try {
            thinkingDb.close();
        }
        catch { }
        thinkingDb = null;
    }
}
/**
 * Get project root path (for vodou-core CLI calls)
 */
export function getProjectRoot() {
    return PROJECT_ROOT;
}
