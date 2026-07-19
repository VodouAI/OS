import { open as openDb, type DB } from './db.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { ThoughtData, ThinkingSession, ThoughtRecord, OIContext } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ThinkingDatabase {
  private thinkingDb: DB;
  private oiDb: DB | null = null;
  
  constructor() {
    // Primary database: thinking.db in MCP server directory
    const thinkingDbPath = join(__dirname, '../thinking.db');
    this.thinkingDb = openDb(thinkingDbPath);
    this.initializeThinkingDb();
    
    // Auto-connect to Vodou database (optional - may not exist)
    this.connectToOIDatabase();
  }
  
  private initializeThinkingDb() {
    this.thinkingDb.exec(`
      CREATE TABLE IF NOT EXISTS thinking_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        topic TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_thought_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP,
        metadata TEXT,
        oi_session_id TEXT,
        oi_agent_id TEXT
      );
      
      CREATE TABLE IF NOT EXISTS thoughts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        thought_number INTEGER NOT NULL,
        thought_text TEXT NOT NULL,
        total_thoughts INTEGER NOT NULL,
        is_revision BOOLEAN DEFAULT 0,
        revises_thought INTEGER,
        branch_from_thought INTEGER,
        branch_id TEXT,
        next_thought_needed BOOLEAN DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES thinking_sessions(session_id)
      );
      
      CREATE TABLE IF NOT EXISTS thinking_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        analysis_type TEXT NOT NULL,
        analysis_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES thinking_sessions(session_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_thoughts_session ON thoughts(session_id);
      CREATE INDEX IF NOT EXISTS idx_thoughts_number ON thoughts(session_id, thought_number);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON thinking_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_oi_ref ON thinking_sessions(oi_session_id);
    `);
    try {
      this.thinkingDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 8000;
      `);
    } catch (e) {
      console.error('[Thinking DB] pragma setup (non-fatal):', e);
    }

    console.error('[Thinking DB] Initialized thinking.db');
  }
  
  private connectToOIDatabase() {
    try {
      // Find vodou-core.db (same pattern as other MCP servers)
      const projectRoot = join(__dirname, '../../..');
      const oiDbPath = join(projectRoot, 'vodou-core.db');
      
      // Check if Vodou database exists
      if (existsSync(oiDbPath)) {
        this.oiDb = openDb(oiDbPath, { readOnly: true }); // Read-only!
        try {
          this.oiDb.exec('PRAGMA busy_timeout = 8000');
        } catch { /* ignore */ }
        console.error('[Thinking DB] ✅ Connected to Vodou database for context');
      } else {
        // Try environment variable
        if (process.env.VODOU_PROJECT_PATH) {
          const envPath = join(process.env.VODOU_PROJECT_PATH, 'vodou-core.db');
          if (existsSync(envPath)) {
            this.oiDb = openDb(envPath, { readOnly: true });
            try {
              this.oiDb.exec('PRAGMA busy_timeout = 8000');
            } catch { /* ignore */ }
            console.error('[Thinking DB] ✅ Connected to Vodou database via VODOU_PROJECT_PATH');
            return;
          }
        }
        console.error('[Thinking DB] ⚠️ Vodou database not found, working in standalone mode');
      }
    } catch (error) {
      console.error('[Thinking DB] ⚠️ Failed to connect to Vodou database:', error);
      // Continue without Vodou connection - thinking DB works standalone
    }
  }
  
  // Session operations
  createSession(topic: string, metadata?: any, oiSessionId?: string, oiAgentId?: string): string {
    const sessionId = uuidv4();
    this.thinkingDb.prepare(`
      INSERT INTO thinking_sessions (session_id, topic, metadata, oi_session_id, oi_agent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      sessionId,
      topic,
      JSON.stringify(metadata || {}),
      oiSessionId || null,
      oiAgentId || null
    );
    return sessionId;
  }
  
  getSession(sessionId: string): ThinkingSession | null {
    const row = this.thinkingDb.prepare(`
      SELECT * FROM thinking_sessions WHERE session_id = ?
    `).get(sessionId) as any;
    
    if (!row) return null;
    
    return {
      session_id: row.session_id,
      topic: row.topic,
      status: row.status,
      created_at: row.created_at,
      last_thought_at: row.last_thought_at,
      completed_at: row.completed_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      oi_session_id: row.oi_session_id,
      oi_agent_id: row.oi_agent_id
    };
  }
  
  updateSessionStatus(sessionId: string, status: 'active' | 'completed' | 'paused', finalSynthesis?: string) {
    if (status === 'completed') {
      this.thinkingDb.prepare(`
        UPDATE thinking_sessions 
        SET status = ?, completed_at = CURRENT_TIMESTAMP
        WHERE session_id = ?
      `).run(status, sessionId);
    } else {
      this.thinkingDb.prepare(`
        UPDATE thinking_sessions 
        SET status = ?
        WHERE session_id = ?
      `).run(status, sessionId);
    }
  }
  
  listSessions(status?: string, limit: number = 10): ThinkingSession[] {
    let query = 'SELECT * FROM thinking_sessions';
    const params: any[] = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY last_thought_at DESC LIMIT ?';
    params.push(limit);
    
    const rows = this.thinkingDb.prepare(query).all(...params) as any[];
    
    return rows.map(row => ({
      session_id: row.session_id,
      topic: row.topic,
      status: row.status,
      created_at: row.created_at,
      last_thought_at: row.last_thought_at,
      completed_at: row.completed_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      oi_session_id: row.oi_session_id,
      oi_agent_id: row.oi_agent_id
    }));
  }
  
  // Thought operations
  addThought(sessionId: string, thought: ThoughtData): void {
    this.thinkingDb.prepare(`
      INSERT INTO thoughts (
        session_id, thought_number, thought_text, total_thoughts,
        is_revision, revises_thought, branch_from_thought, branch_id,
        next_thought_needed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      thought.thoughtNumber,
      thought.thought,
      thought.totalThoughts,
      thought.isRevision ? 1 : 0,
      thought.revisesThought || null,
      thought.branchFromThought || null,
      thought.branchId || null,
      thought.nextThoughtNeeded ? 1 : 0
    );
    
    // Update session last_thought_at
    this.thinkingDb.prepare(`
      UPDATE thinking_sessions 
      SET last_thought_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(sessionId);
  }
  
  getThoughtHistory(sessionId: string, fromThought?: number, toThought?: number, includeBranches: boolean = true): ThoughtRecord[] {
    let query = 'SELECT * FROM thoughts WHERE session_id = ?';
    const params: any[] = [sessionId];
    
    if (fromThought !== undefined) {
      query += ' AND thought_number >= ?';
      params.push(fromThought);
    }
    
    if (toThought !== undefined) {
      query += ' AND thought_number <= ?';
      params.push(toThought);
    }
    
    if (!includeBranches) {
      query += ' AND branch_from_thought IS NULL';
    }
    
    query += ' ORDER BY thought_number';
    
    const rows = this.thinkingDb.prepare(query).all(...params) as any[];
    
    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      thought_number: row.thought_number,
      thought_text: row.thought_text,
      total_thoughts: row.total_thoughts,
      is_revision: row.is_revision === 1,
      revises_thought: row.revises_thought,
      branch_from_thought: row.branch_from_thought,
      branch_id: row.branch_id,
      next_thought_needed: row.next_thought_needed === 1,
      created_at: row.created_at
    }));
  }
  
  // Vodou context operations (read-only from vodou-core.db)
  getOISessionContext(oiSessionId: string): any {
    if (!this.oiDb) return null;
    
    try {
      return this.oiDb.prepare(`
        SELECT * FROM mcp_sessions WHERE session_id = ?
      `).get(oiSessionId);
    } catch (error) {
      console.error('[Thinking DB] Error getting Vodou session context:', error);
      return null;
    }
  }
  
  getAgentContext(agentId: string): any[] {
    if (!this.oiDb) return [];
    
    try {
      return this.oiDb.prepare(`
        SELECT * FROM work_logs WHERE agent_id = ? 
        ORDER BY timestamp DESC LIMIT 10
      `).all(agentId) as any[];
    } catch (error) {
      console.error('[Thinking DB] Error getting agent context:', error);
      return [];
    }
  }
  
  getSkillContext(skillName: string): any[] {
    if (!this.oiDb) return [];
    
    try {
      return this.oiDb.prepare(`
        SELECT * FROM intent_mappings 
        WHERE tool_parameters LIKE ? AND server_name = 'vodou-core'
      `).all(`%${skillName}%`) as any[];
    } catch (error) {
      console.error('[Thinking DB] Error getting skill context:', error);
      return [];
    }
  }
  
  // Hybrid operations (combine both databases)
  getSessionWithContext(sessionId: string): { session: ThinkingSession; oi_context: OIContext } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    
    const oiContext: OIContext = {};
    
    if (session.oi_session_id && this.oiDb) {
      oiContext.oi_session = this.getOISessionContext(session.oi_session_id);
    }
    
    if (session.oi_agent_id && this.oiDb) {
      oiContext.agent_history = this.getAgentContext(session.oi_agent_id);
    }
    
    if (this.oiDb) {
      oiContext.skill_info = this.getSkillContext('deep-thinking');
    }
    
    return { session, oi_context: oiContext };
  }
  
  getFullContext(sessionId: string, includeOIContext: boolean = true): {
    session: ThinkingSession;
    thoughts: ThoughtRecord[];
    oi_context?: OIContext;
  } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    
    const thoughts = this.getThoughtHistory(sessionId);
    
    if (includeOIContext && this.oiDb) {
      const oiContext: OIContext = {};
      
      if (session.oi_session_id) {
        oiContext.oi_session = this.getOISessionContext(session.oi_session_id);
      }
      
      if (session.oi_agent_id) {
        oiContext.agent_history = this.getAgentContext(session.oi_agent_id);
      }
      
      oiContext.skill_info = this.getSkillContext('deep-thinking');
      
      return { session, thoughts, oi_context: oiContext };
    }
    
    return { session, thoughts };
  }
  
  close() {
    // Checkpoint WAL before close so any snapshot taken by the Safe Update System
    // captures all pending writes.
    try { this.thinkingDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.thinkingDb.close();
    if (this.oiDb) {
      this.oiDb.close();
    }
  }
}

