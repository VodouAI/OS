import { spawn, execSync } from 'child_process';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLI_MODEL = process.env.CLI_MODEL || 'haiku';
const MAX_CLAUDE_PROCESSES = 3;

export async function completeClaudeCli(
  prompt: string,
  system: string | undefined,
  modelOverride: string | undefined,
  timeoutMs: number
): Promise<string> {
  const model = modelOverride || CLI_MODEL;
  try {
    // P2: pgrep matches on process NAME, so `pgrep /abs/path/to/claude` never
    // matches and the process cap silently disabled. Use the basename.
    const procName = (CLAUDE_BIN.split('/').pop() || CLAUDE_BIN).replace(/[^A-Za-z0-9._-]/g, '');
    const count = execSync(`pgrep ${procName} | wc -l`, { encoding: 'utf8', timeout: 5000 }).trim();
    const n = parseInt(count, 10);
    if (Number.isFinite(n) && n > MAX_CLAUDE_PROCESSES) {
      throw new Error(`skipping claude extraction: ${n} claude processes already running (max ${MAX_CLAUDE_PROCESSES})`);
    }
  } catch {
    // pgrep failed or not found; continue
  }

  const full = system ? `${system}\n\n${prompt}` : prompt;
  return new Promise((resolve, reject) => {
    const args = ['--print', '--model', model, '--no-session-persistence', full];
    const env = { ...process.env };
    delete (env as Record<string, string>).CLAUDECODE;
    delete (env as Record<string, string>).ANTHROPIC_API_KEY; // force Max subscription OAuth, not API key auth

    const proc = spawn(CLAUDE_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude CLI error: ${stderr.slice(-500) || code}`));
    });
    proc.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}
