// Vodou Bridge — in-page capture button + netcap relay (PLAN-UNIVERSAL-MEMORY).
// Injected on every supported AI-chat host. Two independent jobs:
//   1. The floating "Save to Vodou" button — ONLY on chatgpt.com / claude.ai,
//      where the gateway's trigger_capture import path has an extractor.
//   2. The netcap relay (bottom of file) — on ALL hosts; forwards turns that
//      inject.js teed from the page's own network traffic (opt-in toggle).
// The page itself never talks to the gateway (a chatgpt.com origin would be
// CSRF-blocked); it only messages our own extension.

(function () {
  if (window.__vodouCaptureButtonMounted) return;
  window.__vodouCaptureButtonMounted = true;

  // Hosts where the one-click full-conversation import works today.
  const BUTTON_HOSTS = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)claude\.ai$/;
  mountContextButton(); // PLAN-MEMORY-FOLLOWS-YOU — 🧠 context on ALL hosts
  if (!BUTTON_HOSTS.test(location.hostname)) { mountRelayOnly(); return; }

  const btn = document.createElement('button');
  btn.id = 'vodou-capture-btn';
  btn.type = 'button';
  btn.textContent = '🧠 Save to Vodou';
  btn.setAttribute('aria-label', 'Import this chat into Vodou memory');
  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '18px',
    right: '18px',
    zIndex: '2147483647',
    padding: '8px 12px',
    fontSize: '12px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#fff',
    background: '#16a34a',
    border: '0',
    borderRadius: '999px',
    boxShadow: '0 2px 10px rgba(0,0,0,.35)',
    cursor: 'pointer',
    opacity: '0.9',
  });
  btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
  btn.addEventListener('mouseleave', () => (btn.style.opacity = '0.9'));

  function flash(text, good) {
    btn.textContent = text;
    btn.style.background = good === true ? '#15803d' : good === false ? '#b91c1c' : '#16a34a';
    if (good !== undefined) {
      setTimeout(() => {
        btn.textContent = '🧠 Save to Vodou';
        btn.style.background = '#16a34a';
        btn.disabled = false;
      }, 3200);
    }
  }

  btn.addEventListener('click', () => {
    btn.disabled = true;
    flash('Saving…');
    try {
      chrome.runtime.sendMessage(
        { type: 'trigger_capture', url: location.href, extract: 'background' },
        (resp) => {
          if (chrome.runtime.lastError) { flash('✗ ' + chrome.runtime.lastError.message.slice(0, 40), false); return; }
          if (resp && resp.ok) {
            const r = resp.result || {};
            flash(`✓ Saved${r.messages != null ? ' (' + r.messages + ' msgs)' : ''}`, true);
          } else {
            flash('✗ ' + ((resp && resp.error) || 'failed').slice(0, 40), false);
          }
        },
      );
    } catch (e) {
      flash('✗ ' + String(e && e.message).slice(0, 40), false);
    }
  });

  const mount = () => { if (document.body && !document.getElementById('vodou-capture-btn')) document.body.appendChild(btn); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
  // SPA route changes (chatgpt/claude are SPAs) can wipe the body subtree — re-mount.
  setInterval(mount, 3000);

  mountRelayOnly();

  // ── PLAN-MEMORY-FOLLOWS-YOU: 🧠 context button ─────────────────────────────
  // Fetches a vault-scoped context block from the local gateway and inserts it
  // into the site's composer. Three-tier insertion: (1) the focused/likely
  // composer via execCommand insertText (works for textarea AND contenteditable
  // in Chrome), (2) native value setter for stubborn textareas, (3) clipboard +
  // toast — the fallback that can never break on a DOM change. Alt+V shortcut.
  function mountContextButton() {
    if (window.__vodouContextButtonMounted) return;
    window.__vodouContextButtonMounted = true;

    const cbtn = document.createElement('button');
    cbtn.id = 'vodou-context-btn';
    cbtn.type = 'button';
    cbtn.textContent = '🧠 My context';
    cbtn.setAttribute('aria-label', 'Insert relevant Vodou memory into the composer (Alt+V)');
    cbtn.title = 'Insert relevant Vodou memory (Alt+V)';
    Object.assign(cbtn.style, {
      position: 'fixed',
      bottom: '58px',
      right: '18px',
      zIndex: '2147483647',
      padding: '8px 12px',
      fontSize: '12px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      color: '#fff',
      background: '#7c3aed',
      border: '0',
      borderRadius: '999px',
      boxShadow: '0 2px 10px rgba(0,0,0,.35)',
      cursor: 'pointer',
      opacity: '0.9',
    });
    cbtn.addEventListener('mouseenter', () => (cbtn.style.opacity = '1'));
    cbtn.addEventListener('mouseleave', () => (cbtn.style.opacity = '0.9'));

    function toast(text, ok) {
      const t = document.createElement('div');
      t.textContent = text;
      Object.assign(t.style, {
        position: 'fixed', bottom: '100px', right: '18px', zIndex: '2147483647',
        padding: '8px 12px', fontSize: '12px', borderRadius: '8px', color: '#fff',
        background: ok === false ? '#b91c1c' : '#1f2937',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        boxShadow: '0 2px 10px rgba(0,0,0,.35)', maxWidth: '340px',
      });
      document.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 4000);
    }

    // Find the site's composer. Site-specific selectors first (a ProseMirror /
    // Lexical root survives DOM churn better than geometry and is the RIGHT
    // element to feed the editor's own input pipeline), then the focused
    // editable, then the visible editable nearest the bottom of the viewport.
    const COMPOSER_SELECTORS = [
      'div.ProseMirror[contenteditable="true"]',        // Claude
      '#prompt-textarea',                                // ChatGPT (contenteditable or textarea)
      'textarea[data-testid="chat-input"]',              // ChatGPT (older)
      'div[contenteditable="true"][role="textbox"]',     // generic rich composer
    ];
    // A composer is a sizable textarea or contenteditable — NOT a plain <input>
    // (those are search/title fields; inserting a paragraph there is the
    // "landed in an edit box" bug 2026-07-16).
    function isComposerish(el) {
      if (!el || !(el.tagName === 'TEXTAREA' || el.isContentEditable)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 18;
    }
    function findComposer() {
      // 1) The element the user is TYPING IN wins — when they hit the hotkey,
      //    focus is in the prompt box they just typed the question into. This
      //    fixes both the wrong-target insert AND the empty-seed retrieval
      //    (the seed is read from this same element).
      const ae = document.activeElement;
      if (isComposerish(ae)) return ae;
      // 2) Known composer selectors.
      for (const sel of COMPOSER_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null && isComposerish(el)) return el;
      }
      // 3) Geometry: largest visible editable nearest the bottom of the viewport.
      const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.height > 20 && r.top > 0 && r.top < window.innerHeight;
        });
      candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return candidates[0] || null;
    }

    function editorText(el) {
      if (!el) return '';
      return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
    }
    function draftText(el) {
      return editorText(el).trim().slice(0, 300);
    }

    // Insert `text` at the START of the composer. Returns synchronously with the
    // best signal we have; because Lexical (ChatGPT) / ProseMirror (Claude) apply
    // programmatic edits ASYNCHRONOUSLY, a strategy can succeed even when the
    // immediate `changed()` check is still false — so the caller re-verifies
    // after a tick (insertTextVerified) and only then decides success vs
    // clipboard fallback. Always logs each strategy so a live failure is
    // diagnosable in one test (console: [vodou-inject]).
    const DIAG = () => { try { return localStorage.getItem('vodouInjectDebug') !== '0'; } catch (_) { return true; } };
    function elDesc(el) {
      if (!el) return 'null';
      return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${el.isContentEditable ? ' [contenteditable]' : ''}>`;
    }
    function insertText(el, text) {
      if (!el) { if (DIAG()) console.log('[vodou-inject] no composer element found'); return false; }
      const before = editorText(el);
      const changed = () => editorText(el) !== before;
      if (DIAG()) console.log('[vodou-inject] target composer:', elDesc(el), '| before len', before.length);
      try { el.focus(); } catch (_) { /* ignore */ }
      // Put the caret at the very start so context prepends the user's draft.
      try {
        const sel = window.getSelection();
        if (sel && el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else if (el.setSelectionRange) {
          el.setSelectionRange(0, 0);
        }
      } catch (_) { /* ignore */ }
      let attempted = false;
      // 1) execCommand — works for textareas and simple contenteditables.
      try {
        const r = document.execCommand('insertText', false, text);
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 1 execCommand →', r, '| changed', changed());
        if (r && changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 1 execCommand threw', e && e.message); }
      // 2) native value setter (React-controlled textarea/input, e.g. old ChatGPT).
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        try {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
          const next = text + (el.value || '');
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          attempted = true;
          if (DIAG()) console.log('[vodou-inject] 2 value-setter | changed', changed());
          if (changed()) return true;
        } catch (e) { if (DIAG()) console.log('[vodou-inject] 2 value-setter threw', e && e.message); }
      }
      // 3) beforeinput InputEvent — ProseMirror (Claude) / Lexical apply from
      //    their own handler (often async — see verified re-check).
      try {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 3 beforeinput | changed(sync)', changed());
        if (changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 3 beforeinput threw', e && e.message); }
      // 4) synthetic paste with a DataTransfer.
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        attempted = true;
        if (DIAG()) console.log('[vodou-inject] 4 paste | changed(sync)', changed());
        if (changed()) return true;
      } catch (e) { if (DIAG()) console.log('[vodou-inject] 4 paste threw', e && e.message); }
      // No SYNCHRONOUS change — but an async editor may still apply it. Signal
      // "attempted" so the caller re-checks after a tick before falling back.
      return attempted ? 'async' : false;
    }

    // Wrap insertText with an async re-verification: rich editors apply the edit
    // on a later tick, so we confirm the composer actually changed before
    // reporting success. cb(true) = text is in the composer; cb(false) = truly
    // failed (caller does clipboard fallback).
    function insertTextVerified(el, text, cb) {
      const before = editorText(el);
      const r = insertText(el, text);
      if (r === true) { cb(true); return; }
      if (r === false) { cb(false); return; }
      // 'async' — re-read shortly; the editor's own handler may have applied it.
      setTimeout(() => {
        const ok = editorText(el) !== before;
        if (DIAG()) console.log('[vodou-inject] async re-check →', ok ? 'LANDED' : 'still empty');
        cb(ok);
      }, 60);
    }

    // Insert an assembled block via the three-tier strategy (composer →
    // native setter → clipboard). Shared by the picker and the legacy path.
    function deliverBlock(block, vault, count) {
      const target = findComposer();
      if (target && insertText(target, block)) {
        toast(`✓ Inserted ${count} memories (vault: ${vault})`, true);
        return;
      }
      navigator.clipboard.writeText(block).then(
        () => toast(`✓ Context copied (vault: ${vault}) — paste it into the composer`, true),
        () => toast('✗ could not insert or copy — select the composer and retry', false),
      );
    }

    // ── Memory picker v2 ────────────────────────────────────────────────────
    // Searches your ENTIRE memory (not just the portable vault), seeded from
    // what you're actually discussing in the chat, and shows relevance/tag/age/
    // source chips. Items outside the shared vault are marked 🔒 private and
    // require an explicit tick. Nothing is disclosed until you choose it; the
    // block's fence parts come from the gateway so the format has one producer.

    // Query seed: what you're talking about. Prefer the composer draft; else the
    // tail of the visible conversation; else the tab title. Best-effort — the
    // search box lets you refine regardless, and selectors are wrapped so a UI
    // change on the host site can't throw.
    // Query seed precedence: composer draft (clearest intent) > the visible
    // conversation tail (fresh, rich — matches lots of memory) > '' which lets
    // the GATEWAY seed from captured turns (A1 fallback, for when the DOM scrape
    // finds nothing because the host reshipped its selectors). The scrape is
    // primary again because it doesn't depend on the conversation being captured
    // — an uncaptured/fresh chat has no server turns to seed from.
    function chatContextQuery(composer) {
      const draft = draftText(composer || findComposer());
      if (draft && draft.length > 3) return draft.slice(0, 500);
      try {
        const sel = [
          '[data-message-author-role]',            // ChatGPT
          '[data-testid="user-message"]',          // Claude
          '.font-claude-message', '.prose',        // Claude / generic
        ].join(',');
        const nodes = document.querySelectorAll(sel);
        let tail = '';
        for (let i = nodes.length - 1; i >= 0 && tail.length < 600; i--) {
          const t = (nodes[i].innerText || '').trim();
          if (t.length > 10) tail = t + '  ' + tail;
        }
        tail = tail.trim();
        if (tail.length > 10) return tail.slice(-800);
      } catch (_) { /* selector drift — fall through to the gateway seed */ }
      return ''; // gateway seeds from captured turns, else host
    }

    // Conversation identity from the URL (stable — not DOM markup). Lets the
    // gateway find the turns we already captured under webcap:<provider>:<uuid>.
    //   ChatGPT: /c/<uuid> or /g/.../c/<uuid>   Claude: /chat/<uuid>
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    function convRef() {
      try {
        const h = location.hostname;
        if (/chatgpt\.com|chat\.openai\.com/.test(h)) {
          const m = /\/c\/([0-9a-f-]{36})/i.exec(location.pathname);
          if (m) return { provider: 'chatgpt', convId: m[1] };
        } else if (/claude\.ai/.test(h)) {
          const m = /\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
          if (m) return { provider: 'claude', convId: m[1] };
        }
        const any = UUID_RE.exec(location.pathname);
        if (any) return { provider: '', convId: any[0] };
      } catch (_) { /* ignore */ }
      return { provider: '', convId: '' };
    }

    function relPct(item) {
      const r = typeof item.relevance === 'number' ? item.relevance : 0;
      return Math.max(0, Math.min(99, Math.round(r * 100)));
    }
    function ageLabel(iso) {
      if (!iso) return '';
      const t = Date.parse(String(iso).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'));
      if (!t) return '';
      const days = (Date.now() - t) / 86400000;
      if (days < 1) return 'today';
      if (days < 30) return Math.round(days) + 'd';
      if (days < 365) return Math.round(days / 30) + 'mo';
      return Math.round(days / 365) + 'y';
    }
    function sourceLabel(scope) {
      if (!scope) return '';
      const m = /^capture:(?:web|ide|byok):([a-z0-9-]+)/.exec(scope) || /^import:([a-z0-9-]+)/.exec(scope);
      if (m) return m[1];
      if (/^capture:manual/.test(scope)) return 'manual';
      return scope.split(':')[0];
    }

    let pickerEl = null;
    let pickerSearchTimer = null;
    function closePicker() {
      if (pickerEl) { try { pickerEl.remove(); } catch (_) {} pickerEl = null; }
      if (pickerSearchTimer) { clearTimeout(pickerSearchTimer); pickerSearchTimer = null; }
    }

    // Fetch candidates. `scope` selects the pool: '' / 'all' → all-memory;
    // otherwise a vault name (A3). conv identity rides along so the gateway can
    // seed an empty query from captured turns (A1).
    function fetchCandidates(query, scope, cb) {
      const ref = convRef();
      const allMemory = !scope || scope === 'all';
      chrome.runtime.sendMessage(
        {
          type: 'get_context',
          query,
          host: location.hostname,
          all_memory: allMemory,
          vault: allMemory ? '' : scope,
          conv_id: ref.convId,
          provider: ref.provider,
        },
        (resp) => {
          if (chrome.runtime.lastError) { cb({ ok: false, error: chrome.runtime.lastError.message }); return; }
          cb(resp || { ok: false, error: 'no response' });
        },
      );
    }

    function showPicker(resp, seedQuery) {
      closePicker();
      const panel = document.createElement('div');
      pickerEl = panel;
      panel.id = 'vodou-context-picker';
      Object.assign(panel.style, {
        position: 'fixed', bottom: '100px', right: '18px', zIndex: '2147483647',
        width: '420px', maxHeight: '520px', display: 'flex', flexDirection: 'column',
        background: '#111827', color: '#e5e7eb', borderRadius: '12px',
        boxShadow: '0 6px 24px rgba(0,0,0,.5)', border: '1px solid #374151',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: '12px',
      });

      // Header
      const head = document.createElement('div');
      Object.assign(head.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', gap: '8px' });
      const title = document.createElement('div');
      title.textContent = '🧠 Relevant to this chat';
      title.style.fontWeight = '600';
      const closeX = document.createElement('button');
      closeX.type = 'button'; closeX.textContent = '✕'; closeX.setAttribute('aria-label', 'Close');
      Object.assign(closeX.style, { background: 'none', border: '0', color: '#9ca3af', cursor: 'pointer', fontSize: '13px' });
      closeX.addEventListener('click', closePicker);
      head.appendChild(title); head.appendChild(closeX);

      // Search + sort row
      const controls = document.createElement('div');
      Object.assign(controls.style, { display: 'flex', gap: '6px', padding: '0 12px 8px', borderBottom: '1px solid #374151' });
      const search = document.createElement('input');
      search.type = 'text';
      search.placeholder = 'Search all your memory…';
      search.value = seedQuery && seedQuery.length < 80 ? seedQuery : '';
      Object.assign(search.style, {
        flex: '1', padding: '6px 9px', borderRadius: '8px', border: '1px solid #374151',
        background: '#0b0f19', color: '#e5e7eb', fontSize: '12px', outline: 'none',
      });
      const sortSel = document.createElement('select');
      Object.assign(sortSel.style, { background: '#0b0f19', color: '#9ca3af', border: '1px solid #374151', borderRadius: '8px', fontSize: '11px', padding: '0 4px' });
      sortSel.innerHTML = '<option value="relevance">relevance</option><option value="recency">recency</option>';
      // A3 — scope selector: all-memory (default) or a specific vault.
      const scopeSel = document.createElement('select');
      Object.assign(scopeSel.style, { background: '#0b0f19', color: '#9ca3af', border: '1px solid #374151', borderRadius: '8px', fontSize: '11px', padding: '0 4px' });
      const vaultOpts = ['<option value="all">all memory</option>']
        .concat((Array.isArray(resp.vaults) ? resp.vaults : []).map((v) => `<option value="${v.replace(/"/g, '')}">vault: ${v}</option>`));
      scopeSel.innerHTML = vaultOpts.join('');
      controls.appendChild(search); controls.appendChild(scopeSel); controls.appendChild(sortSel);

      // Status line
      const status = document.createElement('div');
      Object.assign(status.style, { padding: '4px 12px', color: '#6b7280', fontSize: '11px' });

      // List
      const list = document.createElement('div');
      Object.assign(list.style, { overflowY: 'auto', padding: '4px 6px', flex: '1' });

      // Footer
      const foot = document.createElement('div');
      Object.assign(foot.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderTop: '1px solid #374151' });
      const allLabel = document.createElement('label');
      Object.assign(allLabel.style, { display: 'flex', gap: '6px', alignItems: 'center', cursor: 'pointer', color: '#9ca3af' });
      const allCb = document.createElement('input'); allCb.type = 'checkbox';
      const allText = document.createElement('span'); allText.textContent = 'All';
      allLabel.appendChild(allCb); allLabel.appendChild(allText);
      const spacer = document.createElement('div'); spacer.style.flex = '1';
      const insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      Object.assign(insertBtn.style, { padding: '7px 14px', border: '0', borderRadius: '999px', color: '#fff', background: '#7c3aed', cursor: 'pointer', fontSize: '12px', opacity: '0.5' });
      foot.appendChild(allLabel); foot.appendChild(spacer); foot.appendChild(insertBtn);

      let boxes = [];
      let currentItems = resp.items;
      let currentScope = 'all'; // A3 — 'all' or a vault name
      const checkedText = new Set(); // preserve selection across sort/re-query
      let blockParts = { open: resp.open, header: resp.header, close: resp.close, vault: resp.vault };

      function syncButton() {
        const n = boxes.filter((b) => b.checked).length;
        insertBtn.textContent = n ? `Insert ${n}` : 'Insert';
        insertBtn.disabled = n === 0;
        insertBtn.style.opacity = n === 0 ? '0.5' : '1';
        allCb.checked = boxes.length > 0 && n === boxes.length;
      }

      function chip(text, color) {
        const s = document.createElement('span');
        s.textContent = text;
        Object.assign(s.style, { fontSize: '10px', color: color || '#9ca3af', background: '#0b0f19', border: '1px solid #374151', borderRadius: '6px', padding: '0 5px', whiteSpace: 'nowrap' });
        return s;
      }

      function render(items) {
        currentItems = items;
        list.innerHTML = '';
        boxes = [];
        const sortBy = sortSel.value;
        const sorted = items.slice().sort((a, b) =>
          sortBy === 'recency'
            ? String(b.created_at || '').localeCompare(String(a.created_at || ''))
            : relPct(b) - relPct(a));
        // A2 — adaptive pre-check. Instead of a fixed 35% cut, pre-check in-vault
        // items at/above the MEDIAN relevance of this result set (with a 20%
        // floor so a uniformly-weak set doesn't auto-check noise), capped at 5.
        // Scales with the query: a sharp query pre-checks its strong head; a
        // vague one pre-checks little.
        const rels = sorted.map(relPct).sort((a, b) => a - b);
        const median = rels.length ? rels[Math.floor(rels.length / 2)] : 0;
        const preThresh = Math.max(20, median);
        let preCount = 0;
        for (const item of sorted) {
          const row = document.createElement('label');
          Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '7px 8px', borderRadius: '8px', cursor: 'pointer', lineHeight: '1.35' });
          row.addEventListener('mouseenter', () => (row.style.background = '#1f2937'));
          row.addEventListener('mouseleave', () => (row.style.background = 'none'));
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.style.marginTop = '2px'; cb.dataset.text = item.text;
          // Preserve an explicit tick across sort/search; otherwise adaptively
          // pre-check relevant, non-private items (private stays unchecked).
          const autoPre = !!item.in_vault && relPct(item) >= preThresh && preCount < 5;
          cb.checked = checkedText.has(item.text) || autoPre;
          if (autoPre && !checkedText.has(item.text)) preCount++;
          cb.addEventListener('change', () => {
            if (cb.checked) checkedText.add(cb.dataset.text); else checkedText.delete(cb.dataset.text);
            syncButton();
          });
          if (cb.checked) checkedText.add(item.text);
          const body = document.createElement('div');
          Object.assign(body.style, { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1', minWidth: '0' });
          const txt = document.createElement('span');
          txt.textContent = item.text.length > 170 ? item.text.slice(0, 167) + '…' : item.text;
          txt.title = item.text;
          const chips = document.createElement('div');
          Object.assign(chips.style, { display: 'flex', gap: '4px', flexWrap: 'wrap' });
          chips.appendChild(chip(relPct(item) + '%', relPct(item) >= 45 ? '#34d399' : '#9ca3af'));
          if (item.tag) chips.appendChild(chip(item.tag));
          const src = sourceLabel(item.scope); if (src) chips.appendChild(chip(src, '#60a5fa'));
          const age = ageLabel(item.created_at); if (age) chips.appendChild(chip(age));
          if (!item.in_vault) chips.appendChild(chip('🔒 private', '#f59e0b'));
          body.appendChild(txt); body.appendChild(chips);
          row.appendChild(cb); row.appendChild(body);
          list.appendChild(row);
          boxes.push(cb);
        }
        const priv = sorted.filter((i) => !i.in_vault).length;
        if (!sorted.length) {
          status.textContent = 'no matches — try different words';
        } else if (currentScope !== 'all') {
          status.textContent = `${sorted.length} in vault "${currentScope}"`;
        } else {
          status.textContent = `${sorted.length} memories · ${priv} private (🔒 = outside your shared vault; tick to include)`;
        }
        syncButton();
      }

      render(resp.items);

      // Re-query the current scope with a given search text (debounced by caller).
      function requery(q) {
        status.textContent = 'searching…';
        fetchCandidates(q, currentScope, (r) => {
          if (!pickerEl) return; // closed mid-flight
          if (!r || !r.ok || !Array.isArray(r.items)) { status.textContent = '✗ ' + ((r && r.error) || 'search failed'); return; }
          blockParts = { open: r.open, header: r.header, close: r.close, vault: r.vault };
          render(r.items);
        });
      }

      // Live search (debounced).
      search.addEventListener('input', () => {
        if (pickerSearchTimer) clearTimeout(pickerSearchTimer);
        const q = search.value.trim();
        if (q.length < 2) return;
        pickerSearchTimer = setTimeout(() => requery(q), 300);
      });
      // A3 — scope change re-queries the chosen pool (keeps the current search text).
      scopeSel.addEventListener('change', () => {
        currentScope = scopeSel.value;
        search.placeholder = currentScope === 'all' ? 'Search all your memory…' : `Search vault: ${currentScope}…`;
        requery(search.value.trim() || (seedQuery || ''));
      });
      sortSel.addEventListener('change', () => render(currentItems));

      allCb.addEventListener('change', () => {
        boxes.forEach((b) => {
          b.checked = allCb.checked;
          if (allCb.checked) checkedText.add(b.dataset.text); else checkedText.delete(b.dataset.text);
        });
        syncButton();
      });
      insertBtn.addEventListener('click', () => {
        const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.text);
        if (!chosen.length) return;
        const block = `${blockParts.open}\n${blockParts.header}\n${chosen.map((t) => '- ' + t).join('\n')}\n${blockParts.close}\n\n`;
        closePicker();
        deliverBlock(block, blockParts.vault, chosen.length);
      });

      panel.appendChild(head);
      panel.appendChild(controls);
      panel.appendChild(status);
      panel.appendChild(list);
      panel.appendChild(foot);
      document.body.appendChild(panel);
      window.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { closePicker(); window.removeEventListener('keydown', esc); }
      });
    }

    function requestContext() {
      const query = chatContextQuery();
      cbtn.disabled = true;
      cbtn.textContent = '🧠 …';
      fetchCandidates(query, 'all', (resp) => {
        cbtn.disabled = false;
        cbtn.textContent = '🧠 My context';
        if (!resp || !resp.ok) {
          toast('✗ ' + ((resp && resp.error) || 'context failed').slice(0, 200), false);
          return;
        }
        if (Array.isArray(resp.items) && resp.items.length && resp.open) {
          showPicker(resp, query);
          return;
        }
        if (Array.isArray(resp.items)) {
          // Connected, searched, but nothing matched — still open the picker so
          // the user can search manually rather than hitting a dead toast.
          showPicker({ ...resp, items: [] }, query);
          return;
        }
        // Legacy gateway without picker items: auto-insert the block.
        if (!resp.context) { toast('No memory matched — try the search box, or add memories in Vodou.', false); return; }
        deliverBlock(resp.context + '\n\n', resp.vault, resp.bullets);
      });
    }

    cbtn.addEventListener('click', requestContext);
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        requestContext();
      }
    }, true);

    // ── PLAN-AUTO-INJECT-P4 Phase A: Ctrl+B auto-inject ────────────────────────
    // One hotkey, two mechanisms picked per provider by WHERE it dispatches its
    // send (§2.0 of the plan):
    //   chatgpt → network body-rewrite (page-fetch — invisible; fenced block,
    //             stripped again on recapture; inject.js does the splice)
    //   claude  → composer injection (Service-Worker realm unreachable from page
    //             fetch — visible, honest; FENCE-LESS natural first-person prose,
    //             because a machine-fenced "retrieved memory" block trips
    //             Claude's injection resistance — spike finding 2026-07-15)
    // Context comes from a live vault-scoped `mem context` pull seeded by the
    // draft/conversation (same disclosure boundary as the 🧠 picker). Toggles:
    // chrome.storage vodou_inject_settings {master, sites:{chatgpt,claude}}.
    const INJECT_SITES = {
      chatgpt: { host: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, mechanism: 'network' },
      claude: { host: /(^|\.)claude\.ai$/, mechanism: 'composer' },
    };
    function injectSiteKey() {
      for (const [k, v] of Object.entries(INJECT_SITES)) if (v.host.test(location.hostname)) return k;
      return null;
    }
    let injectSettings = { master: true, sites: {} };
    try {
      chrome.storage.local.get(['vodou_inject_settings'], (v) => {
        if (v && v.vodou_inject_settings) injectSettings = Object.assign(injectSettings, v.vodou_inject_settings);
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.vodou_inject_settings) {
          injectSettings = Object.assign({ master: true, sites: {} }, ch.vodou_inject_settings.newValue || {});
        }
      });
    } catch (_) { /* storage unavailable — defaults stand */ }

    function logInjection(entry) {
      try { chrome.runtime.sendMessage({ type: 'inject_log', entry }); } catch (_) { /* ignore */ }
    }

    // Counts from the last armed network block, replayed onto the `injected`
    // confirmation (inject.js only reports that the send happened, not what was
    // in it — it never saw the parts).
    let lastArmed = { facts: 0, profileLines: 0 };

    // Per-query items only ride if they ACTUALLY match the query. Precision-first
    // floor for EXTERNAL inject: 0.30 was calibrated for internal recall and was
    // far too low here — genuine answers score 0.85–1.0 while pure noise scores
    // 0.60–0.72, so "what's my blood type" injected random SQL notes (2026-07-18
    // inject-quality sweep). 0.72 silences the clear-noise band while keeping
    // legit mid-confidence facts (IP 0.72, SUTE 0.76). This is the knob the
    // inject-bench (PLAN follow-on) will tune; it's better-than-nothing precision
    // until extraction quality closes the 0.72–0.78 signal/noise overlap.
    // Profile is exempt — it's the always-applicable "who I am" baseline.
    const INJECT_REL_FLOOR = 0.72;
    // Pointed-question gap cut. When one fact dominates, don't drag in weaker
    // tangential matches (2026-07-18: "what's my dog's name" returned Lucy at
    // 0.978 AND four dog-name *debugging* notes — scope capture:ide:claude-code,
    // tags METRIC/PATTERN — at 0.68–0.81, a clear 0.17 gap below). Keep only
    // items within this band of the top hit. A diffuse query ("tell me about
    // myself") keeps its whole cluster because its items sit near each other.
    const INJECT_REL_GAP = 0.15;
    // System/plumbing scopes that must never travel to a third-party AI even
    // when they match — our own capture/skill telemetry, not the user's facts.
    const INJECT_SCOPE_DENY = /^(capture:ide:|skill$|workbench:)/i;
    // Extraction reasoning-leak guard. Some early chunks stored the extractor's
    // own deliberation verbatim ("... But that's a personal fact ... Not really",
    // "— not in this conversation.") which then scores at the TOP because it
    // contains the query words — a floor can't catch it. Belt at the inject
    // boundary; the matching vault rows are also purged (reversible).
    const INJECT_LEAK_RE = /not in this conversation|but that'?s a personal fact|it'?s a preference\? not really|we should only include|actually it'?s in the instructions|could be useful for addressing/i;
    function relevantItems(items, max) {
      const passed = (items || []).filter(
        (i) =>
          (typeof i.relevance === 'number' ? i.relevance : 0) >= INJECT_REL_FLOOR &&
          !INJECT_SCOPE_DENY.test(String(i.scope || '')) &&
          !INJECT_LEAK_RE.test(String(i.text || '')),
      );
      if (!passed.length) return [];
      const top = Math.max(...passed.map((i) => i.relevance || 0));
      return passed
        .filter((i) => (i.relevance || 0) >= top - INJECT_REL_GAP)
        .slice(0, max)
        .map((i) => String(i.text || '').replace(/^[-•]\s*/, '').trim())
        .filter(Boolean);
    }

    // Query-relevant profile selection. The profile is ~20 durable one-line
    // facts; injecting an arbitrary slice (old bug: first 2 lines) meant "what's
    // my dog's name" got the role/mission lines, not the dog line. For the
    // VISIBLE composer we keep it tight: a one-line identity anchor (line 1)
    // plus the profile lines whose words overlap the question. The invisible
    // network path injects the WHOLE profile (no size cost) — see fencedBlock.
    const PROFILE_STOP = new Set(['the', 'a', 'an', 'my', 'me', 'is', 'are', 'was', 'what', 'who', 'how', 'do', 'does', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'with', 'your', 'you', 'we', 'our', 'at', 'it', 'this', 'that', 'about', 'can', 'could', 'would', 'should', 'where', 'when', 'why', 'am', 'be', 'have', 'has', 'get', 'name', 'names']);
    function tokenize(s) {
      return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !PROFILE_STOP.has(t));
    }
    function relevantProfileLines(profile, query, max) {
      const lines = String(profile || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return [];
      const anchor = lines[0];
      const qtok = tokenize(query);
      const scored = lines.slice(1).map((line) => {
        const lt = tokenize(line);
        let score = 0;
        for (const q of qtok) if (lt.some((w) => w === q || w.startsWith(q) || q.startsWith(w))) score++;
        // Substring catch for the un-tokenized query words the stoplist dropped
        // (e.g. "dog" in a bare "dog?" query) — belt on top of token overlap.
        return { line, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
      return [anchor, ...scored.map((x) => x.line)];
    }

    // Composer providers: natural first-person prose, NO fence (§0.1). Short and
    // TIGHT — it's visible in the user's draft. Philosophy (2026-07-16, Chad):
    // a pointed question deserves a pointed answer, not the whole dossier.
    //   • If specific vault facts match the question (embedding-ranked, above
    //     floor) → inject ONLY those. No identity anchor, no keyword-matched
    //     profile lines (crude overlap false-matches, e.g. "flat WHITE" →
    //     "WHITE-label" SUTE line). The matched fact IS the context.
    //   • Only when NOTHING specific matched → fall back to identity grounding
    //     from the profile (so "tell me about myself" still works).
    // `selected` = server-decomposed + per-sub-question-selected facts (compound
    // prompts split server-side so each fact matches its own question instead of
    // blurring below the floor). Falls back to client-side relevantItems when an
    // older gateway doesn't send `selected`.
    // Returns { text, facts, profileLines } — the counts are what ACTUALLY went
    // into the text, not what was available. The activity log and the toast both
    // read them, so neither can claim a profile that this branch never included
    // (the old code logged `profile: hasProfile`, i.e. "a profile exists", which
    // read as "+profile" on every fact-only injection — 2026-07-25, Chad).
    function composerFraming(profile, selected, items, query) {
      const facts = (Array.isArray(selected) && selected.length)
        ? selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(items, 4);
      let body;
      let profileLines = 0;
      if (facts.length) {
        body = facts.join('; ') + '.';            // specific answer only
      } else {
        const prof = relevantProfileLines(profile, query, 3);
        if (!prof.length) return { text: '', facts: 0, profileLines: 0 };
        body = prof.join(' ');                     // identity grounding fallback
        profileLines = prof.length;
      }
      // No "For context about me:" preamble (2026-07-18, Chad) — the fact
      // stands on its own; the framing added length and read as boilerplate.
      let s = body;
      if (s.length > 700) s = s.slice(0, 697) + '…';
      return { text: s + '\n\n', facts: facts.length, profileLines };
    }

    // Network providers: fenced block assembled from the gateway's own parts
    // (single producer for the fence format); profile rides inside the fence.
    // Same contract as composerFraming: { text, facts, profileLines } counting
    // only what the block actually carries. This path DOES ship the whole
    // profile, so profileLines is its real line count.
    function fencedBlock(resp) {
      const facts = (Array.isArray(resp.selected) && resp.selected.length)
        ? resp.selected.map((t) => String(t || '').replace(/^[-•]\s*/, '').trim()).filter(Boolean)
        : relevantItems(resp.items, 6);
      const prof = String(resp.profile || '').trim();
      const empty = { text: '', facts: 0, profileLines: 0 };
      if (!prof && !facts.length) return empty;
      const lines = [];
      if (resp.open) lines.push(resp.open);
      if (resp.header) lines.push(resp.header);
      if (prof) lines.push(prof);
      for (const t of facts) lines.push('- ' + t);
      if (resp.close) lines.push(resp.close);
      if (lines.length <= 2) return empty;
      const profileLines = prof ? prof.split('\n').filter((l) => l.trim()).length : 0;
      return { text: lines.join('\n'), facts: facts.length, profileLines };
    }

    // Out-of-band loop-strip registry for composer injections (§0.1: no fence
    // means no marker — track the injected text and strip it at capture time).
    function registerStrip(text) {
      try {
        chrome.storage.local.get(['vodou_inject_registry'], (v) => {
          const reg = (v && v.vodou_inject_registry) || [];
          reg.unshift({ text, ts: Date.now(), host: location.hostname });
          while (reg.length > 40) reg.pop();
          chrome.storage.local.set({ vodou_inject_registry: reg });
        });
      } catch (_) { /* ignore */ }
    }

    // Run one injection. `forceComposer` (Ctrl+Shift+B) overrides a site's
    // default mechanism so ANY site — including ChatGPT — inserts VISIBLY into
    // the composer instead of the invisible network rewrite. ChatGPT's composer
    // is already a proven insert target (the 🧠 button uses it), so "make
    // ChatGPT work like Claude" is just routing to the composer path.
    function runInject(site, forceComposer, composer) {
      if (!injectSettings.master || injectSettings.sites[site] === false) {
        toast('Vodou auto-inject is off — enable it in the extension popup', false);
        return;
      }
      // `composer` was captured at keypress (focus = the box the user typed in).
      // Reuse it for BOTH the retrieval seed and the insert so an async focus
      // change between them can't split them onto different elements.
      const seed = chatContextQuery(composer);
      if (DIAG()) console.log('[vodou-inject] seed query:', JSON.stringify((seed || '').slice(0, 80)), '| from', elDesc(composer));
      toast('🧠 pulling your context…', true);
      // scope 'all' → search the ENTIRE store, not just the portable vault
      // (2026-07-18, Chad: any external-LLM lookup must reach all memory — the
      // old vault-scoped pull hid basic personal facts like "my dog is Lucy",
      // which are tagged RESEARCH/etc., not PREF, so the PREF-only portable
      // vault excluded them and inject fell back to the generic profile blurb).
      // Trade-off accepted: this widens what can travel to a third-party AI
      // from vault-eligible only to any above-floor match. The relevance floor
      // (INJECT_REL_FLOOR) still gates noise; the profile fallback still covers
      // "tell me about myself". Matches the 🧠 button, which already uses 'all'.
      fetchCandidates(seed, 'all', (resp) => {
        if (!resp || !resp.ok) {
          toast('✗ context pull failed: ' + ((resp && resp.error) || 'no response'), false);
          return;
        }
        const items = Array.isArray(resp.items) ? resp.items : [];
        const hasProfile = String(resp.profile || '').trim().length > 0;
        if (!items.length && !hasProfile) {
          toast('no vault memories matched this chat — nothing to inject', false);
          logInjection({
            kind: 'inject', site, mechanism: forceComposer ? 'composer' : INJECT_SITES[site].mechanism,
            status: 'nothing', facts: 0, profileLines: 0, convId: convRef().convId, at: Date.now(),
          });
          return;
        }
        // Describe ONLY what the chosen branch actually packs (see composerFraming).
        const describe = (facts, profileLines) => {
          const f = facts ? `${facts} ${facts === 1 ? 'memory' : 'memories'}` : '';
          const p = profileLines ? `${profileLines} profile ${profileLines === 1 ? 'fact' : 'facts'}` : '';
          if (f && p) return `${f} + ${p}`;
          return f || p || 'nothing';
        };
        const mech = forceComposer ? 'composer' : INJECT_SITES[site].mechanism;
        if (mech === 'network') {
          const built = fencedBlock(resp);
          const block = built.text;
          if (!block) { toast('nothing suitable to inject', false); return; }
          window.postMessage({ source: 'vodou-inject', op: 'arm', block }, '*');
          lastArmed = { facts: built.facts, profileLines: built.profileLines };
          logInjection({
            kind: 'inject', site, mechanism: 'network', status: 'armed', chars: block.length,
            facts: built.facts, profileLines: built.profileLines,
            convId: convRef().convId, at: Date.now(),
          });
        } else {
          const built = composerFraming(resp.profile, resp.selected, items, seed);
          const text = built.text;
          const summary = describe(built.facts, built.profileLines);
          if (!text) { toast('nothing suitable to inject', false); return; }
          // Reuse the keypress-captured composer; re-find only if it went away.
          const target = (composer && composer.isConnected) ? composer : findComposer();
          registerStrip(text.trim()); // register regardless of insert path (paste too gets loop-stripped)
          insertTextVerified(target, text, (ok) => {
            if (ok) {
              toast(`🧠 added ${summary} to your draft — review & send`, true);
              logInjection({
                kind: 'inject', site, mechanism: 'composer', status: 'inserted', chars: text.length,
                forced: !!forceComposer, facts: built.facts, profileLines: built.profileLines,
                convId: convRef().convId, at: Date.now(),
              });
            } else {
              // Insert genuinely failed — never lose the context: copy it so the
              // user can paste (a pasted-then-sent block is still loop-stripped).
              navigator.clipboard.writeText(text.trim()).then(
                () => toast(`🧠 ${summary} copied — paste it into the composer (Cmd/Ctrl+V)`, true),
                () => toast('✗ could not insert or copy — click into the composer, then retry', false),
              );
              logInjection({
                kind: 'inject', site, mechanism: 'composer', status: 'clipboard', chars: text.length,
                forced: !!forceComposer, facts: built.facts, profileLines: built.profileLines,
                convId: convRef().convId, at: Date.now(),
              });
            }
          });
        }
      });
    }

    window.addEventListener('keydown', (e) => {
      try {
        // Ctrl+B         → site default (invisible network on ChatGPT, composer on Claude)
        // Ctrl+Shift+B   → force VISIBLE composer injection on ANY site
        // (physical KeyB; Cmd+B stays the site's bold on macOS.)
        if (!(e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyB')) return;
        const site = injectSiteKey();
        if (!site) return; // unsupported host — leave the hotkey to the page
        // Capture the composer NOW, while focus is still the box the user typed
        // in — before preventDefault/async can shift focus. Used for seed+insert.
        const composer = findComposer();
        e.preventDefault();
        e.stopPropagation();
        runInject(site, !!e.shiftKey, composer);
      } catch (_) { /* the hotkey must never break the page */ }
    }, true);

    // Status back-channel from inject.js (network mechanism): disclosure toasts.
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'vodou-inject-status') return;
      if (d.op === 'armed') {
        toast('🧠 context armed — attaches invisibly to your next send', true);
      } else if (d.op === 'injected') {
        toast('🧠 context attached to your message (invisible)', true);
        // Carries the armed block's real counts and `supersedes` so the log ends
        // up with ONE line per injection that advances armed → sent, instead of
        // two half-informative rows.
        logInjection({
          kind: 'inject', site: injectSiteKey(), mechanism: 'network', status: 'injected',
          facts: lastArmed.facts, profileLines: lastArmed.profileLines,
          supersedes: 'armed', how: d.how || '', convId: convRef().convId, at: Date.now(),
        });
      }
    });

    const mountBtn = () => {
      if (document.body && !document.getElementById('vodou-context-btn')) document.body.appendChild(cbtn);
    };
    if (document.body) mountBtn();
    else document.addEventListener('DOMContentLoaded', mountBtn);
    setInterval(mountBtn, 3000); // SPA route changes wipe the body subtree
  }

  // PLAN-UNIVERSAL-MEMORY-V2 Phase C (W2a) — relay network-intercepted turns.
  // inject.js (MAIN world) can't reach chrome.runtime; it window.postMessage's
  // captured turns and we forward them to the background service worker, which
  // sends them to the gateway over the WS. Passive capture is OPT-IN: only relay
  // when the user has enabled it (chrome.storage flag, default off), so simply
  // installing the extension never starts silently recording every AI chat.
  function mountRelayOnly() {
    if (window.__vodouNetcapRelayMounted) return;
    window.__vodouNetcapRelayMounted = true;
    let autoCaptureOn = false;
    // PLAN-AUTO-INJECT-P4 — loop-strip at the capture boundary. Injected context
    // must never re-enter memory as if the user typed it:
    //   • network mechanism: fenced ⟦vodou:context…⟧ blocks (belt here, and the
    //     gateway extractor strips them again — suspenders);
    //   • composer mechanism: NO fence (it trips provider injection resistance),
    //     so we match against the registry of injected texts (out-of-band strip).
    let stripRegistry = [];
    try {
      chrome.storage.local.get(['vodou_auto_capture', 'vodou_inject_registry'], (v) => {
        autoCaptureOn = !!(v && v.vodou_auto_capture);
        stripRegistry = (v && v.vodou_inject_registry) || [];
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.vodou_auto_capture) autoCaptureOn = !!changes.vodou_auto_capture.newValue;
        if (changes.vodou_inject_registry) stripRegistry = changes.vodou_inject_registry.newValue || [];
      });
    } catch (_) { /* ignore */ }

    const STRIP_TTL_MS = 7 * 86400000;
    const FENCE_RE = /⟦vodou:context[^⟧]*⟧[\s\S]*?⟦\/vodou:context⟧\s*/g;
    function stripInjected(turns) {
      try {
        return (turns || []).map((t) => {
          if (!t || t.role !== 'user' || typeof t.content !== 'string') return t;
          let c = t.content.replace(FENCE_RE, '');
          for (const r of stripRegistry) {
            if (!r || !r.text || Date.now() - (r.ts || 0) > STRIP_TTL_MS) continue;
            if (c.startsWith(r.text)) { c = c.slice(r.text.length).replace(/^\s+/, ''); break; }
          }
          return c === t.content ? t : Object.assign({}, t, { content: c });
        }).filter((t) => !t || typeof t.content !== 'string' || t.content.trim().length > 0);
      } catch (_) { return turns; }
    }

    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.source !== 'vodou-netcap' || !autoCaptureOn) return;
      try {
        chrome.runtime.sendMessage({
          type: 'net_capture',
          provider: d.provider,
          conversationId: d.conversationId,
          turns: stripInjected(d.turns),
        });
      } catch (_) { /* service worker asleep — dropped this turn, next one wakes it */ }
    });
  }
})();
