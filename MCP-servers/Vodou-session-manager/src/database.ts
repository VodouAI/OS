import { open as openDb, type DB } from './db.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MCPSession {
  id: number;
  session_id: string;
  server_name: string;
  server_command: string;
  server_args: string | null;
  working_directory: string | null;
  status: 'active' | 'idle' | 'closed' | 'error';
  created_at: string;
  last_used_at: string;
  expires_at: string | null;
  metadata: string | null;
  pid: number | null;
  port: number | null;
}

export interface SessionCall {
  id: number;
  session_id: string;
  tool_name: string;
  arguments: string | null;
  response_status: string | null;
  duration_ms: number | null;
  error_message: string | null;
  called_at: string;
}

function getDatabasePath(): string {
  const projectRoot = join(__dirname, '../../..');
  return join(projectRoot, 'vodou-core.db');
}

export class SessionDatabase {
  private db: DB;

  constructor() {
    this.db = openDb(getDatabasePath(), { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.ensureTables();
  }

  private ensureTables() {
    // Tables created by Rust daemon migration 046.
    // Keeping method call in constructor for future use.
  }

  createSession(session: Omit<MCPSession, 'id' | 'created_at' | 'last_used_at'>): string {
    const stmt = this.db.prepare(`
      INSERT INTO mcp_sessions 
        (session_id, server_name, server_command, server_args, working_directory, 
         status, expires_at, metadata, pid, port)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.session_id,
      session.server_name,
      session.server_command,
      session.server_args,
      session.working_directory,
      session.status,
      session.expires_at,
      session.metadata,
      session.pid,
      session.port
    );

    return session.session_id;
  }

  getSession(sessionId: string): MCPSession | undefined {
    const stmt = this.db.prepare('SELECT * FROM mcp_sessions WHERE session_id = ?');
    return stmt.get(sessionId) as MCPSession | undefined;
  }

  findActiveSession(serverName: string): MCPSession | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM mcp_sessions 
      WHERE server_name = ? AND status = 'active'
      ORDER BY last_used_at DESC
      LIMIT 1
    `);
    return stmt.get(serverName) as MCPSession | undefined;
  }
  
  findActiveSessionWithProcess(serverName: string): MCPSession | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM mcp_sessions 
      WHERE server_name = ? AND status = 'active' AND pid IS NOT NULL AND port IS NOT NULL
      ORDER BY last_used_at DESC
      LIMIT 1
    `);
    return stmt.get(serverName) as MCPSession | undefined;
  }
  
  updateSessionProcess(sessionId: string, pid: number, port: number): void {
    const stmt = this.db.prepare(`
      UPDATE mcp_sessions 
      SET pid = ?, port = ?
      WHERE session_id = ?
    `);
    stmt.run(pid, port, sessionId);
  }

  listSessions(serverName?: string): MCPSession[] {
    if (serverName) {
      const stmt = this.db.prepare(`
        SELECT * FROM mcp_sessions 
        WHERE server_name = ?
        ORDER BY created_at DESC
      `);
      return stmt.all(serverName) as unknown as MCPSession[];
    } else {
      const stmt = this.db.prepare(`
        SELECT * FROM mcp_sessions
        ORDER BY created_at DESC
      `);
      return stmt.all() as unknown as MCPSession[];
    }
  }

  updateSessionStatus(sessionId: string, status: MCPSession['status']): void {
    const stmt = this.db.prepare(`
      UPDATE mcp_sessions 
      SET status = ?, last_used_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `);
    stmt.run(status, sessionId);
  }

  updateLastUsed(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE mcp_sessions 
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `);
    stmt.run(sessionId);
  }

  closeSession(sessionId: string): void {
    const stmt = this.db.prepare(`
      UPDATE mcp_sessions 
      SET status = 'closed', last_used_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `);
    stmt.run(sessionId);
  }

  deleteSession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM mcp_sessions WHERE session_id = ?');
    stmt.run(sessionId);
  }

  recordCall(call: Omit<SessionCall, 'id' | 'called_at'>): void {
    const stmt = this.db.prepare(`
      INSERT INTO mcp_session_calls 
        (session_id, tool_name, arguments, response_status, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      call.session_id,
      call.tool_name,
      call.arguments,
      call.response_status,
      call.duration_ms,
      call.error_message
    );
  }

  cleanupIdleSessions(): number {
    const stmt = this.db.prepare(`
      DELETE FROM mcp_sessions
      WHERE datetime(expires_at) < datetime('now') AND status = 'idle'
    `);
    const result = stmt.run();
    return Number(result.changes);
  }

  getServerConfig(serverName: string): { command: string; args: string[]; working_directory: string | null; connection_type: string } | undefined {
    const stmt = this.db.prepare(`
      SELECT command, args, connection_type 
      FROM mcp_servers 
      WHERE name = ?
    `);
    const result = stmt.get(serverName) as { command: string; args: string; connection_type: string } | undefined;
    
    if (!result) return undefined;

    return {
      command: result.command,
      args: result.args ? JSON.parse(result.args) : [],
      working_directory: null, // mcp_servers table doesn't have working_directory column
      connection_type: result.connection_type || 'stdio'
    };
  }

  close(): void {
    this.db.close();
  }
}

