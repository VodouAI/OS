// cli-portability — cross-platform helpers for spawning provider CLIs
// (claude / kimi / lms) and vodou-core. Fixes the Windows chat blockers from
// PLAN-WINDOWS-PORTABILITY-BUGS.md (C1/C3/C4) without changing mac/linux
// behavior: on posix the resolver still honors PATH the same way, and the
// system-prompt-file path is used everywhere (the CLI supports it on all OSes).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
/**
 * Resolve a binary name to an absolute path, cross-platform.
 * - Absolute path that exists → returned as-is.
 * - win32 → search PATH using PATHEXT (.exe/.cmd/.bat…); Node's spawn() does NOT
 *   apply PATHEXT for explicit targets, so `spawn('claude')` would ENOENT.
 * - posix → search PATH (mirrors `which`), returning the first executable match.
 * Returns null if not found (caller decides the fallback / "not installed" msg).
 */
export function resolveBinPath(nameOrPath) {
    if (!nameOrPath)
        return null;
    if (path.isAbsolute(nameOrPath)) {
        return fs.existsSync(nameOrPath) ? nameOrPath : null;
    }
    const isWin = process.platform === 'win32';
    const exts = isWin
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.trim()).filter(Boolean)
        : [''];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const ext of exts) {
            const cand = path.join(dir, nameOrPath + ext);
            try {
                if (fs.existsSync(cand) && fs.statSync(cand).isFile())
                    return cand;
            }
            catch { /* ignore */ }
        }
    }
    return null;
}
/**
 * Resolve the `claude` CLI to an absolute path.
 *
 * `resolveBinPath` searches PATH and nothing else, which is not enough for the
 * gateway: it runs from a launchd/systemd plist whose PATH is a hardcoded list,
 * so a `claude` installed anywhere unusual (nvm's global bin, a custom npm
 * prefix, or `~/.local/bin` on an older plist generation) is invisible and every
 * claude-cli call fails with ENOENT. The Rust side already probes these same
 * locations (`board/spawn.rs::resolve_claude_bin`); this is the Node twin of it,
 * kept in the same order so both halves agree on which binary they mean.
 *
 * Returns null when nothing is found — callers decide whether to fall back to
 * the bare name or report "not installed".
 */
export function resolveClaudeBinPath() {
    if (process.env.CLAUDE_BIN)
        return process.env.CLAUDE_BIN;
    const onPath = resolveBinPath('claude');
    if (onPath)
        return onPath;
    const home = os.homedir();
    const isWin = process.platform === 'win32';
    const candidates = isWin
        ? [
            path.join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
            path.join(home, '.local', 'bin', 'claude.exe'),
        ]
        : [
            path.join(home, '.local', 'bin', 'claude'),
            path.join(home, '.claude', 'bin', 'claude'),
            '/usr/local/bin/claude',
            '/opt/homebrew/bin/claude',
        ];
    for (const cand of candidates) {
        try {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile())
                return cand;
        }
        catch { /* ignore */ }
    }
    return null;
}
/**
 * FNV-1a 32-bit hash — MUST match `ipc.rs::fnv1a_32` byte-for-byte (it is the
 * wire contract for Windows named-pipe names). Math.imul keeps the multiply in
 * 32-bit; `>>> 0` keeps it unsigned.
 */
export function fnv1a32(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
/**
 * Connection target for a daemon/worker `.sock` path.
 * - posix → the path unchanged (AF_UNIX, exactly as before).
 * - win32 → the named pipe the Rust `ipc.rs` listener actually binds:
 *   `\\.\pipe\vodou-<fnv1a32(parentDir)>-<fileStem>`. Without this, Node's
 *   `net.createConnection('…worker.sock')` ENOENTs (the worker serves a pipe,
 *   not a socket file) and every gateway tool call falls back to a CLI spawn.
 *   Must match `ipc.rs::pipe_name` (hash of the PARENT dir, stem = name w/o ext).
 */
export function sockConnectTarget(sockPath) {
    if (process.platform !== 'win32')
        return sockPath;
    const parent = path.dirname(sockPath);
    const ext = path.extname(sockPath);
    const stem = path.basename(sockPath, ext);
    const hash = fnv1a32(Buffer.from(parent, 'utf8')).toString(16).padStart(8, '0');
    return `\\\\.\\pipe\\vodou-${hash}-${stem}`;
}
/**
 * Write a system prompt to a temp file and return `['--system-prompt-file', path]`.
 * Fixes C1: a 22K-char `--system-prompt` on argv exceeds Windows' 32,767-char
 * CreateProcessW limit → `spawn ENAMETOOLONG` → gateway crash. A file keeps argv
 * tiny on every OS. The CLI supports `--system-prompt-file` (verified live).
 * Temp files are unlinked after a TTL (claude reads the file at startup; a few
 * minutes is ample) so we never leak or need to thread cleanup through callers.
 */
const SYS_PROMPT_TTL_MS = 5 * 60 * 1000;
export function systemPromptFileArgs(systemPrompt) {
    const dir = path.join(os.tmpdir(), 'vodou-sysprompts');
    try {
        fs.mkdirSync(dir, { recursive: true });
        // opportunistic cleanup of stale files (bounded accumulation, no timers to leak)
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            try {
                if (now - fs.statSync(p).mtimeMs > SYS_PROMPT_TTL_MS)
                    fs.unlinkSync(p);
            }
            catch { /* */ }
        }
    }
    catch { /* fall through to a flat tmp path */ }
    // Unique name without Math.random/Date.now collisions across rapid spawns:
    // pid + high-res counter.
    const name = `sp-${process.pid}-${sysPromptSeq++}.txt`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, systemPrompt, 'utf8');
    // Safety-net unlink after the TTL in case the opportunistic sweep never runs again.
    setTimeout(() => { try {
        fs.unlinkSync(file);
    }
    catch { /* */ } }, SYS_PROMPT_TTL_MS).unref?.();
    return ['--system-prompt-file', file];
}
let sysPromptSeq = 0;
/**
 * Per-OS install instructions for the Claude CLI (markdown, for chat/settings
 * messages). One source of truth — the onboarding UI mirrors this logic in
 * public/js/views/onboarding.js::_renderClaudeCliConfig.
 */
export function claudeInstallInstructionsMd() {
    if (process.platform === 'win32') {
        return '**To install (PowerShell):**\n```\nirm https://claude.ai/install.ps1 | iex\n```\n\n' +
            'Then open a **new** PowerShell window (PATH refresh) and run `claude` once to authenticate.';
    }
    const rc = process.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc';
    return '**To install:**\n```\ncurl -fsSL https://claude.ai/install.sh | bash\n```\n\n' +
        `Then add to PATH:\n\`\`\`\necho 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc} && source ${rc}\n\`\`\`\n\n` +
        'Then run `claude` in a terminal once to authenticate with your Anthropic account.';
}
