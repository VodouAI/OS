#!/usr/bin/env node
/**
 * End-to-end smoke test for Cards-MVP.
 * Starts a minimal Express app with just /api/lenses mounted, then exercises
 * every endpoint against the real (compiled) card modules. Catches build /
 * import / wiring issues that unit tests don't.
 *
 * Run: node scripts/smoke-cards.mjs
 */
import express from 'express';
import path from 'node:path';
import { tmpdir } from 'node:os';

process.env.GATEWAY_DB_PATH = path.join(tmpdir(), `cards-smoke-${Date.now()}.db`);

const { lensesRouter } = await import('../dist/api/lenses.js');
const { getRegistry } = await import('../dist/lenses/registry.js');

const app = express();
app.use(express.json());
app.use('/api/lenses', lensesRouter);

const server = app.listen(0, () => {
  const port = server.address().port;
  console.log(`smoke server on :${port}`);
  runChecks(port).then(() => {
    server.close();
    console.log('✅ smoke checks passed');
    process.exit(0);
  }).catch(err => {
    console.error('❌', err);
    server.close();
    process.exit(1);
  });
});

async function runChecks(port) {
  const base = `http://127.0.0.1:${port}`;
  const fail = (msg) => { throw new Error(msg); };

  // 1. status
  let r = await fetch(`${base}/api/lenses/status`);
  let j = await r.json();
  if (j.data.registered < 5) fail(`status: expected ≥5 registered, got ${j.data.registered}`);
  console.log(`  ✓ status — ${j.data.registered} cards registered`);

  // 2. manifests excludes debug
  r = await fetch(`${base}/api/lenses/manifests`);
  j = await r.json();
  if (j.data.some(m => m.type === 'debug.echo')) fail('manifests: should exclude debug.echo');
  if (!j.data.some(m => m.type === 'recipe.allrecipes')) fail('manifests: missing recipe.allrecipes');
  console.log(`  ✓ manifests — ${j.data.length} non-debug cards`);

  // 3. debug.echo fetch
  r = await fetch(`${base}/api/lenses/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'debug.echo', payload: { hello: 'world' } }),
  });
  j = await r.json();
  if (!j.ok || j.data.render_model.payload.hello !== 'world') fail(`debug.echo: ${JSON.stringify(j)}`);
  console.log(`  ✓ debug.echo — echoed payload`);

  // 4. map.directions synth
  r = await fetch(`${base}/api/lenses/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'map.directions',
      payload: { origin: 'A', destination: 'B', mode: 'driving' },
    }),
  });
  j = await r.json();
  if (!j.ok || !j.data.render_model.embed_url.includes('maps.google.com')) fail(`map.directions: ${JSON.stringify(j)}`);
  console.log(`  ✓ map.directions — synthesized embed URL`);

  // 5. preview URL matching
  r = await fetch(`${base}/api/lenses/preview?url=${encodeURIComponent('https://www.allrecipes.com/recipe/12345/x')}`);
  j = await r.json();
  if (!j.data.some(m => m.type === 'recipe.allrecipes')) fail(`preview: missing recipe match`);
  console.log(`  ✓ preview — URL matched to recipe.allrecipes`);

  // 6. health endpoint
  r = await fetch(`${base}/api/lenses/health`);
  j = await r.json();
  if (!j.data.some(m => m.type === 'recipe.allrecipes' && m.probeable)) fail('health: recipe should be probeable');
  console.log(`  ✓ health — ${j.data.length} probeable cards`);

  // 7. action: bridge_required (bridge isn't connected in smoke)
  r = await fetch(`${base}/api/lenses/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'github.pr',
      action_id: 'approve',
      source_url: 'https://github.com/x/y/pull/1',
      consent_granted: true,
    }),
  });
  j = await r.json();
  if (r.status !== 503 || j.error.code !== 'BRIDGE_REQUIRED') {
    fail(`action without bridge: expected 503 BRIDGE_REQUIRED, got ${r.status} ${j.error?.code}`);
  }
  console.log(`  ✓ action — BRIDGE_REQUIRED surfaced when bridge missing`);

  // 8. invalid type
  r = await fetch(`${base}/api/lenses/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'does.not.exist' }),
  });
  if (r.status !== 404) fail(`unknown type: expected 404, got ${r.status}`);
  console.log(`  ✓ unknown type — 404`);
}
