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

    pruneOldSessionLogs(dir, logPath);
  } catch { /* keep console if redirect fails */ }
}

/**
 * Delete CLI session logs older than the retention window.
 *
 * One file per session with nothing pruning them meant 289 files and 14MB had
 * accumulated in `.vodou/workspace/` — a month after the last CLI session, and
 * exactly the kind of noise that makes a directory useless to look through when
 * something is actually wrong.
 *
 * Deliberately conservative, because this runs before anything else in the
 * process and must never be the reason a session fails to start:
 *
 *   * mtime only — no parsing of names or contents;
 *   * the file this process just opened is never a candidate;
 *   * `VODOU_CLI_LOG_RETAIN_DAYS=0` disables it entirely;
 *   * every failure is swallowed. A log that could not be deleted is not worth
 *     a broken CLI.
 */
export function pruneOldSessionLogs(dir: string, currentLog: string): void {
  try {
    const raw = process.env.VODOU_CLI_LOG_RETAIN_DAYS;
    const days = raw === undefined ? 7 : Number(raw);
    if (!Number.isFinite(days) || days <= 0) return; // 0 or nonsense = leave them alone

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('cli-') || !name.endsWith('.log')) continue;
      const full = path.join(dir, name);
      if (full === currentLog) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* in use, gone already, or not ours to delete */ }
    }
  } catch { /* pruning is housekeeping, never a precondition */ }
}

export {};
