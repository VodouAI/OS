/**
 * Heartbeat channel delivery throttle. PLAN-HEARTBEAT-IS-THE-BRIEFING v2 P3.
 *
 * The 2 h heartbeat loop is for NOTICING; delivery to a channel is daily by
 * default — twelve briefings a day is spam, and the five skills that deliver
 * successfully all deliver daily. Factored out of the WebSocket handler in
 * index.ts so the rule has a test; it never had one.
 */
export type DeliveryFrequency = 'daily' | 'every_4h' | string;

const WINDOW_MS: Record<string, number> = { daily: 86_400_000, every_4h: 14_400_000 };

/**
 * @param lastDeliveryText contents of heartbeat_last_delivery.json, or null when
 *   nothing has ever been delivered (first delivery always goes)
 */
export function shouldDeliverNow(lastDeliveryText: string | null, freq: DeliveryFrequency, nowMs: number): boolean {
  if (!lastDeliveryText) return true;
  let lastMs: number;
  try {
    const last = JSON.parse(lastDeliveryText) as { timestamp?: string };
    lastMs = new Date(String(last.timestamp ?? '')).getTime();
  } catch {
    return true; // an unreadable receipt is no receipt
  }
  if (!Number.isFinite(lastMs)) return true;
  const window = WINDOW_MS[freq];
  if (window === undefined) return true; // an unknown frequency is "always" — the old behaviour, unchanged
  return nowMs - lastMs >= window;
}
