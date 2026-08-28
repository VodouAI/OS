/**
 * "Does this machine have the runtime state this suite needs?" — asked in ONE
 * place, because asking it privately has now broken CI three times on one branch:
 *
 *   5d8120ea  two suites required runtime databases that CI cannot have
 *   8a6f8796  four suites needed a Rust binary the gateway job cannot have
 *   (this)    the SEAM suites queried `skills_registry`, which lives in
 *             vodou-core.db — matched by `.gitignore:46 *.db`, so a fresh
 *             checkout has never had one and never will
 *
 * Each was fixed where it was found, with a private guard, and the next author
 * wrote a different private guard. This file is the shared one.
 *
 * ## Why `existsSync` is not the question
 *
 * `getDb()` opens vodou-core.db with `readOnly: false` (db.ts:49), so the FIRST
 * suite in the process to call it CREATES an empty database. Every suite that
 * runs after that sees a file on disk, concludes the state is present, and then
 * throws `no such table` on its first query. The file existing proves nothing.
 * Only the table does — so that is what we ask about.
 *
 * The two databases are NOT symmetric, which is why the SEAM suites half-worked:
 * `getGatewayDb()` runs `initGatewaySchema()`, so gateway.db comes up with its
 * tables (empty). vodou-core.db's schema is owned by the Rust engine and is
 * never created here, so it comes up with no tables at all.
 *
 * ## Why a guard AFTER the query is not a guard
 *
 * The idiom that broke was:
 *
 *     const oneFile = () => getDb().prepare('SELECT name FROM skills_registry LIMIT 1').get()?.name;
 *     const n = oneFile(); if (!n) return;      // never reached
 *
 * `prepare()` throws on a missing table, so the skip sat downstream of the thing
 * it was meant to skip. Ask BEFORE you query, at describe/it level.
 *
 * ## Skipped, never softened
 *
 * The rule 5d8120ea wrote down and this file keeps: a suite that cannot see live
 * data says so out loud and does not run. Loosening its assertions until they
 * pass everywhere is a silent pass wearing a CI badge — the same lie, with a
 * green tick on it.
 */
import { getDb, getGatewayDb } from '../db.js';
const FILE_OF = {
    core: 'vodou-core.db',
    gateway: 'gateway.db',
};
/** Table names are interpolated, so they must look like table names. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * How many rows `table` has on THIS machine, or `null` when the table is not
 * here at all (no database file, no schema, no table). `null` and `0` are
 * different answers: `0` means we looked and it is empty.
 */
export function liveRows(which, table) {
    if (!IDENT.test(table))
        throw new Error(`liveRows: '${table}' is not a table name`);
    try {
        const db = which === 'core' ? getDb() : getGatewayDb();
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        return typeof row?.n === 'number' ? row.n : null;
    }
    catch {
        return null;
    }
}
/** True when `table` exists here AND carries at least `min` rows. */
export function hasLive(which, table, min = 1) {
    const n = liveRows(which, table);
    return n !== null && n >= min;
}
/**
 * The line a skipped suite prints. A skip that says nothing is indistinguishable
 * from a pass in a CI log, which is how a suite stays dead for months.
 */
export function skipNote(suite, which, table) {
    return (`[${suite}] SKIPPED: no rows in \`${table}\`. It lives in ${FILE_OF[which]}, a RUNTIME ` +
        `database that is gitignored, so a fresh checkout (CI, a new clone) has never had one. ` +
        `This is "nobody looked", not "fine".`);
}
