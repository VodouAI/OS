/**
 * ViewLifecycle — per-route cleanup registry.
 *
 * Views register teardown callbacks (clearInterval / removeEventListener /
 * observer.disconnect) via ViewLifecycle.onCleanup(fn). The router drains the
 * registry on every route change (see router.js _handleRoute), so navigating
 * away never leaks a timer, listener, or observer.
 *
 * This is additive to a view's destroy() — destroy() handles instance state the
 * view owns long-term (e.g. terminal keeps its PTY); onCleanup() handles the
 * per-mount resources that must die on swap.
 */
const ViewLifecycle = {
  _cleanups: [],

  /** Register a teardown to run on the next route change. Returns an unregister fn. */
  onCleanup(fn) {
    if (typeof fn !== 'function') return () => {};
    this._cleanups.push(fn);
    return () => {
      const i = this._cleanups.indexOf(fn);
      if (i >= 0) this._cleanups.splice(i, 1);
    };
  },

  /** Drain and run every registered teardown. Called by the router before a swap. */
  drain() {
    const fns = this._cleanups;
    this._cleanups = [];
    for (const fn of fns) {
      try { fn(); } catch (e) { console.warn('[ViewLifecycle] cleanup failed:', e); }
    }
  },
};

if (typeof window !== 'undefined') window.ViewLifecycle = ViewLifecycle;
