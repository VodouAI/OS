#!/usr/bin/env node
/**
 * Proof: a card dropped into ~/.vodou/cards/<id>/ is discovered, registered,
 * and invokable WITHOUT touching the gateway source or rebuilding.
 *
 * Steps the script verifies:
 *   1. Load registry — community.test is found
 *   2. The card has the manifest we wrote
 *   3. POST /api/lenses/fetch returns the community card's output
 */
import express from 'express';
import path from 'node:path';
import { tmpdir } from 'node:os';

process.env.GATEWAY_DB_PATH = path.join(tmpdir(), `cards-community-${Date.now()}.db`);

const { lensesRouter } = await import('../dist/api/lenses.js');
const { ensureRegistryLoaded, getRegistry } = await import('../dist/lenses/registry.js');

await ensureRegistryLoaded();
const reg = getRegistry();

const types = reg.listManifests().map(m => m.type);
console.log('Registered cards:', types.join(', '));

if (!types.includes('community.test')) {
  console.error('❌ community.test NOT discovered');
  process.exit(1);
}
console.log('✓ community.test discovered via dynamic filesystem scan');

const community = reg.get('community.test');
if (community.manifest.author !== '@some-contributor') {
  console.error('❌ manifest did not load correctly');
  process.exit(1);
}
console.log('✓ manifest loaded with correct author:', community.manifest.author);
console.log('✓ motive:', community.manifest.motive);

const app = express();
app.use(express.json());
app.use('/api/lenses', lensesRouter);

const server = app.listen(0, async () => {
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/lenses/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'community.test',
        source_url: 'https://x.community-test.example/page',
        payload: { from: 'smoke' },
      }),
    });
    const j = await r.json();
    if (!j.ok) {
      console.error('❌ fetch returned error:', j);
      process.exit(1);
    }
    if (j.data.render_model.greeting !== 'Hello from a community card') {
      console.error('❌ unexpected render_model:', j.data.render_model);
      process.exit(1);
    }
    console.log('✓ endpoint resolved community.test:', j.data.render_model.greeting);
    console.log('\n✅ community card dynamic-discovery proof: PASSED');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('❌', err);
    server.close();
    process.exit(1);
  }
});
