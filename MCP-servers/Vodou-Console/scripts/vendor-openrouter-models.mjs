#!/usr/bin/env node
/**
 * @deprecated Prefer `npm run sync:llm-models` (or `--provider openrouter`).
 * Kept as a thin alias so old docs/muscle-memory still work.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, 'sync-llm-model-catalogs.mjs');
const child = spawn(process.execPath, [script, '--provider', 'openrouter', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
