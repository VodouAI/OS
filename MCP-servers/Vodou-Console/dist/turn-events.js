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
// P0d — THE SCHEMA LIVES IN `migrations/090_turn_events.sql` AND NOWHERE ELSE.
//
// This module used to carry a `CREATE TABLE` of its own, which was fine while
// the gateway owned the table and became a second definition of one schema the
// moment the engine took it over. Two definitions of one thing across a boundary
// is the disease this whole plan directory is about, so there is one: the
// migration. Tests execute that file rather than a copy of it — if the two ever
// disagreed, the tests would be grading a table the product does not have.
// ─── emit ───────────────────────────────────────────────────────────────────
/**
 * P0d — one turn's events, buffered until the turn ends.
 *
 * The batch boundary is the TURN. Not a count, not a timer: a batcher that
 * splits on anything else splits a turn across two flushes, and half a turn
 * cannot derive — a perfectly healthy turn would grade `unlogged` forever.
 */
const _buffers = new Map();
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
        const buf = _buffers.get(e.turnId) ?? { events: [], blobs: [] };
        // A turn has ONE end — held here as well as at the caller, because a log
        // that can record a turn ending twice cannot be trusted to say a turn ended
        // once. (The interleave that produced two was fixed at the caller: it read
        // a conversation-keyed map at completion time.)
        if (e.kind === 'turn/end' && buf.events.some((x) => x.kind === 'turn/end')) {
            console.error(`[turn-events] turn ${e.turnId.slice(0, 8)} already ended — ignoring a second turn/end`);
            return;
        }
        if (ref && payload !== null) {
            // by-reference: store the body once, keep only the pointer on the event
            buf.blobs.push({ ref, kind: e.lane ?? e.kind, chars: raw.length, payload, first_seen: nowUtc() });
            payload = null;
        }
        // An `inject` for a lane that already contributed THE SAME BYTES this turn
        // is a duplicate, not a second contribution. The CLI families assemble twice
        // per turn — once for the system prompt, once for the user prefix — and both
        // passes emit lane 6. `noteTurnLanes` already dedupes the RECEIPT that way
        // (last write wins); the events did not, so the derive placed the block
        // twice and the turn read `mismatch`: derived 44,964 vs recorded 43,768,
        // exactly one duplicated block apart.
        //
        // Keyed on lane AND content hash, not lane alone: `channel_envelope`
        // legitimately contributes TWO different pieces (the opening tag and the
        // rules block), and collapsing those would lose one.
        //
        // NOT for `userBody` pieces. Those are positional slices of one prompt, and a
        // conversation that says "ok" twice produces two pieces with the same lane and
        // the same bytes at different offsets. Collapsing them drops one, and the
        // derive then rebuilds a prompt shorter than the one that was sent — the log
        // inventing a gap that never existed. The double-assemble this guard exists
        // for happens on the system side, not here.
        const slotOf = (m) => m?.slot ?? 'injected';
        // The slots that are PLACED as a single block. For these, a lane contributes
        // once and the LAST write wins — the same rule P9 already applies to the
        // receipt, and for the same reason: the assembler runs more than once per
        // turn (system prompt, user prefix, cache hit) and the final pass is the one
        // that was sent.
        //
        // Hash equality is NOT the test. It was, and it let a real turn through: the
        // two `tool_results` passes produced 5,587 chars each with DIFFERENT bytes,
        // so both survived, both were placed, and the turn read `mismatch`. Same
        // shape as the historical b9a9e66f.
        //
        // Excluded: `userBody`, whose pieces are positional slices and may legitimately
        // repeat (a conversation that says "ok" twice); and `none`, which is recorded
        // but never placed — `channel_envelope` contributes two `none` pieces that
        // must both survive.
        const PLACED_ONCE = new Set(['staticPrefix', 'staticPrefixTail', 'injected', 'userPrefix']);
        const mySlot = slotOf(meta);
        if (e.kind === 'inject' && e.lane && PLACED_ONCE.has(mySlot)) {
            const dupAt = buf.events.findIndex((x) => {
                const ev = x;
                if (ev.kind !== 'inject' || ev.lane !== e.lane)
                    return false;
                try {
                    return slotOf(JSON.parse(String(ev.meta ?? '{}'))) === mySlot;
                }
                catch {
                    return false;
                }
            });
            if (dupAt >= 0)
                buf.events.splice(dupAt, 1);
        }
        buf.events.push({
            turn_id: e.turnId, conversation_id: e.conversationId, seq: nextSeq(e.turnId), at: nowUtc(),
            kind: e.kind, lane: e.lane ?? null,
            trust: e.trust ?? (e.lane ? _deps.trustOf(e.lane) ?? null : null),
            provider: e.provider ?? null, chars: e.chars ?? raw.length, ms: e.ms ?? null,
            content_hash: hash, payload, payload_ref: ref,
            meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
            source: e.source ?? 'gateway',
        });
        _buffers.set(e.turnId, buf);
        if (_buffers.size > 200) {
            const k = _buffers.keys().next().value;
            if (k && k !== e.turnId)
                _buffers.delete(k);
        }
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
    return deriveFromRows(rows, place);
}
/**
 * P0d — the derive, over rows from ANYWHERE.
 *
 * Split out because the verdict is computed at the turn boundary, when the
 * events are still in the gateway's buffer and have not reached the engine's
 * database yet. Same function either way: a second implementation for the
 * in-memory case is how the log would come to agree with itself and disagree
 * with the request.
 */
export function deriveFromRows(rows, place) {
    if (!rows.length)
        return null;
    let complete = true;
    const lanes = [];
    // `staticPrefixTail` is the scope / workbench / automation framing, which is
    // appended AFTER the assembled system prompt rather than joined into it — so
    // it is its own slot rather than a member of staticPrefix, whose parts join
    // with a separator it must not inherit.
    const bucket = { staticPrefix: [], staticPrefixTail: [], injected: [], userPrefix: [], userMessage: [] };
    // P0b — the user body is reassembled by OFFSET, not by arrival order: its
    // pieces are declared by seven different sites across two files, and the
    // order they are logged in is not the order they appear in the prompt.
    const userBody = [];
    for (const r of rows) {
        const kind = String(r.kind);
        if (kind !== 'inject' && kind !== 'user/message')
            continue;
        const rowMeta = JSON.parse(String(r.meta ?? '{}'));
        const slot = String(rowMeta.slot ?? 'injected');
        const text = (r.payload ?? r.blob_payload);
        // Slot check BEFORE the payload check. A `slot: none` row is RECORDED, not
        // PLACED — the brainloader row (which has no text of its own by design), the
        // bootstrap that already sits inside system_prompt, the child hook's
        // contribution. Its absence cannot make the request incomplete, because it
        // was never part of the request. Reading them in the other order made every
        // turn with a brainloader row grade `unknown` the moment that event started
        // firing.
        if (slot === 'none') {
            if (r.lane)
                lanes.push({ lane: String(r.lane), chars: Number(r.chars) || 0, trust: r.trust ?? undefined });
            continue;
        }
        if (text === null || text === undefined) {
            complete = false;
            continue;
        }
        // A REDACTED row stores something other than what was placed, so the turn
        // cannot be rebuilt byte-for-byte from it — only its hash can be compared.
        //
        // `guest` and `policy` withhold the payload entirely and are already caught
        // by the null check above. `leak_needle` is the case that slipped: it stores
        // the CLEANED text, which is shorter and non-null, so `complete` stayed true,
        // the rebuild came up short, and the difference was reported as `unlogged` —
        // "bytes from a site no lane accounts for". Those bytes were accounted for.
        // They were withheld on purpose, and counting them as a registry gap inflates
        // the exact number the census exists to mean. Observed on a real turn: 154
        // chars, none of them unlogged.
        //
        // Keyed on the PRESENCE of a reason, not on the three known values, so a
        // future redaction reason is honest by default rather than by remembering.
        if (rowMeta.redacted) {
            complete = false;
            continue;
        }
        if (kind === 'user/message') {
            bucket.userMessage.push(text);
            continue;
        }
        const lane = String(r.lane ?? '');
        lanes.push({ lane, chars: Number(r.chars) || 0, trust: r.trust ?? undefined });
        if (slot === 'userBody') {
            const offset = Number(rowMeta.offset ?? 0);
            userBody.push({ offset, text });
            continue;
        }
        (bucket[slot] ?? bucket.injected).push(text);
    }
    // Pieces are verbatim slices of the prompt, so they join with nothing between
    // them. Any byte BETWEEN two declared pieces is a gap — undeclared text that
    // reached the model — and it stays visible in `unloggedChars`.
    userBody.sort((a, b) => a.offset - b.offset);
    const text = place({
        staticPrefix: bucket.staticPrefix.join('\n\n'),
        staticPrefixTail: bucket.staticPrefixTail.join(''),
        injected: bucket.injected.join('\n\n'),
        userPrefix: bucket.userPrefix.join('\n\n'),
        userMessage: userBody.length ? userBody.map((u) => u.text).join('') : bucket.userMessage.join('\n\n'),
    });
    const hash = sha256(text);
    const reqRow = [...rows].reverse().find((r) => String(r.kind) === 'request');
    const recorded = reqRow
        ? { chars: Number(reqRow.chars) || 0, content_hash: String(reqRow.content_hash ?? '') }
        : undefined;
    // Only meaningful when the rebuild is COMPLETE. If a payload was withheld or
    // pruned, the rebuild is short by construction and the shortfall measures the
    // redaction, not a gap in the registry — reporting it as a census number says
    // "the model was told 73 characters nobody can name" about text that was
    // named and deliberately not kept.
    const unloggedChars = complete && recorded?.chars ? Math.max(0, recorded.chars - text.length) : 0;
    // Three outcomes, and the third is NOT "unlogged".
    //
    // `unlogged` means the request is LONGER than what the lanes account for —
    // bytes arrived from a site with no lane, which is the census number. If the
    // lengths agree and the hashes do not, nothing is missing: the same number of
    // bytes are DIFFERENT, which is a genuine disagreement between the log and
    // the request. Reporting that as "0 chars unlogged" was incoherent — it said
    // nothing is missing while refusing to say it matched — and a grader that
    // cannot tell "incomplete" from "wrong" is not one you can act on.
    // A fourth failure shape, and it needed its own name. When the rebuild is
    // LONGER than the request, `unloggedChars` clamps to 0 and the turn reported
    // `mismatch` — "the same length and different bytes" — about a reconstruction
    // 5,396 characters longer than what was sent. That is the grader lying about
    // its own evidence, which is worse than the defect it was describing.
    //
    // `overlogged` means the log claims text the model was never given: a lane
    // placed twice, or placed in a slot it did not travel in. Distinct from
    // `unlogged` (bytes with no lane) and from `mismatch` (right size, wrong
    // bytes), and it points at a different bug in each case.
    const overloggedChars = complete && recorded?.chars ? Math.max(0, text.length - recorded.chars) : 0;
    const verdict = !complete ? 'unknown'
        : recorded?.content_hash === hash ? 'match'
            : unloggedChars > 0 ? 'unlogged'
                : overloggedChars > 0 ? 'overlogged'
                    : 'mismatch';
    return { text, hash, complete, lanes, unloggedChars, overloggedChars, verdict };
}
/**
 * P0c — the injected block did not go where the assembler put it.
 *
 * With `VODOU_COMPAT_STABLE_PREFIX`, the OpenAI-compat path takes `asm.injected`
 * OUT of the system prompt and splices it back in as a late `system` message, so
 * the cacheable prefix stays byte-stable. The assembler has already logged those
 * lanes by then, with `slot: 'injected'` — the system section. Their bytes are
 * really in the user body, inside `api_late_context`.
 *
 * Left alone, the deriver places them twice and the turn reads `mismatch`: the
 * one verdict that means the log is lying rather than merely incomplete. Seen on
 * the first OpenAI-compat turn ever recorded.
 *
 * So they become `slot: 'none'` — named and inspectable, never placed a second
 * time. Exactly the treatment §25.1 gave the three inline lanes, and the same
 * reason: placing a piece twice derives a request nobody sent.
 *
 * Buffer-only by construction; the turn has not flushed yet when this is called.
 */
export function markInjectedRelocated(turnId, intoLane, slots = ['injected']) {
    const buf = _buffers.get(turnId);
    if (!buf)
        return;
    const want = new Set(slots);
    for (const ev of buf.events) {
        if (ev.kind !== 'inject')
            continue;
        let m;
        try {
            m = JSON.parse(String(ev.meta ?? '{}'));
        }
        catch {
            continue;
        }
        if (!want.has(String(m.slot ?? 'injected')))
            continue;
        m.slot = 'none';
        m.relocated_into = intoLane;
        ev.meta = JSON.stringify(m);
    }
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
/**
 * P0 — tool events, emitted from the trajectory accumulator.
 *
 * That accumulator is already the single sink every provider funnels through
 * (`executor.ts` for the API families, the claude-cli and kimi-cli stream
 * parsers), which is exactly why the tool events belong there and not at four
 * call sites. It resolves the turn id through `EmitDeps` rather than importing
 * `llm.ts`, which would be a cycle.
 *
 * Arguments are recorded as a **salted digest, never the text** — the same rule
 * `mcp_audit.rs` follows. A tool's arguments routinely carry the user's data,
 * and the log is not the place to make a second copy of it.
 */
export function emitToolEvent(conversationId, kind, tool, detail) {
    if (!_deps?.turnIdFor)
        return;
    const turnId = _deps.turnIdFor(conversationId);
    if (!turnId)
        return;
    const argsDigest = detail.args === undefined
        ? undefined
        : sha256('vodou-tool-args:' + JSON.stringify(detail.args)).slice(0, 16);
    emitTurnEvent({
        turnId, conversationId, kind,
        ms: detail.ms,
        // A tool RESULT is model-visible text and is logged like any other; a tool
        // CALL is not — only what was invoked, and a digest of with-what.
        ...(kind === 'tool/result' && detail.result !== undefined ? { payload: detail.result } : {}),
        meta: {
            tool, ...(detail.server ? { server: detail.server } : {}),
            ...(argsDigest ? { args_digest: argsDigest } : {}),
            ...(detail.ok !== undefined ? { ok: detail.ok } : {}),
            ...(detail.world ? { world: detail.world } : {}),
            slot: 'none', // recorded, not placed — a tool result reaches the model
            // through the tool_results lane, which logs its own bytes
        },
    });
}
/**
 * P0d — send this turn's events to the engine, once, at the turn boundary.
 *
 * Failure behaviour is deliberate and is the part worth reading. If the daemon
 * cannot take the batch we retry ONCE and then **drop it with a loud line naming
 * the turn**. We do not spool to disk: this table is telemetry-shaped (Lane
 * canon rule 5 — ephemeral output is not a fact), and a durability mechanism for
 * telemetry is a disk-fill bug with a good excuse. And a turn taken while the
 * daemon is down is *already* degraded — memory comes over that same socket — so
 * an absent log is consistent with the turn it describes. What is not acceptable
 * is losing it quietly: `flows` Flow 12 must read `unknown` for that turn, never
 * `ok`.
 */
export async function flushTurnEvents(turnId) {
    const buf = _buffers.get(turnId);
    _buffers.delete(turnId);
    if (!buf || !buf.events.length)
        return true;
    if (!_deps?.flush)
        return false;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (await _deps.flush({ events: buf.events, blobs: buf.blobs }))
                return true;
        }
        catch { /* fall through to the retry, then to the loud drop */ }
    }
    console.error(`[turn-events] DROPPED turn ${turnId} — ${buf.events.length} events could not reach the daemon. ` +
        `This turn will read as unmeasured, not as ok.`);
    return false;
}
/**
 * The buffered events for a turn, so the verdict can be computed before the
 * batch is sent — the derive needs the whole turn, and the whole turn is here.
 *
 * Refs are RESOLVED against the buffered blobs on the way out. By-reference
 * storage moves a payload off the event and into the blob list, so a raw buffer
 * view shows the bootstrap and memory lanes with no text — and the derive, quite
 * correctly, calls that incomplete and grades the turn `unknown`. Every turn
 * read `unknown` until this joined them back, which is the in-memory mirror of
 * the LEFT JOIN the database view does.
 */
export function bufferedEvents(turnId) {
    const buf = _buffers.get(turnId);
    if (!buf)
        return [];
    const byRef = new Map();
    for (const b of buf.blobs)
        byRef.set(b.ref, b.payload);
    return buf.events.map((e) => {
        const ev = e;
        const ref = ev.payload_ref;
        return ref && ev.payload == null ? { ...ev, blob_payload: byRef.get(ref) ?? null } : ev;
    });
}
