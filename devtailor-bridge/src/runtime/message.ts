/**
 * Runtime message types — lightweight conversation primitives.
 *
 * These are intentionally provider-agnostic and carry no I/O logic.
 */

// ── Roles ──────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ── Content parts ──────────────────────────────────────────────────────

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image';
  /** Base64-encoded image data or a URL. */
  data: string;
  /** MIME type, e.g. "image/png". */
  mediaType: string;
}

export interface ToolResultContentPart {
  type: 'tool_result';
  /** The id of the tool call this result responds to. */
  toolCallId: string;
  /** Textual output produced by the tool. */
  content: string;
  /** Whether the tool execution errored. */
  isError?: boolean;
}

export type ContentPart = TextContentPart | ImageContentPart | ToolResultContentPart;

// ── Tool calls embedded in assistant messages ───────────────────────────

export interface RuntimeToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

// ── Top-level message ──────────────────────────────────────────────────

export interface RuntimeMessage {
  role: MessageRole;
  content: ContentPart[];
  /** Tool calls issued by the assistant in this turn (assistant role only). */
  toolCalls?: RuntimeToolCall[];
}
