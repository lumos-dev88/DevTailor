/**
 * Minimal generate() loop — provider-agnostic, no real backend wiring.
 *
 * Orchestrates a multi-step tool-calling conversation:
 *   1. Streams text deltas from the provider, accumulating assistant text.
 *   2. On tool_call parts, executes tools sequentially via RuntimeToolExecutor.
 *   3. Appends tool_result messages and loops until the provider stops,
 *      AbortSignal fires, or an explicit maxSteps is exhausted.
 */

import type {
  RuntimeMessage,
  RuntimeToolCall,
} from './message';
import type {
  RuntimeToolDefinition,
  RuntimeToolExecutor,
} from './tool';
import type {
  ChatProvider,
  StreamedMessagePart,
  FinishReason,
} from './provider';
import { zeroUsage, addTokenUsage, type TokenUsage } from './usage';

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 32_000;

// ── Options & result ───────────────────────────────────────────────────

export interface GenerateCallbacks {
  onTextDelta?: (text: string) => void;
  onError?: (message: string) => void;
  onToolCall?: (toolCall: RuntimeToolCall) => void;
  onToolResult?: (result: {
    toolCallId: string;
    content: string;
    isError?: boolean;
  }) => void;
}

export interface GenerateOptions {
  provider: ChatProvider;
  systemPrompt?: string;
  messages: RuntimeMessage[];
  toolDefinitions?: RuntimeToolDefinition[];
  toolExecutor?: RuntimeToolExecutor;
  maxSteps?: number | null;
  toolTimeoutMs?: number;
  maxToolResultChars?: number;
  signal?: AbortSignal;
  callbacks?: GenerateCallbacks;
}

export interface GenerateResult {
  assistantMessage: RuntimeMessage;
  messages: RuntimeMessage[];
  usage: TokenUsage;
  finishReason: FinishReason;
  aborted?: boolean;
  errorMessage?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function systemMessage(prompt: string): RuntimeMessage {
  return { role: 'system', content: [{ type: 'text', text: prompt }] };
}

function assistantMessage(
  textParts: string[],
  toolCalls: RuntimeToolCall[],
): RuntimeMessage {
  const content: RuntimeMessage['content'] = [];
  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') });
  }
  return { role: 'assistant', content, toolCalls };
}

function toolResultMessage(
  results: Array<{ toolCallId: string; content: string; isError?: boolean }>,
): RuntimeMessage {
  return {
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool_result' as const,
      toolCallId: r.toolCallId,
      content: r.content,
      isError: r.isError,
    })),
  };
}

function normalizeUsage(usage: unknown): TokenUsage {
  if (!usage || typeof usage !== 'object') return zeroUsage();
  const raw = usage as Record<string, unknown>;
  return {
    promptTokens: numberValue(raw.promptTokens) ?? numberValue(raw.prompt_tokens) ?? 0,
    completionTokens: numberValue(raw.completionTokens) ?? numberValue(raw.completion_tokens) ?? 0,
    totalTokens: numberValue(raw.totalTokens) ?? numberValue(raw.total_tokens) ?? 0,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeToolResult(
  result: { toolCallId: string; content: string; isError?: boolean },
  maxChars: number,
): { toolCallId: string; content: string; isError?: boolean } {
  const content = typeof result.content === 'string'
    ? result.content
    : String(result.content ?? '');
  if (maxChars <= 0 || content.length <= maxChars) {
    return { ...result, content };
  }
  const notice = `\n\n[content truncated: tool output exceeded ${maxChars} characters. Re-run the tool with a narrower query or range if more detail is needed.]`;
  if (notice.length >= maxChars) {
    return {
      ...result,
      content: notice.slice(0, maxChars),
    };
  }
  const keepChars = Math.max(0, maxChars - notice.length);
  return {
    ...result,
    content: `${content.slice(0, keepChars)}${notice}`,
  };
}

async function executeToolWithTimeout(
  toolExecutor: RuntimeToolExecutor,
  name: string,
  args: string,
  toolCallId: string,
  timeoutMs: number,
): Promise<{ toolCallId: string; content: string; isError?: boolean }> {
  if (timeoutMs <= 0) {
    return toolExecutor(name, args, toolCallId);
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      toolExecutor(name, args, toolCallId),
      new Promise<{ toolCallId: string; content: string; isError?: boolean }>((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            toolCallId,
            content: `Tool execution timed out after ${timeoutMs}ms.`,
            isError: true,
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ── Core loop ──────────────────────────────────────────────────────────

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const {
    provider,
    systemPrompt,
    messages: userMessages,
    toolDefinitions,
    toolExecutor,
    maxSteps = null,
    toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    signal,
    callbacks,
  } = options;

  if (signal?.aborted) {
    return {
      assistantMessage: { role: 'assistant', content: [] },
      messages: [...userMessages],
      usage: zeroUsage(),
      finishReason: 'stop',
      aborted: true,
    };
  }

  const history: RuntimeMessage[] = [
    ...(systemPrompt ? [systemMessage(systemPrompt)] : []),
    ...userMessages,
  ];
  let usage: TokenUsage = zeroUsage();
  let lastAssistant: RuntimeMessage = { role: 'assistant', content: [] };

  for (let step = 0; ; step++) {
    const textParts: string[] = [];
    const toolCalls: RuntimeToolCall[] = [];

    // Provider tools parameter — pass definitions as plain objects.
    const toolsParam = toolDefinitions?.map((d) => ({
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));

    try {
      for await (const part of provider.chat(history, toolsParam) as AsyncIterable<StreamedMessagePart>) {
        if (signal?.aborted) break;

        switch (part.type) {
          case 'text_delta':
            textParts.push(part.text);
            callbacks?.onTextDelta?.(part.text);
            break;
          case 'tool_call':
            toolCalls.push(part.toolCall);
            callbacks?.onToolCall?.(part.toolCall);
            break;
          case 'done':
            if (part.usage) {
              usage = addTokenUsage(usage, normalizeUsage(part.usage));
            }
            break;
          case 'error':
            callbacks?.onError?.(part.message);
            return {
              assistantMessage: assistantMessage(textParts, toolCalls),
              messages: history,
              usage,
              finishReason: 'error',
              errorMessage: part.message,
            };
        }
      }
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return {
          assistantMessage: assistantMessage(textParts, toolCalls),
          messages: history,
          usage,
          finishReason: 'stop',
          aborted: true,
        };
      }
      throw err;
    }

    if (signal?.aborted) {
      return {
        assistantMessage: assistantMessage(textParts, toolCalls),
        messages: history,
        usage,
        finishReason: 'stop',
        aborted: true,
      };
    }

    lastAssistant = assistantMessage(textParts, toolCalls);
    history.push(lastAssistant);

    // No tool calls → done.
    if (toolCalls.length === 0) {
      return {
        assistantMessage: lastAssistant,
        messages: history,
        usage,
        finishReason: 'stop',
      };
    }

    // maxSteps reached → return with remaining tool calls unexecuted.
    if (typeof maxSteps === 'number' && Number.isFinite(maxSteps) && step + 1 >= maxSteps) {
      return {
        assistantMessage: lastAssistant,
        messages: history,
        usage,
        finishReason: 'tool_calls',
      };
    }

    // Execute tools sequentially.
    if (!toolExecutor) {
      return {
        assistantMessage: lastAssistant,
        messages: history,
        usage,
        finishReason: 'tool_calls',
      };
    }

    const results: Array<{
      toolCallId: string;
      content: string;
      isError?: boolean;
    }> = [];

    for (const tc of toolCalls) {
      if (signal?.aborted) {
        return {
          assistantMessage: lastAssistant,
          messages: history,
          usage,
          finishReason: 'stop',
          aborted: true,
        };
      }

      let result: { toolCallId: string; content: string; isError?: boolean };
      try {
        result = await executeToolWithTimeout(
          toolExecutor,
          tc.name,
          tc.arguments,
          tc.id,
          toolTimeoutMs,
        );
      } catch (err: unknown) {
        result = {
          toolCallId: tc.id,
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
      result = normalizeToolResult(result, maxToolResultChars);

      callbacks?.onToolResult?.(result);
      results.push(result);
    }

    history.push(toolResultMessage(results));
  }

  // Should be unreachable, but satisfy the compiler.
  return {
    assistantMessage: lastAssistant,
    messages: history,
    usage,
    finishReason: 'stop',
  };
}
