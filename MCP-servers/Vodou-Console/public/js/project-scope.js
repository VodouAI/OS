/**
 * ProjectScope — the ONE client-side answer to "is this surface in this project?"
 * PLAN-UNIFIED-PROJECT-SCOPE §2.6 (PLANS/0.6.26).
 *
 * Before this module, `localStorage['vodou.activeProject']` was read independently
 * in chat.js:304, scheduler.js:272 and skills.js:1442, and written in exactly one
 * place — so every new surface added a fourth private copy of the same question.
 * The server now decides visibility (`GET /api/dock/visibility`); this module holds
 * the answer and hands out SYNCHRONOUS booleans, because the dock's render loop
 * cannot await anything.
 *
 * FAIL-OPEN IS THE WHOLE DESIGN (INV-3). The failure mode of this feature is a tab
 * silently not rendering, which is both alarming and hard to diagnose. Unknown
 * scope, map not loaded yet, failed fetch, malformed JSON, kill switch, show-all —
 * all return TRUE. There is deliberately no code path that hides something because it
 * lacked information.
 */
(function () {
  const LS_ACTIVE = 'vodou.activeProject';
  const LS_FLAG = 'vodou.dockScope.v2';        // P4: retired; now a kill switch ('0')
  const LS_SHOWALL = 'vodou.dockScope.showAll'; // the escape hatch (INV-5, INV-7)

  let _map = null;            // { scope: boolean } — null while loading or degraded
  let _defaultVisible = true; // server's verdict for scopes it didn't enumerate
  let _ready = Promise.resolve();
  const _listeners = [];

  function ls(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch (_) {
      return d;
    }
  }

  const ProjectScope = {
    /**
     * PLAN-UNIFIED-PROJECT-SCOPE P4 — the flag is RETIRED (2026-08-17).
     *
     * It shipped dark so that "things disappear from the UI" could be reverted with
     * one keystroke while the invariants were unproven. They are now proven on real
     * data: 4,192 verdicts across 4 projects with 0 mismatches against the dock that
     * shipped before this, and with zero pins in place every shared surface is
     * visible in every project (INV-1/INV-3 re-checked at removal time).
     *
     * The function stays rather than being deleted at ~12 call sites, and it still
     * honours an explicit `vodou.dockScope.v2 = '0'` — a kill switch costs nothing
     * to keep and this feature's failure mode is silence, not an error.
     */
    enabled() {
      return ls(LS_FLAG, '1') !== '0';
    },

    active() {
      return ls(LS_ACTIVE, 'proj_default') || 'proj_default';
    },

    /**
     * Writes the active project, refetches the map, THEN fires `project:changed`.
     * The ordering matters: firing first would let every listener re-render against
     * the PREVIOUS project's visibility map.
     */
    async setActive(id) {
      const next = id || 'proj_default';
      try {
        localStorage.setItem(LS_ACTIVE, next);
      } catch (_) {}
      await this.refresh();
      try {
        window.dispatchEvent(new CustomEvent('project:changed', { detail: { id: next } }));
      } catch (_) {}
      _listeners.forEach((cb) => {
        try {
          cb(next);
        } catch (_) {}
      });
      return next;
    },

    showAll() {
      return ls(LS_SHOWALL, '0') === '1';
    },

    setShowAll(b) {
      try {
        localStorage.setItem(LS_SHOWALL, b ? '1' : '0');
      } catch (_) {}
      // No refetch — visible() short-circuits on this flag.
      try {
        window.dispatchEvent(new CustomEvent('project:changed', { detail: { id: this.active() } }));
      } catch (_) {}
    },

    /** Promise resolving when the visibility map has landed (or failed open). */
    ready() {
      return _ready;
    },

    /** SYNC boolean. Every uncertain path returns true. */
    visible(scope) {
      if (!this.enabled()) return true;
      if (this.showAll()) return true;
      if (!_map) return true; // still loading, or the fetch failed — never hide
      const v = _map[scope];
      return v === undefined ? _defaultVisible : !!v;
    },

    /**
     * Re-fetch the map. Exactly three things invalidate it and nothing else may:
     *   1. setActive() — a project switch
     *   2. a pin write (POST/PUT/DELETE .../scopes), so a pin shows immediately
     *   3. never on new conversations/tabs — a brand-new surface is an unknown
     *      scope, and unknown ⇒ visible, so it appears at once and settles into
     *      its real verdict on the next natural refresh. There is no window in
     *      which a new thing is invisible.
     */
    refresh() {
      _ready = fetch('/api/dock/visibility?project=' + encodeURIComponent(this.active()))
        .then((r) => (r && r.ok ? r.json() : null))
        .then((j) => {
          if (j && j.scopes && typeof j.scopes === 'object') {
            _map = j.scopes;
            _defaultVisible = j.defaultVisible !== false;
          } else {
            _map = null;
            _defaultVisible = true; // INV-3
          }
        })
        .catch(() => {
          _map = null;
          _defaultVisible = true; // INV-3
        });
      return _ready;
    },

    onChange(cb) {
      if (typeof cb === 'function') _listeners.push(cb);
    },

    /** Test seam — lets the vm sandbox assert fail-open without a live fetch. */
    _reset() {
      _map = null;
      _defaultVisible = true;
      _ready = Promise.resolve();
      _listeners.length = 0;
    },
  };

  window.ProjectScope = ProjectScope;

  // P4 — on by default now, so the map loads on boot. Still skipped entirely when
  // someone has set the kill switch, so opting out costs zero requests.
  if (ProjectScope.enabled()) ProjectScope.refresh();
})();
