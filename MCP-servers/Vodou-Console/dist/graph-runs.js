/**
 * PLAN-GRAPH-SKILLS P0 — the run record (holes H3, H4, H20).
 *
 * Before this, a workflow run left no trace anyone could read back. The only
 * artefact was `gateway_tool_trajectories`, which records individual tool calls
 * and knows nothing about groups, joins, or how many branches were *expected*.
 * That is why the Skill Console header, the Board, and the proposer all had
 * nothing to read: there was no such thing as "a run".
 *
 * Three things depend on this table existing:
 *
 *   * **H3 — run history.** "last: 08:00 today · 2/3 · 28s" on the skill tab, and
 *     the Runs list, both read from here. `skills_meta.last_run_at` is written
 *     FROM this table so the header and the list can never disagree (the F10
 *     class of bug: a count displayed that nothing writes).
 *   * **H4 — per-run state.** Keyed by `run_id`, so two skills can be mid-run at
 *     once and a reply from another surface can find its run. The CLI's single
 *     `.vodou/workspace/workflow_state.json` could never do that.
 *   * **H20 — durable execution.** Branch states are persisted AS THEY SETTLE,
 *     not at the end. Kill the gateway mid-fan and the row still names exactly
 *     which branches came back before the kill — the run reports the truth
 *     instead of vanishing.
 *
 * Every count here comes from recorded branch states. Nothing in this file ever
 * derives a number from prose (Coherence Rule 9).
 */
import { randomUUID, createHash } from 'crypto';
import { getGatewayDb } from './db.js';
let _ensured = false;
/**
 * Created lazily rather than in the main migration block so a graph run is never
 * the reason the gateway fails to boot. Every writer below calls this first.
 */
export function ensureGraphRunsTable() {
    if (_ensured)
        return;
    try {
        const db = getGatewayDb();
        db.exec(`
      CREATE TABLE IF NOT EXISTS graph_runs (
        run_id            TEXT PRIMARY KEY,
        skill             TEXT NOT NULL,
        recipe_hash       TEXT,
        parent_run_id     TEXT,
        surface           TEXT NOT NULL DEFAULT 'web',
        conversation_id   TEXT,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER,
        outcome           TEXT NOT NULL DEFAULT 'running',
        node_states_json  TEXT NOT NULL DEFAULT '[]',
        counts_json       TEXT NOT NULL DEFAULT '{}',
        cost_usd          REAL,
        cancelled_by      TEXT,
        board_task_id     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_graph_runs_skill ON graph_runs(skill, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_graph_runs_started ON graph_runs(started_at DESC);
    `);
        // Additive: `pending_ask_json` arrived after the table shipped, so an
        // existing gateway.db has the table WITHOUT it and CREATE TABLE IF NOT
        // EXISTS will not add it. Guarded by a pragma read rather than a caught
        // exception, so a genuine failure is still visible.
        const hasAsk = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('graph_runs') WHERE name = 'pending_ask_json'`)
            .get().n > 0;
        if (!hasAsk) {
            db.exec(`ALTER TABLE graph_runs ADD COLUMN pending_ask_json TEXT`);
            console.error('[GraphRuns] added pending_ask_json');
        }
        _ensured = true;
    }
    catch (err) {
        console.error('[GraphRuns] table ensure failed:', err);
    }
}
/**
 * Identity of the graph that ran, so a later edit cannot silently change what a
 * past run "meant" (H22). Hashes structure only — ids, servers, tools, group
 * membership and join shape — deliberately NOT arguments, which vary per run.
 */
export function recipeHash(steps) {
    try {
        const arr = Array.isArray(steps) ? steps : [];
        const skeleton = arr.map((s) => {
            const st = s;
            return [
                st.id ?? '',
                st.kind ?? 'tool',
                st.server ?? '',
                st.tool ?? '',
                st.parallel_group ?? '',
                Array.isArray(st.in) ? st.in.join('|') : '',
                st.min_success ?? '',
                st.on_partial ?? '',
                st.on_fail ?? '',
            ].join(':');
        });
        return createHash('sha256').update(JSON.stringify(skeleton)).digest('hex').slice(0, 16);
    }
    catch {
        return '';
    }
}
export function startRun(opts) {
    ensureGraphRunsTable();
    const runId = `run_${randomUUID()}`;
    try {
        getGatewayDb()
            .prepare(
        // `board_task_id` is in this INSERT because it was NOT, and the
        // parameter above was therefore dead: `startRun` accepted a
        // `boardTaskId`, dropped it on the floor, and the column read 0 of 1221
        // rows. A field a caller can pass and the database never receives is
        // worse than no field — it makes the wiring look done.
        `INSERT INTO graph_runs
           (run_id, skill, recipe_hash, parent_run_id, surface, conversation_id,
            started_at, outcome, node_states_json, counts_json, board_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '[]', '{}', ?)`)
            .run(runId, opts.skill, opts.steps ? recipeHash(opts.steps) : null, opts.parentRunId ?? null, opts.surface ?? 'web', opts.conversationId ?? null, Date.now(), opts.boardTaskId ?? null);
    }
    catch (err) {
        console.error('[GraphRuns] startRun failed:', err);
    }
    return runId;
}
/**
 * Persist branch states the moment they settle. Called per group, not once at
 * the end — that ordering is the whole of H20: a kill between the fan and the
 * join must still leave evidence of what came back.
 */
export function recordBranches(runId, branches) {
    ensureGraphRunsTable();
    try {
        const db = getGatewayDb();
        const row = db.prepare(`SELECT node_states_json FROM graph_runs WHERE run_id = ?`).get(runId);
        if (!row)
            return;
        const existing = JSON.parse(row.node_states_json || '[]');
        // Last write wins per id: a branch may be recorded `running` then settled.
        const byId = new Map(existing.map((b) => [b.id, b]));
        for (const b of branches)
            byId.set(b.id, b);
        const merged = [...byId.values()];
        const counts = {
            expected: merged.length,
            settled: merged.filter((b) => b.state !== 'running').length,
            ok: merged.filter((b) => b.state === 'ok').length,
            failed: merged.filter((b) => b.state !== 'running' && b.state !== 'ok').length,
        };
        db.prepare(`UPDATE graph_runs SET node_states_json = ?, counts_json = ? WHERE run_id = ?`).run(JSON.stringify(merged), JSON.stringify(counts), runId);
    }
    catch (err) {
        console.error('[GraphRuns] recordBranches failed:', err);
    }
}
export function finishRun(runId, outcome, extra) {
    ensureGraphRunsTable();
    // A run that has ended is not waiting for anybody. Leaving the question behind
    // would let a surface answer a run that finished ten minutes ago — the stale
    // menu problem, with a database row to make it convincing.
    clearAsk(runId);
    try {
        const db = getGatewayDb();
        db.prepare(`UPDATE graph_runs SET ended_at = ?, outcome = ?, cancelled_by = ?, cost_usd = ? WHERE run_id = ?`).run(Date.now(), outcome, extra?.cancelledBy ?? null, extra?.costUsd ?? null, runId);
        // `skills_meta.last_run_at` is DERIVED, never written independently. Two
        // places writing the same fact is how a header ends up disagreeing with the
        // list it sits above.
        const row = db.prepare(`SELECT skill, ended_at FROM graph_runs WHERE run_id = ?`).get(runId);
        if (row) {
            try {
                db.prepare(`UPDATE skills_meta SET last_run_at = ? WHERE name = ?`).run(new Date(row.ended_at).toISOString(), row.skill);
            }
            catch {
                /* skills_meta may not carry last_run_at in every install — not fatal */
            }
        }
    }
    catch (err) {
        console.error('[GraphRuns] finishRun failed:', err);
    }
}
/**
 * Any run left `running` belongs to a process that is no longer alive — the
 * gateway was killed or crashed mid-fan. Called once at boot.
 *
 * These are marked `failed` with their branch states INTACT, which is the
 * user-visible half of H20: the run card can still say "calendar ✓, mail ✓,
 * slack — interrupted" instead of the run simply disappearing.
 */
export function reconcileInterruptedRuns() {
    ensureGraphRunsTable();
    try {
        const db = getGatewayDb();
        const stale = db
            // `parked` is swept too, and that is not a detail. A parked run is waiting
            // on a HUMAN, so it looks survivable — but the thing that would resume it,
            // `activeWorkflows`, is in-memory and dies with the process. Leaving parked
            // rows behind would hand a surface a question whose workflow no longer
            // exists: answerable forever, resumable never. The old test caught this the
            // moment `parked` stopped matching `= 'running'`.
            .prepare(`SELECT run_id, skill, counts_json FROM graph_runs WHERE outcome IN ('running','parked')`)
            .all();
        if (!stale.length)
            return 0;
        db.prepare(`UPDATE graph_runs SET outcome = 'failed', ended_at = COALESCE(ended_at, ?), cancelled_by = 'interrupted' WHERE outcome IN ('running','parked')`).run(Date.now());
        for (const s of stale) {
            console.error(`[GraphRuns] run ${s.run_id} (${s.skill}) was interrupted mid-flight; ` +
                `branch states preserved: ${s.counts_json}`);
        }
        // A reconciled run is dead, so it holds no question. Without this the ask
        // outlives the process that asked it and stays answerable across reboots.
        for (const row of stale) {
            const id = row.run_id;
            if (id)
                clearAsk(id);
        }
        return stale.length;
    }
    catch (err) {
        console.error('[GraphRuns] reconcile failed:', err);
        return 0;
    }
}
/**
 * Park a run on a question. Idempotent: re-asking the same question (a menu
 * re-rendered after a reconnect) overwrites rather than accumulating, so a run
 * can never be waiting on two answers at once.
 */
export function recordAsk(runId, ask) {
    ensureGraphRunsTable();
    try {
        const db = getGatewayDb();
        // Park in the same breath as recording the question. Two writes that must
        // agree are a drift waiting to happen, and the only caller that records an
        // ask is the one presenting a menu — which IS the parking event.
        const current = (getRun(runId)?.outcome ?? 'running');
        const parked = {
            ...ask,
            parkedFrom: ask.parkedFrom ?? (current === 'parked' ? undefined : current),
        };
        db.prepare(`UPDATE graph_runs SET pending_ask_json = ?, outcome = 'parked' WHERE run_id = ?`)
            .run(JSON.stringify(parked), runId);
    }
    catch (err) {
        // Best effort by contract: a run that cannot record its question must still
        // ASK it. The web card is driven by the live event either way; what is lost
        // is answering from another surface, which is worth less than the run.
        console.error('[GraphRuns] recordAsk failed:', err);
    }
}
/** The question is answered (or the run ended). Clearing is what makes a stale
 *  ask impossible to answer twice. */
export function clearAsk(runId) {
    ensureGraphRunsTable();
    try {
        getGatewayDb().prepare(`UPDATE graph_runs SET pending_ask_json = NULL WHERE run_id = ?`).run(runId);
    }
    catch (err) {
        console.error('[GraphRuns] clearAsk failed:', err);
    }
}
/**
 * The question was answered: restore the outcome the run parked FROM and clear
 * the ask. Distinct from `clearAsk`, which is what a run's DEATH uses — a run
 * that died must not come back as `complete` merely because it happened to be
 * parked when the gateway went down.
 */
export function answerAsk(runId) {
    ensureGraphRunsTable();
    try {
        const restore = getPendingAskRaw(runId)?.parkedFrom;
        const db = getGatewayDb();
        if (restore) {
            db.prepare(`UPDATE graph_runs SET pending_ask_json = NULL, outcome = ? WHERE run_id = ?`)
                .run(restore, runId);
        }
        else {
            db.prepare(`UPDATE graph_runs SET pending_ask_json = NULL WHERE run_id = ?`).run(runId);
        }
    }
    catch (err) {
        console.error('[GraphRuns] answerAsk failed:', err);
    }
}
/** The stored ask WITHOUT the liveness check — only `answerAsk` needs this. */
function getPendingAskRaw(runId) {
    const row = getRun(runId);
    if (!row?.pending_ask_json)
        return null;
    try {
        return JSON.parse(row.pending_ask_json);
    }
    catch {
        return null;
    }
}
export function getPendingAsk(runId) {
    const row = getRun(runId);
    if (!row?.pending_ask_json)
        return null;
    // A run that is no longer running is not waiting for anybody, whatever the
    // column says. `finishRun` clears the ask, but a run that DIED never reaches
    // finishRun — it is reconciled to `failed` at the next boot, and nine such
    // rows were sitting in the live pending list, answerable, when this endpoint
    // first went up. Deciding from the outcome rather than from the leftover
    // column means a missed clear can never make a dead run look live.
    if (row.outcome !== 'running' && row.outcome !== 'parked')
        return null;
    try {
        return JSON.parse(row.pending_ask_json);
    }
    catch {
        return null;
    }
}
/** Every run currently parked on a question, newest first. */
export function listPendingAsks(limit = 20) {
    ensureGraphRunsTable();
    try {
        return getGatewayDb()
            .prepare(`SELECT * FROM graph_runs WHERE pending_ask_json IS NOT NULL
           AND outcome IN ('running','parked')
         ORDER BY started_at DESC LIMIT ?`)
            .all(limit);
    }
    catch {
        return [];
    }
}
/**
 * The run this conversation is currently executing, if any.
 *
 * Derived from the RECORD rather than carried in memory on purpose. The menu is
 * presented by a different layer than the one that opened the run, and threading
 * a run id through four call sites would have made the two disagree the first
 * time someone added a fifth. It also survives a gateway restart, which an
 * in-memory handle does not.
 *
 * A skill with no `together:` block never opens a run, so this returns undefined
 * and the caller simply does not announce a graph ask — the prose menu behaves
 * exactly as it did before.
 */
/**
 * The run a stopping point belongs to — the execution that just ended.
 *
 * `findLiveRunForConversation` is the wrong tool here and it took a live test to
 * see why: a run is CLOSED when its step list ends, and the menu is presented
 * after that, so at announce time there is no live run to find. Widening the
 * liveness check did not help either — the run cannot be parked until it is
 * found, and could not be found until it was parked.
 *
 * So this looks for the newest run in the conversation that is still open OR
 * ended moments ago. The window is what makes it safe: it can only match an
 * execution this conversation just performed, and a menu presented long after
 * one (or with no run at all) matches nothing and is announced as prose exactly
 * as it was before.
 */
const PARK_WINDOW_MS = 120_000;
/**
 * The invocation a run belongs to.
 *
 * A multi-phase skill writes one row PER PHASE — `runId` is local to
 * `executeSteps`, and each menu answer starts a new one. Left alone, a Runs list
 * shows four rows for one thing the user ran once.
 *
 * Decided 2026-08-25: rows stay phases and are GROUPED. The first phase is the
 * parent; later phases carry its id. No synthetic parent row, so nothing in the
 * list is a record of something that did not run, and no existing row changes
 * meaning.
 */
export function groupIdOf(row) {
    return row.parent_run_id || row.run_id;
}
/** The group a run belongs to, by id. Undefined when the run is unknown. */
export function groupIdForRun(runId) {
    const row = getRun(runId);
    return row ? groupIdOf(row) : undefined;
}
export function findRunToPark(conversationId) {
    ensureGraphRunsTable();
    try {
        return getGatewayDb()
            .prepare(`SELECT * FROM graph_runs
          WHERE conversation_id = ?
            AND (outcome IN ('running','parked') OR ended_at >= ?)
          ORDER BY started_at DESC LIMIT 1`)
            .get(conversationId, Date.now() - PARK_WINDOW_MS);
    }
    catch {
        return undefined;
    }
}
export function findLiveRunForConversation(conversationId) {
    ensureGraphRunsTable();
    try {
        return getGatewayDb()
            .prepare(`SELECT * FROM graph_runs WHERE conversation_id = ? AND outcome IN ('running','parked')
         ORDER BY started_at DESC LIMIT 1`)
            .get(conversationId);
    }
    catch {
        return undefined;
    }
}
export function getRun(runId) {
    ensureGraphRunsTable();
    try {
        return getGatewayDb().prepare(`SELECT * FROM graph_runs WHERE run_id = ?`).get(runId);
    }
    catch {
        return undefined;
    }
}
export function listRuns(skill, limit = 20) {
    ensureGraphRunsTable();
    try {
        const db = getGatewayDb();
        return (skill
            ? db
                .prepare(`SELECT * FROM graph_runs WHERE skill = ? ORDER BY started_at DESC LIMIT ?`)
                .all(skill, limit)
            : db.prepare(`SELECT * FROM graph_runs ORDER BY started_at DESC LIMIT ?`).all(limit));
    }
    catch {
        return [];
    }
}
/** One-line summary for the Skill Console header. Counts come from the row. */
export function summarizeRun(row) {
    let counts = {};
    try {
        counts = JSON.parse(row.counts_json || '{}');
    }
    catch {
        /* keep the summary honest rather than throwing */
    }
    const dur = row.ended_at ? `${Math.round((row.ended_at - row.started_at) / 100) / 10}s` : 'running';
    const ratio = counts.expected !== undefined ? `${counts.ok ?? 0}/${counts.expected}` : '—';
    return `${ratio} · ${row.outcome} · ${dur}`;
}
/**
 * Graph runs caused by one board task, newest first.
 *
 * item 14. Returns `[]` rather than throwing: the board drawer must open even
 * when this table is missing or unreadable, and "no graph ran" is the ordinary
 * answer for most cards.
 */
export function listRunsForBoardTask(taskId) {
    try {
        ensureGraphRunsTable();
        return getGatewayDb()
            .prepare(`SELECT run_id, skill, outcome, started_at, ended_at, counts_json, pending_ask_json, parent_run_id
           FROM graph_runs
          WHERE board_task_id = ?
          ORDER BY started_at DESC
          LIMIT 20`)
            .all(taskId);
    }
    catch (err) {
        console.error('[GraphRuns] listRunsForBoardTask failed:', err);
        return [];
    }
}
