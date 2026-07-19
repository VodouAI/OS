/**
 * WorkbenchSurfaces — tracks which scoped-workbench conversations are
 * "surfaced" to the main chat tab strip.
 *
 * A workbench is always accessible from #/apps; surfacing adds
 * it as a tab in the second row beneath the main chat tabs so the user
 * can jump back in without navigating. Persistence is purely client-side
 * (localStorage key `vodou-surfaced-workbenches`) — it's a UI preference,
 * not server state.
 *
 * Each entry: { scope: 'workbench:integration:linear', title: 'Linear',
 *               icon: '<svg…>' }
 */
const WorkbenchSurfaces = (() => {
  const KEY = 'vodou-surfaced-workbenches';
  const listeners = [];

  function _read() {
    try {
      const raw = localStorage.getItem(KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function _write(arr) {
    localStorage.setItem(KEY, JSON.stringify(arr));
    for (const cb of listeners) { try { cb(arr); } catch {} }
  }

  function list() { return _read(); }
  function has(scope) { return _read().some((s) => s.scope === scope); }

  function add(entry) {
    if (!entry || !entry.scope) return;
    const arr = _read();
    if (arr.some((s) => s.scope === entry.scope)) return;
    arr.push({
      scope: entry.scope,
      title: entry.title || entry.scope,
      icon: entry.icon || '',
      // `kind` distinguishes surface types: 'workbench' (default — scoped
      // chat conversation) vs 'automation' (run-feed link, not a chat).
      // The main chat tab renderer checks this to pick the click handler.
      kind: entry.kind || 'workbench',
    });
    _write(arr);
  }

  function remove(scope) {
    const arr = _read().filter((s) => s.scope !== scope);
    _write(arr);
  }

  function toggle(entry) {
    if (has(entry.scope)) remove(entry.scope);
    else add(entry);
  }

  /** Patch fields on an existing entry — used by the icon picker to persist
   *  user overrides (icon/title) so the dock + reload pick them up. */
  function update(scope, patch) {
    if (!scope || !patch) return;
    const arr = _read();
    let changed = false;
    for (const s of arr) {
      if (s.scope === scope) {
        Object.assign(s, patch);
        changed = true;
        break;
      }
    }
    if (changed) _write(arr);
  }

  function onChange(cb) {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // Cross-tab sync — if user surfaces on another tab, our listeners fire
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      const arr = _read();
      for (const cb of listeners) { try { cb(arr); } catch {} }
    }
  });

  return { list, has, add, remove, toggle, update, onChange };
})();

if (typeof window !== 'undefined') window.WorkbenchSurfaces = WorkbenchSurfaces;
