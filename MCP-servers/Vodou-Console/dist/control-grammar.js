/**
 * PLAN-CONTROL-GRAMMAR P0 + P1b — the words for how much rope Vodou has, and
 * what Enter does while it is already working.
 *
 * ONE MODULE OWNS THE SPELLING. The plan's own finding is that Vodou has three
 * genuinely different autonomy behaviours and no names for them, so people
 * reach for whichever one they happen to know. Console help, channel help and
 * the docs page all read from here, and `control-grammar.test.ts` fails if a
 * surface hardcodes the strings instead — the same shape as the lane registry,
 * for the same reason: two places spelling one word is how they drift.
 *
 * Scope note: this module names things and decides busy policy. It does not
 * own the heartbeat briefing, the graph cycle, or the proactive-loop contract.
 * Those are sibling plans and saying so here keeps the boundary honest.
 */
/** The three autonomy modes. Ordered least to most autonomous. */
export const MODES = [
    {
        id: 'schedule',
        name: 'Schedule',
        /** One line, for a help list. No jargon, no internal nouns. */
        blurb: 'Run this on the clock. Every tick is a fresh run.',
        /** The question a person is actually asking when they want this. */
        when: 'I want this to happen at 9am whether or not I am here.',
        ends: 'when you delete the job',
        where: 'Activity › Scheduled',
    },
    {
        id: 'watch',
        name: 'Watch',
        blurb: 'Keep an eye on something in this conversation and tell me when it changes.',
        when: 'I want to know when the build goes green, while we carry on talking.',
        ends: 'at a cap, on evidence, or when you clear it',
        where: 'the conversation you start it in',
    },
    {
        id: 'keep-going',
        name: 'Keep going',
        blurb: 'Work towards a goal, deciding after each turn whether it is done.',
        when: 'I want this finished, not one step of it attempted.',
        ends: 'done, blocked, out of budget, parked, or you say stop',
        where: 'a Board card',
    },
];
/**
 * The contention verbs — what you can do to a turn that is already running.
 *
 * These are the missing half. Today the only options are wait for it or open
 * another chat, which is why people open another chat.
 */
export const VERBS = [
    {
        id: 'side-ask',
        name: 'Side ask',
        blurb: 'Ask about this conversation without interrupting it. The answer comes back beside the thread, not in it.',
        when: 'What did we decide about the retry limit? — asked mid-task.',
    },
    {
        id: 'background',
        name: 'Background',
        blurb: 'Send independent work off on its own, with a fresh context.',
        when: 'Go research this separately while we finish here.',
    },
    {
        id: 'steer',
        name: 'Steer',
        blurb: 'Nudge the turn that is running. It lands after the next tool result, without restarting anything.',
        when: 'Actually, use the staging database.',
    },
];
// ── Busy policy (P1b) ──────────────────────────────────────────────────────
/** What Enter does while a turn is already in flight. */
export const BUSY_POLICIES = ['queue', 'interrupt', 'steer'];
/** Today's behaviour, and the default, because changing it silently would be worse. */
export const DEFAULT_BUSY_POLICY = 'queue';
export const BUSY_POLICY_LABELS = {
    queue: 'Queue — your message waits its turn',
    interrupt: 'Interrupt — stop what is running and take this instead',
    steer: 'Steer — nudge the running turn without restarting it',
};
export function isBusyPolicy(v) {
    return typeof v === 'string' && BUSY_POLICIES.includes(v);
}
/**
 * What a stored policy actually DOES right now.
 *
 * `steer` is accepted and stored but not yet implemented (P1c), so it resolves
 * to `queue` and says so. The plan is explicit about this: "fall back to queue
 * and say so in the UI (no silent lie)". A setting that claims a behaviour it
 * does not have is worse than not offering it, because the person stops
 * watching for the thing that never happens.
 */
export function resolveBusyPolicy(stored, steerImplemented = false) {
    const requested = isBusyPolicy(stored) ? stored : DEFAULT_BUSY_POLICY;
    if (requested === 'steer' && !steerImplemented) {
        return {
            effective: 'queue',
            requested,
            note: 'Steer is not wired yet, so this message will queue. You will see it go in when the current turn finishes.',
        };
    }
    if (requested === 'steer')
        return { effective: 'queue', requested, note: null };
    return { effective: requested, requested, note: null };
}
// ── Rendering, so every surface says the same sentence ─────────────────────
/** The help block, as plain lines. The Console, the channels and the docs all use this. */
export function helpLines() {
    const out = ['How much rope:'];
    for (const m of MODES)
        out.push(`  ${m.name} — ${m.blurb}`);
    out.push('', 'While something is running:');
    for (const v of VERBS)
        out.push(`  ${v.name} — ${v.blurb}`);
    return out;
}
/**
 * The one distinction people get wrong, answered in one sentence.
 *
 * P0's gate is that a stranger can answer "what is the difference between
 * Watch and Schedule?" from the Console. This is that answer, and it is a
 * function rather than three copies of a sentence.
 */
export function watchVsSchedule() {
    return 'Watch lives in one conversation and stops on its own; Schedule runs forever on a clock and starts fresh every time.';
}
export function modeById(id) {
    return MODES.find((m) => m.id === id) ?? null;
}
export function verbById(id) {
    return VERBS.find((v) => v.id === id) ?? null;
}
