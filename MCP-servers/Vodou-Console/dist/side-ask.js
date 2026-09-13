/**
 * PLAN-CONTROL-GRAMMAR P1a — ask about this conversation without interrupting
 * it.
 *
 * The problem, stated by the plan: mid-turn the only options are to queue
 * behind the running turn or open another chat. So people open another chat,
 * and the question that was about THIS thread gets asked somewhere that cannot
 * see it.
 *
 * THE LOAD-BEARING RULE, and the plan says so explicitly: a side ask must not
 * enter the transcript as a user turn. If it did, the next real turn would
 * inherit it as history, the model would answer a question that was already
 * answered, and — worse — the person would have silently changed the thing they
 * were only asking about. The plan's own risk note reads "Side ask that
 * silently writes into history → teaches the wrong lesson", and its first gate
 * is that the transcript has no extra user row afterwards.
 *
 * v1 has NO TOOLS, by decision (Chad, 2026-09-10). A read-only snapshot of the
 * conversation and nothing else. "Read-only" is a claim a tool makes about
 * itself rather than something enforced, which is not a foundation to build a
 * side channel on.
 */
import { loadMessages } from './conversation-store.js';
/** How much transcript a side ask may see. Enough for "what did we decide", not a dump. */
export const SNAPSHOT_TURNS = 20;
export const SNAPSHOT_CHARS = 12_000;
/** A side ask is a question, not a brief. */
export const MAX_PROMPT_CHARS = 2_000;
export function validate(conversationId, prompt) {
    const id = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!id)
        return { ok: false, reason: 'no-conversation' };
    const p = typeof prompt === 'string' ? prompt.trim() : '';
    if (!p)
        return { ok: false, reason: 'empty-prompt' };
    return { ok: true, conversationId: id, prompt: p.slice(0, MAX_PROMPT_CHARS) };
}
/**
 * A read-only view of the last few turns, newest kept.
 *
 * Trimmed from the FRONT when it is too long: the recent end of a conversation
 * is what a mid-task question is about. Dropping the newest turns to fit would
 * remove exactly the context the question needs.
 */
export function snapshot(conversationId, opts) {
    const turns = opts?.turns ?? SNAPSHOT_TURNS;
    const chars = opts?.chars ?? SNAPSHOT_CHARS;
    let rows;
    try {
        rows = loadMessages(conversationId);
    }
    catch {
        return '';
    }
    const recent = rows.slice(-turns);
    const lines = recent.map((m) => `${m.role === 'assistant' ? 'Vodou' : 'You'}: ${m.content}`);
    let out = lines.join('\n\n');
    while (out.length > chars && lines.length > 1) {
        lines.shift();
        out = lines.join('\n\n');
    }
    return out.length > chars ? out.slice(out.length - chars) : out;
}
/**
 * The one-shot prompt.
 *
 * It says plainly that this is a question about a conversation, not a turn in
 * it, so the model does not answer as though it had been asked in the thread
 * and start proposing next steps.
 */
export function buildPrompt(transcript, question) {
    return [
        'You are answering a side question about a conversation that is still going.',
        'You are NOT taking part in it. Do not propose next steps, do not address the',
        'other participant, and do not act. Answer the question from the transcript',
        'below, and say plainly if the transcript does not contain the answer.',
        '',
        '--- transcript ---',
        transcript || '(this conversation has no messages yet)',
        '--- end transcript ---',
        '',
        `Question: ${question}`,
    ].join('\n');
}
