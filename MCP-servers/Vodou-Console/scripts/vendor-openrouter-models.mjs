#!/usr/bin/env node
/**
 * Fetches OpenRouter's public model catalog and writes a compact JSON bundle
 * for offline Settings UI (no API key required for end users).
 *
 * Run from repo: `cd MCP-servers/Vodou-Console && npm run vendor:openrouter-models`
 * Optional: OPENROUTER_API_KEY in env (same headers as chat — attribution only for GET).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.resolve(__dirname, '..');
const outPath = path.join(gatewayRoot, 'public', 'data', 'openrouter-models.json');

const url = 'https://openrouter.ai/api/v1/models?output_modalities=all';
const headers = {
  Accept: 'application/json',
  'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || process.env.GATEWAY_BASE_URL || 'https://github.com/vodou-ai/oi',
  'X-Title': process.env.OPENROUTER_APP_TITLE || 'Vodou-Console-vendor-script',
};
if (process.env.OPENROUTER_API_KEY) {
  headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
}

const resp = await fetch(url, { headers });
if (!resp.ok) {
  console.error(`OpenRouter models fetch failed: HTTP ${resp.status}`);
  process.exit(1);
}
const data = await resp.json();
const models = (data.data || [])
  .map((m) => m.id)
  .filter(Boolean)
  .sort();

if (models.length === 0) {
  console.error('OpenRouter returned no model ids');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const payload = {
  source: 'https://openrouter.ai/api/v1/models',
  fetched_at: new Date().toISOString(),
  count: models.length,
  models,
};
fs.writeFileSync(outPath, JSON.stringify(payload) + '\n', 'utf-8');
console.log(`Wrote ${models.length} model ids → ${path.relative(gatewayRoot, outPath)}`);
