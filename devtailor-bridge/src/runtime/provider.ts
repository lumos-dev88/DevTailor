/**
 * Provider types — describes the shape of a chat completion provider
 * without implementing any specific backend (OpenAI, Anthropic, etc.).
 */

import type { ContentPart, RuntimeToolCall } from './message';

// ── Finish reasons ─────────────────────────────────────────────────────

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error' | 'content_filter';

// ── Streamed parts ─────────────────────────────────────────────────────

export interface TextDeltaPart {
  type: 'text_delta';
  text: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  toolCall: RuntimeToolCall;
}

export interface DonePart {
  type: 'done';
  finishReason: FinishReason;
  /** Provider-specific usage data, if available. */
  usage?: unknown;
}

export interface ErrorPart {
  type: 'error';
  message: string;
  code?: string;
}

export type StreamedMessagePart = TextDeltaPart | ToolCallPart | DonePart | ErrorPart;

// ── Chat provider contract ─────────────────────────────────────────────

/**
 * A minimal streaming chat provider.
 *
 * Implementations should yield `StreamedMessagePart` values.
 * This file intentionally contains no I/O — concrete providers
 * (OpenAI, Anthropic, local, etc.) implement this interface elsewhere.
 */
export interface ChatProvider {
  /**
   * Send a list of messages and yield streamed response parts.
   */
  chat(
    messages: Array<{ role: string; content: ContentPart[] }>,
    tools?: Array<Record<string, unknown>>,
  ): AsyncIterable<StreamedMessagePart>;
}
