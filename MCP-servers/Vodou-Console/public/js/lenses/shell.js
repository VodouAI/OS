/**
 * Cards framework — frontend shell.
 *
 * Defines window.LensShell — the shared DOM frame every card renders inside.
 * Loaded by index.html before chat.js. chat.js calls LensShell.mountSlot()
 * for each ```card``` fenced block detected during streaming.
 *
 * Lifecycle:
 *   chat.js renderMarkdown() → replaces ```card``` blocks with placeholder divs
 *   chat.js endStreaming() → walks .lens-pending, calls LensShell.mount(...)
 *   shell POSTs /api/lenses/fetch, mounts skeleton → render → error UI as needed
 */
(function () {
  'use strict';

  const esc = (window.VodouSafe && window.VodouSafe.escapeHtml) || (function () {
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ESC[ch]);
  })();

  function makeShell({ manifest, sourceUrl, sourceDomain }) {
    const wrap = document.createElement('div');
    wrap.className = 'vodou-lens';
    wrap.dataset.cardType = manifest?.type || '';
    wrap.innerHTML = `
      <div class="vodou-lens-header">
        <span class="vodou-lens-icon">${esc(manifest?.icon || '🎴')}</span>
        <span class="vodou-lens-title"></span>
        <span class="vodou-lens-source">${esc(sourceDomain || '')}</span>
        <div class="vodou-lens-actions">
          <button class="vodou-lens-btn vodou-lens-refresh" title="Refresh">⟳</button>
          ${sourceUrl ? `<a class="vodou-lens-btn vodou-lens-open" href="${esc(sourceUrl)}" target="_blank" rel="noopener" title="Open in new tab">↗</a>` : ''}
        </div>
      </div>
      <div class="vodou-lens-body"></div>
      <div class="vodou-lens-footer"></div>
    `;
    return wrap;
  }

  function setTitle(shell, title) {
    const el = shell.querySelector('.vodou-lens-title');
    if (el) el.textContent = title || '';
  }

  function setBody(shell, contentEl) {
    const body = shell.querySelector('.vodou-lens-body');
    if (!body) return;
    body.innerHTML = '';
    if (typeof contentEl === 'string') {
      body.innerHTML = contentEl;
    } else if (contentEl instanceof Node) {
      body.appendChild(contentEl);
    }
  }

  function setFooter(shell, text) {
    const foot = shell.querySelector('.vodou-lens-footer');
    if (foot) foot.textContent = text || '';
  }

  function showError(shell, message, fallbackText) {
    setBody(shell, `
      <div class="vodou-lens-error">
        <span class="vodou-lens-error-icon">⚠</span>
        <span class="vodou-lens-error-msg">${esc(message || 'Card failed to load')}</span>
        <button class="vodou-lens-btn vodou-lens-retry">Retry</button>
      </div>
      ${fallbackText ? `<div class="vodou-lens-fallback">${esc(fallbackText)}</div>` : ''}
    `);
  }

  /**
   * Bridge-install card. Shown when the gateway returns code=BRIDGE_REQUIRED —
   * either the Vodou Bridge Chrome extension isn't installed, or it was once
   * connected but the MV3 service worker suspended (just clicking the Vodou
   * toolbar icon wakes it). Lays out install steps prominently so the user
   * isn't left guessing what "fetch failed" meant.
   */
  function showBridgeRequired(shell, message, detail, fallbackText) {
    const everConnected = !!(detail && detail.ever_connected);
    const heading = everConnected ? 'Bridge is sleeping' : 'Vodou Bridge required';
    const steps = everConnected
      ? `
        <ol class="vodou-lens-bridge-steps">
          <li>Click the <strong>Vodou</strong> icon in your Chrome toolbar.</li>
          <li>Give it a couple of seconds to reconnect.</li>
          <li>Hit <em>Retry</em> below.</li>
        </ol>`
      : `
        <ol class="vodou-lens-bridge-steps">
          <li>Open <code>chrome://extensions</code> in a new tab.</li>
          <li>Toggle <strong>Developer mode</strong> on (top right).</li>
          <li>Click <strong>Load unpacked</strong> and select the folder:
            <code>extension/vodou-bridge</code> inside your Vodou install dir.</li>
          <li>Pin the Vodou icon to your toolbar.</li>
          <li>Hit <em>Retry</em> below.</li>
        </ol>`;
    setBody(shell, `
      <div class="vodou-lens-bridge-required">
        <div class="vodou-lens-bridge-head">
          <span class="vodou-lens-bridge-icon">🌉</span>
          <strong>${esc(heading)}</strong>
        </div>
        <p class="vodou-lens-bridge-msg">${esc(message || 'This card needs the Vodou Browser Bridge.')}</p>
        ${steps}
        <div class="vodou-lens-bridge-actions">
          <button class="vodou-lens-btn vodou-lens-retry">Retry</button>
        </div>
      </div>
      ${fallbackText ? `<div class="vodou-lens-fallback">${esc(fallbackText)}</div>` : ''}
    `);
  }

  function showSkeleton(shell) {
    setBody(shell, `<div class="vodou-lens-skeleton"><div class="vodou-lens-skel-bar"></div><div class="vodou-lens-skel-bar"></div><div class="vodou-lens-skel-bar short"></div></div>`);
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }

  /**
   * mountSlot(placeholderEl, { type, source_url, payload })
   *
   * Replaces placeholderEl with a shell, fires the fetch, renders the
   * result via the type-specific renderer in window.LensRenderers, or
   * falls back to the placeholder's text content on failure.
   */
  async function mountSlot(placeholderEl, blockJson, fallbackText) {
    const { type, source_url = '', payload = {} } = blockJson || {};

    // Best-effort manifest from /api/lenses/manifests cache for icon/title
    const manifest = await ensureManifest(type);
    const sourceDomain = domainOf(source_url);

    const shell = makeShell({ manifest, sourceUrl: source_url, sourceDomain });
    placeholderEl.replaceWith(shell);

    // Refresh handler
    shell.querySelector('.vodou-lens-refresh')?.addEventListener('click', () => {
      fetchAndRender(shell, type, source_url, payload, fallbackText, { force: true });
    });

    fetchAndRender(shell, type, source_url, payload, fallbackText);
  }

  async function fetchAndRender(shell, type, source_url, payload, fallbackText, opts = {}) {
    showSkeleton(shell);
    try {
      const res = await fetch('/api/lenses/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, source_url, payload }),
      });
      const json = await res.json();
      if (!json.ok) {
        if (json.error?.code === 'BRIDGE_REQUIRED') {
          showBridgeRequired(shell, json.error.message, json.error.detail, fallbackText);
        } else {
          showError(shell, json.error?.message || 'fetch failed', fallbackText);
        }
        return;
      }
      const data = json.data || {};
      const renderer = (window.LensRenderers && window.LensRenderers[type]) || window.LensRenderers?.['_default'];
      if (!renderer) {
        showError(shell, `no renderer for "${type}"`, fallbackText);
        return;
      }
      const ctx = {
        sourceUrl: source_url,
        manifest: data.manifest,
        cache: data.cache,
        health: data.health,
        runAction: (actionId, opts2) => runAction(type, actionId, source_url, payload, data.render_model, opts2),
      };
      const out = renderer(data.render_model || {}, ctx);
      if (out && (out.title || out.titleText)) setTitle(shell, out.title || out.titleText || '');
      setBody(shell, out?.body || out?.bodyHtml || out);
      const cacheNote = data.cache?.hit ? `cached ${formatAge(data.cache.age_ms)} ago` : '';
      const healthNote = data.health?.ok === false ? ' · ⚠ some fields missing' : '';
      setFooter(shell, [domainOf(source_url), cacheNote].filter(Boolean).join(' · ') + healthNote);
    } catch (err) {
      console.error('[cards] fetch failed', err);
      showError(shell, err?.message || 'network error', fallbackText);
    }
  }

  async function runAction(type, actionId, source_url, payload, render_model, opts) {
    try {
      const res = await fetch('/api/lenses/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type, action_id: actionId, source_url, payload, render_model,
          consent_granted: !!opts?.consent_granted,
          conversation_id: window.ChatView?.currentConversationId || '',
        }),
      });
      return await res.json();
    } catch (err) {
      return { ok: false, error: { code: 'NETWORK', message: err?.message || 'network error' } };
    }
  }

  function formatAge(ms) {
    if (ms < 1000) return 'just now';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    return Math.round(ms / 3600000) + 'h';
  }

  // -------- Manifest cache (so the shell knows icon+motive before fetch) --------
  let manifestsByType = null;
  let manifestsPromise = null;

  async function ensureManifest(type) {
    if (manifestsByType && manifestsByType[type]) return manifestsByType[type];
    if (!manifestsPromise) {
      manifestsPromise = fetch('/api/lenses/manifests').then(r => r.json()).then(j => {
        manifestsByType = {};
        for (const m of (j.data || [])) manifestsByType[m.type] = m;
        return manifestsByType;
      }).catch(() => ({}));
    }
    const m = await manifestsPromise;
    return m[type] || { type };
  }

  // -------- Consent dialog (used by renderers for action buttons) --------
  function confirmConsent({ cardLabel, actionLabel, domain }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'vodou-lens-consent-overlay';
      overlay.innerHTML = `
        <div class="vodou-lens-consent-dialog">
          <h3>Allow Vodou to act in your browser?</h3>
          <p>The <strong>${esc(cardLabel || 'card')}</strong> wants to perform: <strong>${esc(actionLabel)}</strong></p>
          <p class="vodou-lens-consent-domain">Domain: <code>${esc(domain)}</code></p>
          <p class="vodou-lens-consent-note">This will run in your real browser tab using your real session. You can revoke this anytime.</p>
          <div class="vodou-lens-consent-actions">
            <button class="vodou-btn vodou-btn-secondary" data-act="cancel">Cancel</button>
            <button class="vodou-btn vodou-btn-primary" data-act="allow">Allow</button>
          </div>
        </div>
      `;
      overlay.addEventListener('click', (e) => {
        const t = e.target;
        if (t === overlay) { document.body.removeChild(overlay); resolve(false); return; }
        const act = t.dataset?.act;
        if (act === 'allow') { document.body.removeChild(overlay); resolve(true); }
        if (act === 'cancel') { document.body.removeChild(overlay); resolve(false); }
      });
      document.body.appendChild(overlay);
    });
  }

  window.LensShell = {
    mountSlot,
    confirmConsent,
    esc,
    domainOf,
  };
})();
