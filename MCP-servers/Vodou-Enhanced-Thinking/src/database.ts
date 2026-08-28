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
    // `node:sqlite` binds string | number | bigint | null | Buffer and REJECTS
    // `undefined` with "Provided value cannot be bound to SQLite parameter N".
    // That message names a positional index, not a column, so a single missing
    // field is near-undiagnosable — add_thought was failing on 100% of calls
    // because thoughtNumber arrived undefined and bound as parameter 2.
    //
    // The handler casts every arg (`args.thoughtNumber as number`), and a TS
    // cast is erased at runtime, so nothing between the wire and here can catch
    // it. Coerce at the boundary: for a nullable column this is the fix
    // outright; for a NOT NULL column (thought_number, total_thoughts) it turns
    // an opaque index into "NOT NULL constraint failed: thoughts.thought_number",
    // which names the offender. §7 of PLANS/0.6.26 tracks lifting this into a
    // shared helper for every first-party node:sqlite server.
    const bind = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

    // PLAN-CONSOLE-SHOWS-ITS-WORK §7 S-1 (PLANS/0.6.26) — the coercion above turns
    // an opaque parameter index into a legible NOT NULL error, but the CALL still
    // fails, and a thinking tool that refuses a thought because the caller didn't
    // count for it is broken in the way that matters. The session already knows
    // which thought this is: derive it. Callers that DO pass a number keep full
    // control (revisions and branches depend on that), so this only fills a gap.
    const resolvedNumber =
      thought.thoughtNumber ??
      ((this.thinkingDb
        .prepare('SELECT COALESCE(MAX(thought_number), 0) + 1 AS next FROM thoughts WHERE session_id = ?')
        .get(sessionId) as { next: number } | undefined)?.next ?? 1);

    // Same argument for totalThoughts: it is NOT NULL, so an omitted value would
    // fail the insert for a field that is only ever an estimate. "At least this
    // many" is the honest default and is what a caller means by omitting it.
    const resolvedTotal = thought.totalThoughts ?? resolvedNumber;

    this.thinkingDb.prepare(`
      INSERT INTO thoughts (
        session_id, thought_number, thought_text, total_thoughts,
        is_revision, revises_thought, branch_from_thought, branch_id,
        next_thought_needed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bind(sessionId),
      resolvedNumber,
      bind(thought.thought),
      resolvedTotal,
      thought.isRevision ? 1 : 0,
      thought.revisesThought ?? null,
      thought.branchFromThought ?? null,
      thought.branchId ?? null,
      thought.nextThoughtNeeded === false ? 0 : 1
    );
    
    // Update session last_thought_at
    this.thinkingDb.prepare(`
      UPDATE thinking_sessions
      SET last_thought_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(sessionId);
  }

  /**
   * Persist one analysis pass.
   *
   * `thinking_analysis` has existed since the first schema (line ~55) and had
   * **zero rows** — `analyzeThinking()` computed the gaps, assumptions,
   * suggestions and quality score, returned them to the caller, and dropped
   * them. So a session's *thoughts* survived while the critique that shaped
   * them did not, and that critique is the load-bearing half: in the two
   * sessions of 2026-08-18 the analyzer's "question your absolutes" prompts are
   * what produced the security-inversion finding (T5) and the
   * acquisition/retention sequencing (T13). Re-reading the thoughts does not
   * recover them, because they were never in the thoughts.
   *
   * Append-only on purpose: an analysis is a reading *at a point in time*, and a
   * session's quality score moving 0.34 → 0.51 → 0.61 across a session is
   * itself the signal. Overwriting would keep the number and lose the trend.
   *
   * Best-effort by design — a failure here must never break `analyze_thinking`,
   * which is a read-only introspection call the caller is entitled to get back
   * even if we cannot record it.
   */
  saveAnalysis(sessionId: string, analysisType: string, analysisData: unknown): void {
    try {
      this.thinkingDb.prepare(`
        INSERT INTO thinking_analysis (session_id, analysis_type, analysis_data)
        VALUES (?, ?, ?)
      `).run(sessionId, analysisType, JSON.stringify(analysisData ?? null));
    } catch (err) {
      // Never surface: the analysis itself is still returned to the caller.
      console.error('[thinking] saveAnalysis failed:', (err as Error).message);
    }
  }

  /** Every stored analysis for a session, oldest first — the quality trend. */
  getAnalysisHistory(sessionId: string): Array<{ analysis_type: string; analysis_data: string; created_at: string }> {
    return this.thinkingDb.prepare(`
      SELECT analysis_type, analysis_data, created_at
      FROM thinking_analysis WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId) as Array<{ analysis_type: string; analysis_data: string; created_at: string }>;
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

