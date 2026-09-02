/**
 * Generic Skill Workflow Driver
 *
 * Two sources for workflow definitions:
 * 1. AGENT_ACTIONS in skill markdown (self-describing — any skill, no config needed)
 * 2. workflows.json (static fallback for skills that haven't been updated yet)
 *
 * Skills embed AGENT_ACTIONS as HTML comments:
 *   <!-- AGENT_ACTIONS_1: {"label":"Quick Analysis","vars":{"DEPTH":"5"},"steps":[...]} -->
 *   <!-- AGENT_ACTIONS_2: {"label":"Standard Deep Dive","vars":{"DEPTH":"10"},"steps":[...]} -->
 *
 * The gateway parses these from BrainLoader output, presents the menu,
 * then executes the tool sequence directly via vodou-core call.
 * Claude can't skip steps, fake output, or wing it.
 */

import { existsSync, readFileSync } from 'fs';
import { gatewayPort, gatewayBaseUrl } from './gateway-port.js';   // P3 — one answer to where the gateway is
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, getGatewayDb, getProjectRoot } from './db.js';
import {
  runVodouCore, runVodouCoreGroup, getMemoryProfile, rememberRun, runCheck,
  type CheckVerdict,
} from './executor.js';
import { startRun, recordBranches, finishRun, recordAsk, answerAsk,
         findLiveRunForConversation, findRunToPark, groupIdForRun, getRun,
         type BranchRecord, type PendingAsk } from './graph-runs.js';
import { authorRecipe, recipeBlock } from './skill-recipe-author.js';
import { buildPlan, renderPlanText } from './graph-plan.js';
import type { GroupOutcome } from './executor.js';
import { rawLLMCall, rawLLMCallPooled as _rawLLMCallPooledReal } from './llm.js';
// Injectable so a test can drive the REAL prose-branch path without a model
// (mirrors `_chatFn` in vbb/chat.ts). Production never sets it.
let _rawLLMCallPooled: typeof _rawLLMCallPooledReal = _rawLLMCallPooledReal;
export function _setRawLLMCallForTest(fn: typeof _rawLLMCallPooledReal | null): void { _rawLLMCallPooled = fn ?? _rawLLMCallPooledReal; }
const rawLLMCallPooled: typeof _rawLLMCallPooledReal = (...a) => _rawLLMCallPooled(...a);
import type { StreamEvent } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Types ---

interface WorkflowStep {
  id?: string;
  /**
   * Tool steps carry server+tool. A PROMPT step carries neither and supplies `prompt`
   * instead: it is an LLM synthesis instruction, not a dispatch. `execdesk-action-weekly-brief`
   * is the canonical case — one prompt step, no tools. Both were previously typed as
   * required, so a prompt step built the tool label `undefined::undefined` and its
   * dispatch error was returned as the skill's output.
   */
  server?: string;
  tool?: string;
  prompt?: string;
  args: Record<string, unknown>;
  loop?: string | number;
  capture?: Record<string, string>;
  stream_progress?: boolean;
  /**
   * Opt OUT of batch pre-generation for a {{LLM:}} loop. Default (false) batches all N
   * loop items in ONE LLM call for speed. Set true when each iteration must READ the
   * prior iterations' results — deep-thinking is the canonical case: batch generation
   * makes "build on previous thoughts" impossible (they're all written at once), which
   * is the regression from commit 5ff59a38. Sequential = one LLM call per item with the
   * accumulated results as context (slower, but genuinely iterative).
   */
  sequential?: boolean;
  /**
   * SCHEMA 1.1 (PLAN-GRAPH-SKILLS P0). Steps sharing a `parallel_group` run
   * TOGETHER in one `vodou-core call-group` process. `kind: 'join'` is a
   * barrier that reports settled-vs-expected for the branches it names.
   */
  kind?: 'tool' | 'join' | 'verifier';
  /** verifier only — may only be true; enforced at execution, not just typed. */
  fresh_context?: boolean;
  checks?: Array<{ rule: string; check: string }>;
  parallel_group?: string;
  depends_on?: string[];
  on_fail?: 'skip' | 'block';
  timeout_ms?: number;
  /** join only */
  in?: string[];
  mode?: 'all_settled';
  min_success?: number;
  on_partial?: 'continue_with_warning' | 'block' | 'human';
}

/**
 * Rebuild ONE step from parsed JSON — the single place that decides which fields
 * survive the trip from `actions.json` to the executor.
 *
 * There used to be five copies of this object literal. That is not a style
 * problem, it is the bug: each copy names its fields explicitly, so a field
 * added to the schema has to be remembered in five places and is silently
 * dropped everywhere it is forgotten. It has now cost two incidents.
 *
 * The first was `prompt`: `execdesk-action-weekly-brief` reached the executor
 * with neither a tool nor its prompt and could only no-op. Whoever fixed it left
 * a warning comment — and fixed one copy.
 *
 * The second was every schema-1.1 field. `parallel_group`, `kind`, `min_success`
 * and the rest were in the schema, validated, compiled, and handled by the
 * executor — and stripped right here. The morning briefing therefore ran its
 * three sources one at a time and logged
 * `skipping non-tool step join_sources`, because by the time the executor saw
 * them they were plain tool steps and an object with no server, no tool and no
 * prompt. `graph_runs` had zero rows from a real request for exactly this
 * reason: no group was ever detected, so no run was ever opened.
 *
 * One function, one field list. Adding a field means editing one place.
 */
function stepFromJson(s: any, index: number, idPrefix = 'step'): WorkflowStep {
  return {
    id: s.id || `${idPrefix}_${index}`,
    server: s.server,
    tool: s.tool,
    // A prompt step's whole payload is `prompt`; it carries no server/tool.
    prompt: s.prompt,
    args: s.args || {},
    loop: s.loop,
    capture: s.capture,
    stream_progress: s.stream_progress,
    sequential: s.sequential,
    // --- schema 1.1: the graph fields ---
    kind: s.kind,
    parallel_group: s.parallel_group,
    depends_on: s.depends_on,
    on_fail: s.on_fail,
    timeout_ms: s.timeout_ms,
    in: s.in,
    mode: s.mode,
    min_success: s.min_success,
    on_partial: s.on_partial,
    // --- P2: verifier ---
    fresh_context: s.fresh_context,
    checks: s.checks,
  };
}

interface WorkflowOption {
  label: string;
  vars?: Record<string, string>;
  steps: WorkflowStep[];
  /** Jump to a specific stopping point ID instead of advancing sequentially */
  goto?: number;
}

/** A stopping point with its menu options — engine enforces the pause */
interface StoppingPoint {
  id: number;
  title: string;
  /** 'menu' (default) = numbered choices, 'text_input' = capture free text */
  type?: 'menu' | 'text_input';
  /** For text_input: variable name to store the user's response */
  capture_as?: string;
  options: Record<string, WorkflowOption>;
}

/** Unified AGENT_ACTIONS schema — optional initial steps + stopping points */
interface UnifiedWorkflow {
  /** Steps to execute automatically when the skill first loads (before any menu) */
  initial_steps?: WorkflowStep[];
  stopping_points: StoppingPoint[];
}

interface StaticWorkflowConfig {
  detect: string[];
  menu_options?: Record<string, { label: string; [key: string]: unknown }>;
  steps: WorkflowStep[];
}

export interface ActiveWorkflow {
  skillName: string;
  topic: string;
  // Legacy: flat options (one stopping point)
  options: Record<string, WorkflowOption>;
  // New: multi-phase stopping points
  stoppingPoints?: StoppingPoint[];
  /** Steps to auto-execute on first load (before any menu) */
  initialSteps?: WorkflowStep[];
  /** Whether initial steps have been executed */
  initialStepsRan?: boolean;
  currentPhase: number;
  variables: Record<string, string>;
  step: 'menu' | 'executing' | 'complete';
  /** PLAN §27 Layer B — engine-enforced menus for LLM-created skill consoles */
  workflowOrigin?: 'skill_console';
  /** skills_meta.id for persisting current_phase to gateway.db */
  skillMetaId?: number;
  /**
   * The recipe this workflow was compiled from, when it is known.
   *
   * A run card had no way to offer `[Edit]`: it knows what RAN, not the words it
   * came from. Carried here rather than re-derived, because decompiling gives
   * back the actions' shape and not the author's own phrasing.
   */
  recipe?: string;
}

type StreamCallback = (event: StreamEvent) => void;

// --- Load static workflow configs (fallback) ---

let staticWorkflows: Record<string, StaticWorkflowConfig> = {};

function loadStaticWorkflows(): void {
  for (const relPath of ['workflows.json', path.join('..', 'src', 'workflows.json')]) {
    try {
      const raw = readFileSync(path.join(__dirname, relPath), 'utf-8');
      staticWorkflows = JSON.parse(raw);
      console.error(`[Workflow] loaded ${Object.keys(staticWorkflows).length} static workflow configs`);
      return;
    } catch { /* try next */ }
  }
  console.error(`[Workflow] no workflows.json found (inline AGENT_ACTIONS still work)`);
}

loadStaticWorkflows();

// --- Per-conversation workflow state ---

const activeWorkflows: Map<string, ActiveWorkflow> = new Map();

// --- Parse AGENT_ACTIONS from skill output ---

/**
 * Parse <!-- AGENT_ACTIONS_N: {...} --> blocks from skill markdown.
 * Returns a map of option number → WorkflowOption.
 *
 * Format:
 *   <!-- AGENT_ACTIONS_1: {"label":"Quick Analysis","vars":{"DEPTH":"5"},"steps":[
 *     {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{TOPIC}}"},"capture":{"SESSION_ID":"session_id"}},
 *     {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}"},"loop":"{{DEPTH}}","stream_progress":true}
 *   ]} -->
 */
function parseInlineActions(content: string): Record<string, WorkflowOption> | null {
  const pattern = /<!--\s*AGENT_ACTIONS_(\d+):\s*([\s\S]*?)\s*-->/g;
  const options: Record<string, WorkflowOption> = {};
  let match;
  let found = false;

  while ((match = pattern.exec(content)) !== null) {
    const optionNum = match[1];
    const jsonStr = match[2].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.steps && Array.isArray(parsed.steps)) {
        options[optionNum] = {
          label: parsed.label || `Option ${optionNum}`,
          vars: parsed.vars || {},
          steps: parsed.steps.map((s: any, i: number) => stepFromJson(s, i)),
        };
        found = true;
      }
    } catch (err) {
      console.error(`[Workflow] failed to parse AGENT_ACTIONS_${optionNum}: ${err}`);
    }
  }

  return found ? options : null;
}

/**
 * Parse STOPPING_POINT HTML comments from skill output.
 * Format: <!-- STOPPING_POINT: {"id": 1, "title": "Choose Analysis Type"} -->
 * Returns metadata about stopping points for structured handling.
 */
export function parseStoppingPoints(content: string): Array<{ id: number; title: string; position: number }> {
  const pattern = /<!--\s*STOPPING_POINT:\s*(\{[\s\S]*?\})\s*-->/g;
  const points: Array<{ id: number; title: string; position: number }> = [];
  let match;

  while ((match = pattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      points.push({
        id: parsed.id ?? points.length + 1,
        title: parsed.title ?? `Stopping Point ${points.length + 1}`,
        position: match.index,
      });
    } catch (err) {
      console.error(`[Workflow] failed to parse STOPPING_POINT: ${err}`);
    }
  }

  return points;
}

/** Map JSON object (AGENT_ACTIONS body or skills_meta.stopping_points_json) to workflow state. */
export function stoppingPointsFromParsedUnified(parsed: any): { stoppingPoints: StoppingPoint[]; initialSteps?: WorkflowStep[] } | null {
  if (!parsed || !parsed.stopping_points || !Array.isArray(parsed.stopping_points)) return null;
  const initialSteps = parsed.initial_steps?.map((s: any, i: number) =>
    stepFromJson(s, i, 'init'),
  ) as WorkflowStep[] | undefined;

  const stoppingPoints = parsed.stopping_points.map((sp: any) => ({
    id: sp.id ?? 0,
    title: sp.title ?? 'Choose',
    type: sp.type as 'menu' | 'text_input' | undefined,
    capture_as: sp.capture_as,
    options: Object.fromEntries(
      Object.entries(sp.options || {}).map(([key, opt]: [string, any]) => [
        key,
        {
          label: opt.label || `Option ${key}`,
          vars: opt.vars || {},
          goto: opt.goto,
          steps: (opt.steps || []).map((s: any, i: number) => stepFromJson(s, i)),
        },
      ])
    ),
  }));
  return { stoppingPoints, initialSteps };
}

/**
 * Parse skills_meta.stopping_points_json — same schema as unified AGENT_ACTIONS
 * (`{ "stopping_points": [...], "initial_steps"?: [...] }`). Also accepts a bare array
 * (wrapped as stopping_points).
 */
export function parseWorkflowStoppingPointsJson(
  jsonStr: string | null | undefined,
): { stoppingPoints: StoppingPoint[]; initialSteps?: WorkflowStep[] } | null {
  if (!jsonStr?.trim()) return null;
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    let body: any = parsed;
    if (Array.isArray(parsed)) body = { stopping_points: parsed };
    return stoppingPointsFromParsedUnified(body);
  } catch (err) {
    console.error(`[Workflow] parseWorkflowStoppingPointsJson: ${err}`);
    return null;
  }
}

/**
 * PLAN §27 Layer B — seed in-memory workflow from gateway skills_meta before chat().
 */
export function ensureSkillConsoleLayerBWorkflow(params: {
  conversationId: string;
  skillName: string;
  skillMetaId: number;
  stoppingPointsJson: string | null | undefined;
  currentPhaseDb: number;
}): { active: boolean; totalPhases: number } {
  const parsed = parseWorkflowStoppingPointsJson(params.stoppingPointsJson);
  if (!parsed || parsed.stoppingPoints.length === 0) {
    return { active: false, totalPhases: 0 };
  }
  const n = parsed.stoppingPoints.length;
  if (params.currentPhaseDb >= n) {
    const ex = activeWorkflows.get(params.conversationId);
    if (ex?.workflowOrigin === 'skill_console' && ex.skillMetaId === params.skillMetaId) {
      activeWorkflows.delete(params.conversationId);
    }
    return { active: false, totalPhases: n };
  }
  const ph = Math.min(Math.max(0, params.currentPhaseDb), n - 1);
  const cur = parsed.stoppingPoints[ph];
  const existing = activeWorkflows.get(params.conversationId);
  if (
    existing &&
    existing.workflowOrigin === 'skill_console' &&
    existing.skillMetaId === params.skillMetaId
  ) {
    existing.stoppingPoints = parsed.stoppingPoints;
    existing.initialSteps = parsed.initialSteps;
    existing.currentPhase = ph;
    existing.options = cur.options || {};
    existing.step = 'menu';
    existing.variables.TOPIC = existing.variables.TOPIC || params.skillName;
    return { active: true, totalPhases: n };
  }

  activeWorkflows.set(params.conversationId, {
    skillName: `skill-console:${params.skillName}`,
    topic: '',
    options: cur.options || {},
    stoppingPoints: parsed.stoppingPoints,
    initialSteps: parsed.initialSteps,
    initialStepsRan: false,
    currentPhase: ph,
    variables: { TOPIC: params.skillName },
    step: 'menu',
    workflowOrigin: 'skill_console',
    skillMetaId: params.skillMetaId,
  });
  return { active: true, totalPhases: n };
}

function persistSkillConsolePhase(workflow: ActiveWorkflow, phase: number): void {
  if (workflow.workflowOrigin !== 'skill_console' || workflow.skillMetaId == null) return;
  try {
    getGatewayDb()
      .prepare(
        `UPDATE skills_meta SET current_phase = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(phase, workflow.skillMetaId);
  } catch (e) {
    console.error(`[Workflow] persist skill_console phase: ${e}`);
  }
}

/**
 * Announce a human node as STRUCTURE, and park the run on it.
 *
 * The menu text is unchanged and still streams: this is additive, so a surface
 * that renders prose keeps working exactly as it did. What is new is that a
 * surface with a DOM can draw buttons from data instead of sniffing numbered
 * lines out of an LLM's prose with a regex — the detection that a briefing
 * containing its own numbered list was enough to break.
 *
 * No live run means no announcement. A chain-only skill never opens one, and
 * inventing a run id here so the event could fire would put a row in the record
 * for something that never ran.
 */
/**
 * Register a compiled recipe as a live workflow so it can be RUN ONCE.
 *
 * `[Run once]` used to send the chat string "run it" and hope. The obvious
 * replacement — compile and call `executeSteps` — would have been worse than the
 * shim: a compiled recipe's approval gate lives in `stopping_points`, not in
 * `initial_steps`, so running the steps directly SKIPS the `ask me:` node and
 * fires exactly the sends H8 exists to catch. The card would promise "nothing
 * ships without you" and then ship it.
 *
 * So an ad-hoc run is registered the same way a saved skill is, and the driver
 * enforces the stops it always enforced. Nothing is written to disk: this is a
 * run, not a save.
 */
export function registerAdHocWorkflow(
  conversationId: string,
  actions: unknown,
  label = 'ad-hoc',
  recipe?: string,
): { ok: boolean; steps: number; stops: number } {
  const parsed = stoppingPointsFromParsedUnified(actions);
  if (!parsed) return { ok: false, steps: 0, stops: 0 };
  const first = parsed.stoppingPoints[0];
  activeWorkflows.set(conversationId, {
    skillName: label,
    topic: '',
    options: first?.options || {},
    stoppingPoints: parsed.stoppingPoints,
    initialSteps: parsed.initialSteps,
    initialStepsRan: false,
    currentPhase: 0,
    variables: { TOPIC: label },
    step: 'menu',
    recipe,
  });
  return {
    ok: true,
    steps: parsed.initialSteps?.length ?? 0,
    stops: parsed.stoppingPoints.length,
  };
}

/** The live workflow for a conversation, for callers that must run its steps. */
export function getWorkflowFor(conversationId: string): ActiveWorkflow | undefined {
  return activeWorkflows.get(conversationId);
}

export function announceAsk(
  workflow: ActiveWorkflow,
  conversationId: string,
  onEvent: StreamCallback,
): void {
  try {
    const sp = workflow.stoppingPoints?.[workflow.currentPhase];
    if (!sp || !conversationId) {
      console.error(`[GraphAsk] no announce: sp=${!!sp} conv=${!!conversationId} phase=${workflow.currentPhase}`);
      return;
    }
    // The execution that just ended, not a live one — see findRunToPark.
    let run = findRunToPark(conversationId);
    if (!run) {
      // N14, a consequence of N13. When EVERY step is behind the gate,
      // `initial_steps` is empty, `executeInitialSteps` returns early and no run
      // is ever opened — so the shape the gate most protects ("post this to
      // slack") got the worst approval UI in the product: a numbered prose menu
      // instead of buttons, because there was no run for the ask to attach to.
      //
      // The ask IS evidence that an invocation is under way, so it opens the
      // record itself. Guarded on the workflow having steps SOMEWHERE, because
      // an ordinary menu-only skill has none and must not start writing graph
      // run rows it will never fill.
      const hasSteps =
        (workflow.initialSteps?.length ?? 0) > 0 ||
        (workflow.stoppingPoints ?? []).some((p) =>
          Object.values(p.options || {}).some((o) => (o?.steps?.length ?? 0) > 0),
        );
      if (!hasSteps) {
        console.error(`[GraphAsk] no announce: no run and no steps for ${conversationId}`);
        return;
      }
      const runId = startRun({
        skill: workflow.skillName || 'workflow',
        surface: 'web',
        conversationId,
      });
      run = getRun(runId);
      if (!run) {
        console.error(`[GraphAsk] no announce: could not open a run for ${conversationId}`);
        return;
      }
      console.error(`[GraphAsk] opened run ${runId} for a fully-gated plan (no steps ran yet)`);
    }
    console.error(`[GraphAsk] announcing "${sp.title}" on run ${run.run_id} (was ${run.outcome})`);

    const vars = workflow.variables || {};
    const resolve = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] || `{{${k}}}`);
    const ask: PendingAsk = {
      askId: `${run.run_id}:${workflow.currentPhase}`,
      title: resolve(sp.title ?? 'Choose'),
      options: Object.entries(sp.options || {}).map(([n, opt]) => ({
        n,
        label: resolve(opt.label ?? n),
      })),
      type: sp.type === 'text_input' ? 'text_input' : 'menu',
      askedAt: Date.now(),
    };
    recordAsk(run.run_id, ask);
    onEvent({
      type: 'graph_ask',
      graph: {
        runId: run.run_id,
        skill: run.skill,
        ask: { askId: ask.askId, title: ask.title, options: ask.options, type: ask.type },
      },
    });
  } catch (err) {
    // Never fail a run over its own announcement. The menu already streamed;
    // losing the structured copy costs buttons, not the question.
    console.error('[Workflow] announceAsk failed:', err);
  }
}

export function formatStoppingPointMenu(workflow: ActiveWorkflow): string {
  const sp = workflow.stoppingPoints?.[workflow.currentPhase];
  if (!sp) return '';
  const vars = workflow.variables || {};
  const resolveVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);
  if (sp.type === 'text_input') {
    return resolveVars(sp.title) + '\n\n*(Type your answer)*';
  }
  let menu = `## ${resolveVars(sp.title)}\n\n`;
  for (const [key, opt] of Object.entries(sp.options)) {
    menu += `${key}. ${resolveVars(opt.label)}\n`;
  }
  return menu.trim();
}

/**
 * Parse unified <!-- AGENT_ACTIONS: {"stopping_points": [...]} --> block.
 * This is the new format that embeds stopping points inside AGENT_ACTIONS.
 * The engine enforces stop-wait-execute for each phase.
 */
function parseUnifiedActions(content: string): { stoppingPoints: StoppingPoint[]; initialSteps?: WorkflowStep[] } | null {
  const pattern = /<!--\s*AGENT_ACTIONS:\s*([\s\S]*?)\s*-->/g;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const mapped = stoppingPointsFromParsedUnified(parsed);
      if (mapped) return mapped;
    } catch (err) {
      console.error(`[Workflow] failed to parse unified AGENT_ACTIONS: ${err}`);
    }
  }
  return null;
}

/** Generate actions.json from skill type (template fallback when LLM doesn't include AGENT_ACTIONS) */
function generateActionsJson(skillType: string, requiredTools: string): Record<string, unknown> {
  const baseOptions: Record<string, unknown> = {
    '1': { label: 'Quick version', vars: {}, steps: [] as any[] },
    '2': { label: 'Detailed version', vars: {}, steps: [] as any[] },
  };

  if (skillType === 'monitor') {
    (baseOptions['1'] as any).steps = [
      { server: 'mcp-monitor', tool: 'get_cpu_info', args: {} },
      { server: 'mcp-monitor', tool: 'get_memory_info', args: {} },
    ];
    (baseOptions['2'] as any).steps = [
      { server: 'mcp-monitor', tool: 'get_cpu_info', args: { per_cpu: true } },
      { server: 'mcp-monitor', tool: 'get_memory_info', args: {} },
      { server: 'mcp-monitor', tool: 'get_disk_info', args: { path: '/' } },
      { server: 'mcp-monitor', tool: 'get_network_info', args: {} },
    ];
  } else if (skillType === 'thinking') {
    (baseOptions['1'] as any).label = 'Quick analysis';
    (baseOptions['1'] as any).steps = [
      { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 3 }, capture: { SESSION_ID: 'session_id' } },
      { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Analyze {{TOPIC}} — key insights}}', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false } },
    ];
    (baseOptions['2'] as any).label = 'Deep analysis';
    (baseOptions['2'] as any).steps = [
      { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 8 }, capture: { SESSION_ID: 'session_id' } },
      { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Deep analysis of {{TOPIC}}}}', thoughtNumber: '{{i}}', totalThoughts: 6, nextThoughtNeeded: true }, loop: 6 },
      { server: 'Vodou-Enhanced-Thinking', tool: 'analyze_thinking', args: { session_id: '{{SESSION_ID}}' } },
    ];
  } else if (skillType === 'browser') {
    (baseOptions['1'] as any).label = 'Full audit';
    (baseOptions['1'] as any).steps = [
      { server: 'chrome-devtools', tool: 'runAccessibilityAudit', args: {} },
      { server: 'chrome-devtools', tool: 'runPerformanceAudit', args: {} },
      { server: 'chrome-devtools', tool: 'runSEOAudit', args: {} },
    ];
    (baseOptions['2'] as any).label = 'Screenshot';
    (baseOptions['2'] as any).steps = [
      { server: 'chrome-devtools', tool: 'takeScreenshot', args: {} },
    ];
  }

  return {
    stopping_points: [{
      id: 1,
      title: 'What would you like to do?',
      options: baseOptions,
    }],
  };
}

/**
 * Find actions.json for a skill name.
 * 1) skills_registry.file_path (supports nested e.g. agents/fundraising/foo/SKILL.md)
 * 2) legacy flat dirs: skills/{vodou-core,oi-core,my-skills,community,templates,agents}/<name>/actions.json
 */
export function findActionsFile(skillName: string): string | null {
  const root = getProjectRoot();

  try {
    const row = getDb()
      .prepare(
        `SELECT file_path FROM skills_registry WHERE name = ? AND COALESCE(is_active, 1) != 0 LIMIT 1`
      )
      .get(skillName) as { file_path: string } | undefined;
    if (row?.file_path) {
      const rel = row.file_path.replace(/\\/g, '/');
      const skillMd = path.resolve(root, 'skills', rel);
      const actionsPath = path.join(path.dirname(skillMd), 'actions.json');
      if (existsSync(actionsPath)) {
        return actionsPath;
      }
    }
  } catch (e) {
    console.error(
      `[Workflow] findActionsFile registry lookup failed for "${skillName}":`,
      (e as Error).message
    );
  }

  const candidates = [
    path.join(root, 'skills', 'vodou-core', skillName, 'actions.json'),
    path.join(root, 'skills', 'oi-core', skillName, 'actions.json'),  // legacy fallback
    path.join(root, 'skills', 'my-skills', skillName, 'actions.json'),
    path.join(root, 'skills', 'community', skillName, 'actions.json'),
    path.join(root, 'skills', 'templates', skillName, 'actions.json'),
    path.join(root, 'skills', 'agents', skillName, 'actions.json'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Generate trigger phrases from skill name and description */
function generateTriggers(name: string, description: string): string[] {
  const words = name.replace(/-/g, ' ');
  const triggers = [words];
  // Add first 3 meaningful words of description
  const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 3);
  if (descWords.length >= 2) triggers.push(descWords.join(' '));
  // Add "run <name>"
  triggers.push(`run ${words}`);
  return triggers;
}

/** Generate complete SKILL.md content based on skill type */
async function generateSkillContent(
  name: string, description: string, skillType: string, requiredTools: string, variables: Record<string, string>
): Promise<string> {
  const displayName = name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const triggers = generateTriggers(name, description);
  const toolsArray = requiredTools === 'none' || requiredTools === 'custom' ? '[]' : `["${requiredTools}"]`;

  // Generate AGENT_ACTIONS based on type
  let actionsBlock = '';
  if (skillType === 'monitor') {
    actionsBlock = `<!-- AGENT_ACTIONS: {"stopping_points": [{"id": 1, "title": "Choose scope", "options": {
  "1": {"label":"Full scan — CPU, memory, disk, network","vars":{},"steps":[
    {"server":"mcp-monitor","tool":"get_cpu_info","args":{"per_cpu":true}},
    {"server":"mcp-monitor","tool":"get_memory_info","args":{}},
    {"server":"mcp-monitor","tool":"get_disk_info","args":{"path":"/"}},
    {"server":"mcp-monitor","tool":"get_network_info","args":{}}
  ]},
  "2": {"label":"Quick check — CPU and memory only","vars":{},"steps":[
    {"server":"mcp-monitor","tool":"get_cpu_info","args":{}},
    {"server":"mcp-monitor","tool":"get_memory_info","args":{}}
  ]}
}}]} -->`;
  } else if (skillType === 'thinking') {
    actionsBlock = `<!-- AGENT_ACTIONS: {"stopping_points": [{"id": 1, "title": "Choose depth", "options": {
  "1": {"label":"Quick analysis (3 steps)","vars":{"DEPTH":"3"},"steps":[
    {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"` + '{{TOPIC}}' + `","depth":"` + '{{DEPTH}}' + `"},"capture":{"SESSION_ID":"session_id"}},
    {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"` + '{{SESSION_ID}}' + `","thought":"` + '{{LLM:Analyze {{TOPIC}} — key insights and recommendations}}' + `","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}}
  ]},
  "2": {"label":"Deep analysis (8 steps)","vars":{"DEPTH":"8"},"steps":[
    {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"` + '{{TOPIC}}' + `","depth":"` + '{{DEPTH}}' + `"},"capture":{"SESSION_ID":"session_id"}},
    {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"` + '{{SESSION_ID}}' + `","thought":"` + '{{LLM:Deep analysis of {{TOPIC}} — examine tradeoffs and implications}}' + `","thoughtNumber":"` + '{{i}}' + `","totalThoughts":6,"nextThoughtNeeded":true},"loop":6},
    {"server":"Vodou-Enhanced-Thinking","tool":"analyze_thinking","args":{"session_id":"` + '{{SESSION_ID}}' + `"}}
  ]}
}}]} -->`;
  } else if (skillType === 'browser') {
    actionsBlock = `<!-- AGENT_ACTIONS: {"stopping_points": [{"id": 1, "title": "Choose action", "options": {
  "1": {"label":"Run full audit","vars":{},"steps":[
    {"server":"chrome-devtools","tool":"runAccessibilityAudit","args":{}},
    {"server":"chrome-devtools","tool":"runPerformanceAudit","args":{}},
    {"server":"chrome-devtools","tool":"runSEOAudit","args":{}}
  ]},
  "2": {"label":"Take screenshot","vars":{},"steps":[
    {"server":"chrome-devtools","tool":"takeScreenshot","args":{}}
  ]}
}}]} -->`;
  } else {
    // Simple — no tools, just a guided menu
    actionsBlock = `<!-- AGENT_ACTIONS: {"stopping_points": [{"id": 1, "title": "What would you like to do?", "options": {
  "1": {"label":"Quick version","vars":{},"steps":[]},
  "2": {"label":"Detailed version","vars":{},"steps":[]}
}}]} -->`;
  }

  return `---
name: ${name}
description: ${description}
version: 1.0.0
required_tools: ${toolsArray}
---

# ${displayName}

## Trigger Phrases
${triggers.map(t => `- "${t}"`).join('\n')}

## Overview

${description}

## What would you like to do?

1. Quick version
2. Detailed version

${actionsBlock}
`;
}

/**
 * Convert a static workflow config to WorkflowOptions format.
 */
function staticToOptions(config: StaticWorkflowConfig): Record<string, WorkflowOption> {
  const options: Record<string, WorkflowOption> = {};
  if (config.menu_options) {
    for (const [key, menuOpt] of Object.entries(config.menu_options)) {
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(menuOpt)) {
        if (k !== 'label') vars[k.toUpperCase()] = String(v);
      }
      options[key] = {
        label: menuOpt.label,
        vars,
        steps: config.steps.map((s, i) => ({ ...s, id: s.id || `step_${i}` })),
      };
    }
  }
  return options;
}

// --- Template resolution ---

function resolveTemplate(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const fullMatch = value.match(/^\{\{(\w+)\}\}$/);
    if (fullMatch) {
      const resolved = variables[fullMatch[1]] ?? resolveDynamicVar(fullMatch[1]);
      if (resolved !== undefined) {
        const num = Number(resolved);
        return isNaN(num) ? resolved : num;
      }
      return value;
    }
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? resolveDynamicVar(key) ?? `{{${key}}}`);
  }
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(v => resolveTemplate(v, variables));
  if (value && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveTemplate(v, variables);
    }
    return resolved;
  }
  return value;
}

/** Resolve dynamic date/time vars at step-execution time (PLAN-SKILL-LEARNING-LOOP).
 *  The proposer parameterizes captured date literals to these, so a promoted
 *  skill uses the current day instead of replaying the day it was captured. */
function resolveDynamicVar(key: string): string | undefined {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  switch (key) {
    case 'TODAY': return date;
    case 'TODAY_START': return `${date}T00:00:00`;
    case 'TODAY_END': return `${date}T23:59:59`;
    case 'NOW': return now.toISOString();
    case 'NOW_NAIVE': return now.toISOString().slice(0, 19);
    default: return undefined;
  }
}

/** Pattern for LLM-generated fields: {{LLM:prompt text here}} */
const LLM_PATTERN = /\{\{LLM:([\s\S]+?)\}\}/;

/**
 * Find all balanced `[...]` blocks in `text`, respecting JSON string quoting
 * and escape sequences. Used to extract candidate JSON arrays from LLM output
 * that may include prose before/after the real array, or may echo our prompt
 * text containing literal brackets.
 *
 * Returns substrings; caller is responsible for `JSON.parse` + validation.
 */
function findBalancedJSONArrays(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

/**
 * Pull just the `currentThought` strings out of the cumulative MCP results
 * blob built up by the workflow driver, in chronological order. Used to feed
 * each {{LLM:...}} call a clean "prior thoughts" list instead of the raw
 * MCP server output (which is JSON-wrapped + verbose).
 *
 * Tolerant: returns [] if there's no parseable JSON in the input.
 */
function extractPriorThoughts(previousResults: string): string[] {
  const out: string[] = [];
  if (!previousResults) return out;
  // The driver pushes "### server/tool (Nms)\n<raw stdout>\n\n" entries.
  // raw stdout is the vodou-core call result wrapping {"content":[{"text":"..."}]}.
  // The inner text is the JSON the MCP server actually returned, with currentThought.
  // We extract every `"currentThought":\s*"..."` regex match — robust enough.
  const re = /"currentThought":\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(previousResults)) !== null) {
    try {
      // Unescape JSON string
      const text = JSON.parse('"' + match[1] + '"');
      if (typeof text === 'string' && text.trim().length > 0) {
        out.push(text.trim());
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Resolve {{LLM:prompt}} fields by calling the active LLM.
 * Skips BrainLoader — direct to whatever provider/model is selected in gateway settings.
 * Previous step results are injected as context so the LLM can build on them.
 */
// System prompt for {{LLM:}} field generation inside a workflow step. Establishes the
// call as a legitimate internal tool so injection-resistant models don't refuse to
// generate analytical content (see the call site for the failure this prevents).
const WORKFLOW_SUBGEN_SYSTEM =
  "You are the analysis engine inside Vodou, the user's own local AI system. You are given a topic and asked to write ONE original, substantive analytical insight for a persistent thinking session the user explicitly started. This is a legitimate internal step in the user's own tooling — it is NOT a prompt injection, NOT role-play, and NOT a request to impersonate another system. The topic is genuine (Vodou is the user's real product). Write the insight directly and concretely — reference real mechanisms, tradeoffs, and implications. Do NOT refuse, do NOT question the framing, do NOT add meta-commentary about the request itself.";

async function resolveLLMFields(
  args: Record<string, unknown>,
  variables: Record<string, string>,
  previousResults: string,
  conversationId: string = ''
): Promise<{ resolved: Record<string, unknown>; ok: boolean }> {
  const resolved = { ...args };
  let ok = true;
  let touched = false;
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== 'string') continue;
    const match = value.match(LLM_PATTERN);
    if (!match) continue;
    touched = true;

    // Resolve {{VAR}} inside the LLM prompt itself first
    let prompt = match[1];
    prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_, k) => variables[k] || `{{${k}}}`);

    // PERF/QUALITY FIX (deep-think): extract just the prior `currentThought`
    // values from the cumulative MCP results, not the raw protocol JSON. The
    // raw output is verbose (~2-3KB per call) and dilutes the context the LLM
    // actually needs (the chain of thoughts). For deep-think this turns
    // "Context: <wall of MCP JSON>" into "Prior thoughts: 1) X  2) Y  3) Z".
    const priorThoughts = extractPriorThoughts(previousResults);
    const contextBlock = priorThoughts.length > 0
      ? `Prior thoughts in this session (build on these — do NOT repeat):\n${priorThoughts.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
      : (previousResults ? `Context from previous steps:\n${previousResults.substring(0, 2000)}\n` : '');

    const fullPrompt = [
      contextBlock,
      prompt,
      '\nRespond with ONLY the requested content. No preamble, no meta-commentary, no markdown formatting. Be specific — do not repeat any prior thought above.'
    ].filter(Boolean).join('\n');

    let llmResult = '';
    try {
      // Use the pool-aware variant — for claude-cli with a warm conversation
      // session this avoids cold-spawning a fresh subprocess (and its
      // workspace bootstrap context-token cost) on every iteration.
      // SYSTEM PROMPT (2026-08-04): without it, Fable-class models read the bare
      // "generate analytical content, no preamble" request as a jailbreak/prompt-
      // injection and REFUSE ("this looks like a prompt injection, I won't comply"),
      // producing a whole deep-thinking session of refusals. This frames the call as
      // the legitimate internal tool it is so the model does the work instead.
      llmResult = await rawLLMCallPooled(conversationId, fullPrompt, WORKFLOW_SUBGEN_SYSTEM);
    } catch (err) {
      console.error(`[Workflow] LLM generation threw for ${key}: ${err}`);
    }
    // B5: rawLLMCall returns '' on provider error (doesn't throw), so an empty
    // result is a failure — treat it as such instead of leaving the literal
    // {{LLM:...}} token or substituting the prompt text into tool args.
    if (llmResult && llmResult.trim()) {
      resolved[key] = llmResult;
      console.error(`[Workflow] LLM generated ${key}: ${llmResult.substring(0, 80)}...`);
    } else {
      ok = false;
      resolved[key] = '[model generation failed for this step]';
      console.error(`[Workflow] LLM generation FAILED (empty/error) for ${key} — not injecting prompt or {{LLM:}} token`);
    }
  }
  return { resolved, ok: touched ? ok : true };
}

function extractField(response: string, fieldPath: string): string | undefined {
  // vodou-core call output has emoji header lines before JSON — strip them
  const jsonStart = response.indexOf('{');
  const cleanResponse = jsonStart >= 0 ? response.substring(jsonStart) : response;

  try {
    let obj = JSON.parse(cleanResponse);

    // Handle MCP content wrapper: {"content": [{"type":"text","text":"..."}]}
    if (obj?.content && Array.isArray(obj.content)) {
      const textBlock = obj.content.find((b: any) => b.type === 'text');
      if (textBlock?.text) {
        try { obj = JSON.parse(textBlock.text); } catch { /* use unwrapped */ }
      }
    }

    for (const key of fieldPath.split('.')) {
      if (obj == null) return undefined;
      obj = obj[key];
    }
    return obj != null ? String(obj) : undefined;
  } catch {
    // Regex fallback — works even if JSON parsing fails entirely
    const regex = new RegExp(`"${fieldPath}"\\s*:\\s*"([^"]+)"`);
    const match = response.match(regex);
    return match?.[1];
  }
}

function extractTopic(message: string, triggers: string[]): string {
  let topic = message;
  for (const trigger of triggers) {
    const re = new RegExp(trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    topic = topic.replace(re, '');
  }
  topic = topic.replace(/^\s*(about|on|regarding|for)\s+/i, '').trim();
  topic = topic.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
  return topic || message;
}

// --- Public API ---

/**
 * Check if BrainLoader output contains AGENT_ACTIONS (inline) or matches a static workflow.
 * If so, register the workflow state and return true.
 */
export function detectWorkflow(
  conversationId: string,
  oiResults: string,
  originalQuery: string
): boolean {
  const skillMatch = oiResults.match(/# SKILL:\s*(\S+)/i);
  const skillName = skillMatch?.[1] || 'unknown-skill';
  const topic = extractTopic(originalQuery, []);

  // Honor `actions: none` frontmatter — skill explicitly opts out of the workflow engine.
  // These skills are designed for LLM-driven sequential execution (e.g. deep-thinking).
  const actionsFieldMatch = oiResults.match(/^actions:\s*(\S+)/m);
  if (actionsFieldMatch?.[1] === 'none') {
    console.error(`[Workflow] skill "${skillName}" has actions: none — skipping workflow engine, LLM will drive`);
    return false;
  }

  // Priority -1: Check for actions.json file (clean, separate, no parsing issues)
  if (skillName !== 'unknown-skill') {
    const actionsFile = findActionsFile(skillName);
    if (actionsFile) {
      try {
        const actions = JSON.parse(readFileSync(actionsFile, 'utf-8'));
        if (actions.stopping_points && Array.isArray(actions.stopping_points)) {
          const stoppingPoints = actions.stopping_points.map((sp: any) => ({
            id: sp.id ?? 0,
            title: sp.title ?? 'Choose',
            type: sp.type as 'menu' | 'text_input' | undefined,
            capture_as: sp.capture_as,
            options: Object.fromEntries(
              Object.entries(sp.options || {}).map(([key, opt]: [string, any]) => [key, {
                label: opt.label || `Option ${key}`,
                vars: opt.vars || {},
                goto: opt.goto,
                steps: (opt.steps || []).map((s: any, i: number) => ({
                  ...stepFromJson(s, i),
                })),
              }])
            ),
          })) as StoppingPoint[];

          const initialSteps = actions.initial_steps?.map((s: any, i: number) =>
            stepFromJson(s, i, 'init'),
          ) as WorkflowStep[] | undefined;

          console.error(`[Workflow] loaded actions.json for "${skillName}" (${stoppingPoints.length} stopping points${initialSteps?.length ? `, ${initialSteps.length} initial steps` : ''})`);
          activeWorkflows.set(conversationId, {
            skillName, topic,
            options: stoppingPoints[0].options,
            stoppingPoints, initialSteps,
            initialStepsRan: false, currentPhase: 0,
            variables: { TOPIC: topic }, step: 'menu',
          });
          return true;
        }
      } catch (err) {
        console.error(`[Workflow] failed to parse actions.json for "${skillName}": ${err}`);
      }
    }
  }

  // Priority 0: Unified format in markdown — <!-- AGENT_ACTIONS: {"stopping_points": [...]} -->
  const unified = parseUnifiedActions(oiResults);
  if (unified && unified.stoppingPoints.length > 0) {
    const hasInitial = unified.initialSteps && unified.initialSteps.length > 0;
    console.error(`[Workflow] detected unified AGENT_ACTIONS in "${skillName}" (${unified.stoppingPoints.length} stopping points${hasInitial ? `, ${unified.initialSteps!.length} initial steps` : ''})`);
    activeWorkflows.set(conversationId, {
      skillName,
      topic,
      options: unified.stoppingPoints[0].options,
      stoppingPoints: unified.stoppingPoints,
      initialSteps: unified.initialSteps,
      initialStepsRan: false,
      currentPhase: 0,
      variables: { TOPIC: topic },
      step: 'menu',
    });
    return true;
  }

  // Priority 1: Legacy format — <!-- AGENT_ACTIONS_N: {...} -->
  const inlineOptions = parseInlineActions(oiResults);
  if (inlineOptions && Object.keys(inlineOptions).length > 0) {
    console.error(`[Workflow] detected legacy AGENT_ACTIONS in "${skillName}" (${Object.keys(inlineOptions).length} options)`);
    activeWorkflows.set(conversationId, {
      skillName,
      topic,
      options: inlineOptions,
      currentPhase: 0,
      variables: { TOPIC: topic },
      step: 'menu',
    });
    return true;
  }

  // Priority 2: Check static workflows.json configs
  for (const [skillName, config] of Object.entries(staticWorkflows)) {
    const lowerResults = oiResults.toLowerCase();
    const lowerQuery = originalQuery.toLowerCase();

    const skillDetected = lowerResults.includes(`skill: ${skillName}`) ||
      lowerResults.includes(skillName) ||
      config.detect.some(trigger => lowerQuery.includes(trigger));

    if (skillDetected && config.menu_options) {
      const topic = extractTopic(originalQuery, config.detect);
      console.error(`[Workflow] detected static workflow "${skillName}", topic: "${topic}"`);

      activeWorkflows.set(conversationId, {
        skillName,
        topic,
        options: staticToOptions(config),
        currentPhase: 0,
        variables: { TOPIC: topic },
        step: 'menu',
      });
      return true;
    }
  }

  return false;
}

/**
 * Check if user message is a workflow choice.
 * If so, execute the corresponding tool sequence and return results.
 * Returns null if not a workflow choice.
 */
export async function handleWorkflowChoice(
  conversationId: string,
  message: string,
  onEvent: StreamCallback
): Promise<string | null> {
  const workflow = activeWorkflows.get(conversationId);
  if (!workflow || workflow.step !== 'menu') {
    console.error(`[Workflow] handleWorkflowChoice: no workflow or not in menu state (workflow=${!!workflow}, step=${workflow?.step})`);
    return null;
  }

  const choice = message.trim();
  // Answered. Clear BEFORE the option's steps run, not after: the steps can take
  // a minute, and until the row is cleared another surface can answer the same
  // question and run it twice.
  // The invocation this answer continues. Read BEFORE answering, because
  // answering clears the ask that identifies it.
  let continuingGroup: string | undefined;
  // The run this answer belongs to. Read HERE, before `answerAsk` clears the
  // ask that identifies it, so the last-phase path below can close the record.
  let answeredRunId: string | undefined;
  try {
    const live = findLiveRunForConversation(conversationId);
    if (live) { continuingGroup = groupIdForRun(live.run_id); answeredRunId = live.run_id; }
    // `answerAsk`, not `clearAsk`: answering restores the outcome the run parked
    // FROM, so a phase whose branches partly failed does not come back as
    // `complete` just because someone pressed a button.
    if (live?.pending_ask_json) answerAsk(live.run_id);
  } catch { /* an un-cleared ask is recoverable; a thrown reply is not */ }

  // Check if current phase is a text_input type — capture any input as a variable
  const currentSP = workflow.stoppingPoints?.[workflow.currentPhase];
  console.error(`[Workflow] handleWorkflowChoice: phase=${workflow.currentPhase}, type=${currentSP?.type || 'menu'}, input="${choice.substring(0, 50)}"`);
  if (currentSP?.type === 'text_input' && currentSP.capture_as) {
    workflow.variables[currentSP.capture_as] = choice;
    console.error(`[Workflow] text_input captured ${currentSP.capture_as} = "${choice.substring(0, 80)}"`);

    // Advance to next phase
    if (workflow.stoppingPoints && workflow.currentPhase < workflow.stoppingPoints.length - 1) {
      workflow.currentPhase++;
      persistSkillConsolePhase(workflow, workflow.currentPhase);
      const nextSP = workflow.stoppingPoints[workflow.currentPhase];
      workflow.options = nextSP.options || {};
      workflow.step = 'menu';
      announceAsk(workflow, conversationId, onEvent);

      const resolveVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);

      if (nextSP.type === 'text_input') {
        // Next phase is also text input — show the prompt
        const prompt = resolveVars(nextSP.title);
        console.error(`[Workflow] advancing to text_input phase ${workflow.currentPhase}: "${nextSP.title}"`);
        return '__MENU_ONLY__\n\n' + prompt + '\n\n*(Type your answer)*';
      }

      // Next phase is a menu
      let menu = '';
      const resolvedTitle = resolveVars(nextSP.title);
      menu += `\n\n## ${resolvedTitle}\n\n`;
      for (const [key, opt] of Object.entries(nextSP.options)) {
        const resolvedLabel = resolveVars(opt.label);
        menu += `${key}. ${resolvedLabel}\n`;
      }
      console.error(`[Workflow] advancing to phase ${workflow.currentPhase}: "${nextSP.title}"`);
      return '__MENU_ONLY__' + menu;
    }

    // Last phase — done
    workflow.step = 'complete';
    persistSkillConsolePhase(workflow, workflow.stoppingPoints?.length ?? workflow.currentPhase + 1);
    activeWorkflows.delete(conversationId);
    return '__MENU_ONLY__\n\nDone!';
  }

  // Match by number or label (standard menu phase)
  let selectedOption: WorkflowOption | undefined;
  let selectedKey: string | undefined;

  if (workflow.options[choice]) {
    selectedOption = workflow.options[choice];
    selectedKey = choice;
  } else {
    // B16 — the old rule was `lowerChoice.includes(key) || label.includes(input)`.
    // `includes(key)` selected option 1 for ANY sentence containing the
    // character "1" ("add 12 items"), and a label containing the input let a
    // single letter pick an option. Now: the input STARTS with the key as a
    // whole token ("2 no add it to #alpha" → 2, "12" → nothing), or the input
    // IS the label as whole words. Nothing looser — an approval gate is the
    // one place a generous parser is a liability.
    const lowerChoice = choice.toLowerCase();
    for (const [key, opt] of Object.entries(workflow.options)) {
      const startsWithKey = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[\\s.):,-]|$)').test(lowerChoice);
      const isLabel = lowerChoice === opt.label.toLowerCase().trim();
      if (startsWithKey || isLabel) {
        selectedOption = opt;
        selectedKey = key;
        break;
      }
    }
  }

  if (!selectedOption) {
    // B16 — a parked menu that gets a reply it cannot match MUST re-show the
    // menu, for every workflow origin. This branch used to fire only for
    // `skill_console`; a graph run fell to `return null`, which chat() reads as
    // "not a menu reply" and routes to a MODEL. The model then narrated the
    // choice it imagined was made — including, live, that an approval gate
    // had been switched off. It had not. A gate's reply never reaches a model.
    if (workflow.step === 'menu' && currentSP?.type !== 'text_input') {
      const menu = formatStoppingPointMenu(workflow);
      const hint =
        'That did not match any option. Reply with **1**, **2**, … (the numbers shown below), or type `/menu` to see this list again.\n\n';
      return '__MENU_ONLY__\n\n' + (menu ? hint + menu : '*(No menu options — check skill configuration.)*');
    }
    return null;
  }

  console.error(`[Workflow] user selected option ${selectedKey}: ${selectedOption.label}`);

  // Inject option-level variables
  if (selectedOption.vars) {
    for (const [key, value] of Object.entries(selectedOption.vars)) {
      workflow.variables[key] = value;
    }
  }
  workflow.variables.SELECTED_LABEL = selectedOption.label;
  workflow.step = 'executing';

  // Execute the option's steps
  try {
    const results = await executeSteps(
      selectedOption.steps, workflow.variables, onEvent, conversationId,
      workflow.skillName || 'workflow', continuingGroup,
    );

    // Multi-phase: advance to next stopping point if there are more
    // Support "goto" — jump to a specific stopping point ID instead of sequential advance
    if (workflow.stoppingPoints && workflow.currentPhase < workflow.stoppingPoints.length - 1) {
      if (selectedOption.goto !== undefined) {
        const targetIdx = workflow.stoppingPoints.findIndex(sp => sp.id === selectedOption.goto);
        if (targetIdx >= 0) {
          workflow.currentPhase = targetIdx;
          console.error(`[Workflow] goto: jumped to stopping point id=${selectedOption.goto} (phase ${targetIdx})`);
        } else {
          workflow.currentPhase++;
          console.error(`[Workflow] goto: target id=${selectedOption.goto} not found, advancing sequentially`);
        }
      } else {
        workflow.currentPhase++;
      }
      persistSkillConsolePhase(workflow, workflow.currentPhase);
      const nextSP = workflow.stoppingPoints[workflow.currentPhase];
      workflow.options = nextSP.options;
      workflow.step = 'menu';
      announceAsk(workflow, conversationId, onEvent);
      console.error(`[Workflow] advancing to phase ${workflow.currentPhase}: "${nextSP.title}"`);

      // Build the next stopping point menu — formatStoppingPointMenu resolves
      // {{VAR}} in titles/labels AND handles both option menus and text_input
      // prompts (which have no options, so the old inline builder rendered an
      // empty menu). It reads workflow.currentPhase, which we just advanced.
      const menu = formatStoppingPointMenu(workflow);

      // Always stream the menu directly (no LLM re-interpretation).
      // If there were tool results, prepend them so the LLM formats those,
      // then append the menu after a stable __MENU_FOLLOWS__ token so chat()
      // can split results from menu deterministically (no whitespace coupling).
      if (results.trim()) {
        return '__RESULTS_AND_MENU__' + results + '__MENU_FOLLOWS__' + menu;
      } else {
        return '__MENU_ONLY__' + menu;
      }
    }

    // Single phase or last phase — done
    workflow.step = 'complete';
    persistSkillConsolePhase(workflow, workflow.stoppingPoints?.length ?? workflow.currentPhase + 1);
    activeWorkflows.delete(conversationId);
    // Close the RUN RECORD too. The workflow was deleted and the person got
    // "Done — you chose No", but the graph_runs row stayed `running` — proven
    // on Telegram 2026-08-26 (run 06368aa4). Reconcile would later mislabel it
    // `failed` at the next restart. Same shape as B4 and B17: opened at start,
    // closed on one path only. A declined gate is a completed run that ran
    // nothing; a last phase that ran steps is complete as well — executeSteps
    // only closes at a join or graph_done, which a last-phase option need not
    // reach. `answeredRunId` was read before the ask was cleared.
    if (answeredRunId) {
      try { finishRun(answeredRunId, 'complete'); } catch { /* the record is best-effort; the answer is not */ }
    }
    // B16 — an option with no steps (a "No", a "Cancel") produced EMPTY results
    // here, and chat() treats an empty workflow result as "nothing happened"
    // and dispatches the user's ORIGINAL message to a model. The run was
    // already answered and closed; the model was handed the leftover words and
    // wrote a table about them. An answer that ran nothing says so, in the
    // menu-only shape chat() streams verbatim, so no model is ever consulted.
    if (!results.trim()) {
      return `__MENU_ONLY__\n\nDone — you chose "${selectedOption.label}". Nothing was run.`;
    }
    return results;
  } catch (err) {
    console.error(`[Workflow] execution error: ${err}`);
    activeWorkflows.delete(conversationId);
    return `Workflow execution failed: ${err}`;
  }
}

/**
 * Headless workflow advance for the BOARD path (Layer 2).
 *
 * Unlike `handleWorkflowChoice`, this does NOT touch the in-memory
 * `activeWorkflows` Map or `persistSkillConsolePhase` (gateway skills_meta) — it
 * operates purely on the workflow object handed to it, which the caller loads
 * from / saves to `board_workflow_state`. It applies one user choice, runs that
 * branch's steps, and reports whether the workflow parked at the next stopping
 * point or completed. The caller owns persistence + task-status transitions.
 */
export interface BoardAdvanceResult {
  status: 'parked' | 'complete' | 'no_match';
  /** Tool/step output produced by the chosen branch (may be empty). */
  results?: string;
  /** Rendered menu for the next stopping point (status === 'parked'). */
  menu?: string;
  /** The next stopping point the workflow is now parked at (status === 'parked'). */
  stoppingPoint?: StoppingPoint;
  /** New currentPhase after the advance (status === 'parked'). */
  phase?: number;
}

export async function advanceBoardWorkflow(
  workflow: ActiveWorkflow,
  choice: string,
  onEvent: StreamCallback,
  conversationId: string = '',
): Promise<BoardAdvanceResult> {
  const input = (choice ?? '').trim();
  const currentSP = workflow.stoppingPoints?.[workflow.currentPhase];
  const resolveVars = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);

  // ── text_input phase: capture the free-text answer, then advance. ──
  if (currentSP?.type === 'text_input' && currentSP.capture_as) {
    workflow.variables[currentSP.capture_as] = input;
    return advanceToNextOrComplete(workflow, '', resolveVars);
  }

  // ── menu phase: match the choice by number or label. ──
  let selectedOption: WorkflowOption | undefined;
  let selectedKey: string | undefined;
  if (workflow.options[input]) {
    selectedOption = workflow.options[input];
    selectedKey = input;
  } else {
    const lower = input.toLowerCase();
    for (const [key, opt] of Object.entries(workflow.options)) {
      if (opt.label.toLowerCase().includes(lower) || lower.includes(key)) {
        selectedOption = opt; selectedKey = key; break;
      }
    }
  }
  if (!selectedOption) {
    console.error(`[Workflow] advanceBoardWorkflow: no option matched "${input.substring(0, 40)}" at phase ${workflow.currentPhase}`);
    return { status: 'no_match' };
  }
  console.error(`[Workflow] advanceBoardWorkflow: selected ${selectedKey} (${selectedOption.label})`);

  // Inject option-level variables.
  if (selectedOption.vars) {
    for (const [k, v] of Object.entries(selectedOption.vars)) workflow.variables[k] = v;
  }
  workflow.variables.SELECTED_LABEL = selectedOption.label;
  workflow.step = 'executing';

  // Run the chosen branch's steps, then advance (honoring `goto`).
  const results = await executeSteps(selectedOption.steps, workflow.variables, onEvent, conversationId);
  return advanceToNextOrComplete(workflow, results, resolveVars, selectedOption.goto);
}

/** Shared tail of advanceBoardWorkflow: move to the next stopping point or complete. */
function advanceToNextOrComplete(
  workflow: ActiveWorkflow,
  results: string,
  resolveVars: (s: string) => string,
  goto?: number,
): BoardAdvanceResult {
  const sps = workflow.stoppingPoints;
  if (sps && workflow.currentPhase < sps.length - 1) {
    if (goto !== undefined) {
      const idx = sps.findIndex(sp => sp.id === goto);
      workflow.currentPhase = idx >= 0 ? idx : workflow.currentPhase + 1;
      if (idx < 0) console.error(`[Workflow] advanceBoardWorkflow: goto id=${goto} not found, advancing sequentially`);
    } else {
      workflow.currentPhase++;
    }
    const nextSP = sps[workflow.currentPhase];
    workflow.options = nextSP.options || {};
    workflow.step = 'menu';
    const menu = formatStoppingPointMenu(workflow);
    console.error(`[Workflow] advanceBoardWorkflow: parked at phase ${workflow.currentPhase} ("${nextSP.title}")`);
    return { status: 'parked', results, menu, stoppingPoint: nextSP, phase: workflow.currentPhase };
  }
  // Last phase (or single phase) — workflow complete.
  workflow.step = 'complete';
  return { status: 'complete', results };
}

/** Re-display the current phase menu for slash /menu (skill console Layer B). */
export function getActiveWorkflowMenuMarkdown(conversationId: string): string | null {
  const workflow = activeWorkflows.get(conversationId);
  if (!workflow || workflow.step !== 'menu' || !workflow.stoppingPoints?.length) return null;
  return formatStoppingPointMenu(workflow);
}

/**
 * Rolling window for `together:` blocks. Not a cap on branch count — a 12-branch
 * group runs as three batches of four. Four is `core_limit` from the scheduler's
 * process valve, and past it most fans are sharing a server or an LLM backend
 * anyway. `vodou-core` enforces the same default; this is the gateway's say.
 */
const GRAPH_WIDTH = Number(process.env.VODOU_GRAPH_WIDTH) > 0 ? Number(process.env.VODOU_GRAPH_WIDTH) : 4;

/**
 * The canonical TEXT form of a group's result. Every DOM-less surface — side
 * panel, Telegram, `./do` — shows exactly this; the web run card is a
 * progressive enhancement of it, never a different set of facts.
 */
function renderGroupOutcome(outcome: GroupOutcome): string {
  const lines: string[] = [];
  for (const r of outcome.results) {
    const mark = r.state === 'ok' ? '✓' : '✗';
    const detail = r.state === 'ok' ? `${r.elapsed_ms}ms` : `${r.error || r.state}`;
    lines.push(`  ${mark} ${r.id}  ${r.server}·${r.tool}  ${detail}`);
  }
  lines.push(`Join: ${outcome.ok}/${outcome.expected} settled (${outcome.elapsed_ms}ms total)`);
  if (outcome.serialized_servers.length) {
    lines.push(`ⓘ same server — one at a time: ${outcome.serialized_servers.join(', ')}`);
  }
  return lines.join('\n');
}

/** One recorded branch, as a join sees it: id and terminal state, nothing else. */
export interface JoinBranch {
  id: string;
  state: 'ok' | 'failed' | 'timeout';
}

export interface JoinVerdict {
  ok: number;
  settled: number;
  expected: number;
  met: boolean;
  line: string;
}

/**
 * THE join arithmetic, gateway copy.
 *
 * `src/graph_group.rs::compute_join` is the CLI copy, and BOTH are tested
 * against `tests/fixtures/graph-skills/join-arithmetic.json`. The failure this
 * guards is not a crash: it is the terminal saying `2/3` while the web run card
 * says `2/2` about the same run. `minSuccess === undefined` means all of them.
 */
export function computeJoin(
  joinId: string,
  names: string[],
  branches: JoinBranch[],
  minSuccess?: number,
): JoinVerdict {
  const expected = names.length;
  const counted = branches.filter((b) => names.includes(b.id));
  const settled = counted.length;
  const ok = counted.filter((b) => b.state === 'ok').length;
  const min = minSuccess ?? expected;
  const met = ok >= min;

  // Recipe order, not completion order, so one run always reads the same way.
  const missing = names
    .map((n) => counted.find((b) => b.id === n))
    .filter((b): b is JoinBranch => !!b && b.state !== 'ok')
    .map((b) => `${b.id} (${b.state})`);

  let line = `Join ${joinId}: ${ok}/${expected} succeeded`;
  if (settled !== expected) line += `, ${settled}/${expected} settled`;
  if (min !== expected) line += ` — needed ${min}`;
  if (missing.length) line += ` — missing: ${missing.join(', ')}`;

  return { ok, settled, expected, met, line };
}

/**
 * Execute a sequence of workflow steps.
 * Handles loops, variable capture/chaining, and progress streaming.
 */
export async function executeSteps(
  steps: WorkflowStep[],
  variables: Record<string, string>,
  onEvent: StreamCallback,
  conversationId: string = '',
  /** Names the run record (PLAN-GRAPH-SKILLS P0). Optional so every existing
   *  caller keeps working; a run then records as the generic 'workflow'. */
  runSkillName: string = 'workflow',
  /** The invocation this execution continues, when it continues one. Passed
   *  EXPLICITLY rather than inferred from a time window: the caller answering a
   *  menu is the only thing that actually knows two phases are one run. */
  parentRunId?: string,
  /**
   * Where this execution is happening, and what it belongs to.
   *
   * item 14 — the Board ran graphs that recorded `surface: 'web'` with a null
   * `board_task_id`, so 0 of 1221 runs could ever be traced back to the task
   * that caused them. An options bag rather than two more positional
   * parameters: every existing caller keeps working unchanged.
   */
  opts?: { surface?: string; boardTaskId?: string | null },
): Promise<string> {
  const allResults: string[] = [];

  /**
   * Outcomes of every `together:` block run so far, keyed by group name, so a
   * later `kind: 'join'` step counts from RECORDED BRANCH STATES rather than
   * from anything a model wrote. Coherence Rule 9: the number the user sees and
   * the number the system stored are the same number.
   */
  const groupOutcomes = new Map<string, GroupOutcome>();
  const handledGroups = new Set<string>();
  /** Opened lazily at the first `together:` block; a chain-only skill opens none. */
  let runId = '';
  const runStartedMs = Date.now();
  /**
   * The lines that must reach the user EXACTLY as recorded — join counts, check
   * verdicts, named failures.
   *
   * Everything else in `allResults` is handed to a model to write up, which is
   * right for tool payloads and wrong for these: a count the model restates is
   * a count it can round, soften or drop, and then the transcript that channels
   * replay and memory extracts disagrees with what actually happened. The web
   * run card reads the structured events and is safe; the TEXT path was not.
   * These are streamed verbatim so every surface sees the recorded number.
   */
  const canonical: string[] = [];

  for (const step of steps) {
    // ---- SCHEMA 1.1: `together:` block ------------------------------------
    // Fired once, at its first member. Every member of the group runs in ONE
    // `vodou-core call-group` process (see runVodouCoreGroup for why that is
    // not negotiable), then execution continues at the step after the last
    // member.
    if (step.parallel_group && step.kind !== 'join') {
      const groupName = step.parallel_group;
      if (handledGroups.has(groupName)) continue;
      handledGroups.add(groupName);

      // B8 — a fan is EVERY member of the block, not only the tool calls.
      //
      // This filter used to be the whole story: a prose step in `together:`
      // (a `plan:` line, a `summary:` the compiler moved up for having no
      // dependency) was dropped here before the fan ran. A prose-only fan
      // reached `vodou-core call-group` with zero steps — "group spec has no
      // steps" — and a mixed fan silently lost its prose branches while the
      // join still counted the full block as `expected`. The runner only runs
      // tool calls (GroupStepOutcome is server+tool), so prose members run
      // through the SAME LLM path a `then:` prose step uses, concurrently
      // with the group, and settle into the same outcome rows. One fan.
      const fanMembers = steps.filter((s) => s.parallel_group === groupName && s.kind !== 'join');
      const members = fanMembers.filter((s) => s.server && s.tool);
      const proseMembers = fanMembers.filter((s) => !(s.server && s.tool) && typeof s.prompt === 'string' && s.prompt.trim());
      const groupToolId = `wf_group_${groupName}_${Date.now()}`;
      const startMs = Date.now();

      // One run record per execution, opened at the first group (H3). Later
      // groups in the same option join the same run.
      if (!runId) {
        runId = startRun({
          skill: runSkillName,
          steps,
          surface: opts?.surface ?? 'web',
          conversationId: conversationId || null,
          parentRunId: parentRunId ?? null,
          boardTaskId: opts?.boardTaskId ?? null,
        });
      }

      // Branches are recorded as `running` BEFORE the fan starts. If the
      // gateway dies mid-fan, the row already names what was in flight — the
      // run reports the truth instead of vanishing (H20).
      const pending: BranchRecord[] = [
        ...members.map((m, idx) => ({
          id: m.id || `step_${idx}`,
          group: groupName,
          server: m.server,
          tool: m.tool,
          state: 'running' as const,
        })),
        ...proseMembers.map((m, idx) => ({
          id: m.id || `prose_${idx}`,
          group: groupName,
          server: 'llm',
          tool: m.id || `prose_${idx}`,
          state: 'running' as const,
        })),
      ];
      recordBranches(runId, pending);

      onEvent({
        type: 'tool_call_start',
        toolName: `together → ${groupName}`,
        toolId: groupToolId,
        toolArgs: {
          status: `${members.length} branches, ${GRAPH_WIDTH} at a time`,
          branches: members.map((m) => m.id || `${m.server}::${m.tool}`),
        },
      });

      // Structured twin of the chip above: the run card reads THIS, never the
      // chip text (H2).
      onEvent({
        type: 'graph_branch',
        graph: {
          runId,
          skill: runSkillName,
          group: groupName,
          width: GRAPH_WIDTH,
          branches: pending.map((b) => ({
            id: b.id,
            server: b.server,
            tool: b.tool,
            state: 'running' as const,
          })),
        },
      });

      try {
        // Prose branches start NOW, alongside the tool group — that is what
        // "together" means. Each resolves {{VAR}} and {branch} the way a
        // `then:` prose step does and lands as a GroupStepOutcome row.
        const proseRuns = proseMembers.map(async (m, idx): Promise<import('./executor.js').GroupStepOutcome> => {
          const id = m.id || `prose_${idx}`;
          const t0 = Date.now();
          try {
            const priorContext = allResults.length
              ? `\n\n## Output from earlier steps\n\n${allResults.join('\n\n')}`
              : '';
            const resolved = String(resolveTemplate(String(m.prompt), variables)) + priorContext;
            const out = (await rawLLMCallPooled(conversationId, resolved)) || '';
            return { id, server: 'llm', tool: id, state: out.trim() ? 'ok' : 'failed', elapsed_ms: Date.now() - t0, lane_wait_ms: 0, result: out, ...(out.trim() ? {} : { error: 'empty output' }) };
          } catch (err) {
            return { id, server: 'llm', tool: id, state: 'failed', elapsed_ms: Date.now() - t0, lane_wait_ms: 0, error: err instanceof Error ? err.message : String(err) };
          }
        });

        // A prose-only fan has nothing for the runner; do not ask it to run
        // nothing (that is the "group spec has no steps" it rightly refused).
        const groupRun = members.length
          ? runVodouCoreGroup({
              group: groupName,
              width: GRAPH_WIDTH,
              steps: members.map((m, idx) => ({
                id: m.id || `step_${idx}`,
                server: m.server as string,
                tool: m.tool as string,
                args: resolveTemplate(m.args, variables) as Record<string, unknown>,
                on_fail: m.on_fail,
                timeout_ms: m.timeout_ms,
              })),
            })
          : Promise.resolve<import('./executor.js').GroupOutcome>({ width: GRAPH_WIDTH, expected: 0, settled: 0, ok: 0, failed: 0, elapsed_ms: 0, serialized_servers: [], results: [] });

        // The tool half is ONE engine process for the whole block. If that
        // process cannot START (binary missing, wrong platform, ENOEXEC), the
        // promise rejects — and until 2026-08-27 that rejection fell through to
        // the catch below, which records the WHOLE fan as zero-settled. But the
        // prose branches never went near that process: they run here, in the
        // gateway, and had already produced their text. CI found it (the
        // committed binary is macOS/arm64; ubuntu cannot exec it): the B8 fan
        // reported "0/2 settled" while `plan` sat finished in memory. A
        // transport failure in one member must settle THAT member as failed and
        // leave its siblings' results standing — the same contract the engine
        // gives a branch whose tool returns an error.
        const [toolOutcome, proseOutcomes] = await Promise.all([
          groupRun.catch((err: unknown): import('./executor.js').GroupOutcome => {
            const reason = `engine unavailable: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[Workflow] group ${groupName} tool branches could not start — ${reason}`);
            return {
              group: groupName,
              width: GRAPH_WIDTH,
              expected: members.length,
              settled: members.length,
              ok: 0,
              failed: members.length,
              elapsed_ms: Date.now() - startMs,
              serialized_servers: [],
              results: members.map((m, idx) => ({
                id: m.id || `step_${idx}`,
                server: String(m.server),
                tool: String(m.tool),
                state: 'failed',
                elapsed_ms: Date.now() - startMs,
                lane_wait_ms: 0,
                error: reason,
                on_fail: m.on_fail,
              })),
            };
          }),
          Promise.all(proseRuns),
        ]);
        const merged = [...toolOutcome.results, ...proseOutcomes];
        // The join counts from THESE. Copying the runner's counts would report
        // the tool subset against a block-wide `expected` — the B8 miscount.
        const outcome: import('./executor.js').GroupOutcome = {
          ...toolOutcome,
          results: merged,
          expected: merged.length,
          settled: merged.length,
          ok: merged.filter((r) => r.state === 'ok').length,
          failed: merged.filter((r) => r.state !== 'ok').length,
          elapsed_ms: Math.max(toolOutcome.elapsed_ms, ...proseOutcomes.map((r) => r.elapsed_ms), 0),
        };
        // A single-brace `{plan}` is a REFERENCE, not a template: the compiler
        // turns it into a `depends_on` edge and the branch's text reaches the
        // dependent step through `priorContext` — the same way a tool branch's
        // does, via the allResults push below. This line serves the OTHER form:
        // `{{plan}}`, which resolveTemplate substitutes from `variables`.
        for (const r of proseOutcomes) if (r.state === 'ok' && typeof r.result === 'string') variables[r.id] = r.result;
        groupOutcomes.set(groupName, outcome);

        const settledRecords: BranchRecord[] = outcome.results.map((r) => ({
          id: r.id,
          group: groupName,
          server: r.server,
          tool: r.tool,
          state: r.state,
          elapsed_ms: r.elapsed_ms,
          lane_wait_ms: r.lane_wait_ms,
          error: r.error,
        }));
        recordBranches(runId, settledRecords);
        onEvent({
          type: 'graph_branch',
          graph: {
            runId,
            group: groupName,
            width: outcome.width,
            elapsedMs: outcome.elapsed_ms,
            serializedServers: outcome.serialized_servers,
            branches: outcome.results.map((r) => ({
              id: r.id,
              server: r.server,
              tool: r.tool,
              state: r.state,
              elapsed_ms: r.elapsed_ms,
              lane_wait_ms: r.lane_wait_ms,
              error: r.error,
            })),
          },
        });

        // Per-branch capture, so a `then:` step can read what a branch produced.
        for (const branch of outcome.results) {
          const member = members.find((m, idx) => (m.id || `step_${idx}`) === branch.id);
          if (!member?.capture || branch.state !== 'ok') continue;
          const asText =
            typeof branch.result === 'string' ? branch.result : JSON.stringify(branch.result ?? '');
          for (const [varName, fieldPath] of Object.entries(member.capture)) {
            const value = extractField(asText, fieldPath);
            if (value) variables[varName] = value;
            else
              console.error(
                `[Workflow] group ${groupName}: failed to capture ${varName} from "${fieldPath}" on branch ${branch.id}`,
              );
          }
        }

        onEvent({
          type: 'tool_call_end',
          toolName: `together → ${groupName}`,
          toolId: groupToolId,
          toolResult: renderGroupOutcome(outcome),
          executionTime: Date.now() - startMs,
          // The GROUP ran successfully even when branches failed. Whether that
          // is acceptable is the join's decision, not this chip's.
          success: true,
        });

        // The branch PAYLOADS, not just the tick marks.
        //
        // This block used to push only `renderGroupOutcome` — the status lines.
        // A `then:` step reads `allResults` as its prior context, so a briefing
        // written "from {calendar, mail, slack}" was handed
        // `✓ calendar … 2517ms` and no calendar events. It would have written a
        // briefing out of nothing and looked like it worked. Sequential steps
        // have always pushed their full result; a fan silently did not.
        for (const branch of outcome.results) {
          if (branch.state !== 'ok') continue;
          const body =
            typeof branch.result === 'string' ? branch.result : JSON.stringify(branch.result ?? '');
          if (!body.trim()) continue;
          allResults.push(
            `### ${branch.server}::${branch.tool} (${branch.id}, ${branch.elapsed_ms}ms)\n${body}`,
          );
        }
        // The summary goes LAST so the counts are the final word on the fan,
        // sitting immediately before whatever reads it.
        const summary = renderGroupOutcome(outcome);
        // The counts belong here as well as in `canonical`, and that is not
        // duplication to be optimised away: a `then:` step READS this text, and
        // graph-fan-payload.test.ts pins it ("expected … to contain 'Join: 1/2
        // settled'"). Withholding it to stop the model restating the join broke
        // that contract immediately.
        //
        // Also tried and worse: annotating the entry with "(already reported —
        // do not restate)". `allResults` is ALSO the source of the remembered run
        // note, so the instruction landed in the user's MEMORY verbatim.
        allResults.push(`### together → ${groupName}\n${summary}`);
        canonical.push(summary);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Workflow] group ${groupName} FAILED: ${errMsg}`);
        onEvent({
          type: 'tool_call_end',
          toolName: `together → ${groupName}`,
          toolId: groupToolId,
          toolResult: `Error: ${errMsg}`,
          executionTime: Date.now() - startMs,
          success: false,
        });
        // A group that could not run at all is recorded as zero-settled so a
        // downstream join blocks instead of synthesizing from nothing.
        groupOutcomes.set(groupName, {
          group: groupName,
          width: GRAPH_WIDTH,
          expected: members.length,
          settled: 0,
          ok: 0,
          failed: members.length,
          elapsed_ms: Date.now() - startMs,
          serialized_servers: [],
          results: [],
        });
        recordBranches(
          runId,
          members.map((m, idx) => ({
            id: m.id || `step_${idx}`,
            group: groupName,
            server: m.server,
            tool: m.tool,
            state: 'failed' as const,
            error: errMsg,
          })),
        );
        allResults.push(`### together → ${groupName} (FAILED)\nError: ${errMsg}`);
      }
      continue;
    }

    // ---- SCHEMA 1.1: verifier gate (P2 §7) --------------------------------
    // The most valuable node produces nothing. This one adds no content; its
    // only job is to stop weak work moving downstream.
    if (step.kind === 'verifier') {
      const vId = step.id || 'check';
      // FRESH CONTEXT IS ENFORCED, NOT DECLARED. A verifier that shares the
      // worker's conversation is the worker agreeing with itself in a different
      // font. Nothing below passes `conversationId` to a model, and a verifier
      // that arrives without the flag set is refused outright rather than run
      // as a weaker check — a gate that quietly downgrades itself is not a gate.
      if (step.fresh_context !== true) {
        const msg = `verifier "${vId}" is missing fresh_context: true — refusing to run it`;
        console.error(`[Workflow] ${msg}`);
        onEvent({
          type: 'graph_check',
          graph: { runId: runId || undefined, joinId: vId, met: false, line: msg },
        });
        allResults.push(`### check → ${vId} (REFUSED)\n${msg}`);
        if (runId) finishRun(runId, 'blocked');
        return allResults.join('\n\n');
      }

      // The verifier sees the ARTIFACT — what the run produced — and nothing
      // about how it was produced.
      const artifact = allResults.join('\n\n');
      const verdicts: CheckVerdict[] = [];
      for (const c of step.checks || []) {
        let v = await runCheck(c.rule, artifact);
        if (v.verdict === 'needs_judge' && v.prompt) {
          // No anchored answer exists, so a model judges — on a brand new call
          // that has never seen this conversation. `rawLLMCall`, deliberately,
          // not the pooled variant that carries a conversation id.
          try {
            const reply = await rawLLMCall(v.prompt);
            const head = (reply || '').trim().toUpperCase();
            v = head.startsWith('PASS') || head.startsWith('YES')
              ? { check: v.check, verdict: 'pass', detail: 'judged sound' }
              : head.startsWith('FAIL') || head.startsWith('NO')
                ? { check: v.check, verdict: 'fail', detail: (reply || '').trim().slice(0, 400) }
                : { check: v.check, verdict: 'unknown', detail: `the judge did not answer in the required shape: ${(reply || '').trim().slice(0, 120)}` };
          } catch (e) {
            v = { check: v.check, verdict: 'unknown', detail: `the judge could not be reached: ${e}` };
          }
        }
        verdicts.push({ ...v, check: `${c.check}: ${c.rule}` });
      }

      const failed = verdicts.filter((v) => v.verdict === 'fail');
      const unknown = verdicts.filter((v) => v.verdict === 'unknown');
      const line =
        `Check ${vId}: ${verdicts.length - failed.length - unknown.length}/${verdicts.length} passed` +
        (failed.length ? ` — FAILED: ${failed.map((f) => f.detail).join('; ').slice(0, 300)}` : '') +
        // Unknown is reported loudly and does NOT block: stopping on "I could
        // not tell" would make one flaky judge a wall. Silence about it would
        // be worse — it would read as a pass.
        (unknown.length ? ` — could not tell: ${unknown.map((u) => u.detail).join('; ').slice(0, 200)}` : '');

      onEvent({
        type: 'graph_check',
        graph: { runId: runId || undefined, joinId: vId, met: failed.length === 0, line },
      });
      allResults.push(`### check → ${vId}\n${line}`);
      canonical.push(line);

      if (failed.length) {
        console.error(`[Workflow] verifier ${vId} BLOCKED: ${line}`);
        allResults.push(`### check → ${vId} (STOPPED)\nWork did not pass its own checks.`);
        if (runId) {
          finishRun(runId, 'blocked');
          onEvent({ type: 'graph_done', graph: { runId, outcome: 'blocked', line } });
        }
        return allResults.join('\n\n');
      }
      continue;
    }

    // ---- SCHEMA 1.1: join barrier -----------------------------------------
    if (step.kind === 'join') {
      const joinId = step.id || 'join';
      const names = step.in || [];
      // A join names STEP ids; find the group(s) those branches belong to.
      const sourceGroups = new Set<string>();
      for (const s of steps) {
        if (s.parallel_group && s.id && names.includes(s.id)) sourceGroups.add(s.parallel_group);
      }
      const merged = [...sourceGroups]
        .map((g) => groupOutcomes.get(g))
        .filter((o): o is GroupOutcome => !!o);

      // The count is ALWAYS reported, including on a clean run. A join that only
      // speaks up when something breaks trains people to assume silence means
      // complete — which is exactly how half a briefing looks like a whole one.
      const branchStates: JoinBranch[] = merged
        .flatMap((o) => o.results)
        .map((r) => ({ id: r.id, state: r.state }));
      const verdict = computeJoin(joinId, names, branchStates, step.min_success);
      const { ok: okCount, settled, expected, met, line } = verdict;
      const minSuccess = step.min_success ?? expected;
      const policy = step.on_partial || 'continue_with_warning';

      onEvent({
        type: 'tool_call_start',
        toolName: `join → ${joinId}`,
        toolId: `wf_join_${joinId}_${Date.now()}`,
        toolArgs: { expected, settled, succeeded: okCount, min_success: minSuccess },
      });
      onEvent({
        type: 'tool_call_end',
        toolName: `join → ${joinId}`,
        toolId: `wf_join_${joinId}_${Date.now()}`,
        toolResult: line,
        executionTime: 0,
        success: met,
      });
      allResults.push(`### join → ${joinId}\n${line}`);
      canonical.push(line);

      onEvent({
        type: 'graph_join',
        graph: {
          runId: runId || undefined,
          joinId,
          ok: okCount,
          settled,
          expected,
          minSuccess,
          met,
          line,
        },
      });

      if (!met && (policy === 'block' || policy === 'human')) {
        console.error(`[Workflow] join ${joinId} BLOCKED: ${line}`);
        allResults.push(
          `### join → ${joinId} (STOPPED)\nToo few branches succeeded to continue safely.`,
        );
        if (runId) {
          finishRun(runId, 'blocked');
          onEvent({ type: 'graph_done', graph: { runId, outcome: 'blocked', line } });
        }
        return allResults.join('\n\n');
      }
      if (!met) console.error(`[Workflow] join ${joinId} continuing with partial data: ${line}`);
      continue;
    }

    // A step with no server/tool is a PROMPT step — an instruction for the model
    // (synthesis), not something this function can execute. Every path below builds
    // `${step.server}::${step.tool}`, so such a step became the literal tool call
    // `undefined::undefined`, failed with "tool command requires 'server' and 'tool'
    // in args", and — because failures are appended to allResults like any other
    // result — that raw internal error was RETURNED AS THE SKILL'S OUTPUT.
    //
    // Observed 2026-08-09 on claude.ai: the Face ran `execdesk-action-weekly-brief`
    // (whose only step is a prompt) and injected this into the user's composer:
    //     ### undefined::undefined (FAILED)
    //     Error: tool command requires 'server' and 'tool' in args
    // i.e. Vodou's internal tool-dispatch error, sitting in a third-party chat box.
    //
    // Skip it: the tool executor has nothing to run here. Headless skills whose only
    // steps are prompts now produce NO output rather than error text, so the inject
    // lane stays silent instead of leaking. (Follow-on, deliberately NOT done here:
    // actually executing prompt steps as an LLM synthesis in the headless Face path,
    // which is what would make the weekly brief generate rather than no-op.)
    if (!step.server || !step.tool) {
      const promptText = typeof step.prompt === 'string' ? step.prompt.trim() : '';
      if (!promptText) {
        console.error(
          `[Workflow] skipping non-tool step ${step.id ?? '?'} (no server/tool and no prompt); ` +
          `nothing for the tool executor to run`,
        );
        continue;
      }
      // EXECUTE it as an LLM synthesis. Skipping (the first cut of this fix) stopped
      // the error leak but left the skill useless: `execdesk-action-weekly-brief` is a
      // single prompt step, so the Face delivered "Done." instead of a brief. A skill
      // that fires and produces nothing is not execution, it is theatre.
      // Reuses the same rawLLMCallPooled the {{LLM:…}} field path already uses, and
      // carries prior step output forward so a prompt step can build on what ran before.
      const stepId = String(step.id ?? 'prompt');
      const toolId = `llmstep_${Date.now()}`;
      const startMs = Date.now();
      onEvent({
        type: 'tool_call_start',
        toolName: `LLM → ${stepId}`,
        toolId,
        toolArgs: { status: 'Writing…' },
      });
      try {
        const priorContext = allResults.length
          ? `\n\n## Output from earlier steps\n\n${allResults.join('\n\n')}`
          : '';
        // §3.2 M2 — the node writes in the user's voice without the recipe
        // having to say so. Durable personal facts only; never the parent
        // conversation, and never a query-time memory search (see
        // getMemoryProfile for why the profile and not a search).
        let whoFor = '';
        try {
          const profile = await getMemoryProfile();
          if (profile) whoFor = `\n\n## Who this is for\n\n${profile}\n`;
        } catch {
          /* personalisation is a bonus, never a precondition */
        }
        const resolvedPrompt = String(resolveTemplate(promptText, variables)) + whoFor + priorContext;
        const out = (await rawLLMCallPooled(conversationId, resolvedPrompt)) || '';
        const execTime = Date.now() - startMs;
        onEvent({
          type: 'tool_call_end',
          toolName: `LLM → ${stepId}`,
          toolId,
          toolResult: out.substring(0, 4000),
          executionTime: execTime,
          success: !!out.trim(),
        });
        if (out.trim()) allResults.push(out.trim());
        else console.error(`[Workflow] prompt step ${stepId} returned empty output`);
      } catch (err) {
        const execTime = Date.now() - startMs;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Workflow] prompt step ${stepId} FAILED: ${errMsg}`);
        onEvent({
          type: 'tool_call_end',
          toolName: `LLM → ${stepId}`,
          toolId,
          toolResult: `Error: ${errMsg}`,
          executionTime: execTime,
          success: false,
        });
        // Deliberately NOT pushed to allResults: that is exactly how the internal
        // dispatch error ended up in a third-party composer. A failed synthesis
        // contributes nothing; it must not contribute error text.
      }
      continue;
    }

    const loopCount = step.loop
      ? Number(resolveTemplate(String(step.loop), variables)) || 1
      : 1;

    // Batch pre-generation: if loop > 1 and the step has exactly one {{LLM:...}} field,
    // generate all N items in ONE LLM call instead of N serial spawns.
    // One spawn of 30s beats N × 30s (N=15 → 7.5 min → 30s).
    let batchItems: string[] | null = null;
    if (loopCount > 1 && !step.sequential) {
      const sampleArgs = resolveTemplate({ ...step.args }, { ...variables, i: '1' }) as Record<string, unknown>;
      const llmEntries = Object.entries(sampleArgs).filter(([_, v]) => typeof v === 'string' && LLM_PATTERN.test(v as string));
      console.error(`[Workflow] batch eval: step=${step.id || '?'} loopCount=${loopCount} llmEntries=${llmEntries.length} (keys: ${llmEntries.map(e => e[0]).join(',') || 'none'})`);
      if (llmEntries.length === 1) {
        const sampleStr = llmEntries[0][1] as string;
        const promptMatch = sampleStr.match(LLM_PATTERN);
        console.error(`[Workflow] batch promptMatch=${promptMatch ? 'YES' : 'NULL'} sampleStr.length=${sampleStr.length} startsWith={{LLM:=${sampleStr.startsWith('{{LLM:')} endsWith=}}=${sampleStr.endsWith('}}')}`);
        if (promptMatch) {
          const singlePrompt = promptMatch[1];
          const toolLabel = `${step.server}::${step.tool}`;
          const batchToolId = `llm_batch_${Date.now()}`;
          onEvent({ type: 'tool_call_start', toolName: `LLM → ${toolLabel}`, toolId: batchToolId, toolArgs: { status: `Generating all ${loopCount} thoughts at once...` } });
          // Strict format. Non-Claude providers (Kimi/Fireworks especially) tend to add
          // chain-of-thought prose unless the format constraint is the FIRST AND LAST
          // instruction. We also avoid literal `[` / `]` characters in our INSTRUCTION
          // text — Kimi echoes them back, and a naive regex match would grab the echo
          // instead of the real array.
          const batchPrompt = `Respond with only a JSON array of strings. No prose. No preamble. No markdown fences. No explanation. Just the array literal.\n\nThe array must contain ${loopCount} strings. Each string is one distinct analytical insight (50–200 words) that explores a different angle and builds on the previous ones.\n\nTopic for each insight (write ${loopCount} different responses to this, varying the angle):\n${singlePrompt}\n\nFinal reminder: respond with only the JSON array of ${loopCount} strings. Nothing else.`;
          try {
            const raw = await rawLLMCallPooled(conversationId, batchPrompt, WORKFLOW_SUBGEN_SYSTEM);
            // Find ALL balanced [...] blocks in the response, respecting JSON string
            // quoting. Try each from largest to smallest until one parses as a string
            // array of >= loopCount items. This handles models that echo our prompt
            // text (Kimi/Fireworks) and produces prose before/after the real array.
            const candidates = findBalancedJSONArrays(raw).sort((a, b) => b.length - a.length);
            console.error(`[Workflow] batch raw.length=${raw.length} candidates=${candidates.length} preview=${JSON.stringify(raw.slice(0, 200))}`);
            for (const candidate of candidates) {
              try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed) && parsed.length >= loopCount) {
                  batchItems = parsed.slice(0, loopCount).map(String);
                  console.error(`[Workflow] batch generated ${loopCount} items in one LLM call (candidate ${candidate.length} chars, parsed length=${parsed.length})`);
                  break;
                }
              } catch { /* try next candidate */ }
            }
            if (!batchItems) {
              console.error(`[Workflow] batch: no candidate parsed as Array of >=${loopCount} strings (tried ${candidates.length})`);
            }
          } catch (e) {
            console.error(`[Workflow] batch generation failed, falling back to per-item: ${e}`);
          }
          onEvent({ type: 'tool_call_end', toolName: `LLM → ${toolLabel}`, toolId: batchToolId, success: !!batchItems, executionTime: 0 });
        }
      }
    }

    for (let i = 1; i <= loopCount; i++) {
      variables.i = String(i);

      let resolvedArgs = resolveTemplate(step.args, variables) as Record<string, unknown>;

      // LLM enrichment: resolve {{LLM:prompt}} fields with active provider.
      // If batch pre-generation succeeded, substitute cached items directly.
      const hasLLM = Object.values(resolvedArgs).some(v => typeof v === 'string' && LLM_PATTERN.test(v as string));
      if (hasLLM) {
        const toolLabel = `${step.server}::${step.tool}`;
        if (batchItems) {
          // Use pre-generated batch item — no additional LLM call needed
          for (const [key, value] of Object.entries(resolvedArgs)) {
            if (typeof value === 'string' && LLM_PATTERN.test(value)) {
              resolvedArgs[key] = batchItems[i - 1];
            }
          }
        } else {
          // Per-item fallback: one LLM call per iteration
          const llmToolId = `llm_${Date.now()}`;
          onEvent({ type: 'tool_call_start', toolName: `LLM → ${toolLabel}`, toolId: llmToolId, toolArgs: { status: `Generating thought ${i}/${loopCount}...` } });
          const llmOut = await resolveLLMFields(resolvedArgs, variables, allResults.join('\n\n'), conversationId);
          resolvedArgs = llmOut.resolved;
          // B5: report the REAL outcome, not a hardcoded success.
          onEvent({
            type: 'tool_call_end',
            toolName: `LLM → ${toolLabel}`,
            toolId: llmToolId,
            success: llmOut.ok,
            toolResult: llmOut.ok ? undefined : 'model generation failed for this step',
            executionTime: 0,
          });
        }
      }

      // Last iteration of a loop: set nextThoughtNeeded to false if present
      if (step.loop && i === loopCount && resolvedArgs.nextThoughtNeeded !== undefined) {
        resolvedArgs.nextThoughtNeeded = false;
      }

      const toolLabel = `${step.server}::${step.tool}`;
      const stepId = step.id || `step_${steps.indexOf(step)}`;
      const toolId = `wf_${stepId}_${i}_${Date.now()}`;

      onEvent({
        type: 'tool_call_start',
        toolName: toolLabel,
        toolId,
        toolArgs: resolvedArgs,
      });

      const startMs = Date.now();

      try {
        let result: string;

        // Special gateway-internal tools — no subprocess needed
        if (step.server === '_gateway' && step.tool === 'create_skill') {
          const name = (resolvedArgs.name as string || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const description = resolvedArgs.description as string || name;
          const skillType = resolvedArgs.skill_type as string || 'simple';
          const requiredTools = resolvedArgs.required_tools as string || 'none';

          // PLAN-GRAPH-SKILLS P1 — ask the model for a RECIPE first.
          //
          // Four lines of plain words instead of hand-written nested JSON. The
          // compiler then emits the actions, which makes a whole class of skill
          // impossible to create rather than merely unlikely: a fan with no
          // join, a join that omits a branch, `need: 4 of 3`. JSON is still what
          // runs — this changes who writes it.
          //
          // Falls back to the pre-existing JSON path whenever the model cannot
          // produce something that compiles, so a skill is never half-created.
          let authored: Awaited<ReturnType<typeof authorRecipe>> = null;
          if (requiredTools && requiredTools !== 'none') {
            try {
              authored = await authorRecipe(
                { name, description, requiredTools },
                (p) => rawLLMCallPooled(conversationId, p),
              );
            } catch (e) {
              console.error(`[Workflow] recipe authoring threw: ${e}`);
            }
          }

          if (authored) {
            // Show the plan BEFORE the skill is written, so a wrong tool
            // resolution or an unguarded send is visible while it is still free.
            try {
              const plan = await buildPlan(authored.recipe);
              onEvent({
                type: 'graph_plan',
                graph: {
                  skill: name,
                  plan: {
                    recipe: plan.recipe,
                    rows: plan.rows,
                    needed: plan.needed,
                    notes: plan.notes,
                    guard: plan.guard,
                    // The CANONICAL text, carried on the wire so a DOM-less
                    // surface (side panel, Telegram, `./do`) renders the same
                    // string the web card enhances — instead of each one
                    // reimplementing renderPlanText and drifting. §5.8: text is
                    // canonical, the card is an enhancement of it.
                    text: renderPlanText(plan),
                  },
                },
              });
              allResults.push(`### plan for ${name}\n${renderPlanText(plan)}`);
            } catch (e) {
              console.error(`[Workflow] plan card for "${name}" failed to build: ${e}`);
            }
          }

          // Generate SKILL.md content — use LLM for smart generation, fall back to template
          let skillContent: string;
          try {
            const toolsJson = requiredTools === 'none' ? '[]' : `["${requiredTools}"]`;
            const llmPrompt = `Generate a complete Vodou SKILL.md file.

SKILL REQUIREMENTS:
- Name: ${name}
- Description: ${description}
- Type: ${skillType}
- Required tools: ${requiredTools}

STRUCTURE (follow exactly):

---
name: ${name}
description: ${description}
version: 1.0.0
required_tools: ${toolsJson}
---

# [Display Name]

## Trigger Phrases
- "[trigger 1]"
- "[trigger 2]"
- "[trigger 3]"

## Overview
[2-3 sentences about what this skill does, based on the description]

## [Menu Title - specific to this skill]

1. [Option A - specific to what the user wants]
2. [Option B - specific to what the user wants]
3. [Option C - if needed]

[Then include the AGENT_ACTIONS block below]

AGENT_ACTIONS FORMAT (this is CRITICAL — the engine reads this JSON to execute tools):

<!-- AGENT_ACTIONS: {"stopping_points": [{"id": 1, "title": "[Same menu title]", "options": {"1": {"label":"[Option A label]","vars":{},"steps":[STEPS]}, "2": {"label":"[Option B label]","vars":{},"steps":[STEPS]}}}]} -->

STEP FORMAT for tools:
{"server":"[server-name]","tool":"[tool-name]","args":{[parameters]}}

AVAILABLE TOOLS BY TYPE:
- monitor: {"server":"mcp-monitor","tool":"get_cpu_info","args":{"per_cpu":true}}, get_memory_info, get_disk_info, get_network_info, get_process_info, get_host_info
- thinking: {"server":"Vodou-Enhanced-Thinking","tool":"start_thinking_session","args":{"topic":"{{TOPIC}}","depth":5},"capture":{"SESSION_ID":"session_id"}} then {"server":"Vodou-Enhanced-Thinking","tool":"add_thought","args":{"session_id":"{{SESSION_ID}}","thought":"analysis","thoughtNumber":1,"totalThoughts":1,"nextThoughtNeeded":false}}
- browser: {"server":"chrome-devtools","tool":"takeScreenshot","args":{}}, runAccessibilityAudit, runPerformanceAudit, runSEOAudit
- simple/none: use empty steps arrays: "steps":[]

INITIAL STEPS: To auto-run tools when the skill first loads (before any menu):
{"initial_steps": [{"server":"mcp-monitor","tool":"get_cpu_info","args":{}}], "stopping_points": [...]}

MULTI-PHASE: You can have multiple stopping points for multi-step workflows:
{"stopping_points": [{"id":1, ...}, {"id":2, "title":"What next?", "options":{...}}]}

TEXT INPUT: For steps that need user text (not menu choices):
{"id":2, "title":"Enter your query:", "type":"text_input", "capture_as":"USER_INPUT", "options":{}}

RULES:
- Menu options MUST be specific to what the user described, not generic
- The AGENT_ACTIONS JSON must be valid — no trailing commas, proper quoting
- Steps with no tools use "steps":[]
- The numbered menu text MUST match the AGENT_ACTIONS option labels

Output ONLY the SKILL.md content. No markdown fences. No explanation. Start with ---.`;

            const llmResult = await rawLLMCall(llmPrompt);
            if (llmResult && llmResult.includes('---') && llmResult.includes('name:')) {
              skillContent = llmResult;
              console.error(`[Workflow] LLM generated custom SKILL.md (${skillContent.length} chars)`);
            } else {
              skillContent = await generateSkillContent(name, description, skillType, requiredTools, variables);
              console.error(`[Workflow] LLM output invalid, using template`);
            }
          } catch {
            skillContent = await generateSkillContent(name, description, skillType, requiredTools, variables);
            console.error(`[Workflow] LLM unavailable, using template`);
          }

          // Generate trigger phrases — use LLM if available, fall back to simple generation
          let triggers: string[];
          try {
            const triggerResult = await rawLLMCall(
              `Generate 3 trigger phrases for an Vodou skill called "${name}" that does: "${description}". These are what a user would say to activate the skill. Output ONLY a JSON array like ["phrase one","phrase two","phrase three"]. No explanation.`
            );
            const parsed = JSON.parse(triggerResult.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
            triggers = Array.isArray(parsed) ? parsed.slice(0, 4) : generateTriggers(name, description);
            console.error(`[Workflow] LLM generated triggers: ${triggers.join(', ')}`);
          } catch {
            triggers = generateTriggers(name, description);
          }

          // Create via API
          const apiResp = await fetch(`${gatewayBaseUrl()}/api/skills`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, category: 'my-skills' }),
          });
          const apiResult = await apiResp.json().catch(() => ({})) as any;

          // P1-6: the skill file and its intent mappings must land together.
          // Previously apiResp.ok was unchecked and the intent_mappings INSERT
          // ran unconditionally — so on an API error (no file_path) we'd register
          // keyword routes to a SKILL.md that was never written, and still report
          // ok:true. Bail cleanly if the file wasn't created; register intents
          // ONLY inside the success branch below.
          if (!apiResp.ok || !apiResult.file_path) {
            const why = apiResult?.error || `HTTP ${apiResp.status}` || 'no file_path returned';
            console.error(`[Workflow] _gateway::create_skill FAILED for "${name}": ${why}`);
            result = JSON.stringify({ ok: false, error: `skill create failed: ${why}` });
          } else {
            const { writeFile } = await import('fs/promises');
            // Strip AGENT_ACTIONS from SKILL.md if present (they go in actions.json now)
            const cleanSkillContent = skillContent.replace(/<!--\s*AGENT_ACTIONS:[\s\S]*?-->/g, '').trim();
            await writeFile(apiResult.file_path, cleanSkillContent, 'utf-8');

            // Extract actions JSON and write to actions.json
            const actionsPathFor = () => apiResult.file_path.replace('SKILL.md', 'actions.json');
            const actionsMatch = skillContent.match(/<!--\s*AGENT_ACTIONS:\s*([\s\S]*?)\s*-->/);
            if (authored) {
              // Recipe wins. It is the SOURCE; actions.json is the generated
              // artifact. Both are written, and the recipe is appended to
              // SKILL.md so the next person edits the words, not the JSON.
              await writeFile(
                apiResult.file_path,
                `${cleanSkillContent}\n\n## Shape\n\n${recipeBlock(authored.recipe)}\n`,
                'utf-8',
              );
              await writeFile(actionsPathFor(), JSON.stringify(authored.actions, null, 2), 'utf-8');
              console.error(
                `[Workflow] wrote actions.json compiled from a recipe` +
                  (authored.repaired ? ' (repaired on the second attempt)' : ''),
              );
            } else if (actionsMatch) {
              try {
                const actionsJson = JSON.parse(actionsMatch[1]);
                await writeFile(actionsPathFor(), JSON.stringify(actionsJson, null, 2), 'utf-8');
                console.error(`[Workflow] wrote actions.json alongside SKILL.md`);
              } catch (e) {
                console.error(`[Workflow] failed to extract actions.json from LLM output: ${e}`);
              }
            } else {
              // LLM didn't include AGENT_ACTIONS — generate from template
              const actionsJson = generateActionsJson(skillType, requiredTools);
              await writeFile(actionsPathFor(), JSON.stringify(actionsJson, null, 2), 'utf-8');
              console.error(`[Workflow] wrote template actions.json`);
            }

            // Register intent mappings — ONLY now that the SKILL.md exists on disk
            // (P1-6: previously ran even when the file write was skipped).
            const { getDb } = await import('./db.js');
            const db = getDb();
            for (let i = 0; i < triggers.length; i++) {
              db.prepare(
                `INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES (?, 'vodou-core', 'vc_load_skill', ?, 'mcp', ?)`
              ).run(triggers[i], i === 0 ? 10 : 9, JSON.stringify({ skill_name: name }));
            }

            result = JSON.stringify({
              ok: true, name, file_path: apiResult.file_path, triggers, description,
              authored_from: authored ? 'recipe' : 'json',
            });
            console.error(`[Workflow] _gateway::create_skill created "${name}" with ${triggers.length} triggers`);
          }
        } else {
          result = await runVodouCore(step.server, step.tool, resolvedArgs);
        }

        const execTime = Date.now() - startMs;

        console.error(`[Workflow] ${toolLabel} completed in ${execTime}ms`);

        // Capture variables from result for chaining
        if (step.capture) {
          for (const [varName, fieldPath] of Object.entries(step.capture)) {
            const value = extractField(result, fieldPath);
            if (value) {
              variables[varName] = value;
              console.error(`[Workflow] captured ${varName} = ${value.substring(0, 80)}`);
            } else {
              console.error(`[Workflow] FAILED to capture ${varName} from field "${fieldPath}". Response starts with: ${result.substring(0, 200)}`);
            }
          }
        }

        onEvent({
          type: 'tool_call_end',
          toolName: toolLabel,
          toolId,
          toolResult: result.substring(0, 4000),
          executionTime: execTime,
          success: true,
        });

        allResults.push(`### ${toolLabel} (${execTime}ms)\n${result}`);
      } catch (err) {
        const execTime = Date.now() - startMs;
        const errMsg = err instanceof Error ? err.message : String(err);

        onEvent({
          type: 'tool_call_end',
          toolName: toolLabel,
          toolId,
          toolResult: `Error: ${errMsg}`,
          executionTime: execTime,
          success: false,
        });

        allResults.push(`### ${toolLabel} (FAILED)\nError: ${errMsg}`);
      }
    }
  }

  // Stream the recorded facts verbatim, once, before anything reformats them.
  // Cheap on a surface that also draws a run card (the numbers agree, which is
  // the point) and load-bearing on one that cannot draw anything.
  if (canonical.length) {
    // An echo of graph_branch / graph_join / graph_check, which already carried
    // these exact counts as data. Surfaces with no card renderer need the words;
    // the web card would otherwise print the join twice.
    onEvent({ type: 'text', content: `\n${canonical.join('\n')}\n`, echoOf: 'graph' });
  }

  // Close the run record if this execution opened one. Outcome is derived from
  // recorded branch counts, never from whether the function happened to reach
  // the end: a run where every branch failed is `failed`, not `complete`.
  if (runId) {
    const all = [...groupOutcomes.values()];
    const expected = all.reduce((n, o) => n + o.expected, 0);
    const ok = all.reduce((n, o) => n + o.ok, 0);
    const outcome = expected === 0 ? 'complete' : ok === expected ? 'complete' : ok === 0 ? 'failed' : 'partial';
    finishRun(runId, outcome);

    // §3.2 M3 — a finished run leaves a trace you can search for, so tomorrow's
    // briefing can reference what yesterday's found. Only when the run actually
    // produced something: a run where every branch died has no conclusion to
    // remember, and writing "nothing worked" into recall every morning would
    // degrade the memory this feature exists to serve.
    if (outcome !== 'failed' && allResults.length) {
        try {
          await rememberRun(
            runSkillName,
            allResults.join('\n\n'),
            expected > 0 ? { ok, expected } : undefined,
          );
        } catch (e) {
          console.error(`[Workflow] remembering the run failed: ${e} — run unaffected`);
        }
    }
    onEvent({
      type: 'graph_done',
      // `skill` and `elapsedMs` ride along so a finished card can collapse to a
      // one-liner that names the run and how long it took, without the client
      // having to remember either or re-derive them from prose.
      graph: {
        runId, outcome, ok, expected,
        skill: runSkillName,
        elapsedMs: Date.now() - runStartedMs,
        // So a finished card can offer [Edit] — it otherwise knows what ran and
        // not the words that produced it.
        recipe: activeWorkflows.get(conversationId)?.recipe,
        line: `${ok}/${expected} branches succeeded`,
      },
    });
  }

  return allResults.join('\n\n');
}

export function hasActiveWorkflow(conversationId: string): boolean {
  return activeWorkflows.has(conversationId);
}

export function getActiveWorkflow(conversationId: string): ActiveWorkflow | undefined {
  return activeWorkflows.get(conversationId);
}

/** Execute initial_steps for a workflow — auto-fires on skill load before any menu */
export async function executeInitialSteps(
  workflow: ActiveWorkflow,
  onEvent: StreamCallback,
  conversationId: string = ''
): Promise<string> {
  if (!workflow.initialSteps || workflow.initialSteps.length === 0) return '';
  console.error(`[Workflow] Running ${workflow.initialSteps.length} initial steps for "${workflow.skillName}"`);
  // Pass the SKILL name. Without it every run recorded as the literal
  // "workflow" — so `graph_runs.skill` and the memory note's
  // `scope:workflow:<skill>` both said `workflow`, which is unfilterable and
  // makes per-skill run history meaningless.
  const results = await executeSteps(
    workflow.initialSteps,
    workflow.variables,
    onEvent,
    conversationId,
    workflow.skillName || 'workflow',
  );
  return results;
}

export function clearWorkflow(conversationId: string): void {
  activeWorkflows.delete(conversationId);
}
