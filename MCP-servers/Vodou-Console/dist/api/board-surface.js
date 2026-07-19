let _impl = null;
export function setBoardSurfaceImpl(fn) {
    _impl = fn;
}
export function surfaceBoardResult(taskId, title, body, kind) {
    try {
        _impl?.(taskId, title, body, kind);
    }
    catch (e) {
        console.error('[board-surface] push failed:', e.message);
    }
}
