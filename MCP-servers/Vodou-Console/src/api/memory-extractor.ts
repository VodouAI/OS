/**
 * Memory Extractor API — Stage 3.1 of smarter-memory (+ model selector parity).
 *
 * Lets the Settings UI:
 *   - see which extractor backend is currently in effect
 *   - flip provider via `memory_extractor_provider` gateway_settings
 *   - pick model via `memory_extractor_model` (empty = follow chat model live)
 *   - run the 50-prompt extraction benchmark
 *
 * Model lists come from the same `/api/settings/models/:provider` catalog as
 * Settings → LLM/Model — when that catalog updates, extraction inherits it.
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getSetting, setSetting, getProjectRoot } from '../db.js';

export const memoryExtractorRouter = Router();
export default memoryExtractorRouter;

const KNOWN_BACKENDS = [
  'auto',
  'anthropic',
  'claude',
  'claude-cli',
  'ollama',
  'openai',
  'google',
  'groq',
  'deepseek',
  'kimi',
  'kimi-cli',
  'xai',
  'mistral',
  'openrouter',
  'fireworks',
  'together',
  'vodou',
  'lmstudio',
  'llamacpp',
  'custom',
  'heuristic',
];

/** Map extraction provider → Settings models-API / chat model setting key. */
function catalogProvider(provider: string): string {
  const p = (provider || '').toLowerCase();
  if (p === 'claude') return 'claude-cli';
  return p;
}

function chatModelKey(provider: string): string | null {
  const p = catalogProvider(provider);
  const map: Record<string, string> = {
    'claude-cli': 'cli_model',
    anthropic: 'claude_model',
    openai: 'openai_model',
    google: 'google_model',
    groq: 'groq_model',
    deepseek: 'deepseek_model',
    xai: 'xai_model',
    mistral: 'mistral_model',
    openrouter: 'openrouter_model',
    fireworks: 'fireworks_model',
    vodou: 'vodou_model',
    together: 'together_model',
    kimi: 'kimi_model',
    'kimi-cli': 'kimi_cli_model',
    ollama: 'ollama_model',
    lmstudio: 'lmstudio_model',
    llamacpp: 'llamacpp_model',
    custom: 'custom_llm_model',
  };
  return map[p] || null;
}

function readTomlProvider(): string {
  try {
    const raw = fs.readFileSync(path.join(getProjectRoot(), 'memory.toml'), 'utf8');
    const m = raw.match(/\[extraction\][\s\S]*?^provider\s*=\s*"([^"]+)"/m);
    return (m?.[1] || 'auto').trim().toLowerCase();
  } catch {
    return 'auto';
  }
}

/** Resolve provider the same way Rust does (env → gateway override → toml). */
function resolveProvider(): { provider: string; source: string } {
  const env = (process.env.VODOU_MEMORY_EXTRACTION_PROVIDER || '').trim().toLowerCase();
  if (env) return { provider: env, source: 'env' };
  const override = (getSetting('memory_extractor_provider') || '').trim().toLowerCase();
  if (override) return { provider: override, source: 'override' };
  return { provider: readTomlProvider(), source: 'memory.toml' };
}

function resolveAutoTarget(): string {
  return (getSetting('llm_provider') || '').trim().toLowerCase() || 'anthropic';
}

function chatModelFor(provider: string): string {
  const key = chatModelKey(provider);
  if (!key) return '';
  return (getSetting(key) || '').trim();
}

function resolveModel(effectiveProvider: string): {
  model: string;
  model_override: string | null;
  follow_chat: boolean;
  source: string;
} {
  const env = (process.env.VODOU_MEMORY_EXTRACTION_MODEL || '').trim();
  if (env) return { model: env, model_override: env, follow_chat: false, source: 'env' };
  const override = (getSetting('memory_extractor_model') || '').trim();
  if (override) {
    return { model: override, model_override: override, follow_chat: false, source: 'override' };
  }
  const lane = effectiveProvider === 'auto' || effectiveProvider === 'gateway'
    ? resolveAutoTarget()
    : effectiveProvider;
  const chat = chatModelFor(lane);
  if (chat) return { model: chat, model_override: null, follow_chat: true, source: 'chat' };
  return { model: '', model_override: null, follow_chat: true, source: 'default' };
}

function bt4Path(): string {
  return process.env.VC_PATH || process.env.BT4_PATH || path.join(getProjectRoot(), 'vodou-core');
}

memoryExtractorRouter.get('/status', (_req: Request, res: Response) => {
  try {
    const { provider, source } = resolveProvider();
    const effectiveLane = provider === 'auto' || provider === 'gateway' ? resolveAutoTarget() : provider;
    const modelInfo = resolveModel(provider);
    const lastBenchRaw = getSetting('memory_extractor_last_bench');
    let lastBench: unknown = null;
    if (lastBenchRaw) {
      try { lastBench = JSON.parse(lastBenchRaw); } catch { lastBench = null; }
    }
    const chatProvider = (getSetting('llm_provider') || '').trim().toLowerCase() || null;
    res.json({
      override: (getSetting('memory_extractor_provider') || '').trim() || null,
      model_override: modelInfo.model_override,
      backends: KNOWN_BACKENDS,
      lastBench,
      effective_provider: provider,
      effective_lane: effectiveLane,
      effective_model: modelInfo.model,
      follow_chat: modelInfo.follow_chat,
      provider_source: source,
      model_source: modelInfo.source,
      catalog_provider: catalogProvider(effectiveLane),
      chat: {
        provider: chatProvider,
        model: chatProvider ? chatModelFor(chatProvider) : null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

memoryExtractorRouter.post('/set-backend', (req: Request, res: Response) => {
  const { provider, model } = req.body ?? {};
  try {
    if (provider !== undefined) {
      if (provider !== null && provider !== '') {
        if (typeof provider !== 'string' || !KNOWN_BACKENDS.includes(provider.toLowerCase())) {
          return res.status(400).json({
            error: `provider must be one of: ${KNOWN_BACKENDS.join(', ')}, or null to clear`,
          });
        }
        setSetting('memory_extractor_provider', String(provider).toLowerCase());
      } else {
        setSetting('memory_extractor_provider', '');
      }
    }
    if (model !== undefined) {
      if (model !== null && model !== '') {
        if (typeof model !== 'string' || model.length > 200) {
          return res.status(400).json({ error: 'model must be a short string, or null to follow chat' });
        }
        setSetting('memory_extractor_model', String(model).trim());
      } else {
        setSetting('memory_extractor_model', '');
      }
    }
    const { provider: eff, source } = resolveProvider();
    const lane = eff === 'auto' || eff === 'gateway' ? resolveAutoTarget() : eff;
    const modelInfo = resolveModel(eff);
    res.json({
      ok: true,
      override: (getSetting('memory_extractor_provider') || '').trim() || null,
      model_override: modelInfo.model_override,
      effective_provider: eff,
      effective_lane: lane,
      effective_model: modelInfo.model,
      follow_chat: modelInfo.follow_chat,
      provider_source: source,
      model_source: modelInfo.source,
      catalog_provider: catalogProvider(lane),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

memoryExtractorRouter.post('/bench', (req: Request, res: Response) => {
  const backend = String(req.body?.backend || '').toLowerCase();
  const reference = req.body?.reference ? String(req.body.reference).toLowerCase() : '';
  if (!backend || !KNOWN_BACKENDS.includes(backend) || backend === 'auto' || backend === 'heuristic') {
    return res.status(400).json({ error: 'backend required (not auto/heuristic)' });
  }
  const args = ['mem', 'bench-extract', '--backend', backend, '--json'];
  if (reference) args.push('--reference', reference);

  const child = spawn(bt4Path(), args, {
    cwd: getProjectRoot(),
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* noop */ }
  }, 10 * 60 * 1000);
  child.on('close', (code) => {
    clearTimeout(timer);
    try {
      const report = JSON.parse(stdout.trim());
      try {
        setSetting('memory_extractor_last_bench', JSON.stringify({
          ...report,
          ran_at: new Date().toISOString(),
        }));
      } catch { /* ignore cache write */ }
      res.json(report);
    } catch {
      res.status(500).json({
        error: `bench failed (exit ${code}): ${(stderr || stdout).slice(0, 500)}`,
      });
    }
  });
});
