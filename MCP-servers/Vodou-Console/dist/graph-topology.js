/**
 * PLAN-GRAPH-FRONTEND item 16 — the shape classifier.
 *
 * Compiled actions in, one word out: is this skill a `chain`, a `fan`, a
 * `fan+check`, or a `cycle`? The catalog draws a glyph from it (item 17) and the
 * Automations list captions a row with it (item 15).
 *
 * **Naming.** This is TOPOLOGY — the shape of a compiled *plan*. It is NOT
 * `src/graph_shape.rs`, which asks whether a SENTENCE describes a workflow at
 * all (intent detection, before anything is compiled). Two different questions;
 * the file names are deliberately different so a grep tells them apart.
 *
 * **Why it reads through `collectSteps`.** A fully gated recipe has an empty
 * `initial_steps` — every step lives behind the approval gate. A classifier that
 * read only `initial_steps` would call the most interesting workflows in the
 * corpus "empty", which is the N13/N14 bug wearing a different hat. There is one
 * reader of compiled actions and both the card and this file use it.
 */
import { collectSteps, richestOptionSteps } from './graph-plan.js';
/** Human caption for a shape — one short phrase, no jargon. */
export function shapeLabel(s) {
    switch (s) {
        case 'cycle': return 'repeats a step';
        case 'fan+check': return 'runs wide, then checks';
        case 'fan': return 'runs several at once';
        case 'chain': return 'one step after another';
        case 'single': return 'a single step';
        case 'menu': return 'you choose, no tools run';
        default: return 'not built yet';
    }
}
/** Glyph for the catalog. ASCII-safe fallbacks are the caller's business. */
export function shapeGlyph(s) {
    switch (s) {
        case 'cycle': return '↻';
        case 'fan+check': return '⋔✓';
        case 'fan': return '⋔';
        case 'chain': return '→';
        case 'single': return '·';
        case 'menu': return '☰';
        default: return '∅';
    }
}
/**
 * Classify one compiled `actions.json`.
 *
 * Precedence is deliberate and ordered by what a reader most needs to know:
 * a cycle is the only shape whose COST is unbounded by the step count, so it
 * outranks everything; a fan that is checked is meaningfully different from a
 * bare fan; width beats length because a wide plan is the one that can surprise
 * you. Never throws — a malformed skill classifies as `empty`, because the
 * catalog must render whatever is on disk.
 */
export function classifyShape(actions) {
    const a = (actions && typeof actions === 'object' ? actions : {});
    let steps = [];
    try {
        steps = collectSteps(a, 'richest').steps;
    }
    catch {
        return { shape: 'empty', steps: 0, widest: 0, checks: 0, loops: 0, sideEffecting: false, gated: false };
    }
    const groups = new Map();
    let checks = 0;
    let loops = 0;
    let sideEffecting = false;
    let real = 0;
    for (const s of steps) {
        const kind = typeof s.kind === 'string' ? s.kind : '';
        if (kind === 'verifier') {
            checks += Array.isArray(s.checks) ? s.checks.length : 1;
            continue;
        }
        // A join is bookkeeping, not work — counting it would make every fan look
        // one step longer than it is.
        if (kind === 'join')
            continue;
        real += 1;
        if (s.loop !== undefined && s.loop !== null && s.loop !== 1 && s.loop !== '1')
            loops += 1;
        if (s.side_effecting === true)
            sideEffecting = true;
        const g = typeof s.parallel_group === 'string' ? s.parallel_group : null;
        if (g)
            groups.set(g, (groups.get(g) ?? 0) + 1);
    }
    const widest = groups.size ? Math.max(...groups.values()) : (real ? 1 : 0);
    // A gate is a stopping point holding a step flagged side-effecting — read off
    // the compiled actions, never re-derived, so this cannot disagree with the card.
    const gated = (a.stopping_points ?? []).some((sp) => richestOptionSteps(sp).some((st) => st.side_effecting === true));
    // A skill can be real and still run no tools: a stopping point offers choices
    // and the MODEL does the work. Measured 2026-08-26, that is 12 of the 49
    // skills on disk — calling them "empty" alongside the 2 unbuilt skeletons
    // would tell a user their working skill is broken.
    const offersChoices = (a.stopping_points ?? []).some((sp) => Object.keys(sp.options ?? {}).length > 0);
    let shape;
    if (real === 0)
        shape = offersChoices ? 'menu' : 'empty';
    else if (loops > 0)
        shape = 'cycle';
    else if (widest > 1 && checks > 0)
        shape = 'fan+check';
    else if (widest > 1)
        shape = 'fan';
    else if (real === 1)
        shape = 'single';
    else
        shape = 'chain';
    return { shape, steps: real, widest, checks, loops, sideEffecting, gated };
}
