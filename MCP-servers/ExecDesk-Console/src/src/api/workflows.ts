/**
 * Workflows API — programmatic skill workflow execution
 *
 * Part of the Orchestration API (PLAN-12).
 * Execute skill workflows (actions.json) via REST without going through chat.
 * Uses the workflow-driver's step execution engine directly.
 */

import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { getDb, getProjectRoot } from '../db.js';
import { runVodouCore, freshEnv } from '../executor.js';

const router = Router();

interface WorkflowStep {
  id?: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  loop?: string | number;
  capture?: Record<string, string>;
  stream_progress?: boolean;
}

interface StepResult {
  step_index: number;
  server: string;
  tool: string;
  success: boolean;
  output: string;
  duration_ms: number;
  error?: string;
  iteration?: number;
}

// Active workflow executions (for status polling)
const executions: Map<string, {
  id: string;
  skill: string;
  status: 'running' | 'complete' | 'failed';
  started_at: number;
  steps_done: number;
  steps_total: number;
  results: StepResult[];
  error?: string;
}> = new Map();

/**
 * POST /api/workflows/execute — Execute a skill workflow
 *
 * Body: {
 *   skill: string,           — skill name (looks up actions.json)
 *   stopping_point?: number,  — which stopping point (default: 1)
 *   option: string,           — which option to execute ("1", "2", etc.)
 *   vars?: object,            — override/provide template variables (e.g. { TOPIC: "auth.rs" })
 * }
 *
 * Response: { workflow_id, status: 'running' } (poll /api/workflows/:id for results)
 *   OR for synchronous: { workflow_id, status: 'complete', results: [...] }
 *
 * Query params:
 *   ?async=true — return immediately with workflow_id (poll for results)
 */
router.post('/execute', async (req: Request, res: Response) => {
  const { skill, stopping_point, option, vars } = req.body;

  if (!skill || !option) {
    res.status(400).json({ error: 'skill and option are required' });
    return;
  }

  // Find the skill and its actions.json
  const actions = loadActionsJson(skill);
  if (!actions) {
    res.status(404).json({ error: `Skill '${skill}' not found or has no actions.json` });
    return;
  }

  const spId = stopping_point ?? 1;
  const sp = actions.stopping_points?.find((s: any) => s.id === spId);
  if (!sp) {
    res.status(404).json({ error: `Stopping point ${spId} not found in skill '${skill}'` });
    return;
  }

  const selectedOption = sp.options?.[String(option)];
  if (!selectedOption) {
    const available = Object.keys(sp.options || {}).join(', ');
    res.status(400).json({ error: `Option '${option}' not found. Available: ${available}` });
    return;
  }

  const workflowId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const mergedVars: Record<string, string> = {
    ...(selectedOption.vars || {}),
    ...(vars || {}),
  };

  const isAsync = req.query.async === 'true';

  // Initialize execution tracker
  executions.set(workflowId, {
    id: workflowId,
    skill,
    status: 'running',
    started_at: Date.now(),
    steps_done: 0,
    steps_total: countSteps(selectedOption.steps, mergedVars),
    results: [],
  });

  if (isAsync) {
    // Return immediately, execute in background
    res.json({ workflow_id: workflowId, status: 'running' });
    executeSteps(workflowId, selectedOption.steps, mergedVars).catch(() => {});
  } else {
    // Synchronous — wait for completion
    try {
      await executeSteps(workflowId, selectedOption.steps, mergedVars);
      const exec = executions.get(workflowId)!;
      res.json({
        workflow_id: workflowId,
        status: exec.status,
        duration_ms: Date.now() - exec.started_at,
        steps_done: exec.steps_done,
        results: exec.results,
        error: exec.error,
      });
    } catch (error) {
      const exec = executions.get(workflowId);
      res.status(500).json({
        workflow_id: workflowId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        results: exec?.results || [],
      });
    }
  }
});

/**
 * GET /api/workflows/:id — Get workflow execution status/results
 */
router.get('/:id', (req: Request, res: Response) => {
  const exec = executions.get(req.params.id);
  if (!exec) {
    res.status(404).json({ error: 'Workflow execution not found' });
    return;
  }

  res.json({
    workflow_id: exec.id,
    skill: exec.skill,
    status: exec.status,
    duration_ms: Date.now() - exec.started_at,
    steps_done: exec.steps_done,
    steps_total: exec.steps_total,
    results: exec.results,
    error: exec.error,
  });
});

/**
 * GET /api/workflows/:skillName/actions — Get a skill's actions.json (for building UIs)
 */
router.get('/:skillName/actions', (req: Request, res: Response) => {
  const actions = loadActionsJson(req.params.skillName);
  if (!actions) {
    res.status(404).json({ error: `Skill '${req.params.skillName}' not found or has no actions.json` });
    return;
  }
  res.json(actions);
});

/**
 * GET /api/workflows — List all skills that have actions.json (executable workflows)
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const skills = db.prepare(`
      SELECT name, description, file_path, required_tools, is_active
      FROM skills_registry
      WHERE is_active = 1
      ORDER BY name
    `).all() as any[];

    const executableSkills = skills
      .filter(s => {
        const actions = loadActionsJson(s.name);
        return actions !== null;
      })
      .map(s => ({
        name: s.name,
        description: s.description,
        has_actions: true,
        required_tools: s.required_tools ? JSON.parse(s.required_tools) : [],
      }));

    res.json({
      count: executableSkills.length,
      skills: executableSkills,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});


// --- Internal helpers ---

/**
 * Load actions.json for a skill by name.
 * Searches skills_registry for file_path, then looks for actions.json alongside SKILL.md.
 */
function loadActionsJson(skillName: string): any | null {
  try {
    const db = getDb();
    const skill = db.prepare(
      'SELECT file_path FROM skills_registry WHERE name = ? AND is_active = 1 LIMIT 1'
    ).get(skillName) as { file_path: string } | undefined;

    if (!skill) return null;

    const root = getProjectRoot();
    // file_path in DB is relative to skills/ dir (e.g. "my-skills/chuck-norris/SKILL.md")
    // Try with skills/ prefix first, then without
    let skillDir = path.dirname(path.resolve(root, 'skills', skill.file_path));
    let actionsPath = path.join(skillDir, 'actions.json');
    try {
      readFileSync(actionsPath); // test if it exists
    } catch {
      // Fallback: maybe the path already includes skills/
      skillDir = path.dirname(path.resolve(root, skill.file_path));
      actionsPath = path.join(skillDir, 'actions.json');
    }

    const raw = readFileSync(actionsPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Count total steps including loop expansions
 */
function countSteps(steps: WorkflowStep[], vars: Record<string, string>): number {
  let count = 0;
  for (const step of steps) {
    if (step.loop) {
      const loopCount = resolveLoop(step.loop, vars);
      count += loopCount;
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Resolve loop count from a step's loop field (number, string number, or template var)
 */
function resolveLoop(loop: string | number, vars: Record<string, string>): number {
  if (typeof loop === 'number') return loop;
  const resolved = resolveTemplate(String(loop), vars);
  const n = parseInt(resolved, 10);
  return isNaN(n) ? 1 : n;
}

/**
 * Replace {{VAR}} templates in a value with resolved variables
 */
function resolveTemplate(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/**
 * Deep-resolve templates in an args object
 */
function resolveArgs(args: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === 'string') {
      resolved[key] = resolveTemplate(val, vars);
    } else if (typeof val === 'object' && val !== null) {
      resolved[key] = resolveArgs(val as Record<string, unknown>, vars);
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

/**
 * Execute workflow steps sequentially, handling loops, captures, and template vars
 */
async function executeSteps(
  workflowId: string,
  steps: WorkflowStep[],
  vars: Record<string, string>,
): Promise<void> {
  const exec = executions.get(workflowId);
  if (!exec) return;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const loopCount = step.loop ? resolveLoop(step.loop, vars) : 1;

      for (let iteration = 0; iteration < loopCount; iteration++) {
        const iterVars = { ...vars, i: String(iteration + 1) };
        const resolvedArgs = resolveArgs(step.args, iterVars);
        const startTime = Date.now();

        try {
          const output = await runVodouCore(step.server, step.tool, resolvedArgs);

          // Handle capture — extract fields from JSON output into vars
          if (step.capture) {
            try {
              const parsed = JSON.parse(output);
              for (const [varName, jsonPath] of Object.entries(step.capture)) {
                const value = parsed[jsonPath] ?? parsed[varName];
                if (value !== undefined) {
                  vars[varName] = String(value);
                }
              }
            } catch {
              // Output wasn't JSON — try to capture the whole thing
              for (const [varName] of Object.entries(step.capture)) {
                vars[varName] = output.trim();
              }
            }
          }

          const result: StepResult = {
            step_index: i,
            server: step.server,
            tool: step.tool,
            success: true,
            output,
            duration_ms: Date.now() - startTime,
            iteration: loopCount > 1 ? iteration + 1 : undefined,
          };

          exec.results.push(result);
          exec.steps_done++;

        } catch (error) {
          const result: StepResult = {
            step_index: i,
            server: step.server,
            tool: step.tool,
            success: false,
            output: '',
            error: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - startTime,
            iteration: loopCount > 1 ? iteration + 1 : undefined,
          };

          exec.results.push(result);
          exec.steps_done++;
          // Continue executing remaining steps even if one fails
        }
      }
    }

    exec.status = 'complete';
  } catch (error) {
    exec.status = 'failed';
    exec.error = error instanceof Error ? error.message : String(error);
  }
}

export { router as workflowsRouter };
