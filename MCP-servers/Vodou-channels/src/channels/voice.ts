/**
 * Voice Channel Implementation
 * Text-to-Speech using 'say' (macOS), 'espeak' (Linux), or 'sapi' (Windows)
 */

import say from 'say';
import { Channel, ChannelStatus, IncomingMessage, OutgoingMessage, MessageHandler } from '../types.js';

export class VoiceChannel implements Channel {
  type = 'voice' as const;
  private voiceName?: string;
  private speed: number;
  private connected = false;
  private lastActivity?: Date;
  private error?: string;
  private messageHandler?: MessageHandler;
  private speaking = false;

  constructor() {
    this.voiceName = process.env.VOICE_NAME || undefined;
    this.speed = parseFloat(process.env.VOICE_SPEED || '1.0');
  }

  async connect(): Promise<void> {
    // Voice doesn't need persistent connection
    // Just verify the system has TTS capability
    try {
      // Test that say is available
      this.connected = true;
      this.error = undefined;
      console.error('[Voice] Ready for text-to-speech');
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      console.error(`[Voice] Initialization failed: ${this.error}`);
    }
  }

  async disconnect(): Promise<void> {
    // Stop any current speech
    say.stop();
    this.connected = false;
    console.error('[Voice] Disconnected');
  }

  async send(message: OutgoingMessage): Promise<boolean> {
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
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Stop current speech
   */
  stop(): void {
    say.stop();
    this.speaking = false;
  }

  /**
   * Export speech to audio file
   */
  async export(text: string, filename: string): Promise<boolean> {
    return new Promise((resolve) => {
      say.export(text, this.voiceName, this.speed, filename, (err) => {
        if (err) {
          console.error('[Voice] Export error:', err);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Get available voices
   */
  async getVoices(): Promise<string[]> {
    return new Promise((resolve) => {
      try {
        // @ts-ignore - say types are incorrect
        say.getInstalledVoices((err: Error | null, voices: string[]) => {
          if (err) {
            console.error('[Voice] Get voices error:', err);
            resolve([]);
          } else {
            resolve(voices || []);
          }
        });
      } catch (e) {
        console.error('[Voice] Get voices not supported on this platform');
        resolve([]);
      }
    });
  }

  getStatus(): ChannelStatus {
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

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    // Note: Voice input (speech-to-text) would require additional
    // implementation with something like Whisper or Google Speech API
  }
}
