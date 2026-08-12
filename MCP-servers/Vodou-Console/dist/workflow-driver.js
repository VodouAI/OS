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
import { getDb, getGatewayDb, getProjectRoot } from './db.js';
import { runVodouCore } from './executor.js';
import { rawLLMCall, rawLLMCallPooled } from './llm.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// --- Load static workflow configs (fallback) ---
let staticWorkflows = {};
function loadStaticWorkflows() {
    for (const relPath of ['workflows.json', path.join('..', 'src', 'workflows.json')]) {
        try {
            const raw = readFileSync(path.join(__dirname, relPath), 'utf-8');
            staticWorkflows = JSON.parse(raw);
            console.error(`[Workflow] loaded ${Object.keys(staticWorkflows).length} static workflow configs`);
            return;
        }
        catch { /* try next */ }
    }
    console.error(`[Workflow] no workflows.json found (inline AGENT_ACTIONS still work)`);
}
loadStaticWorkflows();
// --- Per-conversation workflow state ---
const activeWorkflows = new Map();
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
function parseInlineActions(content) {
    const pattern = /<!--\s*AGENT_ACTIONS_(\d+):\s*([\s\S]*?)\s*-->/g;
    const options = {};
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
                    steps: parsed.steps.map((s, i) => ({
                        id: s.id || `step_${i}`,
                        server: s.server,
                        tool: s.tool,
                        prompt: s.prompt, // prompt steps carry no server/tool — see the note below
                        args: s.args || {},
                        loop: s.loop,
                        capture: s.capture,
                        stream_progress: s.stream_progress,
                    })),
                };
                found = true;
            }
        }
        catch (err) {
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
export function parseStoppingPoints(content) {
    const pattern = /<!--\s*STOPPING_POINT:\s*(\{[\s\S]*?\})\s*-->/g;
    const points = [];
    let match;
    while ((match = pattern.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            points.push({
                id: parsed.id ?? points.length + 1,
                title: parsed.title ?? `Stopping Point ${points.length + 1}`,
                position: match.index,
            });
        }
        catch (err) {
            console.error(`[Workflow] failed to parse STOPPING_POINT: ${err}`);
        }
    }
    return points;
}
/** Map JSON object (AGENT_ACTIONS body or skills_meta.stopping_points_json) to workflow state. */
export function stoppingPointsFromParsedUnified(parsed) {
    if (!parsed || !parsed.stopping_points || !Array.isArray(parsed.stopping_points))
        return null;
    const initialSteps = parsed.initial_steps?.map((s, i) => ({
        id: s.id || `init_${i}`,
        server: s.server,
        tool: s.tool,
        prompt: s.prompt,
        args: s.args || {},
        loop: s.loop,
        capture: s.capture,
        stream_progress: s.stream_progress,
    }));
    const stoppingPoints = parsed.stopping_points.map((sp) => ({
        id: sp.id ?? 0,
        title: sp.title ?? 'Choose',
        type: sp.type,
        capture_as: sp.capture_as,
        options: Object.fromEntries(Object.entries(sp.options || {}).map(([key, opt]) => [
            key,
            {
                label: opt.label || `Option ${key}`,
                vars: opt.vars || {},
                goto: opt.goto,
                steps: (opt.steps || []).map((s, i) => ({
                    id: s.id || `step_${i}`,
                    server: s.server,
                    tool: s.tool,
                    // A PROMPT step's whole payload is `prompt`. This mapper rebuilds each step
                    // from a fixed field list, so anything not named here is silently dropped —
                    // which is why `execdesk-action-weekly-brief` (one prompt step) arrived at
                    // the executor with neither a tool NOR its prompt, and could only no-op.
                    prompt: s.prompt,
                    args: s.args || {},
                    loop: s.loop,
                    capture: s.capture,
                    stream_progress: s.stream_progress,
                })),
            },
        ])),
    }));
    return { stoppingPoints, initialSteps };
}
/**
 * Parse skills_meta.stopping_points_json — same schema as unified AGENT_ACTIONS
 * (`{ "stopping_points": [...], "initial_steps"?: [...] }`). Also accepts a bare array
 * (wrapped as stopping_points).
 */
export function parseWorkflowStoppingPointsJson(jsonStr) {
    if (!jsonStr?.trim())
        return null;
    try {
        const parsed = JSON.parse(jsonStr);
        let body = parsed;
        if (Array.isArray(parsed))
            body = { stopping_points: parsed };
        return stoppingPointsFromParsedUnified(body);
    }
    catch (err) {
        console.error(`[Workflow] parseWorkflowStoppingPointsJson: ${err}`);
        return null;
    }
}
/**
 * PLAN §27 Layer B — seed in-memory workflow from gateway skills_meta before chat().
 */
export function ensureSkillConsoleLayerBWorkflow(params) {
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
    if (existing &&
        existing.workflowOrigin === 'skill_console' &&
        existing.skillMetaId === params.skillMetaId) {
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
function persistSkillConsolePhase(workflow, phase) {
    if (workflow.workflowOrigin !== 'skill_console' || workflow.skillMetaId == null)
        return;
    try {
        getGatewayDb()
            .prepare(`UPDATE skills_meta SET current_phase = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(phase, workflow.skillMetaId);
    }
    catch (e) {
        console.error(`[Workflow] persist skill_console phase: ${e}`);
    }
}
export function formatStoppingPointMenu(workflow) {
    const sp = workflow.stoppingPoints?.[workflow.currentPhase];
    if (!sp)
        return '';
    const vars = workflow.variables || {};
    const resolveVars = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || `{{${k}}}`);
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
function parseUnifiedActions(content) {
    const pattern = /<!--\s*AGENT_ACTIONS:\s*([\s\S]*?)\s*-->/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            const mapped = stoppingPointsFromParsedUnified(parsed);
            if (mapped)
                return mapped;
        }
        catch (err) {
            console.error(`[Workflow] failed to parse unified AGENT_ACTIONS: ${err}`);
        }
    }
    return null;
}
/** Generate actions.json from skill type (template fallback when LLM doesn't include AGENT_ACTIONS) */
function generateActionsJson(skillType, requiredTools) {
    const baseOptions = {
        '1': { label: 'Quick version', vars: {}, steps: [] },
        '2': { label: 'Detailed version', vars: {}, steps: [] },
    };
    if (skillType === 'monitor') {
        baseOptions['1'].steps = [
            { server: 'mcp-monitor', tool: 'get_cpu_info', args: {} },
            { server: 'mcp-monitor', tool: 'get_memory_info', args: {} },
        ];
        baseOptions['2'].steps = [
            { server: 'mcp-monitor', tool: 'get_cpu_info', args: { per_cpu: true } },
            { server: 'mcp-monitor', tool: 'get_memory_info', args: {} },
            { server: 'mcp-monitor', tool: 'get_disk_info', args: { path: '/' } },
            { server: 'mcp-monitor', tool: 'get_network_info', args: {} },
        ];
    }
    else if (skillType === 'thinking') {
        baseOptions['1'].label = 'Quick analysis';
        baseOptions['1'].steps = [
            { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 3 }, capture: { SESSION_ID: 'session_id' } },
            { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Analyze {{TOPIC}} — key insights}}', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false } },
        ];
        baseOptions['2'].label = 'Deep analysis';
        baseOptions['2'].steps = [
            { server: 'Vodou-Enhanced-Thinking', tool: 'start_thinking_session', args: { topic: '{{TOPIC}}', depth: 8 }, capture: { SESSION_ID: 'session_id' } },
            { server: 'Vodou-Enhanced-Thinking', tool: 'add_thought', args: { session_id: '{{SESSION_ID}}', thought: '{{LLM:Deep analysis of {{TOPIC}}}}', thoughtNumber: '{{i}}', totalThoughts: 6, nextThoughtNeeded: true }, loop: 6 },
            { server: 'Vodou-Enhanced-Thinking', tool: 'analyze_thinking', args: { session_id: '{{SESSION_ID}}' } },
        ];
    }
    else if (skillType === 'browser') {
        baseOptions['1'].label = 'Full audit';
        baseOptions['1'].steps = [
            { server: 'chrome-devtools', tool: 'runAccessibilityAudit', args: {} },
            { server: 'chrome-devtools', tool: 'runPerformanceAudit', args: {} },
            { server: 'chrome-devtools', tool: 'runSEOAudit', args: {} },
        ];
        baseOptions['2'].label = 'Screenshot';
        baseOptions['2'].steps = [
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
export function findActionsFile(skillName) {
    const root = getProjectRoot();
    try {
        const row = getDb()
            .prepare(`SELECT file_path FROM skills_registry WHERE name = ? AND COALESCE(is_active, 1) != 0 LIMIT 1`)
            .get(skillName);
        if (row?.file_path) {
            const rel = row.file_path.replace(/\\/g, '/');
            const skillMd = path.resolve(root, 'skills', rel);
            const actionsPath = path.join(path.dirname(skillMd), 'actions.json');
            if (existsSync(actionsPath)) {
                return actionsPath;
            }
        }
    }
    catch (e) {
        console.error(`[Workflow] findActionsFile registry lookup failed for "${skillName}":`, e.message);
    }
    const candidates = [
        path.join(root, 'skills', 'vodou-core', skillName, 'actions.json'),
        path.join(root, 'skills', 'oi-core', skillName, 'actions.json'), // legacy fallback
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
function generateTriggers(name, description) {
    const words = name.replace(/-/g, ' ');
    const triggers = [words];
    // Add first 3 meaningful words of description
    const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    if (descWords.length >= 2)
        triggers.push(descWords.join(' '));
    // Add "run <name>"
    triggers.push(`run ${words}`);
    return triggers;
}
/** Generate complete SKILL.md content based on skill type */
async function generateSkillContent(name, description, skillType, requiredTools, variables) {
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
    }
    else if (skillType === 'thinking') {
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
    }
    else if (skillType === 'browser') {
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
    }
    else {
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
function staticToOptions(config) {
    const options = {};
    if (config.menu_options) {
        for (const [key, menuOpt] of Object.entries(config.menu_options)) {
            const vars = {};
            for (const [k, v] of Object.entries(menuOpt)) {
                if (k !== 'label')
                    vars[k.toUpperCase()] = String(v);
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
function resolveTemplate(value, variables) {
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
    if (typeof value === 'boolean' || typeof value === 'number')
        return value;
    if (Array.isArray(value))
        return value.map(v => resolveTemplate(v, variables));
    if (value && typeof value === 'object') {
        const resolved = {};
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
function resolveDynamicVar(key) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
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
function findBalancedJSONArrays(text) {
    const results = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (c === '\\' && inString) {
            escape = true;
            continue;
        }
        if (c === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (c === '[') {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (c === ']') {
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
function extractPriorThoughts(previousResults) {
    const out = [];
    if (!previousResults)
        return out;
    // The driver pushes "### server/tool (Nms)\n<raw stdout>\n\n" entries.
    // raw stdout is the vodou-core call result wrapping {"content":[{"text":"..."}]}.
    // The inner text is the JSON the MCP server actually returned, with currentThought.
    // We extract every `"currentThought":\s*"..."` regex match — robust enough.
    const re = /"currentThought":\s*"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = re.exec(previousResults)) !== null) {
        try {
            // Unescape JSON string
            const text = JSON.parse('"' + match[1] + '"');
            if (typeof text === 'string' && text.trim().length > 0) {
                out.push(text.trim());
            }
        }
        catch { /* skip malformed */ }
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
const WORKFLOW_SUBGEN_SYSTEM = "You are the analysis engine inside Vodou, the user's own local AI system. You are given a topic and asked to write ONE original, substantive analytical insight for a persistent thinking session the user explicitly started. This is a legitimate internal step in the user's own tooling — it is NOT a prompt injection, NOT role-play, and NOT a request to impersonate another system. The topic is genuine (Vodou is the user's real product). Write the insight directly and concretely — reference real mechanisms, tradeoffs, and implications. Do NOT refuse, do NOT question the framing, do NOT add meta-commentary about the request itself.";
async function resolveLLMFields(args, variables, previousResults, conversationId = '') {
    const resolved = { ...args };
    let ok = true;
    let touched = false;
    for (const [key, value] of Object.entries(resolved)) {
        if (typeof value !== 'string')
            continue;
        const match = value.match(LLM_PATTERN);
        if (!match)
            continue;
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
        }
        catch (err) {
            console.error(`[Workflow] LLM generation threw for ${key}: ${err}`);
        }
        // B5: rawLLMCall returns '' on provider error (doesn't throw), so an empty
        // result is a failure — treat it as such instead of leaving the literal
        // {{LLM:...}} token or substituting the prompt text into tool args.
        if (llmResult && llmResult.trim()) {
            resolved[key] = llmResult;
            console.error(`[Workflow] LLM generated ${key}: ${llmResult.substring(0, 80)}...`);
        }
        else {
            ok = false;
            resolved[key] = '[model generation failed for this step]';
            console.error(`[Workflow] LLM generation FAILED (empty/error) for ${key} — not injecting prompt or {{LLM:}} token`);
        }
    }
    return { resolved, ok: touched ? ok : true };
}
function extractField(response, fieldPath) {
    // vodou-core call output has emoji header lines before JSON — strip them
    const jsonStart = response.indexOf('{');
    const cleanResponse = jsonStart >= 0 ? response.substring(jsonStart) : response;
    try {
        let obj = JSON.parse(cleanResponse);
        // Handle MCP content wrapper: {"content": [{"type":"text","text":"..."}]}
        if (obj?.content && Array.isArray(obj.content)) {
            const textBlock = obj.content.find((b) => b.type === 'text');
            if (textBlock?.text) {
                try {
                    obj = JSON.parse(textBlock.text);
                }
                catch { /* use unwrapped */ }
            }
        }
        for (const key of fieldPath.split('.')) {
            if (obj == null)
                return undefined;
            obj = obj[key];
        }
        return obj != null ? String(obj) : undefined;
    }
    catch {
        // Regex fallback — works even if JSON parsing fails entirely
        const regex = new RegExp(`"${fieldPath}"\\s*:\\s*"([^"]+)"`);
        const match = response.match(regex);
        return match?.[1];
    }
}
function extractTopic(message, triggers) {
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
export function detectWorkflow(conversationId, oiResults, originalQuery) {
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
                    const stoppingPoints = actions.stopping_points.map((sp) => ({
                        id: sp.id ?? 0,
                        title: sp.title ?? 'Choose',
                        type: sp.type,
                        capture_as: sp.capture_as,
                        options: Object.fromEntries(Object.entries(sp.options || {}).map(([key, opt]) => [key, {
                                label: opt.label || `Option ${key}`,
                                vars: opt.vars || {},
                                goto: opt.goto,
                                steps: (opt.steps || []).map((s, i) => ({
                                    id: s.id || `step_${i}`, server: s.server, tool: s.tool,
                                    // prompt steps carry no server/tool — dropping `prompt` here left them
                                    // with nothing to run (see executeSteps' prompt-step branch).
                                    prompt: s.prompt,
                                    args: s.args || {}, loop: s.loop, capture: s.capture, stream_progress: s.stream_progress,
                                    sequential: s.sequential,
                                })),
                            }])),
                    }));
                    const initialSteps = actions.initial_steps?.map((s, i) => ({
                        id: s.id || `init_${i}`, server: s.server, tool: s.tool, prompt: s.prompt,
                        args: s.args || {}, loop: s.loop, capture: s.capture, stream_progress: s.stream_progress,
                        sequential: s.sequential,
                    }));
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
            }
            catch (err) {
                console.error(`[Workflow] failed to parse actions.json for "${skillName}": ${err}`);
            }
        }
    }
    // Priority 0: Unified format in markdown — <!-- AGENT_ACTIONS: {"stopping_points": [...]} -->
    const unified = parseUnifiedActions(oiResults);
    if (unified && unified.stoppingPoints.length > 0) {
        const hasInitial = unified.initialSteps && unified.initialSteps.length > 0;
        console.error(`[Workflow] detected unified AGENT_ACTIONS in "${skillName}" (${unified.stoppingPoints.length} stopping points${hasInitial ? `, ${unified.initialSteps.length} initial steps` : ''})`);
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
export async function handleWorkflowChoice(conversationId, message, onEvent) {
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
            persistSkillConsolePhase(workflow, workflow.currentPhase);
            const nextSP = workflow.stoppingPoints[workflow.currentPhase];
            workflow.options = nextSP.options || {};
            workflow.step = 'menu';
            const resolveVars = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);
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
    let selectedOption;
    let selectedKey;
    if (workflow.options[choice]) {
        selectedOption = workflow.options[choice];
        selectedKey = choice;
    }
    else {
        const lowerChoice = choice.toLowerCase();
        for (const [key, opt] of Object.entries(workflow.options)) {
            if (opt.label.toLowerCase().includes(lowerChoice) || lowerChoice.includes(key)) {
                selectedOption = opt;
                selectedKey = key;
                break;
            }
        }
    }
    if (!selectedOption) {
        if (workflow.workflowOrigin === 'skill_console' &&
            workflow.stoppingPoints &&
            workflow.step === 'menu' &&
            currentSP?.type !== 'text_input') {
            const menu = formatStoppingPointMenu(workflow);
            const hint = 'That did not match any option. Reply with **1**, **2**, … (the numbers shown below), or type `/menu` to see this list again.\n\n';
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
        const results = await executeSteps(selectedOption.steps, workflow.variables, onEvent, conversationId);
        // Multi-phase: advance to next stopping point if there are more
        // Support "goto" — jump to a specific stopping point ID instead of sequential advance
        if (workflow.stoppingPoints && workflow.currentPhase < workflow.stoppingPoints.length - 1) {
            if (selectedOption.goto !== undefined) {
                const targetIdx = workflow.stoppingPoints.findIndex(sp => sp.id === selectedOption.goto);
                if (targetIdx >= 0) {
                    workflow.currentPhase = targetIdx;
                    console.error(`[Workflow] goto: jumped to stopping point id=${selectedOption.goto} (phase ${targetIdx})`);
                }
                else {
                    workflow.currentPhase++;
                    console.error(`[Workflow] goto: target id=${selectedOption.goto} not found, advancing sequentially`);
                }
            }
            else {
                workflow.currentPhase++;
            }
            persistSkillConsolePhase(workflow, workflow.currentPhase);
            const nextSP = workflow.stoppingPoints[workflow.currentPhase];
            workflow.options = nextSP.options;
            workflow.step = 'menu';
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
            }
            else {
                return '__MENU_ONLY__' + menu;
            }
        }
        // Single phase or last phase — done
        workflow.step = 'complete';
        persistSkillConsolePhase(workflow, workflow.stoppingPoints?.length ?? workflow.currentPhase + 1);
        activeWorkflows.delete(conversationId);
        return results;
    }
    catch (err) {
        console.error(`[Workflow] execution error: ${err}`);
        activeWorkflows.delete(conversationId);
        return `Workflow execution failed: ${err}`;
    }
}
export async function advanceBoardWorkflow(workflow, choice, onEvent, conversationId = '') {
    const input = (choice ?? '').trim();
    const currentSP = workflow.stoppingPoints?.[workflow.currentPhase];
    const resolveVars = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => workflow.variables[k] || `{{${k}}}`);
    // ── text_input phase: capture the free-text answer, then advance. ──
    if (currentSP?.type === 'text_input' && currentSP.capture_as) {
        workflow.variables[currentSP.capture_as] = input;
        return advanceToNextOrComplete(workflow, '', resolveVars);
    }
    // ── menu phase: match the choice by number or label. ──
    let selectedOption;
    let selectedKey;
    if (workflow.options[input]) {
        selectedOption = workflow.options[input];
        selectedKey = input;
    }
    else {
        const lower = input.toLowerCase();
        for (const [key, opt] of Object.entries(workflow.options)) {
            if (opt.label.toLowerCase().includes(lower) || lower.includes(key)) {
                selectedOption = opt;
                selectedKey = key;
                break;
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
        for (const [k, v] of Object.entries(selectedOption.vars))
            workflow.variables[k] = v;
    }
    workflow.variables.SELECTED_LABEL = selectedOption.label;
    workflow.step = 'executing';
    // Run the chosen branch's steps, then advance (honoring `goto`).
    const results = await executeSteps(selectedOption.steps, workflow.variables, onEvent, conversationId);
    return advanceToNextOrComplete(workflow, results, resolveVars, selectedOption.goto);
}
/** Shared tail of advanceBoardWorkflow: move to the next stopping point or complete. */
function advanceToNextOrComplete(workflow, results, resolveVars, goto) {
    const sps = workflow.stoppingPoints;
    if (sps && workflow.currentPhase < sps.length - 1) {
        if (goto !== undefined) {
            const idx = sps.findIndex(sp => sp.id === goto);
            workflow.currentPhase = idx >= 0 ? idx : workflow.currentPhase + 1;
            if (idx < 0)
                console.error(`[Workflow] advanceBoardWorkflow: goto id=${goto} not found, advancing sequentially`);
        }
        else {
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
export function getActiveWorkflowMenuMarkdown(conversationId) {
    const workflow = activeWorkflows.get(conversationId);
    if (!workflow || workflow.step !== 'menu' || !workflow.stoppingPoints?.length)
        return null;
    return formatStoppingPointMenu(workflow);
}
/**
 * Execute a sequence of workflow steps.
 * Handles loops, variable capture/chaining, and progress streaming.
 */
export async function executeSteps(steps, variables, onEvent, conversationId = '') {
    const allResults = [];
    for (const step of steps) {
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
                console.error(`[Workflow] skipping non-tool step ${step.id ?? '?'} (no server/tool and no prompt); ` +
                    `nothing for the tool executor to run`);
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
                const resolvedPrompt = String(resolveTemplate(promptText, variables)) + priorContext;
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
                if (out.trim())
                    allResults.push(out.trim());
                else
                    console.error(`[Workflow] prompt step ${stepId} returned empty output`);
            }
            catch (err) {
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
        let batchItems = null;
        if (loopCount > 1 && !step.sequential) {
            const sampleArgs = resolveTemplate({ ...step.args }, { ...variables, i: '1' });
            const llmEntries = Object.entries(sampleArgs).filter(([_, v]) => typeof v === 'string' && LLM_PATTERN.test(v));
            console.error(`[Workflow] batch eval: step=${step.id || '?'} loopCount=${loopCount} llmEntries=${llmEntries.length} (keys: ${llmEntries.map(e => e[0]).join(',') || 'none'})`);
            if (llmEntries.length === 1) {
                const sampleStr = llmEntries[0][1];
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
                            }
                            catch { /* try next candidate */ }
                        }
                        if (!batchItems) {
                            console.error(`[Workflow] batch: no candidate parsed as Array of >=${loopCount} strings (tried ${candidates.length})`);
                        }
                    }
                    catch (e) {
                        console.error(`[Workflow] batch generation failed, falling back to per-item: ${e}`);
                    }
                    onEvent({ type: 'tool_call_end', toolName: `LLM → ${toolLabel}`, toolId: batchToolId, success: !!batchItems, executionTime: 0 });
                }
            }
        }
        for (let i = 1; i <= loopCount; i++) {
            variables.i = String(i);
            let resolvedArgs = resolveTemplate(step.args, variables);
            // LLM enrichment: resolve {{LLM:prompt}} fields with active provider.
            // If batch pre-generation succeeded, substitute cached items directly.
            const hasLLM = Object.values(resolvedArgs).some(v => typeof v === 'string' && LLM_PATTERN.test(v));
            if (hasLLM) {
                const toolLabel = `${step.server}::${step.tool}`;
                if (batchItems) {
                    // Use pre-generated batch item — no additional LLM call needed
                    for (const [key, value] of Object.entries(resolvedArgs)) {
                        if (typeof value === 'string' && LLM_PATTERN.test(value)) {
                            resolvedArgs[key] = batchItems[i - 1];
                        }
                    }
                }
                else {
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
                let result;
                // Special gateway-internal tools — no subprocess needed
                if (step.server === '_gateway' && step.tool === 'create_skill') {
                    const name = (resolvedArgs.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    const description = resolvedArgs.description || name;
                    const skillType = resolvedArgs.skill_type || 'simple';
                    const requiredTools = resolvedArgs.required_tools || 'none';
                    // Generate SKILL.md content — use LLM for smart generation, fall back to template
                    let skillContent;
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
                        }
                        else {
                            skillContent = await generateSkillContent(name, description, skillType, requiredTools, variables);
                            console.error(`[Workflow] LLM output invalid, using template`);
                        }
                    }
                    catch {
                        skillContent = await generateSkillContent(name, description, skillType, requiredTools, variables);
                        console.error(`[Workflow] LLM unavailable, using template`);
                    }
                    // Generate trigger phrases — use LLM if available, fall back to simple generation
                    let triggers;
                    try {
                        const triggerResult = await rawLLMCall(`Generate 3 trigger phrases for an Vodou skill called "${name}" that does: "${description}". These are what a user would say to activate the skill. Output ONLY a JSON array like ["phrase one","phrase two","phrase three"]. No explanation.`);
                        const parsed = JSON.parse(triggerResult.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
                        triggers = Array.isArray(parsed) ? parsed.slice(0, 4) : generateTriggers(name, description);
                        console.error(`[Workflow] LLM generated triggers: ${triggers.join(', ')}`);
                    }
                    catch {
                        triggers = generateTriggers(name, description);
                    }
                    // Create via API
                    const apiResp = await fetch('http://localhost:8765/api/skills', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name, description, category: 'my-skills' }),
                    });
                    const apiResult = await apiResp.json().catch(() => ({}));
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
                    }
                    else {
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
                            }
                            catch (e) {
                                console.error(`[Workflow] failed to extract actions.json from LLM output: ${e}`);
                            }
                        }
                        else {
                            // LLM didn't include AGENT_ACTIONS — generate from template
                            const actionsJson = generateActionsJson(skillType, requiredTools);
                            const actionsPath = apiResult.file_path.replace('SKILL.md', 'actions.json');
                            await writeFile(actionsPath, JSON.stringify(actionsJson, null, 2), 'utf-8');
                            console.error(`[Workflow] wrote template actions.json`);
                        }
                        // Register intent mappings — ONLY now that the SKILL.md exists on disk
                        // (P1-6: previously ran even when the file write was skipped).
                        const { getDb } = await import('./db.js');
                        const db = getDb();
                        for (let i = 0; i < triggers.length; i++) {
                            db.prepare(`INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority, execution_type, tool_parameters) VALUES (?, 'vodou-core', 'vc_load_skill', ?, 'mcp', ?)`).run(triggers[i], i === 0 ? 10 : 9, JSON.stringify({ skill_name: name }));
                        }
                        result = JSON.stringify({ ok: true, name, file_path: apiResult.file_path, triggers, description });
                        console.error(`[Workflow] _gateway::create_skill created "${name}" with ${triggers.length} triggers`);
                    }
                }
                else {
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
                        }
                        else {
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
            }
            catch (err) {
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
export function hasActiveWorkflow(conversationId) {
    return activeWorkflows.has(conversationId);
}
export function getActiveWorkflow(conversationId) {
    return activeWorkflows.get(conversationId);
}
/** Execute initial_steps for a workflow — auto-fires on skill load before any menu */
export async function executeInitialSteps(workflow, onEvent, conversationId = '') {
    if (!workflow.initialSteps || workflow.initialSteps.length === 0)
        return '';
    console.error(`[Workflow] Running ${workflow.initialSteps.length} initial steps for "${workflow.skillName}"`);
    const results = await executeSteps(workflow.initialSteps, workflow.variables, onEvent, conversationId);
    return results;
}
export function clearWorkflow(conversationId) {
    activeWorkflows.delete(conversationId);
}
