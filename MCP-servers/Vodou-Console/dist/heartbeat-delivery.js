const WINDOW_MS = { daily: 86_400_000, every_4h: 14_400_000 };
/**
 * @param lastDeliveryText contents of heartbeat_last_delivery.json, or null when
 *   nothing has ever been delivered (first delivery always goes)
 */
export function shouldDeliverNow(lastDeliveryText, freq, nowMs) {
    if (!lastDeliveryText)
        return true;
    let lastMs;
    try {
        const last = JSON.parse(lastDeliveryText);
        lastMs = new Date(String(last.timestamp ?? '')).getTime();
    }
    catch {
        return true; // an unreadable receipt is no receipt
    }
    if (!Number.isFinite(lastMs))
        return true;
    const window = WINDOW_MS[freq];
    if (window === undefined)
        return true; // an unknown frequency is "always" — the old behaviour, unchanged
    return nowMs - lastMs >= window;
}
