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
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, getProjectRoot } from './db.js';
import { runVodouCore } from './executor.js';
import { rawLLMCall, rawLLMCallPooled } from './llm.js';
import type { StreamEvent } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Types ---

interface WorkflowStep {
  id?: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  loop?: string | number;
  capture?: Record<string, string>;
  stream_progress?: boolean;
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

interface ActiveWorkflow {
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
          steps: parsed.steps.map((s: any, i: number) => ({
            id: s.id || `step_${i}`,
            server: s.server,
            tool: s.tool,
            args: s.args || {},
            loop: s.loop,
            capture: s.capture,
            stream_progress: s.stream_progress,
          })),
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
      if (parsed.stopping_points && Array.isArray(parsed.stopping_points)) {
        const initialSteps = parsed.initial_steps?.map((s: any, i: number) => ({
          id: s.id || `init_${i}`,
          server: s.server,
          tool: s.tool,
          args: s.args || {},
          loop: s.loop,
          capture: s.capture,
          stream_progress: s.stream_progress,
        })) as WorkflowStep[] | undefined;

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
                steps: (opt.steps || []).map((s: any, i: number) => ({
                  id: s.id || `step_${i}`,
                  server: s.server,
                  tool: s.tool,
                  args: s.args || {},
                  loop: s.loop,
                  capture: s.capture,
                  stream_progress: s.stream_progress,
                })),
              },
            ])
          ),
        }));
        return { stoppingPoints, initialSteps };
      }
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
function findActionsFile(skillName: string): string | null {
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
      const resolved = variables[fullMatch[1]];
      if (resolved !== undefined) {
        const num = Number(resolved);
        return isNaN(num) ? resolved : num;
      }
      return value;
    }
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
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

/** Pattern for LLM-generated fields: {{LLM:prompt text here}} */
const LLM_PATTERN = /\{\{LLM:([\s\S]+?)\}\}/;

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
async function resolveLLMFields(
  args: Record<string, unknown>,
  variables: Record<string, string>,
  previousResults: string,
  conversationId: string = ''
): Promise<Record<string, unknown>> {
  const resolved = { ...args };
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== 'string') continue;
    const match = value.match(LLM_PATTERN);
    if (!match) continue;

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

    try {
      // Use the pool-aware variant — for claude-cli with a warm conversation
      // session this avoids cold-spawning a fresh subprocess (and its
      // workspace bootstrap context-token cost) on every iteration.
      const llmResult = await rawLLMCallPooled(conversationId, fullPrompt);
      if (llmResult) {
        resolved[key] = llmResult;
        console.error(`[Workflow] LLM generated ${key}: ${llmResult.substring(0, 80)}...`);
      }
    } catch (err) {
      console.error(`[Workflow] LLM generation failed for ${key}: ${err}`);
      // Keep template value as fallback — don't break the workflow
      resolved[key] = prompt;
    }
  }
  return resolved;
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
                  id: s.id || `step_${i}`, server: s.server, tool: s.tool,
                  args: s.args || {}, loop: s.loop, capture: s.capture, stream_progress: s.stream_progress,
                })),
              }])
            ),
          })) as StoppingPoint[];

          const initialSteps = actions.initial_steps?.map((s: any, i: number) => ({
            id: s.id || `init_${i}`, server: s.server, tool: s.tool,
            args: s.args || {}, loop: s.loop, capture: s.capture, stream_progress: s.stream_progress,
          })) as WorkflowStep[] | undefined;

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

  // Check if current phase is a text_input type — capture any input as a variable
  const currentSP = workflow.stoppingPoints?.[workflow.currentPhase];
  console.error(`[Workflow] handleWorkflowChoice: phase=${workflow.currentPhase}, type=${currentSP?.type || 'menu'}, input="${choice.substring(0, 50)}"`);
  if (currentSP?.type === 'text_input' && currentSP.capture_as) {
    workflow.variables[currentSP.capture_as] = choice;
    console.error(`[Workflow] text_input captured ${currentSP.capture_as} = "${choice.substring(0, 80)}"`);

    // Advance to next phase
    if (workflow.stoppingPoints && workflow.currentPhase < workflow.stoppingPoints.length - 1) {
      workflow.currentPhase++;
      const nextSP = workflow.stoppingPoints[workflow.currentPhase];
      workflow.options = nextSP.options || {};
      workflow.step = 'menu';

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
    const lowerChoice = choice.toLowerCase();
    for (const [key, opt] of Object.entries(workflow.options)) {
      if (opt.label.toLowerCase().includes(lowerChoice) || lowerChoice.includes(key)) {
        selectedOption = opt;
        selectedKey = key;
        break;
      }
    }
  }

  if (!selectedOption) return null;

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
    const results = await executeSteps(selectedOption.steps, workflow.variables, onEvent, conversationId);

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
      const nextSP = workflow.stoppingPoints[workflow.currentPhase];
      workflow.options = nextSP.options;
      workflow.step = 'menu';
      console.error(`[Workflow] advancing to phase ${workflow.currentPhase}: "${nextSP.title}"`);

      // Build the next stopping point menu — resolve {{VAR}} in titles/labels
      const resolvedTitle = nextSP.title.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);
      let menu = `\n\n## ${resolvedTitle}\n\n`;
      for (const [key, opt] of Object.entries(nextSP.options)) {
        const resolvedLabel = opt.label.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);
        menu += `${key}. ${resolvedLabel}\n`;
      }

      // Always stream the menu directly (no LLM re-interpretation).
      // If there were tool results, prepend them so the LLM formats those,
      // then append the menu with __MENU_FOLLOWS__ marker so chat() handles it.
      if (results.trim()) {
        return '__RESULTS_AND_MENU__' + results + '\n\n---\n' + menu;
      } else {
        return '__MENU_ONLY__' + menu;
      }
    }

    // Single phase or last phase — done
    workflow.step = 'complete';
    activeWorkflows.delete(conversationId);
    return results;
  } catch (err) {
    console.error(`[Workflow] execution error: ${err}`);
    activeWorkflows.delete(conversationId);
    return `Workflow execution failed: ${err}`;
  }
}

/**
 * Execute a sequence of workflow steps.
 * Handles loops, variable capture/chaining, and progress streaming.
 */
async function executeSteps(
  steps: WorkflowStep[],
  variables: Record<string, string>,
  onEvent: StreamCallback,
  conversationId: string = ''
): Promise<string> {
  const allResults: string[] = [];

  for (const step of steps) {
    const loopCount = step.loop
      ? Number(resolveTemplate(String(step.loop), variables)) || 1
      : 1;

    for (let i = 1; i <= loopCount; i++) {
      variables.i = String(i);

      let resolvedArgs = resolveTemplate(step.args, variables) as Record<string, unknown>;

      // LLM enrichment: resolve {{LLM:prompt}} fields with active provider
      const hasLLM = Object.values(resolvedArgs).some(v => typeof v === 'string' && LLM_PATTERN.test(v as string));
      if (hasLLM) {
        // Emit progress so user sees something during LLM generation
        const toolLabel = `${step.server}::${step.tool}`;
        onEvent({ type: 'tool_call_start', toolName: `LLM → ${toolLabel}`, toolId: `llm_${Date.now()}`, toolArgs: { status: `Generating thought ${i}/${loopCount}...` } });
        resolvedArgs = await resolveLLMFields(resolvedArgs, variables, allResults.join('\n\n'), conversationId);
        onEvent({ type: 'tool_call_end', toolName: `LLM → ${toolLabel}`, toolId: `llm_${Date.now()}`, success: true, executionTime: 0 });
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
          const apiResp = await fetch('http://localhost:8765/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description, category: 'my-skills' }),
          });
          const apiResult = await apiResp.json() as any;

          // Write SKILL.md content + actions.json
          if (apiResult.file_path) {
            const { writeFile } = await import('fs/promises');
            // Strip AGENT_ACTIONS from SKILL.md if present (they go in actions.json now)
            const cleanSkillContent = skillContent.replace(/<!--\s*AGENT_ACTIONS:[\s\S]*?-->/g, '').trim();
            await writeFile(apiResult.file_path, cleanSkillContent, 'utf-8');

            // Extract actions JSON and write to actions.json
            const actionsMatch = skillContent.match(/<!--\s*AGENT_ACTIONS:\s*([\s\S]*?)\s*-->/);
            if (actionsMatch) {
              try {
                const actionsJson = JSON.parse(actionsMatch[1]);
                const actionsPath = apiResult.file_path.replace('SKILL.md', 'actions.json');
                await writeFile(actionsPath, JSON.stringify(actionsJson, null, 2), 'utf-8');
                console.error(`[Workflow] wrote actions.json alongside SKILL.md`);
              } catch (e) {
                console.error(`[Workflow] failed to extract actions.json from LLM output: ${e}`);
              }
            } else {
              // LLM didn't include AGENT_ACTIONS — generate from template
              const actionsJson = generateActionsJson(skillType, requiredTools);
              const actionsPath = apiResult.file_path.replace('SKILL.md', 'actions.json');
              await writeFile(actionsPath, JSON.stringify(actionsJson, null, 2), 'utf-8');
              console.error(`[Workflow] wrote template actions.json`);
            }
          }

          // Register intent mappings
          const { getDb } = await import('./db.js');
          const db = getDb();
          for (let i = 0; i < triggers.length; i++) {
            db.prepare(
              `INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES (?, 'vodou-core', 'vc_load_skill', ?, 'mcp', ?)`
            ).run(triggers[i], i === 0 ? 10 : 9, JSON.stringify({ skill_name: name }));
          }

          result = JSON.stringify({ ok: true, name, file_path: apiResult.file_path, triggers, description });
          console.error(`[Workflow] _gateway::create_skill created "${name}" with ${triggers.length} triggers`);
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
  const results = await executeSteps(workflow.initialSteps, workflow.variables, onEvent, conversationId);
  return results;
}

export function clearWorkflow(conversationId: string): void {
  activeWorkflows.delete(conversationId);
}
