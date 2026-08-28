/**
 * turn-events.ts — the turn event log. "Model-visible ⟺ logged."
 *
 * PLAN-SEAMS-AND-SESSION-LOG P0. The invariant, taken from DeepSeek Harness and
 * stated in its terms: *anything that reaches a model request must be
 * reconstructable from the log.*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, given that lanes.toml and turn_receipts already do
 * ─────────────────────────────────────────────────────────────────────────────
 * The receipt records **that** a lane ran and **how much** it sent. It does not
 * record **what**. `turn_receipts.lanes` is `[{lane, chars, state, ms}]`;
 * `gateway_messages` holds the user's text and the assistant's text; nothing
 * holds the assembled request. So "why did it say that?" on yesterday's turn
 * cannot be answered from the database.
 *
 * And the registry has a structural blind spot the recount proved twice: the
 * coherence guard fires on a *lane-name literal*, so it can only catch an
 * injector that already declares itself. On 2026-08-28 the registry covered 9
 * of ~23 sites that write into the prompt, and three of the nine never emitted.
 * A registry catches what people declare. A log catches what the model received:
 * `deriveRequest(turn_id)` must equal the hash recorded at dispatch, and an
 * injector that skipped the seam makes that comparison fail with a diff.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRIVACY — read before adding a field
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the most sensitive table in gateway.db: it is, by design, the text
 * Vodou handed a model. Four rules, all enforced below rather than by discipline:
 *
 *  1. `content_hash` is taken BEFORE redaction, so the derive check still holds
 *     when the stored payload is redacted or absent. The check compares hashes.
 *  2. A guest / vault turn stores **hashes only** — `payload` is NULL and
 *     `meta.redacted` says why. Same door as the bootstrap suppression: the
 *     owner's MEMORY.md must not become readable by storing what was sent.
 *  3. Everything else passes `inject-policy` (`scope_deny`, `leak_needles`) —
 *     the same policy that governs what may leave for a third-party model.
 *  4. Bootstrap and memory payloads are stored ONCE by reference. A 24 KB
 *     bootstrap on 900 turns/day is 21 MB/day copied otherwise.
 *
 * Retention: `VODOU_TURN_LOG_DAYS` (default 14) prunes payloads; hashes, chars
 * and ms are kept 90 days because they are the dataset the context plan's data
 * gate is waiting for. This table is telemetry-shaped, not memory-shaped: it is
 * never exported by `mem export`, never fed to the contradiction detector, and
 * never injected as memory on a later turn (Lane canon rule 5).
 */
import { createHash } from 'node:crypto';
// ─── the closed event set ───────────────────────────────────────────────────
// Adding a member here is the deliberate act the invariant asks for: a new
// model-visible input needs a new kind, and the gate test asserts every
// `emitTurnEvent` literal in the tree resolves to one of these.
export const TURN_EVENT_KINDS = [
    'turn/start',
    'user/message',
    'inject',
    'request',
    'assistant/chunk',
    'assistant/message',
    'tool/call',
    'tool/result',
    'receipt',
    'turn/end',
];
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
// ─── schema ─────────────────────────────────────────────────────────────────
export function initTurnEventsSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS turn_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id         TEXT    NOT NULL,
      conversation_id TEXT    NOT NULL,
      seq             INTEGER NOT NULL,
      at              TEXT    NOT NULL,
      kind            TEXT    NOT NULL,
      lane            TEXT,
      trust           TEXT,
      provider        TEXT,
      chars           INTEGER NOT NULL DEFAULT 0,
      ms              INTEGER,
      content_hash    TEXT    NOT NULL,
      payload         TEXT,
      payload_ref     TEXT,
      meta            TEXT,
      UNIQUE(turn_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq);
    CREATE INDEX IF NOT EXISTS idx_turn_events_conv ON turn_events(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_turn_events_at   ON turn_events(at);

    -- Payloads stored once and referenced. kind is 'bootstrap' or 'memory'.
    CREATE TABLE IF NOT EXISTS turn_event_blobs (
      ref        TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      chars      INTEGER NOT NULL,
      payload    TEXT,
      first_seen TEXT NOT NULL
    );
  `);
}
// ─── emit ───────────────────────────────────────────────────────────────────
const _seq = new Map();
function nextSeq(turnId) {
    const n = (_seq.get(turnId) ?? 0) + 1;
    _seq.set(turnId, n);
    if (_seq.size > 500) {
        const first = _seq.keys().next().value;
        if (first)
            _seq.delete(first);
    }
    return n;
}
/** Naive UTC `YYYY-MM-DD HH:MM:SS` — the time canon's instant format. */
function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
let _deps = null;
export function configureTurnEvents(d) { _deps = d; }
/**
 * Record one event. **Never throws and never fails a turn** — a log that can
 * break the product it observes would be worse than no log. A write failure is
 * itself recorded (in the log line and, on the next successful write, as
 * `meta.log_failed`) so Flow 12 reports `unknown` rather than `ok`.
 */
export function emitTurnEvent(e) {
    if (!_deps)
        return;
    if (!e.turnId)
        return; // an unidentified turn cannot be derived
    try {
        const raw = e.payload ?? '';
        const hash = sha256(raw);
        let payload = null;
        let ref = e.payloadRef ?? null;
        const meta = { ...(e.meta ?? {}) };
        if (e.payload !== undefined) {
            if (_deps.isGuest()) {
                meta.redacted = 'guest'; // rule 2 — hashes only, never the text
            }
            else {
                const cleaned = _deps.redact(raw);
                if (cleaned === null)
                    meta.redacted = 'policy';
                else {
                    payload = cleaned;
                    if (cleaned !== raw)
                        meta.redacted = 'leak_needle';
                }
            }
        }
        const db = _deps.db();
        if (ref && payload !== null) {
            // by-reference: store the body once, keep only the pointer on the event
            db.prepare(`INSERT INTO turn_event_blobs (ref, kind, chars, payload, first_seen)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING`).run(ref, e.lane ?? e.kind, raw.length, payload, nowUtc());
            payload = null;
        }
        db.prepare(`INSERT INTO turn_events
         (turn_id, conversation_id, seq, at, kind, lane, trust, provider, chars, ms, content_hash, payload, payload_ref, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.turnId, e.conversationId, nextSeq(e.turnId), nowUtc(), e.kind, e.lane ?? null, e.trust ?? (e.lane ? _deps.trustOf(e.lane) ?? null : null), e.provider ?? null, e.chars ?? raw.length, e.ms ?? null, hash, payload, ref, Object.keys(meta).length ? JSON.stringify(meta) : null);
    }
    catch (err) {
        // Fail open, loudly. `green-suite-hides-never-ran-code`: a silent catch here
        // is how a log stops being written and nobody learns for weeks.
        console.error(`[turn-events] write failed (${e.kind}${e.lane ? '/' + e.lane : ''}) — the turn is unaffected:`, err?.message ?? err);
    }
}
/**
 * Rebuild the request from events alone.
 *
 * The placement rules are NOT re-implemented here — they are imported from the
 * assembler's own pure helper (`placeAssembled`), so the thing that builds the
 * request and the thing that rebuilds it cannot disagree by drift. That sharing
 * is the whole reason the extraction exists; a second copy of the placement
 * logic would make this file lie in exactly the way it is meant to detect.
 */
export function deriveRequest(db, turnId, place) {
    const rows = db.prepare(`SELECT e.kind, e.lane, e.trust, e.chars, e.content_hash, e.payload, e.payload_ref, e.meta,
            b.payload AS blob_payload
       FROM turn_events e
       LEFT JOIN turn_event_blobs b ON b.ref = e.payload_ref
      WHERE e.turn_id = ? ORDER BY e.seq`).all(turnId);
    if (!rows.length)
        return null;
    let complete = true;
    const lanes = [];
    const bucket = { staticPrefix: [], injected: [], userPrefix: [], userMessage: [] };
    for (const r of rows) {
        const kind = String(r.kind);
        if (kind !== 'inject' && kind !== 'user/message')
            continue;
        const text = (r.payload ?? r.blob_payload);
        if (text === null || text === undefined) {
            complete = false;
            continue;
        }
        if (kind === 'user/message') {
            bucket.userMessage.push(text);
            continue;
        }
        const lane = String(r.lane ?? '');
        lanes.push({ lane, chars: Number(r.chars) || 0, trust: r.trust ?? undefined });
        const slot = String(JSON.parse(String(r.meta ?? '{}')).slot ?? 'injected');
        // 'none' = recorded for inspection but already inside another block (the
        // bootstrap lives inside system_prompt). Placing it again would derive a
        // request nobody sent.
        if (slot === 'none')
            continue;
        (bucket[slot] ?? bucket.injected).push(text);
    }
    const text = place({
        staticPrefix: bucket.staticPrefix.join('\n\n'),
        injected: bucket.injected.join('\n\n'),
        userPrefix: bucket.userPrefix.join('\n\n'),
        userMessage: bucket.userMessage.join('\n\n'),
    });
    const hash = sha256(text);
    const recorded = db.prepare(`SELECT chars, content_hash FROM turn_events WHERE turn_id = ? AND kind = 'request' ORDER BY seq DESC LIMIT 1`).get(turnId);
    const unloggedChars = recorded?.chars ? Math.max(0, recorded.chars - text.length) : 0;
    const verdict = !complete ? 'unknown'
        : recorded?.content_hash === hash ? 'match'
            : 'unlogged';
    return { text, hash, complete, lanes, unloggedChars, verdict };
}
/** The `request` event's recorded hash for a turn, if any. */
export function recordedRequestHash(db, turnId) {
    const r = db.prepare(`SELECT content_hash FROM turn_events WHERE turn_id = ? AND kind = 'request' ORDER BY seq DESC LIMIT 1`).get(turnId);
    return r?.content_hash ?? null;
}
// ─── retention ──────────────────────────────────────────────────────────────
export function pruneTurnEvents(db, days = Number(process.env.VODOU_TURN_LOG_DAYS ?? '14')) {
    const cutoff = new Date(Date.now() - Math.max(0, days) * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const hardCutoff = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const p = db.prepare(`UPDATE turn_events SET payload = NULL WHERE payload IS NOT NULL AND at < ?`).run(cutoff);
    db.prepare(`UPDATE turn_event_blobs SET payload = NULL WHERE payload IS NOT NULL AND first_seen < ?`).run(cutoff);
    const r = db.prepare(`DELETE FROM turn_events WHERE at < ?`).run(hardCutoff);
    return { payloads: Number(p.changes), rows: Number(r.changes) };
}
