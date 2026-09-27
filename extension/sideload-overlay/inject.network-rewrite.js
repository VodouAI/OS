  // ── PLAN-AUTO-INJECT-P4 mechanism #1: network body-rewrite ─────────────────
  // For page-fetch providers (ChatGPT — spike-proven 2026-07-15). content.js
  // arms a fenced context block (Ctrl+B → live vault-scoped `mem context`
  // pull); the next prompt-bearing request gets the block spliced into the
  // user turn, invisible to the page UI. The fence is stripped again on
  // recapture (client relay + gateway_extractor::strip_vodou_context), so the
  // injection never re-enters memory. One-shot per arm; auto-expires.
  // Claude is NOT a target here: its /completion dispatches from a
  // Service-Worker realm page fetch can't reach — it uses mechanism #2
  // (composer injection in content.js).
  try { window.__vodouInjectBuild = 'p4-a-2026-07-16'; } catch (_) {}
  const NET_INJECT = { block: null, armedAt: 0, TTL_MS: 10 * 60 * 1000 };
  const NET_INJECT_TARGETS = [
    { name: 'chatgpt', host: /chatgpt\.com|chat\.openai\.com/, path: /\/backend-api\/(f\/)?conversation(\?|$)/ },
  ];
  function netInjectTarget(url) {
    const u = String(url || '');
    const t = NET_INJECT_TARGETS.find((x) => x.host.test(u) && x.path.test(u));
    return t ? t.name : null;
  }
  function armedBlock() {
    if (!NET_INJECT.block) return null;
    if (Date.now() - NET_INJECT.armedAt > NET_INJECT.TTL_MS) { NET_INJECT.block = null; return null; }
    return NET_INJECT.block;
  }
  const injectStatus = (op, extra) => {
    try { window.postMessage(Object.assign({ source: 'vodou-inject-status', op }, extra || {}), '*'); } catch (_) {}
  };
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== 'vodou-inject') return;
    if (d.op === 'arm' && typeof d.block === 'string' && d.block.length) {
      NET_INJECT.block = d.block;
      NET_INJECT.armedAt = Date.now();
      injectStatus('armed');
    } else if (d.op === 'disarm') {
      NET_INJECT.block = null;
      injectStatus('disarmed');
    }
  });
  // Splice `block` ahead of the user turn in a JSON body STRING; return the new
  // string, or null if no known prompt field was found (→ request untouched).
  function injectRewriteBody(bodyStr, block) {
    try {
      const req = JSON.parse(bodyStr);
      let hit = false;
      if (Array.isArray(req.messages)) {                 // ChatGPT shape
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          const role = m && (m.role || (m.author && m.author.role));
          if (role !== 'user') continue;
          if (m.content && Array.isArray(m.content.parts) && typeof m.content.parts[0] === 'string') {
            m.content.parts[0] = block + '\n\n' + m.content.parts[0]; hit = true; break;
          }
          if (typeof m.content === 'string') { m.content = block + '\n\n' + m.content; hit = true; break; }
        }
      }
      if (!hit && typeof req.prompt === 'string') {       // generic prompt-field shape
        req.prompt = block + '\n\n' + req.prompt; hit = true;
      }
      return hit ? JSON.stringify(req) : null;
    } catch (_) { return null; }
  }
  // Returns possibly-rewritten fetch args. Handles all body shapes seen live:
  //   A) fetch(url, {body:"<json string>"})       B) fetch(new Request(url,{body}))
  //   C) fetch(url, {body: Blob|ArrayBuffer|TypedArray|URLSearchParams})
  async function maybeInjectArgs(args) {
    const block = armedBlock();
    if (!block) return args;
    const input = args[0];
    const init = args[1];
    const url = (input && input.url) || String(input || '');
    const provider = netInjectTarget(url);
    if (!provider) return args;
    const consumed = (how) => {
      NET_INJECT.block = null;                            // one-shot per arm
      injectStatus('injected', { provider, how, url });
      try { console.debug('[vodou-inject] context attached (' + how + ') → ' + url); } catch (_) {}
    };
    // Case A — string body on the init object (ChatGPT's usual shape).
    if (init && typeof init.body === 'string') {
      const nb = injectRewriteBody(init.body, block);
      if (nb == null) return args;
      consumed('init-string');
      return [input, Object.assign({}, init, { body: nb })];
    }
    // Case B — args[0] is a Request carrying the body (clone → read → rebuild).
    if (input && typeof Request !== 'undefined' && input instanceof Request) {
      let bodyText = '';
      try { bodyText = await input.clone().text(); } catch (_) { return args; }
      if (bodyText) {
        const nb = injectRewriteBody(bodyText, block);
        if (nb != null) {
          try {
            const rewritten = new Request(input, { body: nb });
            consumed('request-clone');
            return [rewritten, init];
          } catch (_) { return args; }
        }
      }
      return args;
    }
    // Case C — non-string body on init.
    if (init && init.body != null && typeof init.body !== 'string') {
      let bodyText = '';
      try {
        const b = init.body;
        if (typeof b.text === 'function') bodyText = await b.text();          // Blob / File
        else if (b instanceof ArrayBuffer) bodyText = new TextDecoder().decode(b);
        else if (b && b.buffer instanceof ArrayBuffer) bodyText = new TextDecoder().decode(b); // TypedArray/DataView
        else if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) bodyText = b.toString();
      } catch (_) { return args; }
      if (bodyText) {
        const nb = injectRewriteBody(bodyText, block);
        if (nb != null) {
          consumed('init-nonstring');
          return [input, Object.assign({}, init, { body: nb })];
        }
      }
      return args;
    }
    return args;
  }
  // Test hook (parsers.test.mjs pattern) — pure functions only.
  try { window.__vodouInjectInternals = { injectRewriteBody, netInjectTarget }; } catch (_) {}
