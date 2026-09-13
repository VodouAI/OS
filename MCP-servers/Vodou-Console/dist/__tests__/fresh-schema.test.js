/**
 * A brand-new database gets every table `initGatewaySchema` declares.
 *
 * This is the missing test class, not a regression test for one line. On
 * 2026-09-10 a column migration ran ~500 lines BEFORE its table was created:
 *
 *     try { db.prepare('SELECT turns_dup FROM capture_site_heartbeat …') }
 *     catch { db.exec('ALTER TABLE capture_site_heartbeat ADD COLUMN …') }
 *
 * On an existing database the SELECT succeeds and nothing happens. On a fresh
 * one the SELECT throws `no such table`, the catch ALTERs a table that does not
 * exist, and THAT throw is uncaught — so schema init died and the 14 tables
 * declared below that line were never created. Every developer machine passed,
 * because every developer machine already had a gateway.db. CI, and a first
 * run, are the only places a fresh database appears.
 *
 * The gate is derived from the source rather than a hand-kept list, so a table
 * added tomorrow is covered without anyone remembering to add it here.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TS = readFileSync(path.resolve(HERE, '../db.ts'), 'utf8');
/**
 * Every `CREATE TABLE IF NOT EXISTS <name>` inside `initGatewaySchema`.
 *
 * Scoped to that function on purpose: `runGatewaySideMigrations` in the same
 * file creates `server_health_log` in the CATALOG database (vodou-core.db), so
 * a whole-file regex reports it missing from gateway.db and is right about the
 * text while being wrong about the world. The first draft of this gate did
 * exactly that.
 */
function declaredTables() {
    const start = DB_TS.indexOf('function initGatewaySchema');
    expect(start, 'initGatewaySchema not found — this gate reads the source').toBeGreaterThan(-1);
    const rest = DB_TS.slice(start + 1);
    const nextFn = rest.search(/\n(?:export )?function \w+/);
    const body = nextFn === -1 ? rest : rest.slice(0, nextFn);
    const names = [...body.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    return [...new Set(names)];
}
describe('a fresh gateway database', () => {
    it('ends up with every table db.ts declares', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'vodou-fresh-schema-'));
        process.env.GATEWAY_DB_PATH = path.join(dir, 'gateway.db');
        const { getGatewayDb } = await import('../db.js');
        const db = getGatewayDb();
        const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
            .map((r) => r.name));
        const declared = declaredTables();
        expect(declared.length).toBeGreaterThan(10); // the regex still matches something
        const missing = declared.filter((t) => !present.has(t));
        expect(missing, `declared in db.ts but absent after init on a FRESH database — \
schema init almost certainly threw partway (an ALTER on a table created later is how it happened before)`).toEqual([]);
    });
    it('is idempotent — opening the same database twice changes nothing', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'vodou-fresh-schema-twice-'));
        process.env.GATEWAY_DB_PATH = path.join(dir, 'gateway.db');
        const mod = await import('../db.js');
        const first = mod.getGatewayDb();
        const before = first.prepare("SELECT count(*) c FROM sqlite_master").get().c;
        // Re-running the migrations on a populated database is the case that DOES
        // work today and must keep working — it is the other half of the pair.
        const again = mod.getGatewayDb();
        const after = again.prepare("SELECT count(*) c FROM sqlite_master").get().c;
        expect(after).toBe(before);
    });
});
