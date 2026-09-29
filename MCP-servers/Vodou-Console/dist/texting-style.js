/**
 * T1 of PLAN-TEXTING-FEEL-AND-ERRANDS: answers in the texting thread read like
 * texts. Chad, 2026-09-26: "Answers from your Mac written like texts (short,
 * answer first, no headers or lists) ... make sure T1 and T2 work in simple
 * chat as well."
 *
 * The thread is ONE conversation, `workbench:channel:relay`: texts from the
 * phone land in it, and /simple on the computer is the same thread. So the
 * style is keyed on the conversation, not on where the turn came from — a
 * question typed in /simple gets the same texting-shaped answer, and the
 * phone's mirror of it reads right too.
 *
 * Registered as the `texting_style` lane in lanes.toml (lane canon rule 3).
 */
/** The texting thread: phone texts + /simple. */
export const TEXTING_THREAD = 'workbench:channel:relay';
export const TEXTING_STYLE_TEXT = '\n\n<instruction>Texting style — this conversation is a text thread (their phone, and the same chat on their computer). ' +
    'Answer first, in plain words. Write 1 to 3 short paragraphs of one to three sentences, with a blank line between them (each becomes its own bubble). ' +
    'No headers, tables, bold or bullet lists; if they ask for steps or a list, keep it to at most 5 short lines. ' +
    'Aim for under about 400 characters unless they asked for detail, and offer "want the details?" instead of dumping them. ' +
    'Ask at most one question. Don\'t narrate what you are doing ("Checking…", "Great question"). ' +
    'You CAN text them pictures: to send a screenshot or image file, write its full file path in your answer and it arrives as a picture.</instruction>';
/** The rider for this turn, or '' — only in the texting thread, never on a menu reply or a guest turn. */
export function textingStyleRider(conversationId, skip) {
    return !skip && conversationId === TEXTING_THREAD ? TEXTING_STYLE_TEXT : '';
}
