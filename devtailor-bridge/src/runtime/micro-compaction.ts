/**
 * Micro-compaction — lightweight, deterministic compression of old tool
 * results in a message history. No LLM involved.
 *
 * Strategy:
 *   1. Keep the last `keepLastN` messages untouched (recent context).
 *   2. For older messages, replace large `tool_result` content parts with
 *      a short marker string.
 *   3. Optionally replace old `image` content parts with a text marker
 *      to reclaim base64 bulk.
 *
 * This runs in-place on the messages array (mutates content arrays).
 */

import type { RuntimeMessage, ContentPart } from './message';

export interface MicroCompactionOptions {
  /** Number of tail messages to keep untouched. Default: 4. */
  keepLastN?: number;
  /** Tool-result content longer than this (chars) gets compacted. Default: 2000. */
  maxToolResultChars?: number;
  /** Also compact old image content parts. Default: true. */
  compactImages?: boolean;
}

const DEFAULT_KEEP_LAST_N = 4;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 2000;

/**
 * Compact large tool results (and optionally images) in older messages.
 * Returns the same array reference for convenience.
 */
export function microCompactMessages(
  messages: RuntimeMessage[],
  options?: MicroCompactionOptions,
): RuntimeMessage[] {
  const keepLastN = options?.keepLastN ?? DEFAULT_KEEP_LAST_N;
  const maxToolResultChars = options?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const compactImages = options?.compactImages ?? true;

  if (messages.length <= keepLastN) return messages;

  // Everything before (messages.length - keepLastN) is eligible for compaction.
  const cutoff = messages.length - keepLastN;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (!msg.content || msg.content.length === 0) continue;

    let changed = false;
    const newContent: ContentPart[] = [];

    for (const part of msg.content) {
      if (
        part.type === 'tool_result' &&
        typeof part.content === 'string' &&
        part.content.length > maxToolResultChars
      ) {
        // Replace large tool result with a short marker.
        newContent.push({
          type: 'tool_result',
          toolCallId: part.toolCallId,
          content: `[compacted: tool result cleared, was ${part.content.length} chars]`,
          isError: part.isError,
        });
        changed = true;
      } else if (part.type === 'image' && compactImages) {
        // Replace base64 image with a text note so the model knows an image existed.
        newContent.push({
          type: 'text',
          text: `[compacted: image removed, mediaType=${part.mediaType}]`,
        });
        changed = true;
      } else {
        newContent.push(part);
      }
    }

    if (changed) {
      msg.content = newContent;
    }
  }

  return messages;
}
