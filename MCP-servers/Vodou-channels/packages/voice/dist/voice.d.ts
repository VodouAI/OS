/**
 * Voice Channel Implementation
 * Text-to-Speech using 'say' (macOS), 'espeak' (Linux), or 'sapi' (Windows)
 */
import { Channel, ChannelStatus, OutgoingMessage, MessageHandler } from '@vodou/channel-sdk';
export declare class VoiceChannel implements Channel {
    type: "voice";
    private voiceName?;
    private speed;
    private connected;
    private lastActivity?;
    private error?;
    private messageHandler?;
    private speaking;
    constructor();
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    send(message: OutgoingMessage): Promise<boolean>;
    /**
     * Stop current speech
     */
    stop(): void;
    /**
     * Export speech to audio file
     */
    export(text: string, filename: string): Promise<boolean>;
    /**
     * Get available voices
     */
    getVoices(): Promise<string[]>;
    getStatus(): ChannelStatus;
    onMessage(handler: MessageHandler): void;
    manifest(): import('@vodou/channel-sdk').ChannelManifest;
}
//# sourceMappingURL=voice.d.ts.map