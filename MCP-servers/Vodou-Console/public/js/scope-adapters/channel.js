/**
 * ChannelScopeAdapter — turns a channel id (telegram, slack, discord,
 * whatsapp, imessage, teams, googlechat, signal) into a workbench descriptor.
 *
 * Mirrors the app (MCP) workbench pattern. Pinning a channel to the workbench gives users
 * the same scoped-conversation + tool-rail + per-scope instructions that
 * Apps have. Tool rail surfaces channel-specific actions:
 *   - Toggle allowlist (quick on/off from the rail)
 *   - Add a sender to the allowlist
 *   - For iMessage: re-check Full Disk Access
 *   - For iMessage: import top senders
 *   - For WhatsApp: reset session
 *
 * Each tool prefills the scoped chat input with a slash command the
 * LLM can route back through the channels API.
 */
(() => {
  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  function esc(s) { return window.VodouSafe.escapeHtml(s); }

  function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // Icon resolution — CHANNEL_META lives in channels.js (via window.ChannelsView
  // at load time). If channels.js hasn't mounted yet (deep-link to workbench
  // before visiting #/messaging), fall back to a neutral initial.
  function buildIcon(channel) {
    try {
      const meta = window.CHANNEL_META || (window.ChannelsView && window.ChannelsView._CHANNEL_META);
      // CHANNEL_META isn't globally exported — fall back to fetching icon by
      // calling into channels.js lazily.
      if (window.ChannelsView && window.ChannelsView.getIconHtml) {
        const ih = window.ChannelsView.getIconHtml(channel);
        if (ih) return `<span class="sw-icon-channel">${ih}</span>`;
      }
    } catch {}
    const initial = String(channel || '?').charAt(0).toUpperCase();
    return `<span class="sw-icon-initial">${esc(initial)}</span>`;
  }

  // Human-readable labels. Mirror what CHANNEL_META uses.
  const DISPLAY_NAMES = {
    telegram: 'Telegram',
    slack: 'Slack',
    discord: 'Discord',
    whatsapp: 'WhatsApp',
    imessage: 'iMessage',
    teams: 'Microsoft Teams',
    googlechat: 'Google Chat',
    signal: 'Signal',
    voice: 'Voice',
    web: 'Web',
  };

  // Per-channel tool rail. Each entry renders as a clickable button in the
  // sidebar under the active channel; click prefills the chat input with
  // the command, matching the Apps tool-rail pattern.
  function toolRailFor(channel) {
    const base = [
      {
        name: 'Toggle allowlist',
        description: 'Flip mode=on/off so Vodou only replies to allowed senders (or everyone).',
        prefill: `/channel ${channel} allowlist toggle `,
      },
      {
        name: 'Add allowed sender',
        description: 'Append a sender ID to the allowlist without opening the modal.',
        prefill: `/channel ${channel} allowlist add `,
      },
      {
        name: 'Show channel status',
        description: 'Connected/disconnected + last activity + sender count.',
        prefill: `/channel ${channel} status`,
      },
    ];
    if (channel === 'imessage') {
      base.push({
        name: 'Re-check permissions',
        description: 'Probe Full Disk Access + Automation → Messages.',
        prefill: `/channel imessage permissions`,
      });
      base.push({
        name: 'Import top senders',
        description: 'Read chat.db for your most-frequent contacts and offer a one-click import.',
        prefill: `/channel imessage allowlist import-top`,
      });
    }
    if (channel === 'whatsapp') {
      base.push({
        name: 'Show QR (if pairing)',
        description: 'Surface the WhatsApp QR for device linking.',
        prefill: `/channel whatsapp qr`,
      });
      base.push({
        name: 'Reset session',
        description: 'Stop WhatsApp, delete saved login, restart.',
        prefill: `/channel whatsapp reset`,
      });
    }
    return base;
  }

  // Fetch live connection state so the workbench header can show the same
  // status pill the card shows (green/connected, red/error, waiting).
  async function fetchConnection(channel) {
    try {
      const [statusRes, standaloneRes] = await Promise.all([
        fetch('/api/channels/status').then(r => r.ok ? r.json() : { statuses: [] }).catch(() => ({ statuses: [] })),
        fetch('/api/channels/standalone/status').then(r => r.ok ? r.json() : { perChannel: {} }).catch(() => ({ perChannel: {} })),
      ]);
      const status = (statusRes.statuses || []).find(s => s.channel === channel) || {};
      const mcpConnected = !!status.connected;
      const standaloneRunning = !!(standaloneRes.perChannel && standaloneRes.perChannel[channel]);
      const connected = mcpConnected || (standaloneRunning && channel !== 'whatsapp');
      const waitingForQr = channel === 'whatsapp' && standaloneRunning && !mcpConnected;
      return {
        connected,
        mcpConnected,
        standaloneRunning,
        waitingForQr,
        error: status.error || null,
        lastActivity: status.lastActivity || null,
        metadata: status.metadata || {},
      };
    } catch {
      return { connected: false, mcpConnected: false, standaloneRunning: false, waitingForQr: false };
    }
  }

  const ChannelScopeAdapter = {
    async describe(channel) {
      if (!channel) return null;
      const displayName = DISPLAY_NAMES[channel] || capitalize(channel);
      const connection = await fetchConnection(channel);

      // Empty-state renderer — the full channel card modal, inlined. Gives
      // users access to setup/tokens/allowlist without leaving the workbench.
      const mountEmptyState = (el) => {
        if (!window.ChannelsView || typeof window.ChannelsView._openModalByChannel !== 'function') {
          el.innerHTML = `<div class="sw-empty-hint">Messaging UI not loaded yet. Refresh the page.</div>`;
          return;
        }
        // Inline a "Manage channel" button that opens the full channel modal.
        // (The modal is richer than we can safely inline into a workbench
        // empty state — setup wizard, permissions probe, allowlist, QR, etc.)
        el.innerHTML = `
          <div class="sw-empty-hint" style="display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;">
            <div><strong>${esc(displayName)}</strong> workbench is ready.</div>
            <div style="color:var(--text-muted);font-size:13px;max-width:380px;">
              ${connection.connected
                ? `Ask Vodou anything about this channel, or use a tool below. Click <em>Manage</em> to tweak credentials, permissions, or allowed senders.`
                : `<strong>${esc(displayName)}</strong> is not connected yet. Click <em>Manage</em> to open setup.`}
            </div>
            <button type="button" class="btn btn-primary sw-manage-channel-btn" data-channel="${esc(channel)}">
              Manage ${esc(displayName)}
            </button>
          </div>`;
        const btn = el.querySelector('.sw-manage-channel-btn');
        if (btn) {
          btn.addEventListener('click', () => {
            window.ChannelsView._openModalByChannel(channel);
          });
        }
      };

      return {
        scopeType: 'channel',
        scopeId: channel,
        raw: `workbench:channel:${channel}`,
        displayName,
        iconHtml: buildIcon(channel),
        toolRail: toolRailFor(channel),
        mountEmptyState,
        connection,
        emptyStateHint: connection.connected
          ? `Ask Vodou about this ${displayName} channel, or pick a tool below.`
          : `${displayName} isn't connected yet. Click Manage to set it up.`,
      };
    },
  };

  if (typeof window.ScopeRegistry !== 'undefined') {
    window.ScopeRegistry.register('channel', ChannelScopeAdapter);
  } else {
    console.error('[ChannelScopeAdapter] ScopeRegistry not loaded — load ws-bus/scope-registry first');
  }
})();
