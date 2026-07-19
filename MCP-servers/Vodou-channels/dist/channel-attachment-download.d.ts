/**
 * Download channel attachments to a local dir the gateway can read (vision / strict roots).
 * Default: <VODOU_PROJECT_PATH>/.vodou/channel-attachments — same tree as whatsapp-auth for one CHANNEL_MEDIA_ROOTS prefix.
 */
import type { Attachment } from './types.js';
export declare function getOiAttachmentsDir(): string;
export declare function mimeToAttachmentType(mimeType: string): Attachment['type'];
/**
 * Write bytes to Vodou attachment dir; returns Attachment with url = absolute local path.
 */
export declare function saveBufferAsAttachment(buffer: Buffer, filename: string, mimeType: string, idPrefix: string): Promise<Attachment | null>;
//# sourceMappingURL=channel-attachment-download.d.ts.map