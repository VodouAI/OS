/**
 * Per-site capture heartbeat — the gateway's half.
 * PLAN-CAPTURE-GRADED-PER-SITE P1 (PLANS/0.6.31/01-…).
 *
 * The extension's `bridge_health` frame now carries `sites`: per capture name,
 * the tallies it accumulated since its last send (visited, turns seen, turns
 * the gateway acked, adapter misses, two short endpoint signatures). This folds
 * them into ONE row per site per LOCAL day in gateway.db, which is the table
 * `vodou-core capture`, `flows` row 17 and Connect → Browser all read.
 *
 * Deltas in, sums here: the worker resets on every drain, so a heartbeat that
 * arrives twice (reconnect race) can at worst double one 30 s slice, never a day.
 * `visited` and `disabled` are OR'd, counts add, signatures take the newest.
 *
 * Time canon: `day` is the LOCAL calendar day (day identity is local);
 * `updated_at` is a naive-UTC instant `YYYY-MM-DD HH:MM:SS` like every other
 * SQLite instant in the tree.
 */
import { getGatewayDb } from '../db.js';
import { dayKeyOf } from '../user-time.js';
const SIG_MAX = 200;
const SITE_KEY = /^[a-z0-9_-]{1,40}$/i;
// The person's day, not the process's (`user-time.ts`, the one arbiter).
const localDay = dayKeyOf;
function naiveUtcNow() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
const flag = (v) => (Number(v) > 0 ? 1 : 0);
const sig = (v) => {
    const s = typeof v === 'string' ? v.slice(0, SIG_MAX) : '';
    return s ? s : null;
};
/**
 * Fold one heartbeat's `sites` object into gateway.db. Returns the number of
 * site rows touched. Never throws: a malformed tally must not cost the
 * liveness credit the heartbeat exists to give.
 */
export function recordSiteHeartbeat(sites, extBuild) {
    if (!sites || typeof sites !== 'object')
        return 0;
    let touched = 0;
    try {
        const db = getGatewayDb();
        const up = db.prepare(`
      INSERT INTO capture_site_heartbeat
        (site, day, ext_build, visited, turns_seen, turns_stored, miss_unmatched, miss_empty,
         disabled, matched_sig, miss_sig, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, day) DO UPDATE SET
        ext_build      = COALESCE(excluded.ext_build, ext_build),
        visited        = MAX(visited, excluded.visited),
        turns_seen     = turns_seen + excluded.turns_seen,
        turns_stored   = turns_stored + excluded.turns_stored,
        miss_unmatched = miss_unmatched + excluded.miss_unmatched,
        miss_empty     = miss_empty + excluded.miss_empty,
        disabled       = MAX(disabled, excluded.disabled),
        matched_sig    = COALESCE(excluded.matched_sig, matched_sig),
        miss_sig       = COALESCE(excluded.miss_sig, miss_sig),
        updated_at     = excluded.updated_at
    `);
        const day = localDay();
        const at = naiveUtcNow();
        // node:sqlite has no transaction() helper; one BEGIN/COMMIT so a 22-site
        // frame is one write, not twenty-two.
        db.exec('BEGIN');
        try {
            for (const [site, t] of Object.entries(sites)) {
                if (!SITE_KEY.test(site) || !t || typeof t !== 'object')
                    continue;
                up.run(site, day, extBuild, flag(t.visited), n(t.turns_seen), n(t.turns_stored), n(t.miss_unmatched), n(t.miss_empty), flag(t.disabled), sig(t.matched_sig), sig(t.miss_sig), at);
                touched++;
            }
            db.exec('COMMIT');
        }
        catch (e) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* not in a transaction */ }
            throw e;
        }
    }
    catch (e) {
        console.warn('[vbb] capture heartbeat not recorded:', e?.message || e);
    }
    return touched;
}
// The build stamp (channel@version#id8) is minted by BridgeConn.extBuildStamp()
// in bridge.ts — one definition, used for the heartbeat row and for the captured
// conversation row alike. The extension id comes from the WS origin the gateway
// validated at upgrade; nothing new is trusted from the frame.
