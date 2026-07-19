/**
 * ChatHelpers — shared primitives for chat UI used by both ChatView
 * (main `#/chat`) and ScopedWorkbench. Extracted in Phase 1 of
 * PLAN-CHAT-COMPOSER-UNIFICATION so both surfaces produce identical
 * DOM and share the same CSS hooks (`.inline-tool-strip`,
 * `.inline-tool-chip`, `.tool-name`, `.tool-elapsed`, `.done`).
 *
 * Load order: this file must load BEFORE scoped-workbench.js and
 * views/chat.js so both can reference `ChatHelpers` at runtime.
 */
const ChatHelpers = (() => {
  /**
   * Get or create the `.inline-tool-strip` inside a message body element.
   *
   * @param {HTMLElement} msgBody  — the `.msg-body` container
   * @param {HTMLElement} [beforeEl] — insert strip before this element
   *                                   (typically `.msg-content`). If omitted
   *                                   or not a child of msgBody, appends.
   * @returns {HTMLElement} the strip element
   */
  function getOrCreateToolStrip(msgBody, beforeEl) {
    let strip = msgBody.querySelector('.inline-tool-strip');
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'inline-tool-strip';
      if (beforeEl && beforeEl.parentElement === msgBody) {
        msgBody.insertBefore(strip, beforeEl);
      } else {
        msgBody.appendChild(strip);
      }
    }
    return strip;
  }

  /**
   * Create an inline tool-chip DOM: name span + elapsed-time span.
   * Does NOT attach a live timer — call startChipTimer() for that.
   *
   * @param {string} toolName
   * @param {string} toolKey — unique key used for later lookup
   * @returns {{chip: HTMLElement, nameEl: HTMLElement, elapsedEl: HTMLElement}}
   */
  function createToolChip(toolName, toolKey) {
    const chip = document.createElement('span');
    chip.className = 'inline-tool-chip';
    chip.dataset.toolKey = toolKey;

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = toolName;
    chip.appendChild(nameEl);

    const elapsedEl = document.createElement('span');
    elapsedEl.className = 'tool-elapsed';
    chip.appendChild(elapsedEl);

    return { chip, nameEl, elapsedEl };
  }

  /**
   * Start a live elapsed-time counter on a chip. Text updates every 100ms.
   * Auto-stops when the chip is removed from the DOM or marked finished.
   *
   * @param {HTMLElement} chip — chip returned from createToolChip
   * @returns {number|null} interval id (also stored on `chip._elapsedTimer`)
   */
  function startChipTimer(chip) {
    const elapsedEl = chip.querySelector('.tool-elapsed');
    if (!elapsedEl) return null;
    const startTime = Date.now();
    chip._startTime = startTime;
    const timerId = setInterval(() => {
      if (!chip.isConnected || chip.classList.contains('done')) {
        clearInterval(timerId);
        chip._elapsedTimer = null;
        return;
      }
      const secs = ((Date.now() - startTime) / 1000).toFixed(1);
      elapsedEl.textContent = ' ' + secs + 's';
    }, 100);
    chip._elapsedTimer = timerId;
    return timerId;
  }

  /**
   * Mark a chip finished: adds `.done`, stops timer, writes final time.
   *
   * @param {HTMLElement} chip
   * @param {number} [executionTimeMs] — server-reported time; falls back to
   *                                     client-side elapsed when omitted
   */
  function stopChipTimer(chip, executionTimeMs) {
    if (!chip) return;
    chip.classList.add('done');
    if (chip._elapsedTimer) {
      clearInterval(chip._elapsedTimer);
      chip._elapsedTimer = null;
    }
    const elapsedEl = chip.querySelector('.tool-elapsed');
    if (!elapsedEl) return;
    let ms = executionTimeMs;
    if (ms == null && chip._startTime) ms = Date.now() - chip._startTime;
    if (ms == null) return;
    elapsedEl.textContent = ms >= 1000
      ? ' ' + (ms / 1000).toFixed(1) + 's'
      : ' ' + Math.round(ms) + 'ms';
  }

  /**
   * Find a chip by tool key within a given scope root.
   *
   * @param {HTMLElement|Document} root — scope to search (e.g. a workbench
   *                                      root or `document` for main chat)
   * @param {string} toolKey
   * @returns {HTMLElement|null}
   */
  function findChipByKey(root, toolKey) {
    if (!toolKey) return null;
    const esc = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(toolKey)
      : String(toolKey).replace(/"/g, '\\"');
    return (root || document).querySelector('.inline-tool-chip[data-tool-key="' + esc + '"]');
  }

  /**
   * Escape HTML — used by renderToolDetail. Defers to ChatView.escapeHtml
   * when available so both chats produce identical output.
   */
  function _escHtml(s) {
    if (typeof ChatView !== 'undefined' && typeof ChatView.escapeHtml === 'function') {
      return ChatView.escapeHtml(s);
    }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Render the expand-panel HTML for a tool's data payload. Same row layout
   * as main chat's `_toggleToolDetail`: Server → Command/Parameters →
   * Image previews → Output → Time → Status.
   *
   * @param {Object} data — toolData entry { tool, server, args, result,
   *                        executionTime, success }
   * @returns {string} HTML (caller assigns to detailEl.innerHTML)
   */
  function renderToolDetail(data) {
    if (!data) return '';
    const cv = (typeof ChatView !== 'undefined') ? ChatView : null;
    let html = '';

    if (data.server) {
      html += '<div class="tool-detail-row"><div class="tool-detail-label">Server</div><div class="tool-detail-value">' + _escHtml(data.server) + '</div></div>';
    }
    if (data.args) {
      const command = data.args.command || data.args.input;
      if (command) {
        html += '<div class="tool-detail-row"><div class="tool-detail-label">Command</div><div class="tool-detail-value"><pre class="tool-detail-pre">' + _escHtml(String(command)) + '</pre></div></div>';
      } else {
        html += '<div class="tool-detail-row"><div class="tool-detail-label">Parameters</div><div class="tool-detail-value"><pre class="tool-detail-pre">' + _escHtml(JSON.stringify(data.args, null, 2)) + '</pre></div></div>';
      }
    }
    if (data.result !== undefined && data.result !== null && data.result !== '') {
      const resultText = String(data.result);
      // Inline images — use ChatView's extractor when available so the same
      // URL patterns work; skip otherwise (rare).
      if (cv && typeof cv._extractRenderableImages === 'function') {
        const imgs = cv._extractRenderableImages(resultText);
        const escAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        for (const im of imgs.slice(0, 6)) {
          if (im.type === 'http') {
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' + escAttr(im.url) + '" referrerpolicy="no-referrer" loading="lazy" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
          } else if (im.type === 'local') {
            const src = '/api/files?path=' + encodeURIComponent(im.path);
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' + escAttr(src) + '" loading="lazy" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
          } else {
            html += '<div class="tool-detail-row"><div class="tool-detail-label">Image</div><div class="tool-detail-value"><img class="chat-image" src="' + escAttr(im.data) + '" onclick="ChatView._openLightbox(this.src)" alt="" /></div></div>';
          }
        }
      }
      // Smart render if available; otherwise truncated pre
      const smart = typeof SmartRender !== 'undefined'
        ? SmartRender.render(resultText, data.tool, data.server)
        : { html: '', isRich: false };
      if (smart.isRich) {
        html += '<div class="tool-detail-row"><div class="tool-detail-label">Output</div><div class="tool-detail-value">' + smart.html + '</div></div>';
      } else {
        const truncated = resultText.length > 2000 ? resultText.substring(0, 2000) + '\n... (truncated)' : resultText;
        html += '<div class="tool-detail-row"><div class="tool-detail-label">Output</div><div class="tool-detail-value"><pre class="tool-detail-pre tool-detail-pre-lg">' + _escHtml(truncated) + '</pre></div></div>';
      }
    }
    if (data.executionTime !== undefined) {
      html += '<div class="tool-detail-row"><div class="tool-detail-label">Time</div><div class="tool-detail-value">' + data.executionTime + 'ms</div></div>';
    }
    if (data.success !== undefined) {
      const cls = data.success ? 'success' : 'error';
      html += '<div class="tool-detail-row"><div class="tool-detail-status ' + cls + '">' + (data.success ? 'Success' : 'Failed') + '</div></div>';
    }
    return html;
  }

  /**
   * Wrap a tool chip so clicking it toggles an expandable detail panel
   * below — exactly like main chat's `.inline-tool-wrap` + `.tool-detail`
   * structure. The returned wrap element should be appended to the strip
   * instead of the bare chip.
   *
   * @param {HTMLElement} chip
   * @param {string} toolKey
   * @param {() => Object} getData — called at expand time; should return
   *                                 the current toolData entry
   * @param {HTMLElement} [scopeRoot] — clicking one chip collapses others
   *                                    within this scope (defaults to
   *                                    document)
   * @returns {HTMLElement} the `.inline-tool-wrap` span containing chip + detail
   */
  function wrapChipForExpand(chip, toolKey, getData, scopeRoot) {
    const detail = document.createElement('div');
    detail.className = 'tool-detail';
    detail.dataset.toolKey = toolKey;

    const wrap = document.createElement('span');
    wrap.className = 'inline-tool-wrap';
    wrap.appendChild(chip);
    wrap.appendChild(detail);

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasExpanded = chip.classList.contains('expanded');
      const scope = scopeRoot || document;
      scope.querySelectorAll('.inline-tool-chip.expanded, .tool-chip.expanded').forEach((c) => c.classList.remove('expanded'));
      if (!wasExpanded) {
        chip.classList.add('expanded');
        const data = (typeof getData === 'function') ? getData() : null;
        detail.innerHTML = renderToolDetail(data);
      }
    });

    return wrap;
  }

  return {
    getOrCreateToolStrip,
    createToolChip,
    startChipTimer,
    stopChipTimer,
    findChipByKey,
    renderToolDetail,
    wrapChipForExpand,
  };
})();

if (typeof window !== 'undefined') window.ChatHelpers = ChatHelpers;
