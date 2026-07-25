#!/usr/bin/env node
/**
 * Sync BYOK LLM model catalogs into public/data/llm-models/*.json for offline Settings UI.
 *
 *   npm run sync:llm-models
 *   npm run sync:llm-models -- --provider openai
 *   npm run sync:llm-models -- --check
 *   npm run sync:llm-models -- --dry-run
 *   npm run sync:llm-models -- --release
 *   npm run sync:llm-models -- --drift          # curated flagship drift only
 *   npm run sync:llm-models -- --max-age-days 14
 *
 * Curated providers (vodou, claude-cli, kimi-cli) are never overwritten from the network.
 * On --release / --drift: compare curated lists to live APIs and WARN (or FAIL if
 * VODOU_LLM_CATALOG_STRICT=1) when newer flagship IDs are missing from the curated file.
 *
 * Keys: same env names as chat (.env / process.env). VODOU_SYNC_SKIP=google,xai skips in --release.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');
const outDir = path.join(gatewayRoot, 'public', 'data', 'llm-models');
const legacyOpenRouter = path.join(gatewayRoot, 'public', 'data', 'openrouter-models.json');

const CURATED = new Set(['vodou', 'claude-cli', 'kimi-cli']);

function loadDotEnv() {
  for (const rel of [path.join(gatewayRoot, '..', '..', '.env'), path.join(gatewayRoot, '.env')]) {
    try {
      const raw = fs.readFileSync(rel, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        if (process.env[k]) continue;
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[k] = v.replace(/\r$/, '');
      }
    } catch {}
  }
}

/** Prefer Settings/gateway keys when .env omits them (never logs values). */
function loadGatewaySettingsKeys() {
  const dbPath = path.join(gatewayRoot, 'gateway.db');
  const map = {
    openai_api_key: 'OPENAI_API_KEY',
    anthropic_api_key: 'ANTHROPIC_API_KEY',
    google_api_key: 'GOOGLE_API_KEY',
    groq_api_key: 'GROQ_API_KEY',
    deepseek_api_key: 'DEEPSEEK_API_KEY',
    xai_api_key: 'XAI_API_KEY',
    mistral_api_key: 'MISTRAL_API_KEY',
    fireworks_api_key: 'FIREWORKS_API_KEY',
    together_api_key: 'TOGETHER_API_KEY',
    openrouter_api_key: 'OPENROUTER_API_KEY',
    kimi_api_key: 'KIMI_API_KEY',
  };
  try {
    const out = execFileSync(
      'sqlite3',
      [dbPath, 'SELECT key || char(9) || value FROM gateway_settings WHERE value IS NOT NULL AND length(value) > 0;'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    let n = 0;
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const env = map[line.slice(0, tab)];
      if (!env || process.env[env]) continue;
      process.env[env] = line.slice(tab + 1).replace(/\r$/, '');
      n++;
    }
    if (n) console.log(`[keys] loaded ${n} from gateway.db (Settings)`);
  } catch {
    /* gateway.db optional */
  }
}

function envKey(...names) {
  for (const n of names) {
    const v = (process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
}

function openaiishIds(data, filter) {
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  let ids = rows
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
    .filter(Boolean)
    .map(String);
  if (filter) ids = ids.filter(filter);
  return [...new Set(ids)].sort();
}

/** @type {Record<string, { url: string, headers?: (key: string) => Record<string,string>, keyNames: string[], keyOptional?: boolean, filter?: (id: string) => boolean, map?: (j: any) => string[] }>} */
const AUTO = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models?output_modalities=all',
    keyNames: ['OPENROUTER_API_KEY'],
    keyOptional: true,
    headers: (key) => {
      const h = {
        Accept: 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || process.env.GATEWAY_BASE_URL || 'https://github.com/vodou-ai/oi',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'Vodou-Console-vendor-script',
      };
      if (key) h.Authorization = `Bearer ${key}`;
      return h;
    },
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    keyNames: ['OPENAI_API_KEY'],
    filter: (id) => /^(gpt-|o\d|chatgpt-|o1|o3|o4)/i.test(id) && !/image|realtime|audio|transcribe|tts|whisper|search|instruct/i.test(id),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1000',
    keyNames: ['ANTHROPIC_API_KEY'],
    headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      Accept: 'application/json',
    }),
    map: (j) => (j.data || []).map((m) => m.id).filter(Boolean).sort(),
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    keyNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    filter: (id) => {
      const bare = id.replace(/^models\//, '');
      return /^gemini-/i.test(bare) && !/embedding|imagen|aqa|tts|image|computer-use|native-audio/i.test(bare);
    },
    map: (j) =>
      openaiishIds(j, (id) => {
        const bare = String(id).replace(/^models\//, '');
        return /^gemini-/i.test(bare) && !/embedding|imagen|aqa|tts|image|computer-use|native-audio/i.test(bare);
      }).map((id) => String(id).replace(/^models\//, '')),
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    keyNames: ['GROQ_API_KEY'],
    filter: (id) => !/whisper|tts|guard/i.test(id),
  },
  deepseek: {
    url: 'https://api.deepseek.com/v1/models',
    keyNames: ['DEEPSEEK_API_KEY'],
  },
  xai: {
    url: 'https://api.x.ai/v1/models',
    keyNames: ['XAI_API_KEY'],
    filter: (id) => /^grok-/i.test(id),
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/models',
    keyNames: ['MISTRAL_API_KEY'],
    filter: (id) => !/embed|moderation/i.test(id),
  },
  fireworks: {
    url: 'https://api.fireworks.ai/inference/v1/models',
    keyNames: ['FIREWORKS_API_KEY'],
    // Prefer live API when key works; sync main also has sitemap fallback.
    filter: (id) =>
      id.includes('accounts/fireworks/models/') &&
      !/(embed|bge-|e5-|asr|whisper|flux|ssd-|controlnet|firesearch-ocr|rerank|clip|stable-diffusion|sdxl|imagen)/i.test(
        id,
      ),
  },
  together: {
    url: 'https://api.together.ai/v1/models',
    keyNames: ['TOGETHER_API_KEY'],
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/models',
    keyNames: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  },
};

function parseArgs(argv) {
  const out = {
    provider: null,
    check: false,
    dryRun: false,
    release: false,
    drift: false,
    maxAgeDays: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--release') out.release = true;
    else if (a === '--drift') out.drift = true;
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--max-age-days') out.maxAgeDays = Number(argv[++i]);
  }
  return out;
}

function readCatalog(provider) {
  const p = path.join(outDir, `${provider}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function modelIds(payload) {
  const m = payload?.models;
  if (!Array.isArray(m)) return [];
  return m.map((x) => (typeof x === 'object' && x ? x.value : x)).filter(Boolean);
}

function diffIds(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  const added = [...a].filter((x) => !b.has(x)).sort();
  const removed = [...b].filter((x) => !a.has(x)).sort();
  return { added, removed };
}

async function fetchProvider(name, cfg) {
  const key = envKey(...cfg.keyNames);
  if (!key && !cfg.keyOptional) {
    const err = new Error(`missing key (${cfg.keyNames.join('|')})`);
    err.code = 'NO_KEY';
    throw err;
  }
  const headers = cfg.headers
    ? cfg.headers(key)
    : { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const resp = await fetch(cfg.url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`HTTP ${resp.status} ${body.slice(0, 200)}`);
    err.code = resp.status === 401 || resp.status === 403 ? 'AUTH' : 'HTTP';
    throw err;
  }
  const data = await resp.json();
  let models = cfg.map ? cfg.map(data) : openaiishIds(data, cfg.filter);
  if (!models.length) throw new Error('empty model list');
  return models;
}

/** Public Fireworks catalog via sitemap — no API key (filters non-chat modalities). */
async function fetchFireworksFromSitemap() {
  const resp = await fetch('https://fireworks.ai/sitemap.xml', {
    headers: { Accept: 'application/xml', 'User-Agent': 'Vodou-Console-llm-catalog-sync' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`sitemap HTTP ${resp.status}`);
  const xml = await resp.text();
  const slugs = [...new Set([...xml.matchAll(/models\/fireworks\/([a-zA-Z0-9._-]+)/g)].map((m) => m[1]))];
  const excl =
    /(embed|bge-|e5-|asr|whisper|flux|ssd-|controlnet|firesearch-ocr|rerank|clip|stable-diffusion|sdxl|imagen)/i;
  let models = slugs
    .filter((s) => !excl.test(s))
    .map((s) => `accounts/fireworks/models/${s}`);
  // Newest Moonshot / flagships first so Settings defaults stay useful when list is long
  const rank = (id) => {
    const s = id.toLowerCase();
    if (s.includes('kimi-k2p7-code')) return 0;
    if (s.includes('kimi-k2p6')) return 1;
    if (s.includes('kimi-k2p5')) return 2;
    if (s.includes('deepseek-v4-pro')) return 3;
    if (s.includes('deepseek-v4-flash')) return 4;
    if (s.includes('gpt-oss-120b')) return 5;
    if (s.includes('glm-5p1')) return 6;
    if (s.includes('kimi-')) return 10;
    return 100;
  };
  models = [...new Set(models)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  if (!models.length) throw new Error('fireworks sitemap empty');
  return models;
}

async function fetchFireworksModels() {
  try {
    return { models: await fetchProvider('fireworks', AUTO.fireworks), source: AUTO.fireworks.url };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[fireworks] API unavailable (${why.slice(0, 80)}) — falling back to public sitemap`);
    return {
      models: await fetchFireworksFromSitemap(),
      source: 'https://fireworks.ai/sitemap.xml',
    };
  }
}

function writeCatalog(provider, models, source) {
  const prev = readCatalog(provider);
  const payload = {
    provider,
    mode: 'auto',
    source,
    fetched_at: new Date().toISOString(),
    count: models.length,
    models,
  };
  if (!opts.dryRun && !opts.check) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${provider}.json`), JSON.stringify(payload, null, 2) + '\n');
    if (provider === 'openrouter') {
      fs.writeFileSync(
        legacyOpenRouter,
        JSON.stringify(
          {
            source,
            fetched_at: payload.fetched_at,
            count: models.length,
            models,
            note: 'Canonical copy at llm-models/openrouter.json; kept for one-release compat.',
          },
          null,
          2,
        ) + '\n',
      );
    }
  }
  const d = diffIds(modelIds(prev), models);
  const tag = d.added.length || d.removed.length
    ? `+${d.added.length}/-${d.removed.length}`
    : 'unchanged';
  console.log(`[${provider}] ${models.length} models (${tag})  ${opts.dryRun || opts.check ? '(no write)' : ''}`);
  if (d.added.length && d.added.length <= 20) console.log(`  + ${d.added.join(', ')}`);
  else if (d.added.length) console.log(`  + ${d.added.slice(0, 12).join(', ')} …`);
  if (d.removed.length && d.removed.length <= 20) console.log(`  - ${d.removed.join(', ')}`);
  return { provider, models, diff: d, prev };
}

function updateManifest() {
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  const providers = files.map((f) => f.replace(/\.json$/, '')).sort();
  const ages = [];
  for (const p of providers) {
    const c = readCatalog(p);
    if (c?.fetched_at) ages.push(c.fetched_at);
  }
  ages.sort();
  const manifest = {
    schema_version: 1,
    fetched_at: ages[ages.length - 1] || new Date().toISOString(),
    providers,
    auto: providers.filter((p) => !CURATED.has(p)),
    curated: providers.filter((p) => CURATED.has(p)),
  };
  if (!opts.dryRun && !opts.check) {
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  return manifest;
}

function checkMaxAge(days) {
  const now = Date.now();
  const maxMs = days * 86400_000;
  let fail = false;
  for (const p of Object.keys(AUTO)) {
    const c = readCatalog(p);
    if (!c?.fetched_at) {
      console.error(`[${p}] missing catalog`);
      fail = true;
      continue;
    }
    const age = now - Date.parse(c.fetched_at);
    if (Number.isFinite(age) && age > maxMs) {
      console.error(`[${p}] stale: fetched_at=${c.fetched_at} (>${days}d)`);
      fail = true;
    }
  }
  return fail;
}

/**
 * Curated drift: live API has flagship IDs our hand-maintained lists omit.
 * Never auto-writes curated JSON — only reports.
 * On --release (or VODOU_LLM_CATALOG_STRICT=1): missing flagships → hard fail.
 * Otherwise: warn only.
 */
async function checkCuratedDrift({ hardFail }) {
  let issues = 0;

  console.log('\n── Curated drift check ──');

  const reportMissing = (name, missing) => {
    const msg = `[${name}] curated missing live flagship(s): ${missing.join(', ')}`;
    if (hardFail) {
      console.error(`❌ ${msg}`);
      console.error(`    Update public/data/llm-models/${name}.json (+ Settings presets), then re-run.`);
    } else {
      console.warn(`⚠️  ${msg}`);
      console.warn(`    Update public/data/llm-models/${name}.json (+ Settings presets). Use --release or STRICT=1 to fail.`);
    }
    issues++;
  };

  // kimi + kimi-cli ← Moonshot /v1/models (preferred) or OpenRouter public mirror
  {
    let flagship = [];
    const key = envKey('KIMI_API_KEY', 'MOONSHOT_API_KEY');
    let source = '';
    try {
      if (key) {
        const live = await fetchProvider('kimi', AUTO.kimi);
        flagship = live.filter(isCurrentKimiFlagship);
        source = 'moonshot';
      } else {
        // No Moonshot key — still catch flagship gaps via OpenRouter public catalog
        const live = await fetchProvider('openrouter', AUTO.openrouter);
        flagship = live
          .filter((id) => /^moonshotai\//i.test(id))
          .map((id) => id.replace(/^moonshotai\//i, ''))
          .filter(isCurrentKimiFlagship);
        source = 'openrouter-mirror';
        console.log(`[kimi-cli/kimi] drift via OpenRouter mirror (${flagship.length} flagships) — set KIMI_API_KEY for native IDs`);
      }
    } catch (e) {
      console.warn(`[kimi drift] skipped — ${e instanceof Error ? e.message : e}`);
    }

    if (flagship.length) {
      for (const curatedName of ['kimi-cli', 'kimi']) {
        const shipped = new Set(modelIds(readCatalog(curatedName)));
        if (!shipped.size) {
          console.error(`[${curatedName}] curated catalog missing/empty`);
          issues++;
          continue;
        }
        const missing = flagship.filter((id) => !shipped.has(id)).sort();
        if (missing.length) reportMissing(curatedName, missing);
        else console.log(`[${curatedName}] ✅ curated covers live kimi-k* (${flagship.length} via ${source})`);
      }
    } else if (!key) {
      console.warn('[kimi-cli/kimi] drift skipped — no Moonshot key and OpenRouter mirror returned no kimi-k*');
    }
  }

  // vodou ← Fireworks: curated values must still exist (don't invent new SKUs)
  {
    const vodou = readCatalog('vodou');
    const ids = modelIds(vodou);
    if (!ids.length) {
      console.error('[vodou] curated catalog missing/empty');
      issues++;
    } else {
      let live = null;
      const key = envKey('FIREWORKS_API_KEY');
      if (key) {
        try {
          live = new Set(await fetchProvider('fireworks', AUTO.fireworks));
        } catch (e) {
          console.warn(`[vodou] Fireworks API failed (${e instanceof Error ? e.message.slice(0, 80) : e}) — trying sitemap`);
        }
      }
      if (!live) {
        try {
          live = new Set(await fetchFireworksFromSitemap());
        } catch (e) {
          console.warn(`[vodou] drift skipped — ${e instanceof Error ? e.message : e}`);
        }
      }
      if (live) {
        const gone = ids.filter((id) => !live.has(id));
        if (gone.length) {
          console.error(`❌ [vodou] curated IDs not on Fireworks: ${gone.join(', ')}`);
          issues++;
        } else {
          console.log(`[vodou] ✅ curated SKUs still present on Fireworks (${ids.length})`);
        }
      }
    }
  }

  // claude-cli: aliases only — remind on release, no auto live map
  {
    const cli = modelIds(readCatalog('claude-cli'));
    if (!cli.length) {
      console.error('[claude-cli] curated catalog missing/empty');
      issues++;
    } else {
      console.log(`[claude-cli] ✅ curated aliases present (${cli.join(', ')}) — bump manually when Anthropic ships a new CLI alias`);
    }
  }

  return issues;
}

loadDotEnv();
loadGatewaySettingsKeys();
// Gemini Settings often store as google_api_key → GOOGLE_API_KEY; mirror for sync keyNames
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
}
const opts = parseArgs(process.argv.slice(2));
if (opts.release && opts.maxAgeDays == null) opts.maxAgeDays = 21;

const skip = new Set(
  (process.env.VODOU_SYNC_SKIP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function isCurrentKimiFlagship(id) {
  const s = String(id);
  // Deprecated / sunset Moonshot IDs — do not require them in curated lists
  if (/^kimi-k2$/i.test(s)) return false;
  if (/^kimi-k2-\d/i.test(s)) return false; // kimi-k2-0905, etc.
  if (/preview|thinking|turbo|latest/i.test(s) && !/k2\.7-code/i.test(s)) return false;
  if (/^kimi-k\d/i.test(s)) return true; // kimi-k3, kimi-k2.5, kimi-k2.6, kimi-k2.7-code…
  if (/^kimi-for-coding/i.test(s)) return true;
  return false;
}

function catalogFreshEnough(name) {
  const c = readCatalog(name);
  if (!c?.models?.length || !c.fetched_at) return false;
  if (opts.maxAgeDays == null) return true;
  const age = Date.now() - Date.parse(c.fetched_at);
  return Number.isFinite(age) && age <= opts.maxAgeDays * 86400_000;
}

const targets = opts.drift && !opts.release && !opts.provider && !opts.check && !opts.dryRun
  ? [] // --drift alone: curated check only
  : opts.provider
    ? [opts.provider]
    : Object.keys(AUTO).sort();

if (opts.provider && CURATED.has(opts.provider)) {
  console.error(`Refusing to sync curated provider: ${opts.provider}`);
  process.exit(1);
}
if (opts.provider && !AUTO[opts.provider]) {
  console.error(`Unknown auto provider: ${opts.provider}`);
  process.exit(1);
}

let failed = 0;
let drifted = 0;
const results = [];

for (const name of targets) {
  if (skip.has(name)) {
    console.log(`[${name}] skipped (VODOU_SYNC_SKIP)`);
    if (opts.release) {
      const c = readCatalog(name);
      if (!c?.models?.length) {
        console.error(`[${name}] skip not allowed — catalog empty`);
        failed++;
      }
    }
    continue;
  }
  const cfg = AUTO[name];
  try {
    let models;
    let source;
    if (name === 'fireworks') {
      const fw = await fetchFireworksModels();
      models = fw.models;
      source = fw.source;
    } else {
      models = await fetchProvider(name, cfg);
      source = cfg.url.split('?')[0];
    }
    const r = writeCatalog(name, models, source);
    results.push(r);
    if (opts.check && (r.diff.added.length || r.diff.removed.length)) drifted++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e?.code === 'NO_KEY') {
      if (catalogFreshEnough(name)) {
        console.warn(`[${name}] no key — keeping shipped catalog (within ${opts.maxAgeDays ?? '?'}d)`);
        continue;
      }
      if (!opts.release) {
        console.warn(`[${name}] skip — ${msg}`);
        continue;
      }
      console.error(`[${name}] FAIL — ${msg} (catalog missing or older than ${opts.maxAgeDays}d)`);
      failed++;
      continue;
    }
    if (opts.release && catalogFreshEnough(name)) {
      console.warn(`[${name}] fetch failed (${msg}) — keeping shipped catalog`);
      continue;
    }
    console.error(`[${name}] FAIL — ${msg}`);
    failed++;
  }
}

if (!opts.check && targets.length) updateManifest();

if (opts.maxAgeDays != null && Number.isFinite(opts.maxAgeDays) && !opts.drift) {
  if (checkMaxAge(opts.maxAgeDays)) failed++;
}

const strictEnv = /^(1|true|yes)$/i.test(String(process.env.VODOU_LLM_CATALOG_STRICT || ''));
const runDrift = opts.release || opts.drift || strictEnv;
if (runDrift) {
  const driftIssues = await checkCuratedDrift({ hardFail: opts.release || strictEnv || opts.drift });
  if (driftIssues) failed += driftIssues;
}

if (opts.release && failed) {
  console.error(`\n--release failed (${failed} provider error(s) / drift issue(s))`);
  process.exit(1);
}
if (opts.drift && !opts.release && failed) {
  console.error(`\n--drift: ${failed} curated issue(s)`);
  process.exit(1);
}
if (opts.check && drifted) {
  console.error(`\n--check: ${drifted} provider(s) drifted from committed catalogs`);
  process.exit(1);
}
if (failed && !opts.release && !opts.drift) {
  console.error(`\nCompleted with ${failed} failure(s)`);
  process.exit(1);
}

console.log(`\nDone. ${results.length} provider(s) synced.`);
