// Board Planner orchestrator.
//
// Takes a free-form goal ("build a CRM sync that pings Slack nightly") and turns
// it into an ordered, dependency-aware task plan GROUNDED in what this user can
// actually do right now: their connected MCP servers + tools, active skills, and
// intent shortcuts.
//
// Design note (responsiveness): the active provider is often `claude-cli`, whose
// one-shot completions are COLD spawns (~30-90s each). So the critical path is a
// SINGLE LLM call (reasoning folded into the synthesis prompt), wrapped in a
// heartbeat + hard timeout so the drawer never looks dead. The Vodou deep-think
// session is recorded AFTER the draft, fire-and-forget — pure persistence, never
// on the user's critical path. Web research runs only when a search server is
// connected. Everything degrades gracefully; only an empty model reply is fatal
// (surfaced as a clear error rather than a hang).
//
// Reused primitives only — no new infra:
//   - getDb()        — vodou-core.db handle (servers/tools/skills/intents)
//   - runVodouCore() — call any MCP server/tool (web search, deep-think)
//   - rawLLMCall()   — provider-aware one-shot completion (+ optional maxTokens)

import { getDb } from './db.js';
import { runVodouCore } from './executor.js';
import { rawLLMCall } from './llm.js';

// ───────────────────────── types ──────────────────────────────

export interface PlanTask {
  title: string;
  body?: string;
  priority?: number;      // assigned at commit time if absent
  skills?: string[];      // pinned skills, if the planner named any real ones
}

export interface PlanDraft {
  summary: string;
  tasks: PlanTask[];
  rationale?: string;
  researched: boolean;
}

export type PlanEvent =
  | { phase: 'enumerate'; note: string }
  | { phase: 'research';  note: string }
  | { phase: 'synthesize'; note: string }
  | { phase: 'draft';     draft: PlanDraft }
  | { phase: 'note';      note: string }
  | { phase: 'error';     note: string };

export interface PlannerInput {
  prompt: string;
  conversation?: { role: 'user' | 'assistant'; content: string }[];
  priorDraft?: PlanDraft | null;
  onEvent: (e: PlanEvent) => void;
  signal?: AbortSignal;
  // Project-scoped planning: absolute root of a codebase the planner should
  // read. The claude subprocess runs here (Read/Grep access); undefined = the
  // sandboxed default (no file access).
  projectRoot?: string;
  projectName?: string;
}

// ───────────────────────── bounds ─────────────────────────────

function envInt(name: string, def: number, lo: number, hi: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
}
const PLAN_MAX_TASKS   = envInt('VODOU_PLAN_MAX_TASKS', 12, 1, 30);
const SYNTH_MAX_TOKENS = envInt('VODOU_PLAN_SYNTH_TOKENS', 4096, 1024, 8192);
// Default 10 min, ceiling 30 min — extremely large plans + web research need
// minutes, not the old 180s. The inner claude -p call gets this same budget
// (passed as timeoutMs to rawLLMCall) so it no longer dies at 90s first.
const PLAN_TIMEOUT_MS  = envInt('VODOU_PLAN_TIMEOUT_MS', 600000, 30000, 1800000);

class AbortedError extends Error { constructor() { super('planner aborted'); } }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw new AbortedError(); }

// Race a promise against a timeout. Rejects with a labeled error on timeout.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// ─────────────────── capability enumeration ───────────────────

interface Catalog {
  text: string;                 // compact, prompt-injectable catalog
  toolNames: Set<string>;       // for grounding-checks / search-tool detection
  serverCount: number;
  toolCount: number;
  search?: { server: string; tool: string; arg: string };  // a usable web-search tool, if any
}

// Known web-search providers, in preference order. The first one whose SERVER is
// active (or whose tool is cataloged) is used for the research phase. tavily/exa are
// hosted HTTP MCP servers connected by default — they search Google + the broader web,
// need no Docker or local key, and return clean results. brave/ddg are optional local
// or keyed providers used only if a user has installed them instead.
const SEARCH_CANDIDATES: { server: string; tool: string; arg: string }[] = [
  { server: 'tavily',            tool: 'tavily_search',     arg: 'query' },
  { server: 'exa',               tool: 'web_search_exa',    arg: 'query' },
  { server: 'brave-search',      tool: 'brave_web_search',  arg: 'query' },
  { server: 'docker-duckduckgo', tool: 'duckduckgo_search', arg: 'query' },
  { server: 'web-search',        tool: 'duckduckgo_search', arg: 'query' },
];

function enumerateCapabilities(): Catalog {
  const db = getDb();
  const toolNames = new Set<string>();
  const serverNames = new Set<string>();
  const lines: string[] = [];

  // Active servers + their tools (this is also where messaging lives:
  // Vodou-channels + its send/list tools surface here like any other server).
  let serverCount = 0;
  let totalTools = 0;
  try {
    const servers = db.prepare(
      `SELECT s.id, s.name, s.description
         FROM mcp_servers s
        WHERE COALESCE(s.active, 1) != 0
        ORDER BY s.name`
    ).all() as Array<{ id: number; name: string; description: string | null }>;
    const toolStmt = db.prepare('SELECT name FROM tools WHERE server_id = ? ORDER BY name');
    lines.push('## Connected MCP servers & tools');
    for (const s of servers.slice(0, 60)) {
      const tools = (toolStmt.all(s.id) as Array<{ name: string }>).map(r => r.name);
      tools.forEach(t => toolNames.add(t));
      serverNames.add(s.name);
      totalTools += tools.length;
      serverCount++;
      const shown = tools.slice(0, 10).join(', ');
      const more = tools.length > 10 ? `, +${tools.length - 10} more` : '';
      const desc = s.description ? ` — ${String(s.description).slice(0, 80)}` : '';
      lines.push(`- ${s.name}${desc}: ${shown || '(no tools cataloged)'}${more}`);
    }
    if (servers.length > 60) lines.push(`- …and ${servers.length - 60} more servers (truncated)`);
  } catch {
    lines.push('## Connected MCP servers & tools\n- (enumeration unavailable)');
  }

  // Active skills (Layer 1 capabilities).
  try {
    const skills = db.prepare(
      `SELECT name, description FROM skills_registry
        WHERE is_active = 1 ORDER BY name LIMIT 60`
    ).all() as Array<{ name: string; description: string | null }>;
    if (skills.length) {
      lines.push('\n## Active skills');
      for (const sk of skills) {
        lines.push(`- ${sk.name}${sk.description ? ` — ${String(sk.description).slice(0, 90)}` : ''}`);
      }
    }
  } catch { /* skills table optional */ }

  // A sample of intent shortcuts (keyword → server/tool routing).
  try {
    const intents = db.prepare(
      `SELECT keyword, server_name, tool_name FROM intent_mappings
        WHERE priority < 80 ORDER BY priority DESC LIMIT 40`
    ).all() as Array<{ keyword: string; server_name: string; tool_name: string | null }>;
    if (intents.length) {
      lines.push('\n## Sample intent shortcuts (keyword → tool)');
      for (const im of intents.slice(0, 40)) {
        lines.push(`- "${im.keyword}" → ${im.server_name}${im.tool_name ? '/' + im.tool_name : ''}`);
      }
    }
  } catch { /* intents optional */ }

  const summary = `(${serverCount} active servers, ${totalTools} tools cataloged)`;
  lines.unshift(`Capability catalog ${summary}:`);

  // Match a connected search provider by ACTIVE SERVER NAME or by cataloged tool name.
  // Remote HTTP MCP servers (tavily/exa) don't enumerate their tools into the `tools`
  // table, so the server-name match is what lights them up; local/keyed providers
  // (brave/ddg) match by tool name too.
  const search = SEARCH_CANDIDATES.find(c => serverNames.has(c.server) || toolNames.has(c.tool));
  return { text: lines.join('\n'), toolNames, serverCount, toolCount: totalTools, search };
}

// ───────────────────────── research ───────────────────────────

// The planner decides whether external facts are needed; if so, and a search
// tool is connected, it runs ONE search round and returns the findings text.
async function maybeResearch(
  prompt: string, catalog: Catalog, signal?: AbortSignal,
): Promise<{ text: string | null; note: string }> {
  if (!catalog.search) {
    return { text: null, note: 'no web-search server connected — skipping research' };
  }
  throwIfAborted(signal);
  let query: string;
  // Fast-path: if the goal explicitly signals it wants current/external facts, research
  // directly and skip the LLM gate. The gate (kimi on the managed tier) is conservative
  // and frequently vetoes even obvious cases, which left the research phase effectively
  // dead — these signals make it actually fire when the user clearly wants it.
  const RESEARCH_SIGNALS = /\b(search the web|web search|look ?up|google|duckduckgo|online|latest|current|today|recent|up[- ]?to[- ]?date|20[0-9]{2}|pricing|price|news|changelog|release notes?|competitors?|alternatives?|benchmark)\b/i;
  if (RESEARCH_SIGNALS.test(prompt)) {
    query = prompt.slice(0, 200);
  } else {
    // Cheap gate for ambiguous goals: does this need up-to-date external facts?
    // TURNLESS: the plan draft is composed before any turn exists; its record is the thinking session (recordThinkingSession), not a turn.
    const gate = await rawLLMCall(
      `A user wants to plan/build this:\n"""${prompt}"""\n\n` +
      `Does producing a good implementation plan require looking up EXTERNAL, current ` +
      `facts (library/API specifics, current best practices, pricing, versions)? ` +
      `If NO, reply exactly: NO. ` +
      `If YES, reply: YES: <a single concise web search query>.`,
      'You are a precise planning assistant. Answer in the exact format requested.',
      { maxTokens: 120 },
    );
    // Lenient parse: explicit "NO" skips; any "YES …" form triggers research (accept
    // "YES: q" / "YES - q" / "YES q" / bare "YES" → fall back to the goal as the query).
    const reply = (gate || '').trim();
    if (/^\s*no\b/i.test(reply)) return { text: null, note: 'planner judged no external research needed' };
    const ym = /yes\b[:\-\s]*(.*)/is.exec(reply);
    if (!ym) return { text: null, note: 'planner judged no external research needed' };
    query = (ym[1] || '').replace(/[\r\n].*$/s, '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    if (!query) query = prompt.slice(0, 200);
  }
  throwIfAborted(signal);
  try {
    const { server, tool, arg } = catalog.search;
    const raw = await runVodouCore(server, tool, { [arg]: query });
    const trimmed = (raw || '').slice(0, 4000);
    return { text: `Web research for "${query}":\n${trimmed}`, note: `researched: "${query}"` };
  } catch (e) {
    return { text: null, note: `web search failed (${String((e as Error).message).slice(0, 80)}) — continuing without it` };
  }
}

// ───────────────────────── explore (project-scoped) ───────────
// Phase A of project-scoped planning: let claude READ the codebase (cwd = the
// project) and write a findings brief. This is agentic + PROSE — which is why
// synthesis is a SEPARATE, tool-less call: mixing "explore the files" with
// "emit strict JSON" makes claude narrate and the JSON never materializes (the
// whole draft then collapses to one salvaged task). Keeping them apart lets the
// JSON step be a clean completion. Returns a brief fed into synthesize as
// `research`; best-effort (a failure just means synthesize plans without it).
async function exploreProject(
  projectRoot: string, projectName: string | undefined, prompt: string, signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  try {
    // TURNLESS: same — pre-turn research brief; recorded by the thinking session.
    const brief = await rawLLMCall(
      `You are inspecting the project "${projectName || projectRoot}" (cwd = ${projectRoot}) to inform a build plan.\n` +
      `The user's goal:\n"""${prompt}"""\n\n` +
      `Use your Read/Grep/List/Glob tools to actually inspect the code, then write a concise findings brief (plain prose, ~200-400 words) covering:\n` +
      `- What the project is + its main modules (from README/manifest/src).\n` +
      `- What's already built vs half-built vs missing, relative to the goal.\n` +
      `- Specific files, functions, orphaned/unwired modules, TODOs, or gaps a plan should target — name real paths.\n` +
      `- Any roadmap/PLAN docs in the repo and what they say is next.\n` +
      `Write ONLY the brief. Do not produce a task list or JSON — that's a later step.`,
      'You are a precise codebase analyst. Inspect the real files and report grounded facts, not guesses.',
      { maxTokens: 2000, timeoutMs: PLAN_TIMEOUT_MS, cwd: projectRoot },
    );
    const t = (brief || '').trim();
    return t ? `Codebase findings for ${projectName || projectRoot} (from reading the actual files):\n${t.slice(0, 6000)}` : null;
  } catch {
    return null;
  }
}

// ───────────────────────── synthesis ──────────────────────────
// ONE call. The model reasons internally (and surfaces a short rationale), then
// emits the ordered plan. Returns null on an empty model reply (provider failure)
// so the caller can show a real error instead of a junk plan.

const SYNTH_SYSTEM =
  'You are Vodou\'s board planner. Output ONLY a single JSON object — no prose, no markdown, no code fences, ' +
  'and do NOT think out loud. Reason internally, then emit just the JSON. Schema: ' +
  '{"summary": string, "rationale": string (one or two sentences, not a monologue), ' +
  '"tasks": [{"title": string, "body": string, "skills"?: string[]}]}. ' +
  'Ground every step in the connected capabilities listed by the user — prefer naming a relevant server or ' +
  'skill by name; if you are unsure of an exact tool name, name the SERVER or SKILL rather than inventing a tool. ' +
  'Tasks MUST be in execution order (first = do first); each is a concrete, self-contained unit of work a ' +
  `worker can pick up. Produce 3–${PLAN_MAX_TASKS} tasks.`;

async function synthesize(
  prompt: string, catalog: Catalog, research: string | null,
  priorDraft: PlanDraft | null,
  conversation: { role: 'user' | 'assistant'; content: string }[] | undefined,
  signal?: AbortSignal,
  projectRoot?: string,
  projectName?: string,
): Promise<PlanDraft | null> {
  throwIfAborted(signal);
  const convo = (conversation || []).slice(-8)
    .map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n');
  const refineBlock = priorDraft
    ? `\n\nThis is a REFINEMENT of an existing plan:\n${JSON.stringify(priorDraft)}\n` +
      `Apply the user's latest message to update it (add/remove/reorder/split steps). Keep the good steps.`
    : '';
  // Project-scoped: the codebase findings arrive via `research` (from
  // exploreProject). Synthesis itself runs WITHOUT file tools (no cwd) — a
  // tool-less completion reliably emits the JSON, whereas an agentic run
  // narrates prose and the plan collapses to one salvaged task.
  const groundNote = projectRoot
    ? `\n\nThe "Codebase findings" above come from reading the real ${projectName || 'project'} files — ground every task in them (name actual paths/modules).\n`
    : '';

  // TURNLESS: same — the synthesis IS the draft the thinking session records.
  const body = await rawLLMCall(
    `GOAL:\n"""${prompt}"""\n\n${catalog.text}\n` +
    (research ? `\n${research}\n` : '') +
    groundNote +
    refineBlock +
    (convo ? `\n\nConversation so far:\n${convo}` : '') +
    `\n\nOutput the JSON plan now.`,
    SYNTH_SYSTEM,
    // Full plan budget so the inner call can't die at 90s before the
    // withTimeout(PLAN_TIMEOUT_MS) wrapper fires. No cwd — tool-less JSON.
    { maxTokens: SYNTH_MAX_TOKENS, jsonMode: true, timeoutMs: PLAN_TIMEOUT_MS },
  );

  if (!body || !body.trim()) return null;   // provider returned nothing → caller errors

  const parsed = extractJsonObject(body);
  // Tolerate schema drift: the model reliably emits a valid plan but sometimes
  // wraps it ({plan:{tasks}}) or names the array differently (steps). Find the
  // first tasks/steps array wherever it lives before giving up. Observed live:
  // claude returned {"plan":{"tasks":[{id,title,why}...]}} which the old
  // top-level `parsed.tasks` check missed → whole plan salvaged to one task.
  const findTaskArray = (o: any): any[] | null => {
    if (!o || typeof o !== 'object') return null;
    for (const k of ['tasks', 'steps', 'plan_tasks', 'items']) {
      if (Array.isArray(o[k]) && o[k].length) return o[k];
    }
    for (const v of Object.values(o)) {
      const found = findTaskArray(v);
      if (found) return found;
    }
    return null;
  };
  const rawTasks = findTaskArray(parsed);
  if (!parsed || !rawTasks) {
    // Non-empty but no task array (e.g. the model wrote pure prose): salvage as
    // one task so the user still gets something actionable rather than a failure.
    return {
      summary: `Plan for: ${prompt}`.slice(0, 200),
      tasks: [{ title: prompt.slice(0, 120), body: body.slice(0, 2000) }],
      rationale: 'The model did not return a structured task list; captured its reply as a single task.',
      researched: !!research,
    };
  }

  const pickStr = (...vals: unknown[]): string | undefined => {
    for (const v of vals) { if (typeof v === 'string' && v.trim()) return v; }
    return undefined;
  };
  let tasks: PlanTask[] = (rawTasks as any[])
    .map(t => {
      if (t && typeof t === 'object') {
        const title = pickStr(t.title, t.name, t.step, t.task, t.summary);
        if (!title) return null;
        const bodyStr = pickStr(t.body, t.why, t.description, t.details, t.what, t.rationale);
        return {
          title: title.trim().slice(0, 200),
          body: bodyStr ? bodyStr.slice(0, 4000) : undefined,
          skills: Array.isArray(t.skills) ? t.skills.filter((s: unknown) => typeof s === 'string').slice(0, 8) : undefined,
        } as PlanTask;
      }
      if (typeof t === 'string' && t.trim()) return { title: t.trim().slice(0, 200) } as PlanTask;
      return null;
    })
    .filter((t): t is PlanTask => !!t);
  if (tasks.length > PLAN_MAX_TASKS) tasks = tasks.slice(0, PLAN_MAX_TASKS);
  if (!tasks.length) return null;

  const p: any = parsed;
  return {
    summary: (pickStr(p.summary, p.plan?.summary, p.plan?.theme, p.theme) || `Plan for: ${prompt}`).slice(0, 400),
    rationale: pickStr(p.rationale, p.plan?.rationale, p.plan?.basis, p.basis)?.slice(0, 2000),
    tasks,
    researched: !!research,
  };
}

// ─────────────── deep-think session (best-effort, post-hoc) ────
// Records the plan's reasoning into a persistent Vodou-Enhanced-Thinking session
// AFTER the draft is returned — fire-and-forget so it never delays the user or
// blocks on the slow one-shot provider. Pure persistence / observability.
async function recordThinkingSession(prompt: string, draft: PlanDraft): Promise<void> {
  try {
    const raw = await runVodouCore('Vodou-Enhanced-Thinking', 'start_thinking_session', {
      topic: `Plan: ${prompt}`.slice(0, 300),
      estimated_steps: Math.max(1, draft.tasks.length),
    });
    const sessionId = extractField(raw, 'session_id') || extractField(raw, 'sessionId');
    if (!sessionId) return;
    const steps = [
      draft.rationale ? `Rationale: ${draft.rationale}` : null,
      ...draft.tasks.map((t, i) => `Step ${i + 1}: ${t.title}${t.body ? ` — ${t.body}` : ''}`),
    ].filter(Boolean) as string[];
    for (let i = 0; i < steps.length; i++) {
      await runVodouCore('Vodou-Enhanced-Thinking', 'add_thought', {
        session_id: sessionId,
        thought: steps[i].slice(0, 1200),
        thoughtNumber: i + 1,
        totalThoughts: steps.length,
        nextThoughtNeeded: i < steps.length - 1,
      }).catch(() => {});
    }
    await runVodouCore('Vodou-Enhanced-Thinking', 'complete_thinking_session', {
      session_id: sessionId, final_synthesis: draft.summary,
    }).catch(() => {});
  } catch { /* persistence is best-effort */ }
}

// ───────────────────────── driver ─────────────────────────────

export async function runPlanner(input: PlannerInput): Promise<PlanDraft> {
  const { prompt, conversation, priorDraft, onEvent, signal, projectRoot, projectName } = input;
  try {
    if (projectRoot) onEvent({ phase: 'note', note: `reading project: ${projectName || projectRoot}` });
    // 1. enumerate (always; cheap, synchronous).
    const catalog = enumerateCapabilities();
    console.error(`[Planner] enumerate done: ${catalog.serverCount} servers / ${catalog.toolCount} tools, search=${catalog.search?.server ?? 'none'}`);
    onEvent({ phase: 'enumerate', note: catalog.text.split('\n')[0] });

    // 2. research-if-needed (first pass only; refinements skip it for speed).
    let research: string | null = null;
    if (priorDraft) {
      onEvent({ phase: 'note', note: 'refining existing plan' });
    } else {
      const r = await maybeResearch(prompt, catalog, signal);
      research = r.text;
      onEvent({ phase: 'research', note: r.note });
    }

    // 2b. Project-scoped: explore the codebase into a findings brief (Phase A),
    // fed into synthesis as extra context. Runs on refinements too — a refine
    // should still be grounded in the current code. See exploreProject.
    if (projectRoot) {
      onEvent({ phase: 'note', note: `inspecting ${projectName || 'the project'} codebase…` });
      const brief = await exploreProject(projectRoot, projectName, prompt, signal);
      if (brief) {
        research = [research, brief].filter(Boolean).join('\n\n');
        onEvent({ phase: 'note', note: 'codebase inspected — composing the plan' });
      } else {
        onEvent({ phase: 'note', note: 'could not read the project — planning from the goal alone' });
      }
    }
    console.error(`[Planner] research done (aborted=${!!signal?.aborted}) — entering synthesis`);

    // 3. synthesize → ordered draft (ONE LLM call: reasoning folded in).
    throwIfAborted(signal);
    onEvent({
      phase: 'synthesize',
      note: priorDraft ? 'updating the plan…' : 'deep-thinking + composing the ordered plan… (≈30–90s on this provider)',
    });

    // Heartbeat so the drawer visibly stays alive during the (slow one-shot) call.
    let secs = 0;
    const hb = setInterval(() => {
      secs += 15;
      if (!signal?.aborted) onEvent({ phase: 'note', note: `still working… ${secs}s` });
    }, 15000);

    let draft: PlanDraft | null;
    try {
      console.error('[Planner] calling synthesize (rawLLMCall)…');
      draft = await withTimeout(
        synthesize(prompt, catalog, research, priorDraft ?? null, conversation, signal, projectRoot, projectName),
        PLAN_TIMEOUT_MS, 'planner',
      );
      console.error(`[Planner] synthesize returned: ${draft ? draft.tasks.length + ' tasks' : 'null/empty'}`);
    } finally {
      clearInterval(hb);
    }

    if (!draft || !draft.tasks.length) {
      const note = 'the planner model returned no usable output — verify the LLM provider is configured & authenticated, then retry';
      onEvent({ phase: 'error', note });
      throw new Error(note);
    }

    onEvent({ phase: 'draft', draft });

    // 4. persist a deep-think session AFTER the draft (non-blocking).
    void recordThinkingSession(prompt, draft);
    return draft;
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    const note = `planner failed: ${String((e as Error).message).slice(0, 200)}`;
    onEvent({ phase: 'error', note });
    throw e;
  }
}

// ───────────────────────── helpers ────────────────────────────

// Pull a top-level string field out of a JSON-ish blob without full parse
// (MCP responses sometimes wrap JSON in content envelopes).
function extractField(raw: string, field: string): string | null {
  if (!raw) return null;
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`);
  const m = re.exec(raw);
  return m ? m[1] : null;
}

// Extract the first balanced top-level JSON object from a model reply that may
// include prose or ```json fences.
function extractJsonObject(s: string): any | null {
  if (!s) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
