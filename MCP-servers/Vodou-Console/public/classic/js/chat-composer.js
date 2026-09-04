/**
 * ChatComposer — shared textarea + send-button composer used by both
 * ScopedWorkbench (adopted in Phase 2 of PLAN-CHAT-COMPOSER-UNIFICATION)
 * and — in Phase 3 — the main ChatView.
 *
 * Built-ins (feature-flagged via opts.features):
 *   - Auto-resize textarea (grows to opts.maxRows)
 *   - Enter-to-send / Shift+Enter-for-newline
 *   - Send button disable/enable during in-flight send
 *   - Programmatic prefill + focus helpers
 *
 * Deliberately NOT in this version (Phase 3/4 scope):
 *   - File drop, voice input, autocomplete, shortcut footer — these stay
 *     on ChatView until Phase 3 migrates the main chat.
 *
 * Usage:
 *   const composer = ChatComposer.create({
 *     mount: myContainer,
 *     placeholder: 'Message Linear…',
 *     prefill: '',
 *     onSend: async (text) => { ... },
 *     classes: { root: 'sw-composer', input: 'sw-input', send: 'sw-send' },
 *   });
 */
const ChatComposer = (() => {
  const DEFAULT_OPTS = {
    placeholder: 'Type a message…',
    prefill: '',
    rows: 1,
    maxRows: 8,
    sendLabel: 'Send',
    features: { autoResize: true, enterToSend: true },
    classes: { root: '', input: '', send: '' },
  };

  function merge(a, b) {
    const out = { ...a, ...b };
    if (b && b.features) out.features = { ...a.features, ...b.features };
    if (b && b.classes) out.classes = { ...a.classes, ...b.classes };
    return out;
  }

  function cls(base, extra) {
    return extra ? base + ' ' + extra : base;
  }

  function create(userOpts) {
    const opts = merge(DEFAULT_OPTS, userOpts || {});
    if (!opts.mount) throw new Error('ChatComposer.create: opts.mount is required');
    if (typeof opts.onSend !== 'function') throw new Error('ChatComposer.create: opts.onSend is required');

    // 1. Build DOM — mirrors the structure of the main chat composer so
    //    the same CSS (.input-wrapper, .input-actions, .chat-footer-bar)
    //    applies. Workbench passes its own `actions` array + shortcut list.
    const root = document.createElement('div');
    root.className = cls('chat-composer', opts.classes.root);

    // Row: [textarea wrapper] [action buttons]
    const row = document.createElement('div');
    row.className = 'input-wrapper';

    const input = document.createElement('textarea');
    input.className = cls('chat-composer__input', opts.classes.input);
    input.rows = opts.rows;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.prefill) input.value = opts.prefill;

    row.appendChild(input);

    // Action-button group — includes extra buttons + the Send button last
    const actions = document.createElement('div');
    actions.className = 'input-actions';

    // Caller-provided icon buttons (voice, autocomplete toggle, clear, etc.)
    if (Array.isArray(opts.actions)) {
      for (const a of opts.actions) {
        if (!a) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        if (a.className) btn.className = a.className;
        if (a.title) btn.title = a.title;
        if (a.id) btn.id = a.id;
        btn.innerHTML = a.html || a.svg || a.label || '';
        if (typeof a.onClick === 'function') btn.addEventListener('click', a.onClick);
        if (typeof a.init === 'function') a.init(btn);
        actions.appendChild(btn);
      }
    }

    const send = document.createElement('button');
    send.type = 'button';
    send.className = cls('chat-composer__send', opts.classes.send);
    send.title = 'Send';
    send.innerHTML = opts.sendIconHtml
      || '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    actions.appendChild(send);

    row.appendChild(actions);
    root.appendChild(row);

    // Optional shortcut-footer bar (kbd chips that prefill the input)
    if (Array.isArray(opts.shortcuts) && opts.shortcuts.length) {
      const footer = document.createElement('div');
      footer.className = 'chat-footer-bar';
      const shortcuts = document.createElement('span');
      shortcuts.className = 'chat-shortcuts';
      for (const s of opts.shortcuts) {
        const kbd = document.createElement('kbd');
        kbd.textContent = s.label;
        if (s.prefill !== undefined) {
          kbd.style.cursor = 'pointer';
          kbd.addEventListener('mousedown', (e) => e.preventDefault());
          kbd.addEventListener('click', (e) => {
            e.stopPropagation();
            input.value = s.prefill + (s.prefill.endsWith(' ') ? '' : ' ');
            input.focus();
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
        }
        shortcuts.appendChild(kbd);
        shortcuts.appendChild(document.createTextNode(' '));
      }
      footer.appendChild(shortcuts);
      root.appendChild(footer);
    }

    opts.mount.appendChild(root);

    // 2. Auto-resize
    function autoResize() {
      if (!opts.features.autoResize) return;
      const lines = Math.max(1, input.value.split('\n').length);
      input.rows = Math.min(opts.maxRows, lines + (lines === 1 ? 0 : 1));
    }
    input.addEventListener('input', autoResize);

    // 3. Send logic — shared by button click + Enter key
    let inFlight = false;
    async function doSend() {
      if (inFlight) return;
      const text = input.value.trim();
      if (!text) return;
      inFlight = true;
      send.disabled = true;
      input.value = '';
      autoResize();
      // Fire input event so autocomplete's hide-on-empty logic runs and the
      // suggestion popup closes after the prompt is submitted.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      try {
        await opts.onSend(text);
      } finally {
        inFlight = false;
        send.disabled = false;
      }
    }

    send.addEventListener('click', doSend);

    if (opts.features.enterToSend) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });
    }

    // 4. Initial focus/prefill cursor
    if (opts.prefill) {
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
      // Defer the input event so listeners attached AFTER create() returns
      // (e.g. ChatAutocomplete.attach) can react to the prefill — opens
      // the suggestion popup automatically when a workbench prefills
      // `/server <name> ` so the user immediately sees tools to pick from.
      setTimeout(() => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, 0);
    }

    // 5. Public API
    return {
      root,
      input,
      sendButton: send,
      getValue: () => input.value,
      setValue: (text) => {
        input.value = text || '';
        autoResize();
        // Fire input event so listeners (e.g. ChatAutocomplete) react to
        // programmatic prefill — without this the suggestion popup never
        // opens after a workbench prefill like `/server <name> `.
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      focus: () => input.focus(),
      disable: () => { send.disabled = true; input.disabled = true; },
      enable: () => { send.disabled = false; input.disabled = false; },
      send: doSend,
      destroy: () => {
        send.removeEventListener('click', doSend);
        if (root.parentElement) root.parentElement.removeChild(root);
      },
    };
  }

  /**
   * Adopt an EXISTING textarea + send button (declared in HTML) and wire
   * auto-resize + Enter-to-send + click-to-send onto them. Unlike create(),
   * this does NOT create any DOM, clear the input, or disable the button.
   * The caller owns input state; this just wires input events.
   *
   * Used by main ChatView (Phase 3) because its textarea is hard-coded in
   * index.html and referenced from many places (voice, autocomplete, file
   * preview, etc.) that all rely on `document.getElementById('chat-input')`.
   *
   * @param {Object} opts
   * @param {HTMLTextAreaElement} opts.input — existing textarea
   * @param {HTMLButtonElement} [opts.send] — existing send button (optional;
   *                                          if omitted, no click handler)
   * @param {() => void | Promise<void>} opts.onSend — invoked on Enter
   *                                                   or send click. The
   *                                                   caller reads the
   *                                                   value from opts.input
   *                                                   itself.
   * @param {() => boolean} [opts.shouldSend] — return false to suppress
   *                                            this send attempt (e.g.
   *                                            autocomplete is active)
   * @param {Object} [opts.features]
   * @param {boolean} [opts.features.autoResize=true]
   * @param {boolean} [opts.features.enterToSend=true]
   * @param {number} [opts.maxRows=8]
   * @returns {{ autoResize: () => void, destroy: () => void }}
   */
  function adopt(opts) {
    if (!opts || !opts.input) throw new Error('ChatComposer.adopt: opts.input is required');
    if (typeof opts.onSend !== 'function') throw new Error('ChatComposer.adopt: opts.onSend is required');

    const features = { autoResize: true, enterToSend: true, ...(opts.features || {}) };
    const maxRows = opts.maxRows || 8;
    const input = opts.input;
    const send = opts.send || null;

    function autoResize() {
      if (!features.autoResize) return;
      const lines = Math.max(1, input.value.split('\n').length);
      input.rows = Math.min(maxRows, lines + (lines === 1 ? 0 : 1));
    }

    function onInput() { autoResize(); }
    function onKeydown(e) {
      if (!features.enterToSend) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (typeof opts.shouldSend === 'function' && opts.shouldSend() === false) return;
      e.preventDefault();
      opts.onSend();
    }
    function onSendClick() { opts.onSend(); }

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown);
    if (send) send.addEventListener('click', onSendClick);

    return {
      autoResize,
      destroy: () => {
        input.removeEventListener('input', onInput);
        input.removeEventListener('keydown', onKeydown);
        if (send) send.removeEventListener('click', onSendClick);
      },
    };
  }

  return { create, adopt };
})();

if (typeof window !== 'undefined') window.ChatComposer = ChatComposer;
