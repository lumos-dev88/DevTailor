/**
 * OpenAI-compatible streaming chat provider.
 *
 * Talks to any `/v1/chat/completions` endpoint that follows the OpenAI SSE
 * streaming protocol. No real API keys are embedded; all credentials and
 * base URLs come from the constructor.
 */

import type { ContentPart, RuntimeMessage, RuntimeToolCall } from './message';
import type {
  ChatProvider,
  StreamedMessagePart,
  FinishReason,
} from './provider';
import { isContextOverflow, ERROR_CONTEXT_OVERFLOW } from './errors';

// ── Constructor options ────────────────────────────────────────────────

export interface OpenAICompatibleProviderOptions {
  /** Base URL of the API, with or without a trailing /v1. */
  baseUrl: string;
  /** Bearer token / API key. */
  apiKey: string;
  /** Model identifier, e.g. "gpt-4o". */
  model: string;
  /**
   * Optional fetch implementation. Defaults to the global `fetch`.
   * Useful for testing or custom HTTP stacks.
   */
  fetch?: typeof globalThis.fetch;
}

// ── Retry config ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 60_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

// ── Provider ───────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *chat(
    messages: Array<{ role: string; content: ContentPart[] }>,
    tools?: Array<Record<string, unknown>>,
  ): AsyncIterable<StreamedMessagePart> {
    // Convert runtime messages → OpenAI messages.
    const oaiMessages = this.buildMessages(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: oaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await this.fetchWithRetry(body);
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const code = isContextOverflow(response.status, detail)
        ? ERROR_CONTEXT_OVERFLOW
        : String(response.status);
      yield {
        type: 'error',
        message: `HTTP ${response.status}: ${detail}`,
        code,
      };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'Empty response body' };
      return;
    }

    // Stream SSE chunks.
    yield* this.parseSSE(response.body);
  }

  diagnostics(): { provider: 'openai-compatible'; baseUrl: string; model: string } {
    return {
      provider: 'openai-compatible',
      baseUrl: this.baseUrl,
      model: this.model,
    };
  }

  // ── Retry logic ──────────────────────────────────────────────────────

  private async fetchWithRetry(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const url = this.chatCompletionsUrl();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    const bodyStr = JSON.stringify(body);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
        if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) {
          return response;
        }
        // Drain body to avoid leaking the connection.
        try { await response.text(); } catch { /* ignore */ }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt === MAX_RETRIES) break;
      } finally {
        clearTimeout(timeout);
      }
      // Exponential backoff: 500ms, 1s, 2s ...
      await new Promise((r) => setTimeout(r, INITIAL_BACKOFF_MS * Math.pow(2, attempt)));
    }

    // All retries exhausted — return a synthetic error response.
    const message = lastError
      ? `Fetch failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`
      : `Retryable HTTP errors exhausted after ${MAX_RETRIES + 1} attempts`;
    return new Response(message, { status: 503 });
  }

  // ── Message conversion ─────────────────────────────────────────────

  private chatCompletionsUrl(): string {
    return this.baseUrl.endsWith('/v1')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;
  }

  private buildMessages(
    messages: Array<{ role: string; content: ContentPart[] }>,
  ): Array<Record<string, unknown>> {
    return messages.flatMap((msg) => {
      switch (msg.role) {
        case 'system':
        case 'user':
          return [this.buildUserOrSystem(msg)];
        case 'assistant':
          return [this.buildAssistant(msg as RuntimeMessage)];
        case 'tool':
          return this.buildToolResults(msg);
        default:
          return [this.buildUserOrSystem(msg)];
      }
    });
  }

  private buildUserOrSystem(msg: {
    role: string;
    content: ContentPart[];
  }): Record<string, unknown> {
    const parts = msg.content.map((p) => this.convertContentPart(p));
    // If single text part, flatten to plain string for compatibility.
    if (parts.length === 1 && typeof parts[0] === 'object' && 'type' in parts[0] && parts[0].type === 'text') {
      return { role: msg.role, content: (parts[0] as { type: string; text: string }).text };
    }
    return { role: msg.role, content: parts };
  }

  private buildAssistant(msg: RuntimeMessage): Record<string, unknown> {
    const result: Record<string, unknown> = { role: 'assistant' };

    // Flatten text parts into a single string.
    const textParts = msg.content.filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string }>;
    if (textParts.length > 0) {
      result.content = textParts.map((p) => p.text).join('');
    } else {
      result.content = null;
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      result.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    return result;
  }

  private buildToolResults(msg: {
    role: string;
    content: ContentPart[];
  }): Array<Record<string, unknown>> {
    return msg.content
      .filter((p) => p.type === 'tool_result')
      .map((p) => {
        const tr = p as { type: 'tool_result'; toolCallId: string; content: string };
        return {
          role: 'tool',
          tool_call_id: tr.toolCallId,
          content: tr.content,
        };
      });
  }

  private convertContentPart(part: ContentPart): Record<string, unknown> {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image') {
      return {
        type: 'image_url',
        image_url: {
          url: `data:${part.mediaType};base64,${part.data}`,
        },
      };
    }
    // tool_result parts are handled separately in buildToolResults.
    // Fall through: treat unknown types as text.
    if ('content' in part && typeof part.content === 'string') {
      return { type: 'text', text: part.content };
    }
    return { type: 'text', text: '' };
  }

  // ── SSE parsing ────────────────────────────────────────────────────

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamedMessagePart> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    // Accumulate partial tool call arguments by index.
    const toolCallAccumulators: Array<{
      id: string;
      name: string;
      args: string;
    }> = [];
    // Accumulate usage from any chunk that carries it (including usage-only
    // chunks where choices is empty). This ensures we never lose usage data
    // when [DONE] arrives after the final usage-only chunk.
    let accumulatedUsage: unknown = undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines.
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer.
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue; // skip empty / comments.

          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // Emit accumulated tool calls.
              for (const acc of toolCallAccumulators) {
                if (acc.name) {
                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: acc.id,
                      name: acc.name,
                      arguments: acc.args,
                    },
                  };
                }
              }
              yield {
                type: 'done',
                finishReason: 'stop',
                usage: accumulatedUsage,
              };
              return;
            }

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue; // skip malformed JSON
            }

            // Capture usage from any chunk that carries it.
            if (parsed.usage !== undefined && parsed.usage !== null) {
              accumulatedUsage = parsed.usage;
            }

            const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
            // Usage-only chunk: choices absent or empty — nothing else to process.
            if (!choices || choices.length === 0) continue;

            const choice = choices[0];
            const delta = choice.delta as Record<string, unknown> | undefined;
            if (!delta) continue;

            // Text content delta.
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              yield { type: 'text_delta', text: delta.content };
            }

            // Tool call deltas.
            const toolCallsDelta = delta.tool_calls as Array<Record<string, unknown>> | undefined;
            if (toolCallsDelta) {
              for (const tc of toolCallsDelta) {
                const idx = tc.index as number;
                const fn = tc.function as Record<string, unknown> | undefined;

                // Initialize accumulator for this index if needed.
                while (toolCallAccumulators.length <= idx) {
                  toolCallAccumulators.push({ id: '', name: '', args: '' });
                }
                const acc = toolCallAccumulators[idx];

                if (typeof tc.id === 'string' && tc.id.length > 0) {
                  acc.id = tc.id;
                }
                if (fn && typeof fn.name === 'string' && fn.name.length > 0) {
                  acc.name = fn.name;
                }
                if (fn && typeof fn.arguments === 'string') {
                  acc.args += fn.arguments;
                }
              }
            }

            // Check finish reason.
            const finishReason = choice.finish_reason as string | null;
            if (finishReason) {
              // Emit accumulated tool calls.
              for (const acc of toolCallAccumulators) {
                const toolCall: RuntimeToolCall = {
                  id: acc.id,
                  name: acc.name,
                  arguments: acc.args,
                };
                yield { type: 'tool_call', toolCall };
              }

              const mapped = mapFinishReason(finishReason);
              yield {
                type: 'done',
                finishReason: mapped,
                usage: accumulatedUsage,
              };
              return;
            }
          }
        }
      }

      // If the stream ended without [DONE] or finish_reason, emit whatever
      // tool calls we accumulated (edge case for truncated streams).
      for (const acc of toolCallAccumulators) {
        if (acc.name) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: acc.id,
              name: acc.name,
              arguments: acc.args,
            },
          };
        }
      }

      yield { type: 'done', finishReason: 'stop', usage: accumulatedUsage };
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}
