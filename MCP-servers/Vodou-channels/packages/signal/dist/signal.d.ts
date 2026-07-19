/**
 * Signal — inbound via `signal-cli … jsonRpc` (line-delimited JSON-RPC on stdio),
 * outbound via the same RPC `send` while connected.
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare function encodeSignalRecipient(phone: string | null | undefined, groupId: string | null | undefined): string;
export type SignalRouting = {
    phone?: string;
    groupId?: string;
};
export declare function decodeSignalRecipient(recipient: string): SignalRouting | null;
export declare class SignalChannel implements Channel {
    type: "signal";
    private proc;
    private rl;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private allowlist;
    private pending;
    private nextRpcId;
    private ownDigits;
    connect(): Promise<void>;
    private handleLine;
    private onReceive;
    private rpcCall;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=signal.d.ts.map