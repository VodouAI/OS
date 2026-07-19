/**
 * Memory Extractor API — Stage 3.1 of smarter-memory.
 *
 * Lets the Settings UI:
 *   - see which extractor backend is currently in effect (local Ollama vs a
 *     remote LLM vendor)
 *   - flip the backend persistently via the `memory_extractor_provider`
 *     `gateway_settings` key (vodou-core reads this key in
 *     `MemoryConfig::effective_extraction_provider`)
 *   - run the 50-prompt extraction benchmark (`vodou-core mem bench-extract`)
 *     in compare-vs-reference mode and surface pass/fail inline before
 *     committing a default flip
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { getSetting, setSetting, getProjectRoot } from '../db.js';

const router = Router();

const KNOWN_BACKENDS = [
  'anthropic',
  'claude',
  'ollama',
  'openai',
  'google',
  'groq',
  'deepseek',
  'kimi',
  'xai',
  'mistral',
  'openrouter',
  'heuristic',
  'auto',
];

/** Absolute path to the vodou-core binary. Mirrors `VC_PATH()` in executor.ts. */
function bt4Path(): string {
  return process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
}

/**
 * GET /api/memory/extractor/status
 * Return current backend (effective priority = gateway_settings override →
 * fallback "default"), available backend options, and whether the last bench
 * passed if cached.
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    const override = getSetting('memory_extractor_provider');
    const lastBenchRaw = getSetting('memory_extractor_last_bench');
    let lastBench: unknown = null;
    if (lastBenchRaw) {
      try { lastBench = JSON.parse(lastBenchRaw); } catch { lastBench = null; }
    }
    res.json({
      override: override ?? null,            // explicit gateway flip, or null
      backends: KNOWN_BACKENDS,
      lastBench,                             // null if never run
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/memory/extractor/set-backend
 * Body: { provider: string | null }  — null clears the override
 */
router.post('/set-backend', (req: Request, res: Response) => {
  const { provider } = req.body ?? {};
  if (provider !== null && provider !== undefined) {
    if (typeof provider !== 'string' || !KNOWN_BACKENDS.includes(provider.toLowerCase())) {
      return res.status(400).json({ error: `provider must be one of: ${KNOWN_BACKENDS.join(', ')}, or null to clear` });
    }
  }
  try {
    if (provider === null || provider === undefined || provider === '') {
      // Clear the override — vodou-core will fall back to memory.toml.
      setSetting('memory_extractor_provider', '');
    } else {
      setSetting('memory_extractor_provider', String(provider).toLowerCase());
    }
    res.json({ ok: true, override: provider ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/memory/extractor/bench
 * Body: { backend: string, reference?: string }
 * Spawns `vodou-core mem bench-extract --backend <b> [--reference <r>] --json`
 * and returns the parsed BenchReport. The cached result is also written to
 * `memory_extractor_last_bench` for the Status endpoint.
 *
 * Long-running — 50 prompts × (1 or 2 provider calls). Response time scales
 * with provider latency. Caller SHOULD show a loading UI and not time out
 * for at least 5 minutes. A SSE/streaming mode could come in a future pass;
 * this is a one-shot POST for simplicity.
 */
router.post('/bench', async (req: Request, res: Response) => {
  const { backend, reference } = req.body ?? {};
  if (typeof backend !== 'string' || !backend) {
    return res.status(400).json({ error: 'backend required' });
  }
  if (reference !== undefined && (typeof reference !== 'string' || !reference)) {
    return res.status(400).json({ error: 'reference must be a non-empty string if provided' });
  }
  const args = ['mem', 'bench-extract', '--backend', backend, '--json'];
  if (reference) {
    args.push('--reference', reference);
  }

  try {
    const result = await runBt4(args, 300_000);
    // bt4 exits non-zero when the bench fails its pass threshold. Still parse
    // the JSON body — the row-by-row results are useful even on failure.
    let parsed: any = null;
    try { parsed = JSON.parse(result.stdout); } catch {}
    if (!parsed) {
      return res.status(500).json({
        error: 'vodou-core bench-extract did not return valid JSON',
        stderr: result.stderr,
        exit: result.code,
      });
    }
    // Cache for the Status endpoint — trimmed so we don't blow up the settings row.
    const cached = {
      backend: parsed.backend,
      reference: parsed.reference,
      passed: parsed.passed,
      total: parsed.total,
      pass_rate: parsed.pass_rate,
      pass: parsed.pass,
      avg_cosine: parsed.avg_cosine,
      ran_at: new Date().toISOString(),
    };
    try { setSetting('memory_extractor_last_bench', JSON.stringify(cached)); } catch {}

    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * Spawn vodou-core with the given args, capture stdout+stderr+exitcode.
 * Resolves even on non-zero exit — caller decides what to do with the code.
 * Rejects only on spawn failure or timeout.
 */
function runBt4(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bt4Path(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (d: Buffer) => { chunks.push(d); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error(`vodou-core ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      stdout = Buffer.concat(chunks).toString('utf8');
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export default router;
