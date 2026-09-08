/**
 * Google Chat app — HTTP POST /api/googlechat, outbound via Chat REST API
 * (@googleapis/chat + service account).
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '../types.js';
export declare class GoogleChatChannel implements Channel {
    type: "googlechat";
    private app;
    private server;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    private credsJson;
    private port;
    private chatApi;
    /**
     * SEC-1 — bind loopback by default.
     *
     * `listen(port)` with no host binds EVERY interface, so this endpoint was
     * reachable from the whole local network (and from anywhere that could reach
     * the host) while accepting `req.body` with no verification at all. The
     * documented deployment is "your public URL + /api/googlechat", i.e. through
     * a reverse proxy or tunnel — which works fine against loopback and is the
     * only shape where the operator has decided to expose it.
     */
    private host;
    /**
     * SEC-1 — the audience Google signs its request JWT for: your Chat app's
     * project number. Verification is skipped, loudly, when it is not configured,
     * because a silent skip is the state this finding is about.
     */
    private audience;
    constructor();
    /**
     * SEC-1 — is this POST actually from Google Chat?
     *
     * Google signs every request to a Chat app's HTTP endpoint with a Bearer JWT
     * issued by `chat@system.gserviceaccount.com`, audienced to the app's project
     * number. Nothing checked it: the handler answered 200 and dispatched
     * `req.body` straight into the message pipeline, so anything that could reach
     * the port could inject a message as any sender. Teams already verifies via
     * the Bot Framework; this lane simply did not.
     *
     * Returns null when the request is good, or the reason to refuse it.
     */
    private verifyGoogleRequest;
    connect(): Promise<void>;
    private handleEventPayload;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
}
export type GoogleChatRouting = {
    space: string;
    thread?: string;
};
export declare function decodeGoogleChatRecipient(recipient: string): GoogleChatRouting | null;
//# sourceMappingURL=googlechat.d.ts.map