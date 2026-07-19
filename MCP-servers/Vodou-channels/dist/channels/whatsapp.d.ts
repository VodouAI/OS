/**
 * WhatsApp Channel — thin wrapper around the vendored whatsmeow bridge.
 *
 * Architecture:
 *   1. On connect(), spawn `whatsapp-bridge/whatsapp-bridge` as a child process
 *      with BRIDGE_STORE_DIR pointed at .vodou/whatsapp-auth so existing reset
 *      tooling continues to work.
 *   2. The bridge writes its QR code to <storeDir>/qr.txt — the gateway UI
 *      reads this same path. No extra plumbing needed.
 *   3. The bridge POSTs your own messages (IsFromMe) to BRIDGE_INCOMING_WEBHOOK;
 *      others' DMs are not forwarded. We run a tiny localhost server to receive
 *      them and forward through the message handler.
 *   4. Outbound messages POST to the bridge's /api/send.
 *
 * Why this replaces the previous Baileys implementation: Baileys 7.x rcs lag
 * WhatsApp Web protocol changes and we were getting consistent 405 handshake
 * rejections. whatsmeow (Go) is the most actively maintained WA Web client
 * and is the same one Vodou used successfully in earlier versions.
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '../types.js';
export declare class WhatsAppChannel implements Channel {
    type: "whatsapp";
    private bridge;
    private webhookServer;
    private connected;
    private loggedIn;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private healthPoller?;
    /** User or disconnectAll() requested shutdown — do not auto-respawn bridge */
    private intentionalDisconnect;
    private reconnectTimer;
    private allowlist;
    private recentOutbound;
    constructor();
    connect(): Promise<void>;
    private killOrphanedBridges;
    private startWebhookServer;
    /** Debounced respawn after unexpected bridge exit (standalone / long-running WA). */
    private scheduleBridgeReconnect;
    private startHealthPoller;
    private fetchHealth;
    private handleIncoming;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
}
//# sourceMappingURL=whatsapp.d.ts.map