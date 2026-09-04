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
  /** Set once seedSkillsOnce() has run; see its comment for why it must not repeat. */
  const SEEDED_KEY = 'vodou-surfaced-skills-seeded';
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

  /**
   * One-time recovery seed for the dock's Skills tier.
   *
   * Surfacing has always been client-only state, so clearing site data or
   * opening a different browser profile emptied the Skills tier permanently —
   * `is-empty` hides the whole group, header included, while the persona
   * conversations sat untouched in gateway.db with no path back into the UI.
   * This pulls `workbench:skill:*` from the server and surfaces any that aren't
   * already listed.
   *
   * Runs ONCE, gated on SEEDED_KEY. That gate is the whole design: removing a
   * persona from the dock is a real user choice, and re-seeding on every load
   * would undo it every refresh. A user who wants a persona back re-adds it
   * from the Skills view, which is also what sets this flag for fresh installs
   * that never needed recovery.
   */
  async function seedSkillsOnce() {
    try {
      if (localStorage.getItem(SEEDED_KEY)) return;
      const res = await fetch('/api/workbench/skills');
      if (!res.ok) return; // older server without the endpoint — try again next load
      const data = await res.json();
      const skills = Array.isArray(data && data.skills) ? data.skills : [];
      // Mark seeded only after a successful fetch, so a transient failure
      // doesn't silently burn the one recovery attempt.
      localStorage.setItem(SEEDED_KEY, String(skills.length));
      for (const s of skills) {
        if (!s || !s.scope) continue;
        add({ scope: s.scope, title: s.title || s.scope, icon: '🧑', kind: 'workbench' });
      }
    } catch {
      // Offline / server down — leave the gate unset and retry on the next load.
    }
  }

  return { list, has, add, remove, toggle, update, onChange, seedSkillsOnce };
})();

if (typeof window !== 'undefined') window.WorkbenchSurfaces = WorkbenchSurfaces;
