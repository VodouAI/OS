import { ThinkingDatabase } from './database.js';
import { ThinkingAnalyzer } from './analysis.js';
import type { ThoughtData, ThinkingAnalysis } from './types.js';

export class ThinkingServer {
  private db: ThinkingDatabase;
  private analyzer: ThinkingAnalyzer;
  
  constructor() {
    this.db = new ThinkingDatabase();
    this.analyzer = new ThinkingAnalyzer();
  }
  
  startSession(topic: string, estimatedSteps?: number, metadata?: any, oiSessionId?: string, oiAgentId?: string): {
    session_id: string;
    topic: string;
    status: string;
    estimated_steps: number;
  } {
    const sessionId = this.db.createSession(topic, {
      ...metadata,
      estimated_steps: estimatedSteps || 5
    }, oiSessionId, oiAgentId);
    
    return {
      session_id: sessionId,
      topic,
      status: 'active',
      estimated_steps: estimatedSteps || 5
    };
  }
  
  addThought(
    sessionId: string,
    thought: ThoughtData
  ): {
    thoughtNumber: number;
    totalThoughts: number;
    nextThoughtNeeded: boolean;
    currentThought: string;
    previousThoughts: Array<{ thoughtNumber: number; thought: string; createdAt: string }>;
    thoughtHistoryLength: number;
    suggestions?: string[];
  } {
    // Validate session exists
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // -----------------------------------------------------------------------
    // Garbage-content guards. The skill instructs the calling LLM to write
    // real analytical content per thought, but agents (especially in the
    // gateway pooled-CLI path) sometimes batch-submit the literal iteration
    // template ("Deep analysis iteration N of M on: <prompt>") for every
    // thought, treating the skill as a mechanical N-step tool sequence.
    //
    // Reject those submissions with a clear, actionable error so the LLM has
    // to write something real before the request succeeds. We accept the
    // first occurrence of duplicate text as well — the LLM may legitimately
    // re-quote a phrase — but anything that exactly matches a prior thought
    // is rejected too.
    // -----------------------------------------------------------------------
    const text = (thought.thought || '').trim();
    if (text.length < 30) {
      throw new Error(
        `Thought text too short (${text.length} chars). Write a real analytical thought (≥30 chars) — examine the topic, draw a connection, identify a tradeoff, or surface an assumption. Do NOT just echo the user prompt or write a placeholder.`
      );
    }
    const lower = text.toLowerCase();
    const ITERATION_PATTERNS = [
      /^deep analysis iteration \d+ of \d+ on:/i,
      /^iteration \d+ of \d+ on:/i,
      /^step \d+ of \d+ on:/i,
      /^thought \d+ of \d+:/i,
      /^analysis iteration \d+/i,
    ];
    for (const re of ITERATION_PATTERNS) {
      if (re.test(text)) {
        throw new Error(
          `Rejected: thought text matches the "iteration N of M on: <prompt>" template. The thinking skill requires REAL content per thought, not the iteration scaffold. Re-call with actual analysis: what does this step examine? What did you find? What follows from the previous thought? See the skill's "Rules for Good Thoughts" — be specific, build on prior thoughts, and quantify when possible.`
        );
      }
    }

    // Duplicate-content check: reject if this thought is verbatim equal to
    // any previous thought in the session. Catches the case where the agent
    // submits the same placeholder N times.
    const priorHistory = this.db.getThoughtHistory(sessionId);
    for (const prev of priorHistory) {
      const prevText = (prev.thought_text || '').trim();
      if (prevText.length > 0 && prevText === text) {
        throw new Error(
          `Rejected: this thought duplicates thought #${prev.thought_number} verbatim. Each thought must contribute new analysis — build on, disagree with, or extend the prior thought. Don't repeat the same text.`
        );
      }
    }
    // High-overlap check: catch near-duplicates that change a digit or word.
    if (priorHistory.length > 0) {
      const tokens = new Set(lower.split(/\s+/).filter(w => w.length > 3));
      for (const prev of priorHistory) {
        const prevLower = (prev.thought_text || '').trim().toLowerCase();
        const prevTokens = new Set(prevLower.split(/\s+/).filter(w => w.length > 3));
        if (tokens.size === 0 || prevTokens.size === 0) continue;
        const overlap = [...tokens].filter(t => prevTokens.has(t)).length;
        const jaccard = overlap / Math.max(tokens.size, prevTokens.size);
        if (jaccard > 0.85) {
          throw new Error(
            `Rejected: this thought is ≥85% identical (token overlap) to thought #${prev.thought_number}. Write fresh analysis — pick a different angle, examine an assumption, or go deeper on one specific aspect.`
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Derive the bookkeeping fields the server already knows.
    //
    // thoughtNumber / totalThoughts / nextThoughtNeeded are declared required
    // in the tool's inputSchema, but nothing validates against that schema, and
    // the handler casts each arg (`as number`) — a compile-time assertion with
    // no runtime effect. A caller that sends only {session_id, thought} — the
    // natural shape, and what the orchestrator sends — therefore reached the DB
    // with `undefined` and died at bind time on 100% of calls.
    //
    // Requiring the CALLER to track a counter the server can compute was the
    // design error. `priorHistory` is already loaded above for the duplicate
    // checks, so the number is free. MAX+1 rather than length+1: revisions and
    // branches can leave gaps, and reusing a number would corrupt ordering.
    // -----------------------------------------------------------------------
    const priorMaxNumber = priorHistory.reduce(
      (m, p) => Math.max(m, Number(p.thought_number) || 0),
      0
    );
    const priorMaxTotal = priorHistory.reduce(
      (m, p) => Math.max(m, Number((p as { total_thoughts?: number }).total_thoughts) || 0),
      0
    );

    const resolved: ThoughtData = {
      ...thought,
      thoughtNumber: thought.thoughtNumber ?? priorMaxNumber + 1,
      // Keep the caller's estimate when given; otherwise carry the session's
      // running estimate forward, never below the number we just assigned.
      totalThoughts: thought.totalThoughts ?? Math.max(priorMaxTotal, priorMaxNumber + 1),
      // A thought arriving with no explicit end-signal means the session is
      // still going — that is the safe default, since a wrong `false` would
      // silently mark an in-progress session finished.
      nextThoughtNeeded: thought.nextThoughtNeeded ?? true,
    };
    // Guard the derivation itself: if either NOT NULL field is still not a
    // usable number, say so here rather than letting SQLite report an index.
    if (!Number.isFinite(resolved.thoughtNumber) || !Number.isFinite(resolved.totalThoughts)) {
      throw new Error(
        `Could not resolve thought numbering (thoughtNumber=${String(resolved.thoughtNumber)}, ` +
        `totalThoughts=${String(resolved.totalThoughts)}). Pass thought_number explicitly.`
      );
    }

    // Add thought to database
    this.db.addThought(sessionId, resolved);
    thought = resolved;
    
    // Get thought history
    const history = this.db.getThoughtHistory(sessionId);
    
    // Analyze for suggestions
    const analysis = this.analyzer.analyzeThoughts(history);
    
    // Format previous thoughts
    const previousThoughts = history
      .filter(t => t.thought_number < thought.thoughtNumber)
      .map(t => ({
        thoughtNumber: t.thought_number,
        thought: t.thought_text,
        createdAt: t.created_at
      }));
    
    return {
      thoughtNumber: thought.thoughtNumber,
      totalThoughts: thought.totalThoughts,
      nextThoughtNeeded: thought.nextThoughtNeeded,
      currentThought: thought.thought,
      previousThoughts,
      thoughtHistoryLength: history.length,
      suggestions: analysis.suggestions.slice(0, 3) // Top 3 suggestions
    };
  }
  
  getThoughtContext(
    sessionId: string,
    fromThought?: number,
    toThought?: number,
    includeBranches: boolean = true,
    includeOIContext: boolean = true
  ): {
    session_id: string;
    topic: string;
    thoughts: Array<{
      thoughtNumber: number;
      thought: string;
      createdAt: string;
      isRevision: boolean;
      revisesThought?: number;
      branchFromThought?: number;
      branchId?: string;
    }>;
    oi_context?: any;
  } {
    const fullContext = this.db.getFullContext(sessionId, includeOIContext);
    
    if (!fullContext) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    let thoughts = fullContext.thoughts;
    
    // Filter by range if specified
    if (fromThought !== undefined || toThought !== undefined) {
      thoughts = thoughts.filter(t => {
        if (fromThought !== undefined && t.thought_number < fromThought) return false;
        if (toThought !== undefined && t.thought_number > toThought) return false;
        return true;
      });
    }
    
    // Filter branches if requested
    if (!includeBranches) {
      thoughts = thoughts.filter(t => !t.branch_from_thought);
    }
    
    return {
      session_id: sessionId,
      topic: fullContext.session.topic,
      thoughts: thoughts.map(t => ({
        thoughtNumber: t.thought_number,
        thought: t.thought_text,
        createdAt: t.created_at,
        isRevision: t.is_revision,
        revisesThought: t.revises_thought,
        branchFromThought: t.branch_from_thought,
        branchId: t.branch_id
      })),
      oi_context: fullContext.oi_context
    };
  }
  
  analyzeThinking(sessionId: string): {
    session_id: string;
    analysis: ThinkingAnalysis;
  } {
    const thoughts = this.db.getThoughtHistory(sessionId);
    
    if (thoughts.length === 0) {
      throw new Error(`No thoughts found for session ${sessionId}`);
    }
    
    const analysis = this.analyzer.analyzeThoughts(thoughts);

    // Keep the critique, not just the thoughts. See database.saveAnalysis —
    // this table existed with no writer, so every gap, assumption and quality
    // score computed here was discarded the moment it was returned.
    this.db.saveAnalysis(sessionId, 'thinking_quality', analysis);

    return {
      session_id: sessionId,
      analysis
    };
  }
  
  completeSession(sessionId: string, finalSynthesis?: string): {
    session_id: string;
    status: string;
    totalThoughts: number;
    completedAt: string;
  } {
    const session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const thoughts = this.db.getThoughtHistory(sessionId);
    
    // Update status
    this.db.updateSessionStatus(sessionId, 'completed', finalSynthesis);
    
    // Get updated session
    const updatedSession = this.db.getSession(sessionId);
    
    return {
      session_id: sessionId,
      status: 'completed',
      totalThoughts: thoughts.length,
      completedAt: updatedSession!.completed_at || new Date().toISOString()
    };
  }
  
  listSessions(status?: 'active' | 'completed' | 'paused', limit: number = 10): Array<{
    session_id: string;
    topic: string;
    status: string;
    thoughtCount: number;
    createdAt: string;
    lastThoughtAt: string;
  }> {
    const sessions = this.db.listSessions(status, limit);
    
    return sessions.map(session => {
      const thoughts = this.db.getThoughtHistory(session.session_id);
      return {
        session_id: session.session_id,
        topic: session.topic,
        status: session.status,
        thoughtCount: thoughts.length,
        createdAt: session.created_at,
        lastThoughtAt: session.last_thought_at
      };
    });
  }
  
  close() {
    this.db.close();
  }
}

