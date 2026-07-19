/**
 * board-surface.ts — injection point so the boardRouter (api/board.ts) can push a
 * finished task's result into the shared "Board" chat tab WITHOUT importing
 * index.ts (which would be circular). index.ts owns streamToConversation,
 * broadcastBoardActivity, saveMessage and the live `clients` map, so it registers
 * the real implementation at startup via setBoardSurfaceImpl().
 *
 * Without this, a result saved to the board-chat conversation only appears after
 * the tab is reloaded — an already-open Board tab never updates live.
 */
export type BoardSurfaceFn = (
  taskId: string,
  title: string,
  body: string,
  kind: 'done' | 'blocked',
) => void;

let _impl: BoardSurfaceFn | null = null;

export function setBoardSurfaceImpl(fn: BoardSurfaceFn): void {
  _impl = fn;
}

export function surfaceBoardResult(
  taskId: string,
  title: string,
  body: string,
  kind: 'done' | 'blocked',
): void {
  try {
    _impl?.(taskId, title, body, kind);
  } catch (e) {
    console.error('[board-surface] push failed:', (e as Error).message);
  }
}
