/**
 * TypeScript types mirroring the board.db row shapes.
 * Keep in sync with `src/board/types.rs` on the Rust side.
 */
export type TaskStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'archived' | 'pending_approval';
export type WorkspaceKind = 'scratch' | 'worktree' | `dir:/${string}`;
export type RunOutcome = 'completed' | 'blocked' | 'crashed' | 'timed_out' | 'spawn_failed' | 'gave_up' | 'reclaimed' | 'budget_exceeded';
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'expired';
export interface Task {
    id: string;
    board_id: string;
    tenant_id: string;
    title: string;
    body: string | null;
    status: TaskStatus;
    assignee: string | null;
    assignee_principal_id: string | null;
    priority: number;
    parents_json: string | null;
    skills_json: string | null;
    workspace: WorkspaceKind;
    current_run_id: string | null;
    claim_lock: string | null;
    claim_expires_at: string | null;
    worker_pid: number | null;
    max_runtime_seconds: number | null;
    max_retries: number | null;
    consecutive_failures: number;
    hallucination_gate_strikes: number;
    last_heartbeat_at: string | null;
    last_failure_error: string | null;
    idempotency_key: string | null;
    workflow_template_id: string | null;
    workflow_template_version: string | null;
    current_step_key: string | null;
    requires_approval_on: string | null;
    budget_tokens_cap: number | null;
    budget_usd_cap: number | null;
    budget_usd_soft_cap: number | null;
    budget_runtime_seconds_cap: number | null;
    budget_soft_warned: number;
    model_override: string | null;
    intent_embedding: Buffer | null;
    created_by_principal_id: string | null;
    created_at: string;
    updated_at: string;
    source_conversation_id: string | null;
    source_channel: string | null;
}
export interface TaskRun {
    id: string;
    task_id: string;
    attempt_no: number;
    profile: string | null;
    step_key: string | null;
    worker_pid: number | null;
    started_at: string;
    ended_at: string | null;
    outcome: RunOutcome | null;
    summary: string | null;
    metadata_json: string | null;
    error: string | null;
    tokens_used: number;
    usd_spent: number;
    log_path: string | null;
}
export interface TaskEvent {
    id: number;
    task_id: string;
    run_id: string | null;
    kind: string;
    payload_json: string | null;
    actor: string | null;
    created_at: string;
}
export interface TaskComment {
    id: number;
    task_id: string;
    body: string;
    author_principal_id: string | null;
    author_label: string | null;
    in_reply_to: number | null;
    created_at: string;
}
export interface MemoryChunk {
    doc_id: string;
    score: number;
    snippet: string;
    tags: string[];
    metadata?: Record<string, unknown>;
}
export interface WorkerContext {
    task: Pick<Task, 'id' | 'title' | 'body' | 'assignee' | 'priority' | 'workspace' | 'current_step_key'> & {
        skills_loaded: string[];
    };
    prior_attempts: Array<Pick<TaskRun, 'attempt_no' | 'outcome' | 'summary' | 'ended_at' | 'error'>>;
    parent_handoffs: Array<{
        task_id: string;
        title: string;
        summary: string | null;
        metadata: Record<string, unknown> | null;
    }>;
    role_history: Array<{
        task_id: string;
        title: string;
        summary: string | null;
        completed_at: string;
    }>;
    comments: Array<Pick<TaskComment, 'body' | 'created_at'> & {
        author_label: string;
    }>;
    memory: MemoryChunk[];
    budget: {
        tokens_cap: number | null;
        usd_cap: number | null;
        tokens_used: number;
        usd_spent: number;
    };
    workspace_path: string;
    model: string;
    guidance: string;
}
export interface BoardApproval {
    id: string;
    task_id: string;
    transition_label: string;
    requested_at: string;
    expires_at: string | null;
    decision: ApprovalDecision;
    decided_at: string | null;
    decided_by_principal_id: string | null;
    decided_via: string | null;
    reason: string | null;
    notified_targets_json: string | null;
}
/** Filter shape for board_list MCP tool */
export interface TaskFilter {
    board_id?: string;
    status?: TaskStatus | TaskStatus[];
    assignee?: string;
    tenant_id?: string;
    archived?: boolean;
    limit?: number;
    offset?: number;
}
/** Assignee discovery entry (board_assignees output) */
export interface AssigneeEntry {
    name: string;
    active: boolean;
    in_flight: number;
    preferred_model: string | null;
    persona_role: string | null;
}
