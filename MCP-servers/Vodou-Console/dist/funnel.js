/**
 * Activation funnel — first-occurrence milestones for THIS install.
 *
 * PLAN-EXECUTION-SHELF-FUNNEL §5. Vodou had no activation instrumentation at all,
 * which is the one gap that cannot be filled retroactively: every install that
 * happens before this ships is a measurement nobody can ever recover. The launch
 * question — "of the people who install, how many reach the moment the product is
 * actually about?" — is unanswerable without it.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not analytics, not telemetry, not a beacon. Nothing here leaves the machine.
 * It is nine timestamps in the local gateway_settings table, readable by the owner
 * and by nobody else, following the same posture as the capture kill switch
 * (`credentials:'omit'`, no install id, not a beacon) and the MCP audit log (salted
 * digests, never argument text). If a funnel ever needs to be reported anywhere, it
 * must be an explicit opt-in that ships aggregate counts — never this table verbatim,
 * and never per-event.
 *
 * WHY FIRST-OCCURRENCE, NOT AN EVENT STREAM
 * -----------------------------------------
 * A funnel asks "did this install ever reach step N, and when" — not "how many times".
 * Storing only the first timestamp makes the whole thing nine rows instead of an
 * unbounded log, makes every write idempotent (so the call sites can be dumb and
 * fire-and-forget), and removes any question of what to prune. Counting repeats is a
 * usage question, and `gateway_usage` already owns that.
 *
 * ORDER IS NOT ENFORCED. A user can reach `first_inject` without `pair` if pairing is
 * off, and `first_backfill` without `first_capture` if their first act is opening an
 * old thread. Recording what happened beats recording what the funnel diagram
 * expected — a step that arrives "out of order" is a finding, not a bug to normalise
 * away.
 */
import { getSetting, setSetting } from './db.js';
/** The nine milestones, in the order the tour presents them. */
export const FUNNEL_STEPS = [
    'install', // gateway ran for the first time
    'pair', // the browser extension completed the bridge handshake
    'first_capture', // a web turn was actually WRITTEN (not merely relayed)
    'first_backfill', // pre-install history was read for the first time
    'first_inject', // memory reached a third-party composer
    'first_receipt', // a turn reported doing something (memories/tools/skills)
    'first_skill', // a skill ran
    'first_automation', // an automation fired
    'pro', // upgraded
];
const KEY = (step) => `funnel.${step}`;
/**
 * Record a milestone the first time it happens. Idempotent and fire-and-forget:
 * call sites are hot paths (capture writes, inject responses) and must never take a
 * throw or a measurable cost from instrumentation. A funnel that can break the
 * product it measures is worse than no funnel.
 */
export function markFunnel(step) {
    try {
        const key = KEY(step);
        if (getSetting(key))
            return; // already reached — keep the FIRST time
        setSetting(key, new Date().toISOString());
        console.error(`[funnel] ${step} — first time on this install`);
    }
    catch { /* never let instrumentation break a hot path */ }
}
/** Every milestone with its first-occurrence timestamp, or null if never reached. */
export function getFunnel() {
    const out = {};
    for (const step of FUNNEL_STEPS) {
        try {
            out[step] = getSetting(KEY(step));
        }
        catch {
            out[step] = null;
        }
    }
    return out;
}
/**
 * The funnel as the two numbers worth arguing about, plus the raw timestamps.
 *
 *   activation — installs that reached `first_inject`: the product's actual moment,
 *                "my context followed me to another AI".
 *   execution  — of those, the ones that reached a receipt / skill / automation:
 *                the memory-PLUS-EXECUTION claim, which is the positioning. If this
 *                stays near zero, the pitch is wrong or the execution shelf is buried.
 *
 * Single-install here by construction (this is a local-first product), so these read
 * as booleans; they exist so the console can render one honest line instead of nine
 * timestamps, and so any future aggregate reporting has ONE definition to use.
 */
export function getFunnelSummary() {
    const steps = getFunnel();
    const reached = FUNNEL_STEPS.filter((s) => !!steps[s]);
    return {
        steps,
        reached,
        activated: !!steps.first_inject,
        executed: !!(steps.first_receipt || steps.first_skill || steps.first_automation),
    };
}
