import { spawn } from 'child_process';

export async function completeScript(
  prompt: string,
  system: string | undefined,
  command: string,
  timeoutMs: number
): Promise<string> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // P2: expand `~` only as a path prefix — at the start of the command or after
  // whitespace, when followed by `/`, whitespace, or end — not EVERY tilde in
  // the string (which mangled tildes inside args, e.g. `echo "a~b"`).
  const expanded = command.replace(/(^|\s)~(?=\/|\s|$)/g, `$1${home}`);

  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', expanded], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const input = JSON.stringify({ prompt, system });
    child.stdin?.write(input, (err) => {
      if (err) reject(err);
      child.stdin?.end();
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`script timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`script error: ${stderr.slice(-500) || code}`));
    });
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}
