/**
 * PLAN-GRAPH-SKILLS P1 — the plan card.
 *
 * The product moment: a recipe becomes something the user READS before
 * anything runs, with the resolved `server·tool` on every row. A wrong tool
 * resolution is then visible while it is still free to fix, instead of being
 * discovered by a Slack message that should never have been sent.
 *
 * Two rules live here, and only here.
 *
 *   **H8 — nothing sends without being asked.** Vodou's parameter engine
 *   auto-fills declared booleans as TRUE (`param-engine-booleans-default-true`).
 *   A fan of four tools with a `slack_post_message` in it would therefore post,
 *   with arguments nobody typed. Any step whose tool looks like it sends, posts,
 *   deletes or pays gets an approval gate appended unless the author explicitly
 *   opted out — and the plan card marks the row so the gate is visible, not just
 *   present.
 *
 *   **The plan is not the run.** Building a plan never executes anything. The
 *   card is inert until the user presses a button.
 *
 * This module does not parse recipes. `vodou-core recipe compile` is the single
 * compiler (§15 Q1); this turns its output into rows a surface can draw.
 */

import { compileRecipe, type CompiledRecipe } from './executor.js';

export interface PlanRow {
  block: 'together' | 'then' | 'join' | 'ask' | 'check';
  id: string;
  label?: string;
  server?: string;
  tool?: string;
  sideEffecting?: boolean;
}

export interface GraphPlan {
  recipe: string;
  actions: Record<string, unknown>;
  rows: PlanRow[];
  needed?: number;
  notes: string[];
  guard?: string;
}

/**
 * Tools that change something outside Vodou. Matched on the tool NAME, which is
 * the only thing available before a run.
 *
 * Deliberately over-inclusive: a false positive costs one confirmation click, a
 * false negative costs a message the user never authorised. When those are the
 * two error modes there is no case for being clever.
 */
const SIDE_EFFECTING = /(^|[_-])(send|post|create|delete|remove|update|write|publish|reply|invite|pay|charge|archive|move|rename|upload|share|schedule|cancel)([_-]|$)/i;

/** `sendEmail`, `postMessage` — camelCase verbs the regex above would miss. */
const SIDE_EFFECTING_CAMEL = /^(send|post|create|delete|remove|update|write|publish|reply|invite|pay|charge|archive|move|rename|upload|share|schedule|cancel)[A-Z]/;

export function isSideEffecting(tool: string | undefined): boolean {
  if (!tool) return false;
  return SIDE_EFFECTING.test(tool) || SIDE_EFFECTING_CAMEL.test(tool);
}

/** Did the author say, in the recipe itself, not to be asked? */
function optedOutOfAsking(recipe: string): boolean {
  return /\bwithout asking\b/i.test(recipe) || /\bdon'?t ask\b/i.test(recipe);
}

/**
 * Compile a recipe and describe what it will do. Never executes a step.
 */
/** The compiled-actions shape both the card and the classifier read. */
export interface CompiledActions {
  initial_steps?: Array<Record<string, unknown>>;
  stopping_points?: Array<Record<string, unknown>>;
}

/**
 * The steps held behind one stopping point's option 1.
 *
 * Exported because the topology classifier must read a plan the SAME way the
 * card does. Two readers of one structure is how `reranker_model` ended up with
 * one floor and two scorers; there is one reader here and both callers use it.
 */
export function optionSteps(sp: Record<string, unknown>): Array<Record<string, unknown>> {
  const one = (sp.options as Record<string, { steps?: Array<Record<string, unknown>> }> | undefined)?.['1'];
  return Array.isArray(one?.steps) ? one.steps : [];
}

/**
 * The RICHEST option branch — the most work any single path through this
 * stopping point performs.
 *
 * `optionSteps` reads option `"1"`, which is correct for the card because the
 * compiler always emits the proceed-branch there (`graph_recipe.rs:470,612,622,636`).
 * Hand-authored `actions.json` does not follow that convention: measured across
 * the 49-skill corpus on 2026-08-26, steps live under `"2"` 14 times, `"3"` 9
 * times and `"4"` once, and 15 of 49 skills have NO option `"1"` at all —
 * `mcp-builder` offers only `"2"` and `"3"`.
 *
 * The union would be wrong: 12 stopping points carry steps under more than one
 * option, and those are mutually-exclusive alternatives, not concurrent work.
 * Merging them would invent a plan no path actually runs. The richest branch is
 * the honest answer to "how big can this get".
 */
export function richestOptionSteps(sp: Record<string, unknown>): Array<Record<string, unknown>> {
  const opts = sp.options as Record<string, { steps?: Array<Record<string, unknown>> }> | undefined;
  if (!opts || typeof opts !== 'object') return [];
  let best: Array<Record<string, unknown>> = [];
  for (const v of Object.values(opts)) {
    const steps = Array.isArray(v?.steps) ? v.steps : [];
    if (steps.length > best.length) best = steps;
  }
  return best;
}

/**
 * Every step that would RUN, from wherever it lives — `initial_steps` plus the
 * steps held behind a gate — de-duplicated, with the held ids reported.
 *
 * Reading only `initial_steps` is the N13/N14 bug: a fully gated recipe has an
 * EMPTY `initial_steps`, so anything that reads just that half sees no work at
 * all and reports a gated workflow as empty.
 */
export function collectSteps(
  actions: CompiledActions,
  /**
   * `first` reads the compiler's proceed-branch (option `"1"`) — the card's
   * rule, unchanged. `richest` reads the largest branch, for classifying
   * hand-authored skills the compiler did not write. See `richestOptionSteps`.
   */
  branch: 'first' | 'richest' = 'first',
): {
  steps: Array<Record<string, unknown>>;
  heldIds: Set<string>;
} {
  const read = branch === 'richest' ? richestOptionSteps : optionSteps;
  const initial = Array.isArray(actions.initial_steps) ? actions.initial_steps : [];
  const initialIds = new Set(initial.map((s) => String(s.id ?? '')));
  const heldSteps: Array<Record<string, unknown>> = [];
  for (const sp of actions.stopping_points ?? []) {
    for (const st of read(sp)) {
      // A step that ALSO appears up front is the "Run again" menu echoing the
      // graph, not a held step. Counting it would invent a gate.
      if (!initialIds.has(String(st.id ?? ''))) heldSteps.push(st);
    }
  }
  const seen = new Set<string>();
  const steps = [...initial, ...heldSteps].filter((st) => {
    const id = String(st.id ?? '');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { steps, heldIds: new Set(heldSteps.map((s) => String(s.id ?? ''))) };
}

export async function buildPlan(recipe: string): Promise<GraphPlan> {
  const compiled: CompiledRecipe = await compileRecipe(recipe);
  const actions = compiled.actions as CompiledActions;
  // A gated recipe (`ask first:`) keeps its work behind the go-menu, because
  // `initial_steps` run before any stopping point and could not see the answers.
  // Reading only initial_steps rendered an empty card for exactly the recipes
  // that stop to ask — the ones a plan card is most useful for.
  //
  // Since N13 a SENDING step also lives behind a gate, so reading only
  // initial_steps stopped showing the very row the ⚠ is for — the card lost the
  // step it exists to warn about. Everything that would run is collected, from
  // wherever it lives, and the gated ones are remembered so the card can say
  // which are held.
  const { steps, heldIds } = collectSteps(actions);

  const rows: PlanRow[] = [];
  let needed: number | undefined;
  let sawSideEffect = false;

  for (const s of steps) {
    const id = String(s.id ?? 'step');
    if (s.kind === 'join') {
      const inList = Array.isArray(s.in) ? (s.in as string[]) : [];
      needed = typeof s.min_success === 'number' ? s.min_success : inList.length;
      rows.push({ block: 'join', id, label: `needs ${needed} of ${inList.length}` });
      continue;
    }
    if (s.kind === 'verifier') {
      // A verifier carries depends_on like any dependent step, so treating it
      // as one rendered it in `then:` as a tool row with no tool. It is a gate.
      for (const c of (Array.isArray(s.checks) ? s.checks : []) as Array<{ rule?: string; check?: string }>) {
        rows.push({ block: 'check', id: String(c.check ?? 'check'), label: String(c.rule ?? '') });
      }
      continue;
    }
    const server = typeof s.server === 'string' ? s.server : undefined;
    const tool = typeof s.tool === 'string' ? s.tool : undefined;
    const sideEffecting = isSideEffecting(tool);
    if (sideEffecting) sawSideEffect = true;
    rows.push({
      block: s.parallel_group ? 'together' : 'then',
      id,
      label: typeof s.prompt === 'string' ? s.prompt : undefined,
      server,
      tool,
      sideEffecting,
    });
  }

  const allSps = Array.isArray(actions.stopping_points) ? actions.stopping_points : [];
  for (const sp of allSps) {
    const r = sp as Record<string, unknown>;
    if (r.type === 'text_input' && typeof r.title === 'string') {
      rows.unshift({ block: 'ask', id: String(r.capture_as ?? r.title), label: `${r.title} (asked first)` });
    }
  }
  const asks = allSps
    .filter((sp) => (sp as Record<string, unknown>).type !== 'text_input')
    .map((sp) => String((sp as Record<string, unknown>).title ?? ''))
    .filter((t) => t && t !== 'Run complete' && t !== 'Ready to run?');
  for (const a of asks) rows.push({ block: 'ask', id: a, label: a });

  // The gate itself lives in the COMPILER now, where every path gets it —
  // `saveRecipeAsSkill` and `[Run once]` call `compileRecipe` directly and never
  // came through here, so a gate built in this file was appended to a copy of
  // the actions that the card displayed and threw away (N13).
  //
  // What remains here is the SENTENCE explaining it, read back off the compiled
  // actions rather than re-derived — so the card cannot describe a gate that is
  // not there, or miss one that is.
  let guard: string | undefined;
  // A gate exists when a SENDING step is held — not merely when some stopping
  // point happens to carry one. The "Run again" menu carries the whole graph,
  // and matching on that reported a gate for a recipe that opted out of one.
  const gate = (actions.stopping_points ?? []).find((sp) =>
    optionSteps(sp).some(
      (st) => (st as { side_effecting?: boolean }).side_effecting && heldIds.has(String(st.id ?? '')),
    ),
  );
  if (gate) {
    const names = rows.filter((r) => r.sideEffecting).map((r) => `${r.server}·${r.tool}`);
    guard =
      `${names.join(', ')} ${names.length === 1 ? 'changes' : 'change'} something outside Vodou, ` +
      `so this will stop and ask before running it. Say "without asking" in the recipe to opt out.`;
    // Only when the gate is one the COMPILER synthesised. When it is the
    // author's own `ask me:`, that row already exists — pushing another showed
    // the same question twice on the card.
    const title = String(gate.title ?? '');
    const alreadyShown = rows.some((r) => r.block === 'ask' && (r.label === title || r.id === title));
    if (!alreadyShown) rows.push({ block: 'ask', id: title || 'approval', label: title });
  }

  return {
    recipe,
    actions: compiled.actions,
    rows,
    needed,
    notes: compiled.notes,
    guard,
  };
}

/**
 * The canonical TEXT form of a plan. Every DOM-less surface — side panel,
 * Telegram, `./do` — shows exactly this; the web card is an enhancement of it,
 * never a different set of facts.
 */
export function renderPlanText(plan: GraphPlan): string {
  const out: string[] = [];
  const together = plan.rows.filter((r) => r.block === 'together');
  const then = plan.rows.filter((r) => r.block === 'then');
  const asks = plan.rows.filter((r) => r.block === 'ask');

  if (together.length) {
    out.push("together — these don't need each other, so they run at once");
    for (const r of together) out.push(`  • ${r.id}  ${describe(r)}`);
  }
  const join = plan.rows.find((r) => r.block === 'join');
  if (join) out.push(`join — ${join.label}`);
  if (then.length) {
    out.push('then — needs the results above');
    for (const r of then) out.push(`  • ${r.id}  ${describe(r)}`);
  }
  const checks = plan.rows.filter((r) => r.block === 'check');
  if (checks.length) {
    out.push('check — fresh eyes; nothing weak gets past this');
    // The resolved check id is shown so the author can see what their sentence
    // became and disagree with it.
    for (const r of checks) out.push(`  • ${r.label}  [${r.id}]`);
  }
  if (asks.length) {
    out.push('ask me — nothing ships without you');
    for (const r of asks) out.push(`  • ${r.label}`);
  }
  for (const n of plan.notes) out.push(`\nⓘ ${n}`);
  if (plan.guard) out.push(`\n⚠ ${plan.guard}`);
  return out.join('\n');
}

function describe(r: PlanRow): string {
  if (r.server && r.tool) return `${r.server}·${r.tool}${r.sideEffecting ? '  ⚠' : ''}`;
  return r.label ?? '';
}

/**
 * One graph event as a line of text, for surfaces that have no DOM.
 *
 * item 12 — channels (Telegram, Slack, WhatsApp, iMessage, …) and `./do` receive
 * only text. Without this a run that PARKS for permission is silent on every one
 * of them: the gate holds, and the person who has to answer never learns there
 * is a question. An approval nobody can see is not an approval.
 *
 * Returns `null` when an event has nothing worth saying to a human, so callers
 * can skip rather than emit blank lines.
 */
export function renderGraphEventText(type: string, graph: Record<string, any> | undefined): string | null {
  const g = graph ?? {};
  switch (type) {
    case 'graph_plan': {
      const text = g.plan?.text;
      if (!text) return null;
      return `${g.skill ? `plan for ${g.skill}` : 'plan'}\n${text}`;
    }
    case 'graph_branch': {
      const n = Array.isArray(g.branches) ? g.branches.length : (g.width ?? 0);
      if (!n) return null;
      return g.elapsedMs != null
        ? `${g.group || 'together'} — ${n} finished in ${(g.elapsedMs / 1000).toFixed(1)}s`
        : `${g.group || 'together'} — running ${n} at once`;
    }
    case 'graph_join':
      return g.line ? `join — ${g.line}` : null;
    case 'graph_check':
      return g.line ? `check — ${g.line}${g.met === false ? ' (REFUSED)' : ''}` : null;
    case 'graph_ask': {
      const ask = g.ask ?? {};
      const title = ask.title || 'Vodou needs an answer';
      const opts = Array.isArray(ask.options) ? ask.options : [];
      if (ask.type === 'text_input' || !opts.length) {
        return `${title}\n\n(reply with your answer)`;
      }
      // Numbered exactly as the menu presents them: on a channel the reply IS
      // the number, so what is shown must be what can be typed back.
      const lines = opts.map((o: { n: string; label: string }) => `${o.n}. ${o.label}`);
      return `${title}\n${lines.join('\n')}\n\n(reply with the number)`;
    }
    case 'graph_done':
      return g.outcome ? `${g.outcome}${g.line ? ` — ${g.line}` : ''}` : null;
    default:
      return null;
  }
}
