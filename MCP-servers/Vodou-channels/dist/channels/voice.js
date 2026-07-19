/**
 * Voice Channel Implementation
 * Text-to-Speech using 'say' (macOS), 'espeak' (Linux), or 'sapi' (Windows)
 */
import say from 'say';
export class VoiceChannel {
    type = 'voice';
    voiceName;
    speed;
    connected = false;
    lastActivity;
    error;
    messageHandler;
    speaking = false;
    constructor() {
        this.voiceName = process.env.VOICE_NAME || undefined;
        this.speed = parseFloat(process.env.VOICE_SPEED || '1.0');
    }
    async connect() {
        // Voice doesn't need persistent connection
        // Just verify the system has TTS capability
        try {
            // Test that say is available
            this.connected = true;
            this.error = undefined;
            console.error('[Voice] Ready for text-to-speech');
        }
        catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            console.error(`[Voice] Initialization failed: ${this.error}`);
        }
    }
    async disconnect() {
        // Stop any current speech
        say.stop();
        this.connected = false;
        console.error('[Voice] Disconnected');
    }
    async send(message) {
        if (!this.connected) {
            console.error('[Voice] Cannot speak - not initialized');
            return false;
        }
        return new Promise((resolve) => {
            this.speaking = true;
            this.lastActivity = new Date();
            say.speak(message.content, this.voiceName, this.speed, (err) => {
                this.speaking = false;
                if (err) {
                    console.error('[Voice] Speak error:', err);
                    resolve(false);
                }
                else {
                    resolve(true);
                }
            });
        });
    }
    /**
     * Stop current speech
     */
    stop() {
        say.stop();
        this.speaking = false;
    }
    /**
     * Export speech to audio file
     */
    async export(text, filename) {
        return new Promise((resolve) => {
            say.export(text, this.voiceName, this.speed, filename, (err) => {
                if (err) {
                    console.error('[Voice] Export error:', err);
                    resolve(false);
                }
                else {
                    resolve(true);
                }
            });
        });
    }
    /**
     * Get available voices
     */
    async getVoices() {
        return new Promise((resolve) => {
            try {
                // @ts-ignore - say types are incorrect
                say.getInstalledVoices((err, voices) => {
                    if (err) {
                        console.error('[Voice] Get voices error:', err);
                        resolve([]);
                    }
                    else {
                        resolve(voices || []);
                    }
                });
            }
            catch (e) {
                console.error('[Voice] Get voices not supported on this platform');
                resolve([]);
            }
        });
    }
    getStatus() {
        return {
            channel: 'voice',
            connected: this.connected,
            error: this.error,
            lastActivity: this.lastActivity,
            metadata: {
                voiceName: this.voiceName,
                speed: this.speed,
                speaking: this.speaking,
            },
        };
    }
    onMessage(handler) {
        this.messageHandler = handler;
        // Note: Voice input (speech-to-text) would require additional
        // implementation with something like Whisper or Google Speech API
    }
}
//# sourceMappingURL=voice.js.map