/**
 * IntegrationScopeAdapter — turns a server id into a workbench descriptor.
 *
 * Tools come from `GET /api/tools?server=<id>` (existing endpoint).
 * Preset data (display name, icon, setup steps, connect state) comes from
 * `window._integrationPresets` if the Apps view has populated it;
 * otherwise we fetch `/api/oauth/status` on first use so the workbench can
 * stand alone (pinned tab opened before visiting #/apps).
 *
 * When setup/management UI makes sense (unconnected, or connected but the
 * user may want to replace keys / test / disconnect), we hand the empty-state
 * area to `window._integrationUi.renderSetupPanel(id, el)`, which builds the
 * full form (install steps + credential inputs + submit buttons) and
 * re-renders itself after successful connect/save so Connected state flips
 * without a page reload.
 */
(() => {
  function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function esc(s) { return window.VodouSafe.escapeHtml(s); }

  function buildIcon(preset, serverId) {
    if (preset?.logo) {
      const mono = preset.logoColor ? '' : ' icon-logo-mono-img';
      return `<img src="${esc(preset.logo)}" class="sw-icon-img${mono}" alt="${esc(preset.name || serverId)}" />`;
    }
    if (preset?.icon) {
      return `<span class="sw-icon-emoji">${esc(preset.icon)}</span>`;
    }
    const initial = String(serverId || '?').charAt(0).toUpperCase();
    return `<span class="sw-icon-initial">${esc(initial)}</span>`;
  }

  async function ensurePresetCache() {
    const cache = window._integrationPresets;
    if (!cache || cache.size > 0) return;
    try {
      const res = await fetch('/api/oauth/status');
      if (!res.ok) return;
      const { providers } = await res.json();
      if (Array.isArray(providers)) {
        for (const p of providers) cache.set(p.id, p);
      }
    } catch (err) {
      console.error('[IntegrationScopeAdapter] oauth/status prefetch failed:', err);
    }
  }

  const IntegrationScopeAdapter = {
    async describe(serverId) {
      if (!serverId) return null;

      await ensurePresetCache();

      const presetMap = window._integrationPresets;
      const preset = presetMap && typeof presetMap.get === 'function' ? presetMap.get(serverId) : null;

      let tools = [];
      try {
        const res = await fetch(`/api/tools?server=${encodeURIComponent(serverId)}`);
        if (res.ok) {
          const data = await res.json();
          tools = Array.isArray(data.tools) ? data.tools : [];
        }
      } catch (err) {
        console.error('[IntegrationScopeAdapter] /api/tools fetch failed:', err);
      }

      const displayName = preset?.name || capitalize(serverId);
      const toolRail = tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        prefill: `/server ${serverId} ${t.name} `,
      }));

      // Show the inline setup/management panel when we have a preset.
      // It handles both "not connected" (install steps + credential form) and
      // "connected" (KV info + replace-key / test / disconnect) states.
      const mountEmptyState = preset
        ? (el) => {
            const ui = window._integrationUi;
            if (ui && typeof ui.renderSetupPanel === 'function') {
              ui.renderSetupPanel(serverId, el);
            } else {
              el.innerHTML = `<div class="sw-empty-hint">Apps UI not loaded yet.</div>`;
            }
          }
        : null;

      // Connection-state summary — used by scoped-workbench.js to render a
      // status dot + "Manage connection" link next to the title.
      const connection = preset
        ? {
            connected: !!preset.connected,
            expired: !!preset.expired,
            blocked: !!preset.blocked,
            mcpHealth: preset.mcpHealth || null,
            mcpEnabled: preset.mcpEnabled !== false,
            toolCount: preset.toolCount ?? null,
            authPath: preset.authPath || null,
          }
        : null;

      return {
        scopeType: 'integration',
        scopeId: serverId,
        raw: `workbench:integration:${serverId}`,
        displayName,
        iconHtml: buildIcon(preset, serverId),
        toolRail,
        mountEmptyState,
        connection,
        emptyStateHint: tools.length
          ? `Ask ${displayName} anything. Click a tool below to start.`
          : preset && !preset.connected
            ? `${displayName} is not connected yet.`
            : `${displayName} has no tools cached yet. Connect or refresh the server first.`,
      };
    },
  };

  if (typeof window.ScopeRegistry !== 'undefined') {
    window.ScopeRegistry.register('integration', IntegrationScopeAdapter);
  } else {
    console.error('[IntegrationScopeAdapter] ScopeRegistry not loaded — load ws-bus/scope-registry first');
  }
})();
