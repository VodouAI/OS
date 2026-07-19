/**
 * Tool-visibility gate for Vodou-Board.
 *
 * The 14 board_* tools are visible to the LLM ONLY when VODOU_BOARD_TASK is set
 * in the calling process's env. The dispatcher sets this before spawning a
 * worker; normal chat sessions don't have it set so the LLM never sees board
 * tools cluttering its schema.
 *
 * Mirrors Hermes Kanban's HERMES_KANBAN_TASK check_fn pattern (PR #16100).
 */
export function isWorkerSession() {
    return typeof process.env.VODOU_BOARD_TASK === 'string'
        && process.env.VODOU_BOARD_TASK.length > 0;
}
/**
 * Whether board_* tools are EXPOSED — visible in tools/list AND callable. True
 * inside a worker spawn (VODOU_BOARD_TASK set), OR when the operator opts the board
 * into normal chat with VODOU_BOARD_TOOLS_ALWAYS_ON=1, making it behave like any
 * other always-on Vodou MCP server.
 *
 * NOTE: exposure ≠ task context. The six task-scoped tools (board_show / complete /
 * block / heartbeat / artifact / request_approval) still need a task id; with no
 * worker VODOU_BOARD_TASK they require an explicit `task_id` arg (see currentTaskId).
 * This is why we DON'T just set a placeholder VODOU_BOARD_TASK to open the gate —
 * that would silently point those tools at a bogus task.
 */
export function toolsExposed() {
    if (isWorkerSession())
        return true;
    const v = process.env.VODOU_BOARD_TOOLS_ALWAYS_ON;
    return v === '1' || v === 'true';
}
export function currentTaskId() {
    const id = process.env.VODOU_BOARD_TASK;
    if (!id) {
        throw new Error('No task context — pass an explicit "task_id" (VODOU_BOARD_TASK is only auto-set inside a worker spawn).');
    }
    return id;
}
export function currentRunId() {
    return process.env.VODOU_BOARD_RUN_ID ?? null;
}
export function currentWriteToken() {
    return process.env.VODOU_BOARD_WRITE_TOKEN ?? null;
}
export function currentWorkspace() {
    return process.env.VODOU_BOARD_WORKSPACE ?? process.cwd();
}
export function currentProfile() {
    return process.env.VODOU_PROFILE ?? null;
}
export function currentTenant() {
    return process.env.VODOU_TENANT ?? 'self';
}
