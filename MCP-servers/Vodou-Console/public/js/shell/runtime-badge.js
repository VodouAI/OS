(function () {
  'use strict';
  var POLL_MS = 25000;

  function mapOverall(o) {
    if (o === 'healthy') return { state: 'healthy', title: 'Kernel: healthy — open System for details' };
    if (o === 'degraded') return { state: 'degraded', title: 'Kernel: degraded — open System' };
    if (o === 'down') return { state: 'down', title: 'Kernel: down — open System' };
    return { state: 'unknown', title: 'Kernel status unavailable' };
  }

  function applyFooter(el, info) {
    if (!el) return;
    el.className = 'chat-runtime-badge chat-runtime-badge--' + info.state;
    el.setAttribute('title', info.title);
    el.textContent = 'Kernel';
  }

  function applyMenubar(info) {
    var kernel = document.getElementById('shell-ind-kernel');
    if (!kernel) return;
    var dot = kernel.querySelector('.shell-kernel-dot');
    var txt = kernel.querySelector('.shell-status-text');
    if (dot) dot.setAttribute('data-state', info.state);
    if (txt) {
      if (info.state === 'healthy') txt.textContent = 'OK';
      else if (info.state === 'degraded') txt.textContent = '!';
      else if (info.state === 'down') txt.textContent = '×';
      else txt.textContent = '…';
    }
    kernel.setAttribute('title', info.title);
  }

  async function tick() {
    var info = mapOverall(null);
    try {
      var res = await fetch('/api/system', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('bad');
      var data = await res.json();
      var o = data.runtime && data.runtime.overall;
      info = mapOverall(typeof o === 'string' ? o : null);
    } catch (_) {}
    applyFooter(document.getElementById('chat-runtime-badge'), info);
    applyMenubar(info);
  }

  document.addEventListener('DOMContentLoaded', function () {
    tick();
    setInterval(tick, POLL_MS);
  });
})();
