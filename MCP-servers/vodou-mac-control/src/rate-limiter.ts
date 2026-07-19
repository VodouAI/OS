/**
 * Token-bucket rate limiter for mutation actions.
 * Default: 5 actions/sec, burst 10. traverse/screenshot/check_permission are free.
 */

const MAX_TOKENS = 10;
const REFILL_RATE = 5; // tokens per second
const REFILL_INTERVAL = 1000 / REFILL_RATE; // ms between refills

let tokens = MAX_TOKENS;
let lastRefill = Date.now();

function refill() {
  const now = Date.now();
  const elapsed = now - lastRefill;
  const newTokens = Math.floor(elapsed / REFILL_INTERVAL);
  if (newTokens > 0) {
    tokens = Math.min(MAX_TOKENS, tokens + newTokens);
    lastRefill = now;
  }
}

const READ_ONLY_TOOLS = new Set([
  'traverse',
  'screenshot',
  'clipboard_read',
  'list_windows',
  'check_permission',
]);

/**
 * Try to consume a rate limit token.
 * Returns true if allowed, false if rate limited.
 */
export function tryConsume(toolName: string): boolean {
  // Read-only tools are free
  if (READ_ONLY_TOOLS.has(toolName)) return true;

  refill();

  if (tokens > 0) {
    tokens--;
    return true;
  }
  return false;
}
