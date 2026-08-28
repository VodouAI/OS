/**
 * sqlite-bind — make a `node:sqlite` bind failure say WHICH COLUMN broke.
 *
 * PLAN-CONSOLE-SHOWS-ITS-WORK §7 S-4.
 *
 * `DatabaseSync` accepts string | number | bigint | null | Buffer and rejects
 * `undefined` with:
 *
 *     TypeError: Provided value cannot be bound to SQLite parameter 2.
 *
 * That message names a POSITIONAL INDEX. Nothing in it says which column, which
 * table, or which field of the caller's object was missing — and a TypeScript
 * cast (`args.thoughtNumber as number`) is erased at runtime, so the type system
 * never sees it either. `Vodou-Enhanced-Thinking.add_thought` failed on 100% of
 * calls for months behind exactly this message (§7.1); the audit that found it
 * had to count question marks by hand.
 *
 * This maps the index back to the column by parsing the statement's own SQL, so
 * the next instance announces itself:
 *
 *     Provided value cannot be bound to SQLite parameter 2
 *       — parameter 2 is `thought_number` (INSERT INTO thoughts), value: undefined
 *
 * Deliberately NOT a wrapper around every query: it costs nothing on the success
 * path (a try/catch with no allocation) and is opt-in at the call sites that bind
 * caller-supplied data. Wrapping the whole DB layer would be a bigger change with
 * no more diagnostic value.
 */
/** Column names for a statement's `?` placeholders, left to right, best-effort. */
export function columnsForPlaceholders(sql) {
    const flat = sql.replace(/\s+/g, " ").trim();
    // INSERT INTO t (a, b, c) VALUES (?, ?, ?)
    const ins = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+[\w."`[\]]+\s*\(([^)]*)\)\s*VALUES/i.exec(flat);
    if (ins) {
        return ins[1]
            .split(",")
            .map((c) => c.trim().replace(/[`"[\]]/g, ""))
            .filter(Boolean);
    }
    // UPDATE t SET a = ?, b = ? WHERE c = ?  → SET columns, then WHERE columns.
    const upd = /UPDATE\s+[\w."`[\]]+\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$/i.exec(flat);
    if (upd) {
        const cols = [];
        const collect = (part) => {
            if (!part)
                return;
            // Only assignments whose right-hand side is a placeholder consume one.
            for (const m of part.matchAll(/([\w."`[\]]+)\s*(?:=|<=|>=|<|>|!=|<>|\sIS\s|\sLIKE\s)\s*\?/gi)) {
                cols.push(m[1].replace(/[`"[\]]/g, "").replace(/^\w+\./, ""));
            }
        };
        collect(upd[1]);
        collect(upd[2]);
        return cols;
    }
    // SELECT … WHERE a = ? AND b = ?
    const where = /\sWHERE\s+(.*)$/i.exec(flat);
    if (where) {
        const cols = [];
        for (const m of where[1].matchAll(/([\w."`[\]]+)\s*(?:=|<=|>=|<|>|!=|<>|\sIS\s|\sLIKE\s)\s*\?/gi)) {
            cols.push(m[1].replace(/[`"[\]]/g, "").replace(/^\w+\./, ""));
        }
        return cols;
    }
    return [];
}
/** Short label for the statement, so the message says where it happened. */
function statementLabel(sql) {
    const flat = sql.replace(/\s+/g, " ").trim();
    const m = /^(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|SELECT)\b[\s\S]*?([\w."`[\]]+)/i.exec(flat);
    if (!m)
        return flat.slice(0, 40);
    return `${m[1].toUpperCase().replace(/\s+/g, " ")} ${m[2].replace(/[`"[\]]/g, "")}`;
}
/**
 * Run `exec`, and if node:sqlite rejects a bind, re-throw naming the column.
 * Every other error passes through untouched.
 */
export function withBindDiagnostics(sql, values, exec) {
    try {
        return exec();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const m = /cannot be bound to SQLite parameter (\d+)/i.exec(msg);
        if (!m)
            throw err;
        const idx = Number(m[1]);
        const col = columnsForPlaceholders(sql)[idx - 1];
        const val = values[idx - 1];
        const shown = val === undefined ? "undefined" : val === null ? "null" : typeof val;
        const detail = `${msg} — parameter ${idx} is ` +
            (col ? `\`${col}\`` : "an unnamed placeholder") +
            ` (${statementLabel(sql)}), received: ${shown}`;
        const wrapped = new TypeError(detail);
        wrapped.cause = err;
        throw wrapped;
    }
}
/**
 * Coerce `undefined` → `null` at the boundary, logging the column it belonged to.
 *
 * For a NULLABLE column this is the fix outright. For a NOT NULL one it converts
 * an opaque index into "NOT NULL constraint failed: thoughts.thought_number",
 * which names the offender — strictly better than a positional guess, and the
 * caller still finds out something was missing.
 */
export function bindSafe(sql, values, label = "bind-guard") {
    const cols = columnsForPlaceholders(sql);
    return values.map((v, i) => {
        if (v !== undefined)
            return v;
        console.error(`[${label}] ${cols[i] ?? `parameter ${i + 1}`} was undefined → NULL (${statementLabel(sql)})`);
        return null;
    });
}
