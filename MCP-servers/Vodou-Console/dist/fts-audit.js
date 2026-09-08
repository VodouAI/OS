/**
 * DI-2 Experiment 2 — instrument the delete/update path into the external-content
 * FTS5 index. See `.build/DI-2-GATEWAY-DB-CORRUPTION.md`.
 *
 * The prime suspect for four gateway.db corruptions is delete/update traffic
 * against `gateway_messages_fts`, which is an EXTERNAL-CONTENT index. Its
 * contract is unforgiving: the `'delete'` command in
 *
 *   INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content)
 *     VALUES('delete', old.id, old.content)          -- db.ts:595 / :598
 *
 * must present the content that was ACTUALLY indexed for that rowid, byte for
 * byte. Hand it anything else and FTS5 removes the wrong postings and leaves the
 * index quietly inconsistent — which is what "fts5: corruption found reading
 * blob N" reads like later.
 *
 * The dates fit: `gateway_messages` was append-only until late July; the first
 * DELETE landed 07-27/28, the first UPDATE 07-31, the first corruption 08-04.
 *
 * Every UPDATE fires that trigger, INCLUDING ones that do not touch `content` at
 * all — `excluded_from_context`, `dedupe_key`, `source_msg_id`. Any row indexed
 * with different bytes than it now holds (or never indexed, because it predates
 * the trigger) turns a harmless metadata update into a bad `'delete'`. The
 * unbounded pair in excludeSkillMessagesFromContext can do that to thousands of
 * rows in one statement.
 *
 * So this logs WHICH site mutated HOW MANY rows. That alone lets the next
 * incident be correlated with a statement instead of guessed at.
 *
 * VODOU_FTS_AUDIT_CHECK=1 additionally runs FTS5's own `integrity-check`
 * immediately after each mutation and names the site if it just went bad. That
 * turns "the index broke sometime today" into "THIS statement broke it". It
 * costs a full index scan per mutation, so it is opt-in and meant for a
 * reproduction run, not for normal operation.
 */
let checkedOk = 0;
let checkedBad = 0;
function stamp() { return new Date().toISOString(); }
/**
 * Record one mutation of `gateway_messages`. `changes` is the row count the
 * statement actually touched — zero is not logged, because a statement that
 * matched nothing issued no `'delete'` command and cannot have damaged anything.
 */
export function auditFtsMutation(site, op, changes, db) {
    if (!Number.isFinite(changes) || changes <= 0)
        return;
    // A mutation touching many rows issues that many `'delete'` commands in one
    // statement, so row count is the exposure, not just a curiosity.
    console.error(`[${stamp()}] [fts-audit] ${op} site=${site} rows=${changes}`);
    if (process.env.VODOU_FTS_AUDIT_CHECK !== '1' || !db)
        return;
    try {
        const stmt = db.prepare("INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('integrity-check')");
        if (typeof stmt.run === 'function')
            stmt.run();
        checkedOk++;
    }
    catch (e) {
        checkedBad++;
        const msg = e instanceof Error ? e.message : String(e);
        // The whole point of the experiment: a site named at the moment it breaks.
        console.error(`[${stamp()}] [fts-audit] INDEX WENT BAD IMMEDIATELY AFTER: site=${site} op=${op} rows=${changes}\n` +
            `[fts-audit]   ${msg}\n` +
            `[fts-audit]   (${checkedOk} clean check(s) preceded this one; this is DI-2 Experiment 2 — ` +
            `record the site in .build/DI-2-GATEWAY-DB-CORRUPTION.md)`);
    }
}
/** For a reproduction run that wants the tally rather than the lines. */
export function ftsAuditCounts() {
    return { ok: checkedOk, bad: checkedBad };
}
