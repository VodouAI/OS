/**
 * Vodou-Channels Types
 */

export type ChannelType = 'telegram' | 'slack' | 'discord' | 'voice' | 'web' | 'whatsapp' | 'imessage' | 'teams' | 'googlechat' | 'signal';

export interface IncomingMessage {
  id: string;
  channel: string;
  sender: string;
  senderName?: string;
  content: string;
  timestamp: Date;
  replyTo?: string;
  attachments?: Attachment[];
  raw?: any;
  /**
   * PLAN-MASTER-EXECUTION-ORDER item 2 (S-PRINCIPAL) — who is driving this turn.
   *   'owner' — on the sender allowlist. Full capability (today's behavior).
   *   'guest' — matched a listened ROOM only. May ask; no tools/shell/writes.
   * Computed by the bridge, which is where sender + room identity actually live.
   * Absent means owner: every channel not yet migrated to tiers is unchanged.
   */
  principal?: 'owner' | 'guest';
  /**
   * Vault scoping what a GUEST from this room may know — a vault name, or "*"
   * for the whole brain. Ignored for owners, who are never filtered.
   */
  guestVault?: string;
}

export interface OutgoingMessage {
  channel: string;
  recipient: string;
  content: string;
  /** Local filesystem path for WhatsApp bridge /api/send (image, doc, etc.) */
  mediaPath?: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'image' | 'audio' | 'video' | 'file';
  url?: string;
  data?: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface ChannelStatus {
  channel: string;
  connected: boolean;
  error?: string;
  warning?: string;
  lastActivity?: Date;
  metadata?: Record<string, any>;
}

export interface ChannelConfig {
  enabled: boolean;
  token?: string;
  [key: string]: any;
}

export type MessageHandler = (message: IncomingMessage) => Promise<string | null>;

export interface Channel {
  type: string;

  /**
   * Initialize and connect the channel
   */
  connect(): Promise<void>;

  /**
   * Disconnect the channel
   */
  disconnect(): Promise<void>;

  /**
   * Send a message through the channel
   */
  send(message: OutgoingMessage): Promise<boolean>;

  /**
   * Get channel status
   */
  getStatus(): ChannelStatus;

  /**
   * Set message handler for incoming messages
   */
  onMessage(handler: MessageHandler): void;
}
