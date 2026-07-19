/**
 * platform.js — server-OS awareness for onboarding/UI copy.
 *
 * The gateway serves one machine; the OS that matters for install commands,
 * demo labels, and mac-only features is the SERVER's (from
 * /api/onboarding/status.platform), not the browser's. Until the fetch
 * resolves we fall back to a UA sniff (right >99% of the time since the
 * browser and gateway are the same box for localhost installs).
 *
 * Load this before any view script. Synchronous-safe: reads are plain
 * globals; the async fetch upgrades the guess and re-renders nothing itself
 * (views read it at render time; onboarding re-renders per step anyway).
 */
(function () {
  function uaGuess() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/win/i.test(p)) return 'windows';
    if (/mac/i.test(p)) return 'mac';
    return 'linux';
  }
  window.VODOU_OS = uaGuess();
  window.vodouModKey = function () { return window.VODOU_OS === 'mac' ? '⌘' : 'Ctrl'; };
  window.vodouModChord = function (key) {
    return window.VODOU_OS === 'mac' ? '⌘' + key : 'Ctrl+' + key;
  };
  // Authoritative upgrade from the server.
  fetch('/api/onboarding/status')
    .then((r) => r.json())
    .then((s) => { if (s && s.platform) window.VODOU_OS = s.platform; })
    .catch(() => { /* keep UA guess */ });
})();
