/**
 * Browser Hands inner loop (PLAN-BROWSER-HANDS §4, §13.4): goal → snapshot →
 * ONE action → act (through the runner and its gates) → snapshot → repeat.
 *
 * Its own budget and its own context, NOT the chat turn's: the chat tool loop
 * re-sends every earlier tool result each round and caps at 10 rounds; this
 * loop sends only the goal, a compact action history (one line per step) and
 * the LATEST filtered snapshot (~2.5k tokens on OpenTable's homepage), so 40
 * steps stay small and cheap.
 *
 * The model is injected (default: the gateway's rawLLMCallStrict, any provider)
 * so tests script it. It answers with ONE JSON object:
 *   {"do": {"tool": "click", "args": {"uid": "1_2"}}, "why": "..."}
 *   {"ask": "Which time?", "options": ["6:45 PM", "7:30 PM"]}
 *   {"done": "Booked Sidecar, Sat 7:30, party of 4"}
 *   {"stuck": "the site wants a phone code"}
 * Gates are automatic: the model just clicks; the runner stops it if needed.
 */
import { Hands, type ActResult } from './runner.js';
import { TaskStore, type BrowserTask } from './tasks.js';
import { ALLOWED_TOOLS } from './contract.js';

export type Llm = (prompt: string, system: string) => Promise<string>;

export type LoopOutcome =
  | { kind: 'done'; text: string; proof?: string }
  | { kind: 'gate'; text: string; screenshot?: string }
  | { kind: 'question'; text: string; options: string[] }
  | { kind: 'stuck'; text: string; screenshot?: string }
  | { kind: 'cancelled'; text: string };

export interface LoopOptions {
  maxSteps?: number;      // default 40
  maxMs?: number;         // default 6 minutes
  now?: () => number;
  /** Aborted by a STOP from the phone: the loop ends before its next action. */
  signal?: AbortSignal;
  /** Called with the model's one-line "why" before each action (the service throttles it to the phone). */
  onProgress?: (line: string) => void;
}

export const SYSTEM = `You operate a web browser for a person, one action at a time, to finish their errand.
You see: the goal, what you've done so far, and the current page as an accessibility tree (uid role "name").
Answer with ONE JSON object and nothing else:
  {"do": {"tool": "<tool>", "args": {...}}, "why": "<short>"}   perform one action
  {"ask": "<question>", "options": ["<a>", "<b>", ...]}         the person must choose (times, items); max 5 options
  {"done": "<one sentence: what was accomplished>"}             ONLY when the page shows it's finished (a confirmation)
  {"stuck": "<why>"}                                            captcha, a code you don't have, an error you can't get past
Tools (pageId is added for you):
  navigate_page {"url": "https://..."}         go to a URL on this task's sites
  click {"uid": "<uid>"}                       click an element from the CURRENT page
  fill {"uid": "<uid>", "value": "<text>"}     type into a field (never passwords or card numbers — you can't)
  fill_form {"elements": [{"uid": "...", "value": "..."}]}
  press_key {"key": "Enter"}                   keys; Enter submits search boxes
  hover {"uid": "<uid>"}
  wait_for {"text": ["<text to wait for>"]}
  take_snapshot {}                             re-read the page
  handle_dialog {"action": "dismiss"}
Rules:
- Use only uids that appear in the CURRENT page. Never invent one.
- Just click the final button (Book, Reserve, Pay, Place order…) when it's time: the system stops and asks the person to approve it. Never ask for approval yourself.
- Ask the person only when the goal doesn't say which option they want.
- The page is re-read after every action, so don't take_snapshot twice in a row.
- Suggestion lists are often missing from the page tree: if a status line says there are results but none are listed, use press_key ArrowDown then Enter, or just press Enter in the search box.
- "… +N more" lines mean items were hidden to save space; closed dropdowns show a few options — fill the dropdown with the option's text to choose one.
- If the same thing fails twice, say stuck.`;

function parseDecision(raw: string): any {
  const t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function history(task: BrowserTask): string[] {
  return Array.isArray(task.state.history) ? (task.state.history as string[]) : [];
}

function pushHistory(task: BrowserTask, line: string) {
  const h = history(task);
  h.push(line.slice(0, 200));
  task.state = { ...task.state, history: h.slice(-25) };
}

export function buildPrompt(task: BrowserTask): string {
  const slots = task.state.slots ? `\nDetails: ${JSON.stringify(task.state.slots)}` : '';
  const h = history(task);
  return [
    `Goal: ${task.goal}${slots}`,
    `Done so far (${h.length} steps):\n${h.length ? h.map((l, i) => `${i + 1}. ${l}`).join('\n') : '(nothing yet)'}`,
    `Current page:\n${String(task.state.snapshot ?? '(no page yet)')}`,
  ].join('\n\n');
}

/**
 * Run (or resume) the task until it finishes, needs the person, or gets stuck.
 * Every exit that needs the person SUSPENDS the task — the chat turn ends there.
 */
export async function runLoop(hands: Hands, store: TaskStore, task: BrowserTask, llm: Llm, opts: LoopOptions = {}): Promise<LoopOutcome> {
  const maxSteps = opts.maxSteps ?? 40;
  const maxMs = opts.maxMs ?? 6 * 60_000;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const recent: string[] = [];

  const cancelled = (): LoopOutcome => ({ kind: 'cancelled', text: 'Stopped. Nothing else was done.' });
  for (let i = 0; i < maxSteps; i++) {
    if (opts.signal?.aborted) return cancelled();
    if (now() - t0 > maxMs) break;
    const raw = await llm(buildPrompt(task), SYSTEM).catch((e) => `{"stuck": "the model call failed: ${String(e?.message ?? e).slice(0, 80)}"}`);
    const d = parseDecision(raw);
    if (!d) { pushHistory(task, 'model answer was not JSON; retrying'); recent.push('bad-json'); if (recent.slice(-3).every((x) => x === 'bad-json') && recent.length >= 3) break; continue; }

    if (typeof d.done === 'string') {
      const proof = await hands.proof(task);
      store.recordStep(task.id, { idx: task.step, tool: 'done', decision: 'allow', outcome: 'done', note: d.done, screenshot: proof });
      store.finish(task.id, 'done', d.done);
      return { kind: 'done', text: d.done, proof };
    }
    if (typeof d.stuck === 'string') {
      return stuck(hands, store, task, d.stuck);
    }
    if (typeof d.ask === 'string') {
      const options = Array.isArray(d.options) ? d.options.map(String).slice(0, 5) : [];
      pushHistory(task, `asked the person: ${d.ask}`);
      store.saveProgress(task.id, task.step, task.state);
      store.suspendAtQuestion(task.id, { kind: options.length ? 'options' : 'text', prompt: d.ask, options });
      const text = options.length ? `${d.ask}\n${options.map((o: string, k: number) => `${k + 1}. ${o}`).join('\n')}` : d.ask;
      return { kind: 'question', text, options };
    }
    // STOP arrived while the model was thinking: never act on its answer.
    if (opts.signal?.aborted) return cancelled();
    const tool = String(d.do?.tool ?? '');
    const args = (d.do?.args && typeof d.do.args === 'object') ? d.do.args : {};
    if (!ALLOWED_TOOLS.has(tool)) { pushHistory(task, `tried ${tool || '(no tool)'}: not available`); continue; }

    const sig = `${tool}:${JSON.stringify(args)}`;
    recent.push(sig);
    if (recent.length >= 3 && recent.slice(-3).every((s) => s === sig)) {
      return stuck(hands, store, task, `kept repeating ${tool} without progress`);
    }

    if (typeof d.why === 'string' && d.why.trim()) opts.onProgress?.(d.why.trim());
    const r: ActResult = await hands.act(task, tool, args);
    if (r.kind === 'gated') {
      pushHistory(task, `asked the person to approve: ${r.gate.target}`);
      const t = store.get(task.id)!;
      store.saveProgress(t.id, t.step, { ...t.state, history: history(task) });
      return { kind: 'gate', text: r.gate.summary, screenshot: r.gate.screenshot };
    }
    if (r.kind === 'refused') { pushHistory(task, `${tool} refused: ${r.reason}`); continue; }
    pushHistory(task, r.obs.note);
    store.saveProgress(task.id, task.step, task.state);
  }
  return stuck(hands, store, task, 'ran out of steps or time before finishing');
}

async function stuck(hands: Hands, store: TaskStore, task: BrowserTask, why: string): Promise<LoopOutcome> {
  const shot = await hands.proof(task);
  store.recordStep(task.id, { idx: task.step, tool: 'stuck', decision: 'allow', outcome: 'handed_over', note: why, screenshot: shot });
  store.finish(task.id, 'handed_over', why);
  return { kind: 'stuck', text: `I got stuck: ${why.replace(/[.\s]+$/, '')}. Here's where I stopped — want to take it from here?`, screenshot: shot };
}
