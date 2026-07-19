#!/usr/bin/env node
/**
 * Standalone preset validator. Runs the full JSON Schema against every
 * preset JSON in ../presets/*.json. Exits non-zero if any preset fails.
 *
 * Used locally by contributors (`npm run validate-presets`) AND in the
 * `VodouAI/Apps` repo's CI workflow (same file, vendored).
 *
 * Requires `ajv` + `ajv-formats` as devDependencies of the gateway package.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

async function loadAjv() {
  try {
    const { default: Ajv } = await import('ajv');
    const { default: addFormats } = await import('ajv-formats');
    return { Ajv, addFormats };
  } catch {
    console.error('validate-presets: missing deps. Run: npm install --save-dev ajv ajv-formats');
    process.exit(2);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, '..', 'presets');
const SCHEMA_FILE = path.join(PRESETS_DIR, '_schema.json');

async function main() {
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(`validate-presets: schema not found at ${SCHEMA_FILE}`);
    process.exit(2);
  }

  const { Ajv, addFormats } = await loadAjv();
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  const files = fs.readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  let failures = 0;
  const idSeen = new Map();

  for (const file of files) {
    const fullPath = path.join(PRESETS_DIR, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      console.error(`✗ ${file} — not valid JSON: ${err.message}`);
      failures++;
      continue;
    }

    if (!validate(raw)) {
      console.error(`✗ ${file} — schema errors:`);
      for (const e of validate.errors || []) {
        console.error(`    ${e.instancePath || '/'} ${e.message}`);
      }
      failures++;
      continue;
    }

    const expectedFile = `${raw.id}.json`;
    if (file !== expectedFile) {
      console.error(`✗ ${file} — filename must match id: expected '${expectedFile}'`);
      failures++;
      continue;
    }

    if (idSeen.has(raw.id)) {
      console.error(`✗ ${file} — duplicate id '${raw.id}' (also in ${idSeen.get(raw.id)})`);
      failures++;
      continue;
    }
    idSeen.set(raw.id, file);

    console.log(`✓ ${file}`);
  }

  console.log();
  if (failures > 0) {
    console.error(`${failures} preset(s) failed validation.`);
    process.exit(1);
  }
  console.log(`All ${files.length} presets valid.`);
}

main().catch((err) => {
  console.error('validate-presets: unexpected error:', err);
  process.exit(2);
});
