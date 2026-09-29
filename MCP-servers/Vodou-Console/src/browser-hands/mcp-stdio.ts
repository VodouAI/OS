/**
 * Browser Hands: a minimal MCP client over stdio (JSON-RPC 2.0, one message per
 * line). Dependency-free on purpose, like MCP-servers/vodou-browser.
 *
 * Why the hands layer has its own client instead of going through
 * `vodou_core_call`: it launches ITS OWN chrome-devtools-mcp with its own flags
 * and profile (§13.6), and its calls must never pass through trajectory capture,
 * which records tool arguments (§13.8 — a password fill must leave no trace).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface McpToolResult {
  text: string;
  images: { data: string; mimeType: string }[];
  isError: boolean;
}

export class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private waiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  exited: { code: number | null; signal: string | null } | null = null;

  /**
   * `pidFile`: where this server's pid is published while it runs, for
   * processes.toml (lane canon rule 3 — start, stop and the updater must all
   * know a process). Removed when it exits. Absent for throwaway servers (the
   * doctor's isolated check), which must not overwrite the errand server's.
   */
  constructor(private cmd: string, private args: string[], private env: NodeJS.ProcessEnv, private pidFile?: string) {}

  async start(timeoutMs = 30_000): Promise<{ name: string; version: string }> {
    const p = spawn(this.cmd, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    if (this.pidFile && p.pid) {
      try {
        fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
        fs.writeFileSync(this.pidFile, `${p.pid}\n`);
      } catch { /* the registry then reads it as absent; the browser still works */ }
    }
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => this.onData(d));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => {
      for (const line of d.split('\n')) if (line.trim()) this.stderrTail.push(line.slice(0, 300));
      if (this.stderrTail.length > 20) this.stderrTail.splice(0, this.stderrTail.length - 20);
    });
    p.on('exit', (code, signal) => {
      this.exited = { code, signal };
      if (this.pidFile) {
        // Only our own pid: a newer server may already have claimed the file.
        try { if (fs.readFileSync(this.pidFile, 'utf8').trim() === String(p.pid)) fs.unlinkSync(this.pidFile); } catch { /* not there */ }
      }
      for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(new Error(`browser server exited (${code ?? signal}): ${this.lastError()}`)); }
      this.waiters.clear();
    });
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vodou-browser-hands', version: '1' },
    }, timeoutMs);
    this.notify('notifications/initialized');
    return init?.serverInfo ?? { name: '?', version: '?' };
  }

  lastError(): string {
    return this.stderrTail.slice(-3).join(' | ');
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id === 'number' && this.waiters.has(msg.id)) {
        const w = this.waiters.get(msg.id)!;
        this.waiters.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.error) w.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    }
  }

  private notify(method: string, params?: unknown) {
    this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (!this.proc || this.exited) return Promise.reject(new Error('browser server is not running'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async listTools(): Promise<string[]> {
    const r = await this.request('tools/list', {});
    return (r?.tools ?? []).map((t: { name: string }) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpToolResult> {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const content: any[] = r?.content ?? [];
    return {
      text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: content.filter((c) => c.type === 'image').map((c) => ({ data: c.data, mimeType: c.mimeType })),
      isError: !!r?.isError,
    };
  }

  close() {
    if (this.proc && !this.exited) {
      try { this.proc.stdin.end(); } catch { /* gone */ }
      try { this.proc.kill(); } catch { /* gone */ }
    }
  }
}
