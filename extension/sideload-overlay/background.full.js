// ── SIDELOAD OVERLAY — appended to the Store build's background.js ─────────────
//
// Generated into extension/vodou-bridge/ and extension/sideload-only-vodou-bridge/
// by scripts/build-sideload-bridge.py. This file is the ONLY place the full
// build's extra gateway commands live; do not edit the generated background.js.
//
// The Store build answers `extract` / `act_in_tab` with UNSUPPORTED and has no
// `cache_get` / `cache_set` / `open_url`; the generator rewires its dispatcher to
// these. Function declarations hoist in module scope, so appending them after the
// dispatcher is fine. The two extra builtin extractors register at the bottom,
// after BUILTIN_EXTRACTORS exists.
//
// Moved verbatim from the hand-kept vodou-bridge/background.js (2026-09-23).

// ---------- extract ----------
async function cmdExtract(msg, reply, replyError) {
  const { url, selector, opts = {} } = msg;
  if (!url || !selector) return replyError('VALIDATION_FAILED', 'url + selector required');
  const timeoutMs = opts.timeout_ms || 15000;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id, timeoutMs);
    const [{ result } = { result: [] }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractFromDom,
      args: [selector],
    });
    reply({ matches: result || [] });
  } catch (err) {
    replyError('EXTRACTION_FAILED', err?.message || 'extract failed');
  } finally {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`tab ${tabId} did not load within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        // Give the page a moment to finish any client-side rendering
        setTimeout(resolve, 250);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Injected into the page — must be self-contained, no closures.
function extractFromDom(selector) {
  const nodes = Array.from(document.querySelectorAll(selector));
  return nodes.slice(0, 50).map(el => {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      outerHTML: el.outerHTML.slice(0, 8192),
      text: (el.textContent || '').slice(0, 4096),
      attrs,
    };
  });
}

// ---------- act_in_tab ----------
async function cmdActInTab(msg, reply, replyError) {
  const { urlPattern, script, args = [] } = msg;
  if (!urlPattern || !script) return replyError('VALIDATION_FAILED', 'urlPattern + script required');
  try {
    // Find a matching tab the user already has open. Prefer the focused tab.
    const tabs = await chrome.tabs.query({ url: urlPatternToMatchUrl(urlPattern) });
    const tab = tabs.find(t => t.active) || tabs[0];
    if (!tab) {
      return replyError('NO_MATCHING_TAB', `no open tab matches ${urlPattern}`);
    }
    const [exec] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runUserScript,
      args: [script, args],
    });
    reply({ result: exec?.result ?? null });
  } catch (err) {
    replyError('INTERNAL', err?.message || 'act_in_tab failed');
  }
}

// Injected — runs the user-supplied script string as a function.
function runUserScript(scriptSrc, args) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...['__args'], `return (${scriptSrc})`);
    return fn(args);
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ---------- cache_get / cache_set (observe() snapshot store) ----------
// Per-domain extension-storage bucket. Lenses use this to opportunistically
// cache state from the user's active sessions so reads don't need a tab.
// Format: `{ "vodou_lens_cache": { "<key>": { value, updated_at } } }`.
async function cmdCacheGet(msg, reply, replyError) {
  const key = msg.key;
  if (typeof key !== 'string' || !key) {
    return replyError('VALIDATION_FAILED', 'key required');
  }
  try {
    const { vodou_lens_cache } = await chrome.storage.local.get(['vodou_lens_cache']);
    const entry = (vodou_lens_cache || {})[key] || null;
    reply({ entry });
  } catch (err) {
    replyError('CACHE_GET_FAILED', err?.message || String(err));
  }
}
async function cmdCacheSet(msg, reply, replyError) {
  const key = msg.key;
  if (typeof key !== 'string' || !key) {
    return replyError('VALIDATION_FAILED', 'key required');
  }
  try {
    const { vodou_lens_cache } = await chrome.storage.local.get(['vodou_lens_cache']);
    const cache = vodou_lens_cache || {};
    cache[key] = { value: msg.value, updated_at: Date.now() };
    await chrome.storage.local.set({ vodou_lens_cache: cache });
    reply({ ok: true });
  } catch (err) {
    replyError('CACHE_SET_FAILED', err?.message || String(err));
  }
}

// ---------- Built-in extractors (CSP-safe page injections) ----------
//
// Some target sites (Gmail, X, banks) ship strict Content Security Policy
// headers that forbid `unsafe-eval` even in the extension's isolated world.
// That breaks the `act_in_tab` path because it relies on `new Function(src)`
// to invoke a lens-supplied script string. The CSP-safe alternative is
// `chrome.scripting.executeScript({func: <real function>})` — Chrome
// uses a privileged injection mechanism that doesn't trigger CSP eval rules.
//
// Trade-off: extractors must be defined here at extension build time, not
// shipped from the lens. Community lenses that need CSP-strict sites (Gmail,
// X, etc.) call `extract_builtin` with a known id; this file is the registry.

function extractor_gmailUnread() {
  // Runs in Gmail's page context (isolated world). Returns a plain object
  // that Chrome serializes back. Never uses eval / new Function.
  //
  // Extraction strategy for the modern Gmail inbox table:
  //   - Each row's accessible label (aria-label) is the canonical structured
  //     summary: "state, sender, [recipient], subject, time, snippet".
  //   - Sender is also exposed cleanly on `span[email]` / `span[name]`.
  //   - Avatars/badges occasionally insert extra comma-separated tokens —
  //     we detect time via regex and use it as a fixed anchor to slice
  //     subject before / snippet after.
  try {
    const dbg = {
      url: location.href,
      ready: document.readyState,
      title: document.title,
      variants: [],
    };
    const main = document.querySelector('div[role="main"]');
    dbg.has_role_main = !!main;
    const scopes = [main || document.body];
    function tryQ(q, label) {
      for (let s = 0; s < scopes.length; s++) {
        try {
          const r = scopes[s].querySelectorAll(q);
          dbg.variants.push(label + ':' + r.length);
          if (r.length > 0) return Array.from(r);
        } catch (_) { dbg.variants.push(label + ':err'); }
      }
      return [];
    }
    let rows = tryQ('tr[role="row"]', 'tr-role-row');
    if (rows.length === 0) rows = tryQ('[role="row"]', 'any-role-row');
    if (rows.length === 0) rows = tryQ('div[gh="tl"] [role="row"]', 'gh-tl-row');
    if (rows.length === 0) rows = tryQ('table.F.cf.zt tr', 'classic-tbl');
    if (rows.length === 0) rows = tryQ('li[role="listitem"]', 'listitem');
    dbg.row_count = rows.length;
    if (rows.length === 0) {
      if (main) {
        dbg.main_first_child_tag = main.firstElementChild ? main.firstElementChild.tagName : null;
        dbg.main_preview = (main.innerText || '').slice(0, 200);
      }
      return { count: 0, messages: [], diagnostic: dbg };
    }

    function isUnread(row) {
      try {
        if (/\bzE\b/.test(row.className || '')) return true;
        const els = row.querySelectorAll('span, div, b, strong');
        for (let i = 0; i < Math.min(els.length, 8); i++) {
          try {
            const w = getComputedStyle(els[i]).fontWeight;
            if (parseInt(w, 10) >= 600) return true;
            if (w === 'bold' || w === 'bolder') return true;
          } catch (_) { /* skip */ }
        }
      } catch (_) {}
      return false;
    }

    const unread = rows.filter(isUnread);
    dbg.unread_count = unread.length;
    const target = unread.length > 0 ? unread : rows.slice(0, 10);

    function cleanText(s) {
      return (s || '')
        // Strip Gmail's invisible padding chars (zero-width / soft-hyphen
        // family) that pad short snippets to fill column width.
        .replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁩　﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function extractRow(row) {
      // Sender via the explicit attribute first.
      let sender = '';
      try {
        const e = row.querySelector('span[email], span[name]');
        if (e) {
          sender = e.getAttribute('email') || e.getAttribute('name') ||
            (e.textContent && e.textContent.trim()) || '';
        }
      } catch (_) {}

      // The row's accessible label (aria-label) is the canonical structured
      // summary Gmail computes for screen readers — sender, subject, time,
      // snippet, all in one string separated by ", ".
      let aria = '';
      try {
        aria = row.getAttribute('aria-label') || '';
        if (!aria) {
          // aria-labelledby chain — concatenate referenced text content.
          const ids = (row.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
          if (ids.length) {
            aria = ids.map(function (id) {
              const el = document.getElementById(id);
              return el ? (el.textContent || '') : '';
            }).filter(Boolean).join(', ');
          }
        }
      } catch (_) {}

      let subject = '', snippet = '', time = '';
      if (aria) {
        // Find the time token (e.g. "9:44 PM", "May 13", "Tue 8:21 AM").
        // Everything before it (after sender) is subject; everything after
        // is the snippet.
        const timeRe = /\b(\d{1,2}:\d{2}\s*(?:AM|PM)?|[A-Z][a-z]{2}\s+\d{1,2}|[A-Z][a-z]{2}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)\b/;
        const m = aria.match(timeRe);
        if (m) time = m[0];
        const cleaned = cleanText(aria);
        // Strip leading "Unread, " state token if present.
        const noState = cleaned.replace(/^(Unread|Read|Starred|Important|Snoozed)\s*,\s*/i, '');
        // If we have time, split aria around it.
        if (time) {
          const idx = noState.lastIndexOf(time);
          if (idx > 0) {
            const before = noState.slice(0, idx).replace(/\s*,\s*$/, '').trim();
            const after = noState.slice(idx + time.length).replace(/^\s*,\s*/, '').trim();
            // `before` = "sender_label, [recipient,] subject"
            // `after`  = "snippet"
            const parts = before.split(/\s*,\s*/);
            // Last comma-separated chunk = subject; everything else = sender or recipient noise.
            if (parts.length >= 1) subject = parts[parts.length - 1];
            snippet = after;
            // If we didn't get a sender from span[email], use the first part.
            if (!sender && parts.length >= 2) sender = parts[0];
          }
        }
        // Fallback if time-anchored slicing failed.
        if (!subject) {
          const parts = noState.split(/\s*,\s*/);
          if (parts.length >= 2) {
            if (!sender) sender = parts[0];
            subject = parts.slice(1, Math.min(parts.length, 3)).join(', ');
            snippet = parts.slice(3).join(', ');
          } else {
            subject = noState;
          }
        }
      }

      // Final fallback if aria parsing yielded nothing usable.
      if (!subject) {
        try {
          const subjEl = row.querySelector('.bog, .y6 span, [data-thread-id] [role="link"] > span');
          subject = subjEl ? cleanText(subjEl.textContent) : '';
        } catch (_) {}
      }
      if (!sender) sender = '(unknown)';
      if (!subject) subject = '(no subject)';
      subject = cleanText(subject).slice(0, 160);
      snippet = cleanText(snippet).slice(0, 180);
      // If the aria didn't carry a usable date, try the title attr on the time cell.
      if (!time) {
        try {
          const t = row.querySelector('span[title*=":"], td[role="gridcell"] [title*=":"]');
          if (t) time = t.getAttribute('title') || t.textContent || '';
          time = cleanText(time);
        } catch (_) {}
      }

      // Thread URL — make rows clickable to open the email in Gmail.
      // Tries every signal we can find. Defensive against null returns.
      let thread_url = '';
      try {
        // Helper: safely read an attribute from an element-or-null.
        function attr(el, name) {
          return el && el.getAttribute ? (el.getAttribute(name) || '') : '';
        }
        // Source 1: data-legacy-thread-id (modern Gmail puts this on the row).
        let threadId =
          attr(row, 'data-legacy-thread-id') ||
          attr(row.querySelector('[data-legacy-thread-id]'), 'data-legacy-thread-id') ||
          attr(row, 'data-thread-id') ||
          attr(row.querySelector('[data-thread-id]'), 'data-thread-id') ||
          '';
        if (threadId) {
          const cleanId = String(threadId).replace(/^#?thread-[fa]:?/i, '');
          const acctMatch = location.pathname.match(/\/mail\/u\/(\d+)/);
          const acct = acctMatch ? acctMatch[1] : '0';
          thread_url = location.origin + '/mail/u/' + acct + '/#inbox/' + cleanId;
        }
        // Source 2: an anchor inside the row that already points at a thread.
        if (!thread_url) {
          const a = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#search/"]');
          if (a) {
            const href = a.getAttribute('href') || '';
            thread_url = href.startsWith('http') ? href : (location.origin + href);
          }
        }
        // Source 3: parse aria-haspopup'd link target via data-pid / data-tid.
        if (!thread_url) {
          const pid = attr(row, 'data-pid') || attr(row.querySelector('[data-pid]'), 'data-pid');
          if (pid) {
            const acctMatch = location.pathname.match(/\/mail\/u\/(\d+)/);
            const acct = acctMatch ? acctMatch[1] : '0';
            thread_url = location.origin + '/mail/u/' + acct + '/#inbox/' + pid;
          }
        }
      } catch (_) {}

      return {
        sender: sender,
        subject: subject,
        snippet: snippet,
        time: time,
        thread_url: thread_url,
      };
    }

    const messages = [];
    for (let i = 0; i < Math.min(target.length, 10); i++) {
      try { messages.push(extractRow(target[i])); }
      catch (e) {
        dbg.extract_errors = (dbg.extract_errors || []);
        dbg.extract_errors.push(String((e && e.message) || e));
      }
    }
    return { count: messages.length, messages: messages, diagnostic: dbg };
  } catch (e) {
    return { count: 0, messages: [], error: String((e && e.message) || e), diagnostic: { trapped: true } };
  }
}


function extractor_chatgptConversation() {
  try {
    const uuid = (location.pathname.match(/\/c\/([0-9a-f-]{8,})/i) || [])[1] || '';
    const title = (document.title || 'ChatGPT chat').replace(/\s*[-|].*$/, '').trim() || 'Captured ChatGPT chat';
    // E9 — per-message timestamp, when the page actually renders one.
    //
    // Most chat UIs render no per-message time at all, so this is best-effort by
    // design: a message with no readable time simply omits `created_at`, and the
    // Rust side falls back to the conversation's own time exactly as before
    // (webchat.rs -> conversation_writer.rs). What it fixes is the case where the
    // time IS in the DOM and we were throwing it away, so a whole saved chat
    // collapsed to a single save-time instant.
    //
    // Read from the ORIGINAL node, never a stripped clone: sites.js strips
    // timestamp nodes as visual noise (see its .text-hint note), so by clone time
    // the evidence is already gone.
    function readTimestamp(el) {
      try {
        const t = el.querySelector && el.querySelector('time[datetime]');
        if (t) {
          const iso = t.getAttribute('datetime');
          if (iso && !isNaN(Date.parse(iso))) return new Date(Date.parse(iso)).toISOString();
        }
        const holder =
          (el.querySelector && el.querySelector('[data-timestamp], [data-time]')) ||
          (el.closest && el.closest('[data-timestamp], [data-time]'));
        if (holder && holder.getAttribute) {
          const raw = holder.getAttribute('data-timestamp') || holder.getAttribute('data-time');
          if (raw) {
            const str = String(raw).trim();
            const n = Number(str);
            let ms;
            if (str !== '' && isFinite(n)) {
              // Purely numeric = epoch. Seconds vs milliseconds: under ~1e11 is
              // seconds. Non-positive is not a capture time.
              ms = n > 0 ? (n < 1e11 ? n * 1000 : n) : NaN;
            } else {
              ms = Date.parse(str);
            }
            // Plausibility floor (2000-01-01). Date.parse('0') is the YEAR 2000
            // and Number('2024') * 1000 is 1970 — both parse "successfully" and
            // would silently backdate a message by decades.
            if (isFinite(ms) && ms > 946684800000) return new Date(ms).toISOString();
          }
        }
      } catch (_) { /* a page that throws on DOM reads must not fail the capture */ }
      return null;
    }

    const messages = [];
    // ChatGPT tags each turn with data-message-author-role.
    const nodes = document.querySelectorAll('[data-message-author-role]');
    nodes.forEach((el) => {
      const role = el.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') return;
      const text = (el.innerText || el.textContent || '').trim();
      if (text) messages.push({ role, text, created_at: readTimestamp(el) });
    });
    return { uuid, title, messages, diagnostic: { selector_hits: nodes.length } };
  } catch (e) {
    return { uuid: '', title: 'Captured ChatGPT chat', messages: [], error: String((e && e.message) || e) };
  }
}

// ---------- open_url ----------
// Navigate an existing tab matching `match_url` (or open a new one) to
// the given target URL. Used by lens renderers that want clicks to land
// in the user's already-logged-in session — e.g. clicking a row in
// gmail.unread navigates the existing Gmail tab to the thread, no popup,
// no separate window.
async function cmdOpenUrl(msg, reply, replyError) {
  const url = msg.url;
  const matchUrl = msg.match_url || null; // pattern for an existing tab to reuse
  const newTab = !!msg.new_tab;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return replyError('VALIDATION_FAILED', 'url must be http(s)://');
  }
  try {
    if (!newTab && matchUrl) {
      const tabs = await chrome.tabs.query({ url: matchUrl });
      const tab = tabs.find((t) => t.active) || tabs[0];
      if (tab) {
        await chrome.tabs.update(tab.id, { url, active: true });
        // Focus the window that holds it.
        if (tab.windowId) {
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
        }
        return reply({ tabId: tab.id, reused: true });
      }
    }
    // Fall through: open a new tab.
    const created = await chrome.tabs.create({ url, active: true });
    reply({ tabId: created.id, reused: false });
  } catch (err) {
    replyError('OPEN_URL_FAILED', err?.message || String(err));
  }
}

// Registered here, not in the Store's BUILTIN_EXTRACTORS literal: gmail.unread
// needs mail.google.com, which only <all_urls> reaches, and chatgpt_conversation
// is the DOM fallback the Store build dropped with its cookies_fetch primary.
BUILTIN_EXTRACTORS['gmail.unread'] = {
  urlPattern: 'https://mail.google.com/*',
  fn: extractor_gmailUnread,
};
BUILTIN_EXTRACTORS['chatgpt_conversation'] = {
  urlPattern: 'https://chatgpt.com/*',
  fn: extractor_chatgptConversation,
};
