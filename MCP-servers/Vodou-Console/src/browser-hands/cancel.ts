/**
 * Browser Hands: STOP from the phone reaches the errand (PLAN-BROWSER-HANDS §13.7).
 *
 * The relay turns a texted STOP into {cancel: true} (APP #89) and the tunnel
 * client aborts the running /chat turn (DEV #260) — but aborting the HTTP call
 * doesn't stop a browser loop already running inside it, and an errand waiting
 * at a question or a "yes" isn't a running turn at all. So the tunnel client
 * also calls cancelBrowserErrands(), and the service registers the handler.
 * A registry rather than an import: the tunnel client stays free of the
 * browser stack, and with Browser Hands off nothing is registered.
 */
type Canceller = (conversationId: string) => Promise<boolean>;
let handler: Canceller | null = null;

export function onBrowserCancel(fn: Canceller | null): void {
  handler = fn;
}

/** Stop any errand (running or waiting) in this conversation. True if one was stopped. */
export async function cancelBrowserErrands(conversationId: string): Promise<boolean> {
  if (!handler) return false;
  try { return await handler(conversationId); } catch { return false; }
}
