export interface ThoughtData {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
  nextThoughtNeeded: boolean;
}

export interface ThinkingSession {
  session_id: string;
  topic: string;
  status: 'active' | 'completed' | 'paused';
  created_at: string;
  last_thought_at: string;
  completed_at?: string;
  metadata?: string;
  oi_session_id?: string;
  oi_agent_id?: string;
}

export interface ThoughtRecord {
  id: number;
  session_id: string;
  thought_number: number;
  thought_text: string;
  total_thoughts: number;
  is_revision: boolean;
  revises_thought?: number;
  branch_from_thought?: number;
  branch_id?: string;
  next_thought_needed: boolean;
  created_at: string;
}

export interface ThinkingAnalysis {
  totalThoughts: number;
  averageThoughtLength: number;
  revisions: number;
  branches: number;
  gaps: string[];
  assumptions: string[];
  suggestions: string[];
  qualityScore: number;
}

export interface OIContext {
  oi_session?: any;
  agent_history?: any[];
  skill_info?: any;
}

