/**
 * page-presence — "which page was open while this memory was created?"
 *
 * PLAN-MEMORY-ON-EVERY-PAGE P0, Architecture §5.
 *
 * The plan is emphatic that a passive browsing log is NEVER built. A silent local
 * record of pages visited is a Chrome Web Store violation ("Purple Magnesium",
 * capability (e) in the plan's verdict table) regardless of it being local-only,
 * and it is also just the wrong shape: nobody wants a history file.
 *
 * Presence is therefore an ATTRIBUTE of a memory that is being created anyway. A
 * page you merely looked at produces no row. A page you were on while writing
 * something produces one column on that something. The difference is the whole
 * compliance argument, and it is enforced here by having exactly one caller
 * shape: `currentPageUrl()` is consulted at INSERT time or not at all.
 *
 * Off by default. `memory.page.enabled` must be explicitly turned on, and the
 * plan pairs that with an in-product first-run disclosure card (P1) because
 * User-Data FAQ Q10 says listing text alone does not satisfy consent.
 */

import { getSetting } from './db.js';
import { normalizeUrl } from './page-id.js';

/** Is page-memory turned on? Default OFF — an unset value is a NO. */
export function pagePresenceEnabled(): boolean {
  try {
    const v = getSetting('memory.page.enabled');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/**
 * The normalized page key for the tab that is open right now, or null.
 *
 * Null on every uncertain path — toggle off, extension not connected, tab is not
 * an http(s) page, stale report. Provenance you are unsure about is worse than
 * none: a wrong page stamp would put a memory on a page it never came from, and
 * T1 would then confidently show it there.
 */
export function currentPageUrl(activeTab: { url?: string; updated_at?: number } | null): string | null {
  if (!pagePresenceEnabled()) return null;
  if (!activeTab || !activeTab.url) return null;
  // A tab report older than 5 minutes is not evidence of where you are now.
  if (activeTab.updated_at && Date.now() - activeTab.updated_at > 5 * 60_000) return null;
  const pid = normalizeUrl(activeTab.url);
  return pid ? pid.pageKey : null;
}
