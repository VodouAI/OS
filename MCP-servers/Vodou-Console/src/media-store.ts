/**
 * Where Vodou keeps pictures and files people send it — texted to the Vodou
 * line, or attached in /simple — so they are still there tomorrow.
 *
 * They used to go to /tmp (texted: /private/tmp/vodou-texted-media; attached:
 * /tmp/vodou-drop-*), which macOS clears on its own, so older pictures in the
 * thread turned into "(picture no longer on this computer)". Chad, 2026-09-26:
 * "Keep texted pictures permanently ... move them into Vodou's own folder."
 *
 * `.vodou/media` under the project root (git-ignored with the rest of .vodou/).
 * The gateway itself writes here, so channelAttachments.ts always allows it,
 * even under CHANNEL_MEDIA_STRICT with roots that don't name it.
 */
import path from 'path';
import { getProjectRoot } from './db.js';

export function vodouMediaRoot(): string {
  return process.env.VODOU_MEDIA_DIR || path.join(getProjectRoot(), '.vodou', 'media');
}

export function vodouMediaDir(kind: 'texted' | 'uploads'): string {
  return path.join(vodouMediaRoot(), kind);
}
