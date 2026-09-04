/**
 * Hash router for the dashboard SPA
 */

const Router = {
  routes: {},
  currentRoute: null,
  currentView: null,

  register(path, renderFn, view) {
    this.routes[path] = { renderFn, view };
  },

  navigate(path) {
    location.hash = path;
  },

  init() {
    window.addEventListener('hashchange', () => this._handleRoute());
    // 0.6.31 — render as soon as the DOM is ready, not on window 'load'.
    // 'load' waits for every image and in-flight request; with a slow
    // /api/system (measured 14 s) and dozens of brand icons queued behind it,
    // Memory sat on a spinner for 6-14 s while its own API answered in ~110 ms.
    // init() is called from the DOMContentLoaded bootstrap after every view
    // script has registered its route, so routing now is safe.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._handleRoute(), { once: true });
    } else {
      this._handleRoute();
    }
  },

  _parseHash() {
    // PLAN-CONSOLE-SHOWS-ITS-WORK §4.4 — where the console OPENS.
    //
    // §1.1 is the test: "if the user never typed anything, would the console still
    // be worth opening?" P2 built the surface that makes the answer yes. But
    // silently moving everyone's front door is a product decision, not a commit
    // side effect, so this is OPT-IN: set `vodou.landing` to a route and the
    // console opens there instead of /chat. Unset keeps today's behaviour exactly.
    let landing = '/chat';
    try {
      const pref = localStorage.getItem('vodou.landing');
      if (pref && /^\/[a-z0-9/-]*$/i.test(pref)) landing = pref;
    } catch (_) { /* private mode — keep the default */ }
    let raw = location.hash.slice(1) || landing;
    if (raw === '/home' || raw.startsWith('/home?')) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/system`);
      raw = location.hash.slice(1) || '/system';
    }
    const qIdx = raw.indexOf('?');
    let pathOnly = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const qs = qIdx >= 0 ? raw.slice(qIdx + 1) : '';
    if (!pathOnly.startsWith('/')) pathOnly = '/' + pathOnly;
    if (pathOnly.length > 1 && pathOnly.endsWith('/')) pathOnly = pathOnly.slice(0, -1);
    return { raw, pathOnly, qs };
  },

  _maybeRedirectLegacy(pathOnly) {
    const toCap = {
      '/skills': 'skills',
      '/intents': 'routing-rules',
      '/scripts': 'scripts',
    };
    // 0.6.31 — Board is an Activity tab; the old deep link keeps working.
    const toAct = { '/logs': 'history', '/scheduler': 'scheduled', '/board': 'board' };
    if (pathOnly === '/servers') {
      history.replaceState(null, '', `${location.pathname}${location.search}#/connect?tab=servers`);
      return true;
    }
    if (toCap[pathOnly]) {
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}#/capabilities?tab=${toCap[pathOnly]}`
      );
      return true;
    }
    if (toAct[pathOnly]) {
      history.replaceState(
        null,
        '',
        `${location.pathname}${location.search}#/activity?tab=${toAct[pathOnly]}`
      );
      return true;
    }
    return false;
  },

  _updateNavActive(pathOnly, qs, raw) {
    const params = new URLSearchParams(qs);
    const tabCap = params.get('tab') || 'skills';
    const tabAct = params.get('tab') || 'history';
    const tabSet = params.get('tab') || 'profile';

    document.querySelectorAll('#sidebar .nav-item[href]').forEach(item => {
      const href = item.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      const inner = href.slice(1);
      const iq = inner.indexOf('?');
      const hp = iq >= 0 ? inner.slice(0, iq) : inner;
      const hq = iq >= 0 ? inner.slice(iq + 1) : '';
      const hParams = new URLSearchParams(hq);
      const hTabCap = hParams.get('tab') || 'skills';
      const hTabAct = hParams.get('tab') || 'history';
      const hTabSet = hParams.get('tab') || 'profile';

      let active = false;
      if (inner === raw) active = true;
      else if (hp === '/capabilities') {
        active = pathOnly === '/capabilities' && tabCap === hTabCap;
        if (hTabCap === 'tools' && pathOnly.startsWith('/servers')) active = true;
      } else if (hp === '/activity') {
        active = pathOnly === '/activity' && tabAct === hTabAct;
      } else if (hp === '/settings') {
        active = pathOnly === '/settings' && tabSet === hTabSet;
      } else if (!hq && hp === pathOnly && !qs) {
        // Path-only nav entry matches current route only when the URL has no query
        // (e.g. #/chat vs #/chat?channel=… where the channel row carries the highlight).
        active = true;
      }

      item.classList.toggle('active', active);
    });

    document.querySelectorAll('#sidebar .nav-group').forEach((g) => g.classList.remove('nav-group-active'));
    // Skills + Capabilities merged into one "Skills & Tools" group (id=nav-capabilities).
    if (pathOnly === '/capabilities' || pathOnly === '/lenses' || pathOnly.startsWith('/servers')) {
      document.getElementById('nav-capabilities')?.classList.add('nav-group-active');
    }
    if (pathOnly === '/activity') {
      document.getElementById('nav-activity')?.classList.add('nav-group-active');
    }
    if (pathOnly === '/apps') {
      document.getElementById('nav-apps')?.classList.add('nav-group-active');
    }
    if (pathOnly === '/projects') {
      document.getElementById('nav-projects')?.classList.add('nav-group-active');
    }
    if (pathOnly === '/messaging' || (pathOnly === '/chat' && params.get('channel'))) {
      document.getElementById('nav-messaging')?.classList.add('nav-group-active');
    }
    if (pathOnly === '/settings') {
      document.getElementById('nav-settings')?.classList.add('nav-group-active');
    }

    document.querySelectorAll('#sidebar .nav-advanced').forEach((a) => a.classList.remove('nav-advanced-active'));
    if (pathOnly === '/builder' || pathOnly.startsWith('/builder/') || pathOnly === '/terminal') {
      document.getElementById('nav-advanced')?.classList.add('nav-advanced-active');
    }

    if (typeof window._syncNavCollapsibles === 'function') {
      window._syncNavCollapsibles(pathOnly);
    }
  },

  /** Re-apply sidebar .active / group highlights from the current location (no route render). */
  syncNavFromHash() {
    const { raw, pathOnly, qs } = this._parseHash();
    this._updateNavActive(pathOnly, qs, raw);
  },

  _handleRoute() {
    let { raw, pathOnly, qs } = this._parseHash();

    // Legacy onboarding landed on #/heartbeat (not a real route) — chat is
    // #/chat with the Heartbeat tab selected inside ChatView.
    if (pathOnly === '/heartbeat') {
      history.replaceState(null, '', `${location.pathname}${location.search}#/chat`);
      const focusHeartbeat = () => {
        if (typeof ChatView === 'undefined' || !Array.isArray(ChatView._tabs)) {
          requestAnimationFrame(focusHeartbeat);
          return;
        }
        const hb = ChatView._tabs.find((t) => t.conversationId === 'vodou-heartbeat');
        if (hb && hb.id !== ChatView._activeTabId) ChatView._switchTab(hb.id);
      };
      focusHeartbeat();
      return this._handleRoute();
    }

    if (pathOnly === '/integrations') {
      const tail = qs ? `?${qs}` : '';
      history.replaceState(null, '', `${location.pathname}${location.search}#/apps${tail}`);
      return this._handleRoute();
    }

    if (pathOnly === '/channels') {
      const tail = qs ? `?${qs}` : '';
      history.replaceState(null, '', `${location.pathname}${location.search}#/messaging${tail}`);
      return this._handleRoute();
    }

    // 0.6.31 — Builder (demo) left the tree; its links land on Skills.
    if (pathOnly === '/builder' || pathOnly.startsWith('/builder/')) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/capabilities?tab=skills`);
      return this._handleRoute();
    }
    // 0.6.31 — MCP servers live under Connect.
    if (pathOnly === '/capabilities' && new URLSearchParams(qs).get('tab') === 'tools') {
      history.replaceState(null, '', `${location.pathname}${location.search}#/connect?tab=servers`);
      return this._handleRoute();
    }
    if (pathOnly === '/activity') {
      const p = new URLSearchParams(qs);
      if (p.get('tab') === 'background') {
        history.replaceState(
          null,
          '',
          `${location.pathname}${location.search}#/capabilities?tab=scripts`
        );
        return this._handleRoute();
      }
    }

    if (this._maybeRedirectLegacy(pathOnly)) {
      return this._handleRoute();
    }

    const mainContent = document.getElementById('main-content');
    const chatContainer = document.getElementById('chat-container');

    if (window.ViewLifecycle) window.ViewLifecycle.drain();
    if (this.currentView && typeof this.currentView.destroy === 'function') {
      this.currentView.destroy();
    }

    document.title = window.VODOU_TITLE || 'VODOU - ALPHA';

    this._updateNavActive(pathOnly, qs, raw);

    if (pathOnly === '/chat') {
      chatContainer.style.display = 'flex';
      mainContent.style.display = 'none';
      this.currentRoute = '/chat';
      this.currentView = (typeof ChatView !== 'undefined') ? ChatView : null;
      if (typeof window.refreshSidebarState === 'function') window.refreshSidebarState();
      return;
    }

    chatContainer.style.display = 'none';
    mainContent.style.display = 'block';
    // #main-content is a SHARED container: the same element is handed to every
    // view. A view that opts out of the standard padded-document chrome does so
    // by adding a class (today only the board, `#main-content.board-view` →
    // padding:0; overflow:hidden). Nothing removed it, so the opt-out was
    // permanent for the rest of the session: visit Kanban once and Memory,
    // Apps, Messaging, Skills, Scripts, Servers and Channels all rendered
    // flush to the edges with their internal scrolling clipped, until a
    // reload. `display` was already normalized on this line for the same
    // reason; the class list is the half that was missed.
    //
    // Reset here, one line above the dispatch, so a full-bleed view re-adds its
    // own class inside its render() and every other view gets the 24/32 page
    // padding back. Nothing reads a class off this element, so clearing is safe.
    mainContent.className = '';

    const serversDetailMatch = pathOnly.match(/^\/servers\/(.+)$/);
    if (serversDetailMatch) {
      mainContent.innerHTML = '';
      this.currentRoute = pathOnly;
      this.currentView = ServersView;
      ServersView.render(mainContent, decodeURIComponent(serversDetailMatch[1]));
      if (typeof window.refreshSidebarState === 'function') window.refreshSidebarState();
      return;
    }


    const route = this.routes[pathOnly];
    // 0.6.31 — #main-content is the scroller now; a new page starts at the top.
    mainContent.scrollTop = 0;
    if (route) {
      mainContent.innerHTML = '';
      this.currentRoute = pathOnly;
      this.currentView = route.view || null;
      route.renderFn(mainContent);
    } else {
      mainContent.innerHTML = '<div class="empty-state">Page not found</div>';
      this.currentView = null;
    }

    if (typeof window.refreshSidebarState === 'function') window.refreshSidebarState();

    if (typeof window._refreshAlerts === 'function') {
      window._refreshAlerts();
    }
  },
};
