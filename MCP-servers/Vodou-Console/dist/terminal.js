/**
 * Terminal backend — PTY management via node-pty
 *
 * Uses node-pty for native pseudo-terminal allocation.
 * Streams terminal I/O over WebSocket.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { getProjectRoot } from './db.js';
let nodePty = null;
// Try to load node-pty (native addon)
try {
    nodePty = await import('node-pty');
}
catch {
    console.error('[Terminal] node-pty not available — terminal sessions disabled. Run: npm install node-pty');
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function getDefaultShell() {
    if (process.platform === 'win32')
        return 'powershell.exe';
    return process.env.SHELL || '/bin/zsh';
}
const terminals = new Map();
/**
 * Create a terminal PTY session for a WebSocket client.
 */
export function createTerminal(clientId, ws, cwd, cols, rows) {
    if (!nodePty) {
        ws.send(JSON.stringify({ type: 'terminal_exit', exitCode: 1, error: 'Terminal not available: node-pty not installed' }));
        return;
    }
    destroyTerminal(clientId);
    const shell = getDefaultShell();
    const projectRoot = cwd || getProjectRoot();
    // Build clean env — strip vars that cause CLI nesting detection
    const cleanEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
    };
    const stripVars = [
        'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_SESSION',
        'CLAUDE_CONVERSATION_ID', 'CLAUDE_CODE_ENTRYPOINT',
    ];
    for (const v of stripVars) {
        delete cleanEnv[v];
    }
    const ptyProcess = nodePty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: projectRoot,
        env: cleanEnv,
    });
    const disposables = [];
    // PTY output → WebSocket
    disposables.push(ptyProcess.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'terminal_output', data }));
        }
    }));
    // PTY exit → WebSocket
    disposables.push(ptyProcess.onExit(({ exitCode }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'terminal_exit', exitCode }));
        }
        terminals.delete(clientId);
    }));
    const session = { pty: ptyProcess, ws, disposables, createdAt: new Date() };
    terminals.set(clientId, session);
    console.error(`[Terminal] Started for ${clientId}: ${shell} in ${projectRoot} (pid ${ptyProcess.pid})`);
}
/**
 * Write input to the terminal PTY.
 */
export function writeTerminal(clientId, data) {
    const session = terminals.get(clientId);
    if (session) {
        session.pty.write(data);
    }
}
/**
 * Resize the terminal PTY.
 */
export function resizeTerminal(clientId, cols, rows) {
    const session = terminals.get(clientId);
    if (session) {
        try {
            session.pty.resize(cols, rows);
        }
        catch {
            // Resize may fail if process already exited
        }
    }
}
/**
 * Destroy a terminal session.
 */
export function destroyTerminal(clientId) {
    const session = terminals.get(clientId);
    if (session) {
        for (const d of session.disposables) {
            try {
                d.dispose();
            }
            catch { }
        }
        try {
            session.pty.kill();
        }
        catch { }
        terminals.delete(clientId);
        console.error(`[Terminal] Destroyed for ${clientId}`);
    }
}
/**
 * Cleanup all terminals.
 */
export function destroyAllTerminals() {
    for (const [id] of terminals) {
        destroyTerminal(id);
    }
}
/**
 * Get terminal count.
 */
export function getTerminalCount() {
    return terminals.size;
}
