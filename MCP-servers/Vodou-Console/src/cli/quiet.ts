/**
 * quiet.ts — redirect the engine's chatty console.* to a per-session log file.
 *
 * MUST be imported FIRST in the CLI entrypoint: ESM evaluates imports in order, so this
 * runs before llm.js/db.js side effects, capturing their startup logging. The renderers
 * draw via process.stdout.write (not console.*), so the terminal stays clean while the
 * full engine log is preserved on disk. `--verbose` keeps logs on the console.
 */

import fs from 'fs';
import path from 'path';

const verbose = process.argv.includes('--verbose') || process.env.VODOU_CLI_VERBOSE === '1';

if (!verbose) {
  try {
    const root = process.env.VODOU_PROJECT_PATH || process.cwd();
    const dir = path.join(root, '.vodou', 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `cli-${process.pid}.log`);
    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    const write = (level: string) => (...args: unknown[]) => {
      try { stream.write(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`); } catch { /* */ }
    };
    console.error = write('error');
    console.warn = write('warn');
    console.log = write('log');
    console.info = write('info');
    console.debug = write('debug');
    (process.env as Record<string, string>).VODOU_CLI_LOG = logPath;
  } catch { /* keep console if redirect fails */ }
}

export {};
