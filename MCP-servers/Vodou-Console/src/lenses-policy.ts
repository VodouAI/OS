/**
 * Visual lenses run only in the primary gateway web chat (#/chat, source=web).
 * Messaging channels, workbench tabs, heartbeat, and external clients get
 * plain-text replies without lens instructions or ```lens fences.
 */

/** Closed ```lens ... ``` blocks and trailing unclosed fences. */
const LENS_FENCE_RE = /```lens\s*\n[\s\S]*?```/g;
const LENS_FENCE_OPEN_RE = /```lens\s*\n[\s\S]*$/;

/**
 * True when this conversation may use lens system-prompt instructions and
 * gateway lens fetch/render (primary web chat only).
 */
export function lensesAllowedForConversation(
  convId: string,
  source?: string | null,
): boolean {
  if (!convId || convId.startsWith('workbench:')) return false;
  const s = (source || '').trim().toLowerCase();
  if (s && s !== 'web') return false;
  return true;
}

/** Remove lens fenced blocks; keep prose that precedes them. */
export function stripLensBlocks(text: string): string {
  if (!text || !text.includes('```lens')) return text;
  return text
    .replace(LENS_FENCE_RE, '')
    .replace(LENS_FENCE_OPEN_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text for Telegram/Slack/etc. delivery. */
export function channelOutboundText(text: string): string {
  return stripLensBlocks(text);
}
