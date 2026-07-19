/**
 * Bridge to vodou-ax Swift binary.
 * Spawns the binary as a subprocess, passes CLI args, parses JSON output.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, '..');
const TIMEOUT = 15000; // 15s max for any vodou-ax call
function getVodouAxPath() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    // Release: pre-compiled binary in bin/
    const releasePath = join(SERVER_DIR, 'bin', `vodou-ax-${arch}`);
    if (existsSync(releasePath))
        return releasePath;
    // Dev: swift build output
    const devPath = join(SERVER_DIR, 'swift', '.build', 'release', 'vodou-ax');
    if (existsSync(devPath))
        return devPath;
    // Debug build
    const debugPath = join(SERVER_DIR, 'swift', '.build', 'debug', 'vodou-ax');
    if (existsSync(debugPath))
        return debugPath;
    throw new Error('vodou-ax binary not found. Run: cd swift && swift build -c release');
}
/**
 * Call vodou-ax with a subcommand and arguments.
 * Returns parsed JSON response. Throws on errors.
 */
export async function callVodouAx(subcommand, args = {}) {
    const binaryPath = getVodouAxPath();
    // Build CLI arguments from the args object
    const cliArgs = [subcommand];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null)
            continue;
        const flag = `--${key.replace(/_/g, '-')}`;
        if (typeof value === 'boolean') {
            if (value)
                cliArgs.push(flag);
        }
        else if (Array.isArray(value)) {
            cliArgs.push(flag, value.join(','));
        }
        else {
            cliArgs.push(flag, String(value));
        }
    }
    return new Promise((resolve, reject) => {
        const proc = execFile(binaryPath, cliArgs, {
            timeout: TIMEOUT,
            maxBuffer: 10 * 1024 * 1024, // 10MB — trees can be large
            killSignal: 'SIGKILL',
        }, (error, stdout, stderr) => {
            if (stderr) {
                console.error(`[vodou-ax] ${stderr.trim()}`);
            }
            if (!stdout) {
                reject(new Error(error?.message || 'vodou-ax returned no output'));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                if (!result.ok) {
                    const errResult = result;
                    reject(new Error(`${errResult.error}: ${errResult.message}`));
                    return;
                }
                resolve(result);
            }
            catch (parseErr) {
                reject(new Error(`Failed to parse vodou-ax output: ${stdout.substring(0, 200)}`));
            }
        });
    });
}
//# sourceMappingURL=ax-bridge.js.map