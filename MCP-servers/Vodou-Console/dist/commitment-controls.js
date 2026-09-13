/**
 * PLAN-COMMITMENTS-LANE P2 — `done` / `snooze <when>` / `drop` on the channel.
 *
 * A commitment reminder is pushed to whichever channel the owner is actually
 * reachable on. The person answers it there, in one word, the way they would
 * answer a person. This module is the only place that turns such a word into an
 * action, and it does so through the daemon (`open_loops`), never by opening
 * vodou-core.db from here — the engine owns that file (lane canon rule 4).
 *
 * Two rules keep this from eating real messages:
 *
 *  1. **A control word only counts when a reminder is actually waiting.** The
 *     daemon answers `awaiting` from the DELIVERY ledger — a loop whose reminder
 *     landed on this platform, is still open, and is inside the window. A bare
 *     "done" in a chat that has had no reminder matches nothing and falls
 *     through to the LLM as an ordinary message.
 *  2. **Only a bare control word counts.** "done" is a control; "done with the
 *     migration, what's next?" is a sentence about work. The grammar is
 *     deliberately tiny, and anything longer is a message.
 */
import { daemonRequest } from './daemon-client.js';
/** Words that mean "it is finished" / "stop asking", as a person types them. */
const DONE_WORDS = ['done', 'did it', 'did that', 'finished', 'complete', 'completed', 'sent', '✅'];
const DROP_WORDS = ['drop', 'cancel it', 'forget it', 'nevermind', 'never mind', 'not doing it'];
/**
 * Parse a reply into a control, or null when it is an ordinary message.
 *
 * Length is the guard that matters: a control is one or two words, optionally
 * with a leading slash. Anything with a clause in it is someone talking.
 */
export function parseLoopControl(raw) {
    const text = String(raw ?? '').trim().replace(/^\/+/, '').trim();
    if (!text || text.length > 40)
        return null;
    const lower = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (DONE_WORDS.includes(lower))
        return { action: 'done', when: '' };
    if (DROP_WORDS.includes(lower))
        return { action: 'drop', when: '' };
    if (lower === 'snooze' || lower === 'later' || lower === 'remind me later') {
        return { action: 'snooze', when: '' };
    }
    const m = lower.match(/^(?:snooze|remind me)\s+(?:in\s+|until\s+|on\s+)?(.{1,24})$/);
    if (m)
        return { action: 'snooze', when: m[1].trim() };
    return null;
}
/** The platform an inbound /chat call came from, or '' when it is not a channel. */
export function platformOf(source, conversationId) {
    const s = String(source ?? '').trim().toLowerCase();
    const known = ['telegram', 'discord', 'whatsapp', 'imessage', 'teams', 'googlechat', 'signal', 'slack'];
    if (known.includes(s))
        return s;
    const m = String(conversationId ?? '').match(/^workbench:channel:([a-z]+)/i);
    return m && known.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : '';
}
/**
 * Try to handle one inbound channel message as a loop control.
 *
 * Returns null whenever this is NOT a control for a waiting reminder — which is
 * the common case, and the caller then proceeds with the ordinary turn. Never
 * throws: a daemon that is down must not swallow a person's message.
 */
export async function tryLoopControl(text, source, conversationId) {
    const control = parseLoopControl(text);
    if (!control)
        return null;
    const platform = platformOf(source, conversationId);
    if (!platform)
        return null;
    try {
        // `DaemonResult.data` is `unknown` by design — the socket answers many ops.
        // Narrow it here, where the shape of THIS op's answer is known.
        const waiting = await daemonRequest('open_loops', { action: 'awaiting', platform, within_hours: 72 }, 4_000);
        const loop = waiting?.ok ? waiting.data?.loop : null;
        const loopId = typeof loop?.id === 'number' ? loop.id : 0;
        if (!loopId)
            return null; // nothing waiting → this was just a message
        const applied = await daemonRequest('open_loops', { action: control.action, id: loopId, when: control.when, by: `reply:${platform}` }, 5_000);
        if (!applied?.ok) {
            // A refusal is still an answer: "I don't know when 'blorp' is" belongs in
            // front of the person, not in a log they will never read.
            const why = String(applied?.reason ?? 'could not apply that').replace(/^[a-z_]+: /, '');
            return { reply: why, loopId, action: control.action };
        }
        const msg = applied.data?.message;
        return { reply: String(msg ?? 'Done.'), loopId, action: control.action };
    }
    catch {
        return null; // daemon down: treat it as an ordinary message
    }
}
