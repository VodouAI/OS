import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
const PROJECT_ROOT = process.env.VODOU_PROJECT_PATH || process.cwd();
export function getAttachmentsDir() {
    if (process.env.VODOU_CHANNEL_ATTACHMENTS_DIR?.trim()) {
        return process.env.VODOU_CHANNEL_ATTACHMENTS_DIR.trim();
    }
    return join(PROJECT_ROOT, '.vodou', 'channel-attachments');
}
export function mimeToAttachmentType(mimeType) {
    const m = (mimeType || '').toLowerCase();
    if (m.startsWith('image/'))
        return 'image';
    if (m.startsWith('audio/'))
        return 'audio';
    if (m.startsWith('video/'))
        return 'video';
    return 'file';
}
export async function saveBufferAsAttachment(buffer, filename, mimeType, idPrefix) {
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
    }
    catch (err) {
        console.error('[ChannelAttachments] save failed:', err);
        return null;
    }
}
//# sourceMappingURL=attachments.js.map