// Test-only access to the netcap parsers.
//
// inject.js used to end with `window.__vodouNetCapParsers = {…}`, which is how the
// parser tests reached ~30 pure functions. That export was removed in fdbee668
// because it ran in the MAIN world: every page the extension touched could read the
// parsers off its own `window`. Removing it was right, and it silently took the
// parser test suite with it — 52 tests stopped exercising anything, and nothing
// said so, because a suite that cannot construct its subject still exits non-zero
// in a way that reads like ordinary failure.
//
// The seam is restored HERE instead: the export is appended to the source string
// inside the test process, so the functions are reachable from a test and remain
// unreachable from a page. Nothing is added to the shipped file.
//
// Keep this list in sync when an adapter is added — an adapter missing from it is
// simply untestable, not broken, so the failure mode is a quiet coverage gap.
import fs from 'node:fs';

const EXPORTS = [
  'sniffModel',
  'parseChatGPT', 'parseClaude', 'parseGemini', 'parsePerplexity', 'parseGrok', 'parseGrokX',
  'parseDeepSeek', 'parseLeChat', 'parseMetaAI', 'parseAIStudio', 'parseCopilotFrames',
  'parseManus', 'parseQwen', 'parseKimi', 'parseDuckAI', 'parseHuggingChat', 'parseYouCom',
  'parseMetaAIFrames', 'parseZai', 'parseT3Chat', 'parseOpenRouter', 'parseNotebookLM',
  'parsePoeFrames', 'parseCharacterAI', 'parseCopilotHistory', 'sseDataChunks', 'jsonLines', 'vercelStreamText',
  'lastUserContent', 'redactRecord', 'redact', 'redactUrl', 'stripInlineReasoning',
];

/**
 * Evaluate a build's inject.js against a stubbed window.
 *
 * Returns { P, internals } where `internals` is window.__vodouInjectInternals —
 * present in the sideload build and ABSENT in the store build, which stubs the
 * PLAN-AUTO-INJECT-P4 network body-rewrite out on purpose. Callers must SKIP
 * rather than fail when it is missing: a store build without it is correct.
 */
export function loadInject(injectUrl) {
  const src = fs.readFileSync(injectUrl, 'utf8');

  // Appended INSIDE the IIFE: find its final closing so the assignment sees the
  // function scope. The file ends with the IIFE's `})();` — everything before it
  // is the body, so splicing at the last occurrence puts the export in scope.
  const close = src.lastIndexOf('})();');
  if (close < 0) throw new Error('could not find the inject.js IIFE close — harness needs updating');

  const shim = '\n  try { window.__vodouNetCapParsers = { ' + EXPORTS.join(', ') + ' }; } catch (e) {}\n';
  const patched = src.slice(0, close) + shim + src.slice(close);

  const windowStub = {
    addEventListener() {},
    postMessage() {},
    fetch: async () => ({}),
    XMLHttpRequest: undefined,
    WebSocket: undefined,
  };
  new Function('window', patched)(windowStub);

  const P = windowStub.__vodouNetCapParsers;
  if (!P) throw new Error('parsers did not export — the IIFE shape changed');
  const missing = EXPORTS.filter((n) => typeof P[n] !== 'function');
  if (missing.length) throw new Error('not exported as functions: ' + missing.join(', '));
  return { P, internals: windowStub.__vodouInjectInternals };
}

/** Convenience for the common case: just the parsers. */
export function loadParsers(injectUrl) {
  return loadInject(injectUrl).P;
}
