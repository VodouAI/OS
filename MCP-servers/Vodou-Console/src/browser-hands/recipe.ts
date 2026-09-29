/**
 * Browser Hands recipes (PLAN-BROWSER-HANDS §5.1): a named flow for one site and
 * one task, as DATA. A recipe can only express contract actions, and every
 * action still goes through the Hands layer, so its gates and allow-list apply
 * exactly as they do to the model (a recipe's "gate" is a floor, not the gate).
 *
 * Why recipes at all, when the loop already works: the loop spends 5–10 model
 * calls finding its way around a site it has seen a hundred times. A recipe does
 * the known path with zero model calls, and falls back to the loop AT THE STEP
 * that failed when the site has changed (§5.5) — the loop then starts from where
 * the recipe got to, with a note saying what was expected.
 *
 * Steps:
 *   {do:'navigate', url}                         url is a template ("…?query={restaurant}")
 *   {do:'click', target}                         target = {role, name_matches} (regex, slots substituted)
 *   {do:'fill', target, value}
 *   {expect: target | {text_matches}, within_ms} polls the page; missing → fallback
 *   {do:'pick_options', from: target, keep, ask} lists matching names; asks the person
 *   {when_present: target, fallback: '<why>', ask?}  e.g. a "Log in" button → hand to the loop;
 *                                                with `ask`, the RECIPE asks the person first (live
 *                                                2026-09-28: told only to ask, K3 went for Reserve Now)
 *   {proof: true}                                 the step after the gate: done, with a screenshot
 * Slots are the only place a person's specifics go, filled at run time and kept
 * in the task (never in the recipe). Name patterns are matched case-insensitively
 * against the RAW snapshot, first match in page order.
 */
import { nodesFromSnapshot, type NodeInfo } from './contract.js';
import type { Hands, ActResult } from './runner.js';
import type { TaskStore, BrowserTask } from './tasks.js';
import type { LoopOutcome } from './loop.js';
import { RECIPES } from './recipes/index.js';

export interface Target { role?: string | string[]; name_matches?: string; text_matches?: string }
export type Step =
  | { do: 'navigate'; url: string }
  | { do: 'click'; target: Target }
  | { do: 'fill'; target: Target; value: string }
  | { expect: Target; within_ms?: number }
  | { do: 'pick_options'; from: Target; keep?: number; ask?: string; none?: string; filter?: 'time_window' }
  | { when_present: Target; fallback: string; ask?: string }
  | { proof: true; text: string };

export interface Recipe {
  id: string;
  version: number;
  site: { domains: string[]; needs_login?: boolean };
  task: string;
  /** slot name → a one-line description the chat model reads when filling it. */
  slots: Record<string, string>;
  required: string[];
  steps: Step[];
}

/**
 * First-party recipes shipped with Vodou. TypeScript data modules, not .json
 * files: the gateway build is plain `tsc`, which copies no JSON into dist/, so a
 * JSON recipe would be silently missing from every release.
 */
export function loadRecipes(): Map<string, Recipe> {
  return new Map(RECIPES.map((r) => [r.id, r]));
}

export function getRecipe(id: string): Recipe | null {
  return loadRecipes().get(id) ?? null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fill {slot} in a template. In a URL every value is encoded; in a name pattern it's regex-escaped. */
export function fillTemplate(t: string, slots: Record<string, string>, mode: 'url' | 'regex' | 'text'): string {
  // A slot name starts with a letter: `{2}` in `\d{2}` is a regex quantifier, not a slot.
  return t.replace(/\{([A-Za-z_]\w*)\}/g, (_m, k: string) => {
    const v = slots[k] ?? '';
    return mode === 'url' ? encodeURIComponent(v) : mode === 'regex' ? esc(v) : v;
  });
}

/** Every node matching a target, in page order. */
export function findAll(snapshot: string, t: Target, slots: Record<string, string>): NodeInfo[] {
  const roles = t.role === undefined ? null : Array.isArray(t.role) ? t.role : [t.role];
  const re = t.name_matches ? new RegExp(fillTemplate(t.name_matches, slots, 'regex'), 'i') : null;
  const out: NodeInfo[] = [];
  for (const n of nodesFromSnapshot(snapshot).nodes.values()) {
    if (roles && !roles.includes(n.role)) continue;
    if (re && !re.test(n.name)) continue;
    out.push(n);
  }
  return out;
}

function present(snapshot: string, t: Target, slots: Record<string, string>): boolean {
  if (t.text_matches) return new RegExp(fillTemplate(t.text_matches, slots, 'regex'), 'i').test(snapshot);
  return findAll(snapshot, t, slots).length > 0;
}

/** "18:00-20:30" → minutes; a time label "7:30 PM DINNER" → minutes. */
function minutes(label: string): number | null {
  const m = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(label);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (!m[3]) h = Number(m[1]);
  else if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

/** Keep options inside the window, nearest its middle first; with no window, page order. */
export function pickTimes(names: string[], window: string | undefined, keep: number): string[] {
  const w = window ? /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(window.trim()) : null;
  if (!w) return names.slice(0, keep);
  const lo = minutes(w[1])!;
  const hi = minutes(w[2])!;
  const mid = (lo + hi) / 2;
  return names
    .map((n) => ({ n, t: minutes(n) }))
    .filter((x) => x.t !== null && x.t >= lo && x.t <= hi)
    .sort((a, b) => Math.abs(a.t! - mid) - Math.abs(b.t! - mid) || a.t! - b.t!)
    .slice(0, keep)
    .sort((a, b) => a.t! - b.t!)
    .map((x) => x.n);
}

export interface RecipeState { id: string; step: number; slots: Record<string, string>; fellBack?: string }

export type RecipeOutcome = LoopOutcome | { kind: 'fallback'; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the recipe from task.state.recipe.step until it finishes, needs the person
 * (a gate or a question — the turn ends there), or can't continue (fallback).
 */
export async function runRecipe(hands: Hands, store: TaskStore, task: BrowserTask, recipe: Recipe, opts: { signal?: AbortSignal; pollMs?: number } = {}): Promise<RecipeOutcome> {
  const st = task.state.recipe as RecipeState;
  const pollMs = opts.pollMs ?? 1_000;
  const save = () => { task.state = { ...task.state, recipe: st }; store.saveProgress(task.id, task.step, task.state); };
  const fallback = (reason: string): RecipeOutcome => {
    st.fellBack = reason;
    task.state = { ...task.state, recipe: st, history: [...((task.state.history as string[]) ?? []), `the ${recipe.id} recipe stopped at step ${st.step + 1}: ${reason}. Continue from the current page.`].slice(-25) };
    store.saveProgress(task.id, task.step, task.state);
    return { kind: 'fallback', reason };
  };
  const acted = (r: ActResult, what: string): RecipeOutcome | null => {
    if (r.kind === 'gated') {
      // The approved click is performed by resumeGate; the recipe resumes AFTER it.
      st.step += 1; save();
      return { kind: 'gate', text: r.gate.summary, screenshot: r.gate.screenshot };
    }
    if (r.kind === 'refused') return fallback(`${what} was refused: ${r.reason}`);
    if (r.kind === 'done' && r.obs.ok === false) return fallback(`${what} failed: ${r.obs.note}`);
    return null;
  };

  while (st.step < recipe.steps.length) {
    if (opts.signal?.aborted) return { kind: 'cancelled', text: 'Stopped. Nothing else was done.' };
    const step = recipe.steps[st.step];
    const snap = () => hands.rawSnapshot(task);

    if ('do' in step && step.do === 'navigate') {
      const r = await hands.act(task, 'navigate_page', { url: fillTemplate(step.url, st.slots, 'url') });
      const o = acted(r, 'opening the page'); if (o) return o;
    } else if ('do' in step && (step.do === 'click' || step.do === 'fill')) {
      // Sites render some controls twice with one copy hidden (live on Resy
      // 2026-09-28, the "Dining Room / Bar Seat" layout: clicking the first
      // "7:00 PM Dining Room" failed "did not become interactive"). Try the
      // next match, up to three, before handing the page to the loop.
      const matches = findAll(snap(), step.target, st.slots).slice(0, 3);
      if (!matches.length) return fallback(`couldn't find ${describe(step.target, st.slots)}`);
      let r: ActResult | null = null;
      let n = matches[0];
      for (n of matches) {
        r = step.do === 'click'
          ? await hands.act(task, 'click', { uid: n.uid })
          : await hands.act(task, 'fill', { uid: n.uid, value: fillTemplate(step.value, st.slots, 'text') });
        const notInteractive = r.kind === 'done' && r.obs.ok === false && /interactive|interactable|not visible|timed? ?out/i.test(r.obs.note);
        if (!notInteractive) break;
      }
      const o = acted(r!, `${step.do} ${n.role} "${n.name}"`); if (o) return o;
    } else if ('expect' in step) {
      const until = Date.now() + (step.within_ms ?? 10_000);
      let ok = present(snap(), step.expect, st.slots);
      while (!ok && Date.now() < until) {
        if (opts.signal?.aborted) return { kind: 'cancelled', text: 'Stopped. Nothing else was done.' };
        await sleep(pollMs);
        await hands.refresh(task).catch(() => undefined);
        ok = present(snap(), step.expect, st.slots);
      }
      if (!ok) return fallback(`expected ${describe(step.expect, st.slots)} and the page didn't show it`);
    } else if ('when_present' in step) {
      if (present(snap(), step.when_present, st.slots)) {
        const out = fallback(step.fallback);
        if (!step.ask) return out;
        const prompt = fillTemplate(step.ask, st.slots, 'text');
        store.suspendAtQuestion(task.id, { kind: 'text', prompt, options: [] });
        return { kind: 'question', text: prompt, options: [] };
      }
    } else if ('do' in step && step.do === 'pick_options') {
      const names = [...new Set(findAll(snap(), step.from, st.slots).map((n) => n.name))];
      let options = step.filter === 'time_window' ? pickTimes(names, st.slots.time_window, step.keep ?? 5) : names.slice(0, step.keep ?? 5);
      // Open times exist, just none in their window: say so and offer what IS
      // open — "no tables" would be false.
      let outside = false;
      if (!options.length && names.length) { options = names.slice(0, step.keep ?? 5); outside = true; }
      if (!options.length) {
        const text = fillTemplate(step.none ?? 'There was nothing to choose from.', st.slots, 'text');
        const proof = await hands.proof(task);
        store.recordStep(task.id, { idx: task.step, tool: 'done', decision: 'allow', outcome: 'done', note: text, screenshot: proof });
        store.finish(task.id, 'done', text);
        return { kind: 'done', text, proof };
      }
      if ((options.length === 1 && !outside) || !step.ask) {
        st.slots.chosen_option = options[0];
      } else {
        st.step += 1; save();
        const prompt = (outside ? `Nothing is open between ${st.slots.time_window?.replace('-', ' and ')}. ` : '') + fillTemplate(step.ask, st.slots, 'text');
        store.suspendAtQuestion(task.id, { kind: 'options', prompt, options });
        return { kind: 'question', text: `${prompt}\n${options.map((o, k) => `${k + 1}. ${o}`).join('\n')}`, options };
      }
    } else if ('proof' in step) {
      const text = fillTemplate(step.text, st.slots, 'text');
      const proof = await hands.proof(task);
      store.recordStep(task.id, { idx: task.step, tool: 'done', decision: 'allow', outcome: 'done', note: text, screenshot: proof });
      store.finish(task.id, 'done', text);
      return { kind: 'done', text, proof };
    }
    st.step += 1;
    save();
  }
  return fallback('the recipe ran out of steps without a confirmation');
}

function describe(t: Target, slots: Record<string, string>): string {
  if (t.text_matches) return `text like "${fillTemplate(t.text_matches, slots, 'text')}"`;
  const role = Array.isArray(t.role) ? t.role.join('/') : t.role ?? 'an element';
  return `${role}${t.name_matches ? ` named like "${fillTemplate(t.name_matches, slots, 'text')}"` : ''}`;
}
