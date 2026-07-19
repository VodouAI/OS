import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import type { Attachment } from './types.js';

const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();

export function getAttachmentsDir(): string {
  if (process.env.VODOU_CHANNEL_ATTACHMENTS_DIR?.trim()) {
    return process.env.VODOU_CHANNEL_ATTACHMENTS_DIR.trim();
  }
  return join(PROJECT_ROOT, '.vodou', 'channel-attachments');
}

export function mimeToAttachmentType(mimeType: string): Attachment['type'] {
  const m = (mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

export async function saveBufferAsAttachment(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  idPrefix: string
): Promise<Attachment | null> {
  try {
    const attachDir = getAttachmentsDir();
    await mkdir(attachDir, { recursive: true });
    const base = (filename || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
    const safePrefix = String(idPrefix).replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80);
    const localPath = join(attachDir, `${safePrefix}_${base}`);
    await writeFile(localPath, buffer);
    return {
      type: mimeToAttachmentType(mimeType),
      url: localPath,
      mimeType: mimeType || 'application/octet-stream',
      filename: filename || base,
    };
  } catch (err) {
    console.error('[ChannelAttachments] save failed:', err);
    return null;
  }
}
