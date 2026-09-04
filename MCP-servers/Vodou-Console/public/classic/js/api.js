/**
 * Shared API helper for dashboard
 */

/**
 * Thrown when a request exceeds its timeout. Typed so callers can do
 * `if (err instanceof TimeoutError)` or `if (err.name === 'TimeoutError')`.
 */
class TimeoutError extends Error {
  constructor(message, timeoutMs) {
    super(message || 'Request timed out');
    this.name = 'TimeoutError';
    this.timeout = timeoutMs;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Core request helper.
 * @param {string} method
 * @param {string} path
 * @param {*} [body] JSON-serializable body (omitted for GET/DELETE-style calls)
 * @param {{ timeout?: number, signal?: AbortSignal, headers?: object }} [options]
 *   timeout: ms before aborting (default 30000). Pass 0 to disable.
 *   signal:  caller's AbortSignal — aborting it also aborts this request.
 *   headers: extra/override request headers.
 * @returns {Promise<*|null>} parsed JSON, or null for 204/empty bodies.
 */
async function api(method, path, body, options) {
  const o = options || {};
  const timeoutMs = o.timeout == null ? DEFAULT_TIMEOUT_MS : o.timeout;

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(o.headers || {}) },
  };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

  // AbortController wiring: our own timeout, plus an optional caller signal.
  const controller = new AbortController();
  opts.signal = controller.signal;

  let timedOut = false;
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  let onCallerAbort = null;
  if (o.signal) {
    if (o.signal.aborted) controller.abort();
    else {
      onCallerAbort = () => controller.abort();
      o.signal.addEventListener('abort', onCallerAbort);
    }
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (timedOut) {
      throw new TimeoutError(`Request to ${path} timed out after ${timeoutMs}ms`, timeoutMs);
    }
    throw err; // network failure, or caller-initiated abort
  } finally {
    if (timer) clearTimeout(timer);
    if (o.signal && onCallerAbort) o.signal.removeEventListener('abort', onCallerAbort);
  }

  if (!res.ok) {
    const text = await res.text();
    let message = text || `HTTP ${res.status}`;
    let parsedBody = null;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        parsedBody = parsed;
        // Surface a human message instead of dumping raw JSON braces.
        message = parsed.error || parsed.message || text;
      } catch (_) {
        // Non-JSON body — use the raw text as-is.
      }
    }
    const error = new Error(message);
    error.status = res.status; // let callers branch on HTTP status (e.g. 404, 409)
    error.data = parsedBody;   // parsed JSON body, so callers can read fields like upgrade_url
    throw error;
  }

  // 204 No Content, or any empty body → return null instead of letting
  // res.json() throw "Unexpected end of JSON input".
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

// Convenience wrappers — signatures unchanged; trailing `options` is optional.
const API = {
  get: (path, options) => api('GET', path, undefined, options),
  post: (path, body, options) => api('POST', path, body, options),
  put: (path, body, options) => api('PUT', path, body, options),
  patch: (path, body, options) => api('PATCH', path, body, options),
  del: (path, options) => api('DELETE', path, undefined, options),
};
