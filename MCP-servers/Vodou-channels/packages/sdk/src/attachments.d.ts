import type { Attachment } from './types.js';
export declare function getAttachmentsDir(): string;
export declare function mimeToAttachmentType(mimeType: string): Attachment['type'];
export declare function saveBufferAsAttachment(buffer: Buffer, filename: string, mimeType: string, idPrefix: string): Promise<Attachment | null>;
//# sourceMappingURL=attachments.d.ts.map