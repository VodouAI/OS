/**
 * Conversation State Manager for Vodou-Console
 *
 * Manages conversation history for each client session.
 * Provides context persistence across messages.
 */

import Anthropic from '@anthropic-ai/sdk';

type MessageParam = Anthropic.Messages.MessageParam;

// Lazy import to avoid circular dependency — set by anthropic.ts
let _flushCallback: (() => void) | null = null;
export function setFlushCallback(cb: () => void): void {
  _flushCallback = cb;
}

interface ConversationState {
  id: string;
  messages: MessageParam[];
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

// Maximum messages to keep in history (user + assistant pairs)
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '40', 10);

// Conversation timeout (30 minutes)
const CONVERSATION_TIMEOUT = 30 * 60 * 1000;

export class ConversationManager {
  private conversations: Map<string, ConversationState> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Check every minute
  }

  /**
   * Get or create a conversation
   */
  getOrCreate(conversationId: string): ConversationState {
    let conversation = this.conversations.get(conversationId);

    if (!conversation) {
      conversation = {
        id: conversationId,
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date(),
        metadata: {}
      };
      this.conversations.set(conversationId, conversation);
    }

    return conversation;
  }

  /**
   * Add a user message to the conversation (plain text or multimodal blocks for Anthropic).
   */
  addUserMessage(conversationId: string, content: string | Anthropic.Messages.ContentBlockParam[]): void {
    const conversation = this.getOrCreate(conversationId);

    conversation.messages.push({
      role: 'user',
      content
    });

    conversation.lastActivity = new Date();
    this.trimHistory(conversation);
  }

  /**
   * Add an assistant message to the conversation
   */
  addAssistantMessage(
    conversationId: string,
    content: Anthropic.Messages.ContentBlock[]
  ): void {
    const conversation = this.getOrCreate(conversationId);

    conversation.messages.push({
      role: 'assistant',
      content
    });

    conversation.lastActivity = new Date();
    this.trimHistory(conversation);
  }

  /**
   * Add a tool result to the conversation.
   * Does NOT trim — callers should call trimAfterToolResults() after the full
   * batch of tool results has been added (trimming mid-batch orphans pairs).
   */
  addToolResult(
    conversationId: string,
    toolUseId: string,
    result: string,
    isError: boolean = false
  ): void {
    const conversation = this.getOrCreate(conversationId);

    conversation.messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: result,
          is_error: isError
        }
      ]
    });

    conversation.lastActivity = new Date();
    // Intentionally no trimHistory() here — trim after full batch via trimAfterToolResults()
  }

  /**
   * Trim history after a full batch of tool results has been added.
   * Safe to call after all addToolResult() calls for a single assistant turn.
   */
  trimAfterToolResults(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) this.trimHistory(conversation);
  }

  /**
   * Get all messages for a conversation
   */
  getMessages(conversationId: string): MessageParam[] {
    const conversation = this.conversations.get(conversationId);
    return conversation?.messages || [];
  }

  /**
   * Clear conversation history
   */
  clear(conversationId: string): void {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.messages = [];
      conversation.lastActivity = new Date();
    }
  }

  /**
   * Delete a conversation entirely
   */
  delete(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  /**
   * Get conversation metadata
   */
  getMetadata(conversationId: string): Record<string, unknown> {
    const conversation = this.conversations.get(conversationId);
    return conversation?.metadata || {};
  }

  /**
   * Set conversation metadata
   */
  setMetadata(conversationId: string, key: string, value: unknown): void {
    const conversation = this.getOrCreate(conversationId);
    conversation.metadata[key] = value;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalConversations: number;
    activeConversations: number;
    totalMessages: number;
  } {
    const now = Date.now();
    let activeCount = 0;
    let totalMessages = 0;

    for (const conv of this.conversations.values()) {
      totalMessages += conv.messages.length;
      if (now - conv.lastActivity.getTime() < CONVERSATION_TIMEOUT) {
        activeCount++;
      }
    }

    return {
      totalConversations: this.conversations.size,
      activeConversations: activeCount,
      totalMessages
    };
  }

  /**
   * Trim history to max size, preserving tool_use/tool_result pairs.
   *
   * Invariants maintained:
   * 1. messages.length <= MAX_HISTORY (soft — may exceed by a few to keep pairs intact)
   * 2. Every tool_use block has its matching tool_result, and vice-versa
   * 3. First message is role:user with text content (not tool_result)
   */
  private trimHistory(conversation: ConversationState): void {
    while (conversation.messages.length > MAX_HISTORY) {
      const first = conversation.messages[0];
      if (!first) break;

      // Collect all tool_use IDs if this is an assistant message
      if (first.role === 'assistant' && Array.isArray(first.content)) {
        const toolIds = new Set<string>();
        for (const b of first.content as any[]) {
          if (b.type === 'tool_use' && b.id) toolIds.add(b.id);
        }

        // If assistant has tool_use blocks, remove it AND all following
        // user messages that contain tool_results for those IDs
        if (toolIds.size > 0) {
          conversation.messages.shift();
          while (conversation.messages.length > 0) {
            const next = conversation.messages[0];
            if (next.role === 'user' && Array.isArray(next.content)) {
              const allToolResults = (next.content as any[]).every(
                (b: any) => b.type === 'tool_result' && toolIds.has(b.tool_use_id)
              );
              if (allToolResults) {
                conversation.messages.shift();
                continue;
              }
            }
            break;
          }
          continue; // Re-check length
        }
      }

      // If first message is a user tool_result (orphaned — its tool_use is gone),
      // remove it to prevent API errors
      if (first.role === 'user' && Array.isArray(first.content)) {
        const allToolResults = (first.content as any[]).every(
          (b: any) => b.type === 'tool_result'
        );
        if (allToolResults) {
          conversation.messages.shift();
          continue;
        }
      }

      // Normal case: remove a plain user or assistant text message
      conversation.messages.shift();
    }

    // Post-trim: ensure conversation starts with a user text message.
    // The API rejects conversations starting with role:assistant or tool_result.
    while (conversation.messages.length > 0) {
      const first = conversation.messages[0];

      // Assistant as first message — remove it (and its tool_results)
      if (first.role === 'assistant') {
        const toolIds = new Set<string>();
        if (Array.isArray(first.content)) {
          for (const b of first.content as any[]) {
            if (b.type === 'tool_use' && b.id) toolIds.add(b.id);
          }
        }
        conversation.messages.shift();
        // Remove orphaned tool_results for this assistant
        if (toolIds.size > 0) {
          while (conversation.messages.length > 0) {
            const next = conversation.messages[0];
            if (next.role === 'user' && Array.isArray(next.content)) {
              const allTR = (next.content as any[]).every(
                (b: any) => b.type === 'tool_result' && toolIds.has(b.tool_use_id)
              );
              if (allTR) { conversation.messages.shift(); continue; }
            }
            break;
          }
        }
        continue;
      }

      // Orphaned tool_result as first message — remove it
      if (first.role === 'user' && Array.isArray(first.content)) {
        const allTR = (first.content as any[]).every(
          (b: any) => b.type === 'tool_result'
        );
        if (allTR) { conversation.messages.shift(); continue; }
      }

      // First message is a proper user text message — good
      break;
    }
  }

  /**
   * Cleanup old conversations — triggers memory flush when conversations with
   * actual exchanges expire (gateway equivalent of SessionEnd).
   */
  private cleanup(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, conv] of this.conversations) {
      if (now - conv.lastActivity.getTime() > CONVERSATION_TIMEOUT) {
        expiredIds.push(id);
      }
    }

    if (expiredIds.length > 0) {
      // Check if any expired conversation had real exchanges worth flushing
      let hadMessages = false;
      for (const id of expiredIds) {
        const conv = this.conversations.get(id);
        if (conv && conv.messages.length >= 2) {
          hadMessages = true;
        }
        console.error(`[ConversationManager] Cleaning up expired conversation: ${id} (${conv?.messages.length || 0} messages)`);
        this.conversations.delete(id);
      }

      // Trigger memory flush if we had real conversations — their content is
      // already in .prompt_buffer from per-turn saves, just needs extraction
      if (hadMessages && _flushCallback) {
        _flushCallback();
      }
    }
  }

  /**
   * Shutdown the manager
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.conversations.clear();
  }
}

// Singleton instance
let instance: ConversationManager | null = null;

export function getConversationManager(): ConversationManager {
  if (!instance) {
    instance = new ConversationManager();
  }
  return instance;
}
