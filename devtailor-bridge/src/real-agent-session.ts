import { randomUUID } from 'crypto';
import {
  AgentCallbacks,
  AgentSession,
  AgentSessionStartResult,
  BrowserToolRunner,
} from './agent-session';
import { BrowserActionName } from './browser-action-types';
import { createBrowserToolDefinitions, isBrowserToolName } from './browser-tool-definitions';
import { buildPrompt, buildSystemPrompt, HistoryMessage } from './prompt-builder';
import { ReviewPayload } from './types';
import {
  createWorkspaceToolDefinitions,
  isWorkspaceToolName,
} from './workspace-tool-definitions';
import { WorkspaceToolRunner } from './workspace-tool-runner';
import {
  ChatProvider,
  RuntimeMessage,
  RuntimeToolCall,
  generate,
} from './runtime';
import { microCompactMessages } from './runtime/micro-compaction';

/** Default character budget for this.messages history window. */
const DEFAULT_MAX_MESSAGE_CHARS = 200_000;

export interface RealAgentSessionOptions {
  provider: ChatProvider;
  runBrowserTool: BrowserToolRunner;
  runWorkspaceTool?: WorkspaceToolRunner;
  maxSteps?: number | null;
  /** Maximum character budget for this.messages. Default: 200_000 (~200 KB). */
  maxMessageChars?: number;
}

export class RealAgentSession implements AgentSession {
  private callbacks: AgentCallbacks | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private starting = false;
  private busy = false;
  private abortController: AbortController | null = null;
  private messages: RuntimeMessage[] = [];
  private toolKinds = new Map<string, string>();

  constructor(private readonly options: RealAgentSessionOptions) {}

  async start(): Promise<AgentSessionStartResult> {
    if (this.ready) return { sessionId: this.sessionId, mode: 'reused' };
    this.starting = true;
    this.sessionId = this.sessionId || `real_${randomUUID()}`;
    this.ready = true;
    this.starting = false;
    return { sessionId: this.sessionId, mode: 'created' };
  }

  async sendReview(
    payload: ReviewPayload['payload'],
    history?: HistoryMessage[],
  ): Promise<string> {
    // Concurrency guard — ws-server has its own queue, but the session must
    // also protect against concurrent generate calls writing this.messages.
    if (this.busy) {
      throw new Error('sendReview is already in progress');
    }
    await this.start();
    this.busy = true;
    // Clear previous turn's tool-kind tracking to avoid long-term growth.
    this.toolKinds.clear();
    this.abortController = new AbortController();
    try {
      const userMessage = reviewPayloadToRuntimeMessage(payload, history);
      const runMessages = [...this.messages, userMessage];
      let providerErrorEmitted = false;
      this.logProviderStart();

      const result = await generate({
        provider: this.options.provider,
        systemPrompt: buildSystemPrompt(),
        messages: runMessages,
        toolDefinitions: [
          ...createBrowserToolDefinitions(),
          ...(this.options.runWorkspaceTool ? createWorkspaceToolDefinitions() : []),
        ],
        toolExecutor: async (name, args, toolCallId) => {
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = parseToolArgs(args);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              toolCallId,
              content: JSON.stringify({ error: `Invalid tool arguments: ${msg}` }),
              isError: true,
            };
          }
          if (isBrowserToolName(name)) {
            const browserResult = await this.options.runBrowserTool(name, parsedArgs);
            return {
              toolCallId,
              content: JSON.stringify(browserResult.ok ? browserResult.result ?? null : browserResult.error ?? null),
              isError: !browserResult.ok,
            };
          }
          if (isWorkspaceToolName(name) && this.options.runWorkspaceTool) {
            const workspaceResult = await this.options.runWorkspaceTool(
              name,
              parsedArgs,
              this.abortController?.signal,
            );
            return {
              toolCallId,
              content: JSON.stringify(workspaceResult.ok ? workspaceResult.result ?? null : workspaceResult.error ?? null),
              isError: !workspaceResult.ok,
            };
          }
          return {
            toolCallId,
            content: `Unknown tool: ${name}`,
            isError: true,
          };
        },
        maxSteps: this.options.maxSteps ?? null,
        signal: this.abortController.signal,
        callbacks: {
          onTextDelta: (text) => this.callbacks?.onStream(text),
          onError: (message) => {
            providerErrorEmitted = true;
            this.emitProviderError(message);
          },
          onToolCall: (toolCall) => this.emitToolCall(toolCall),
          onToolResult: (toolResult) => this.emitToolResult(toolResult),
        },
      });

      if (!result.aborted) {
        this.messages = result.messages.filter(message => message.role !== 'system');
        microCompactMessages(this.messages);
        trimMessageHistory(this.messages, this.options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS);
      }

      if (result.aborted) return 'cancelled';
      if (result.finishReason === 'error') {
        const message = result.errorMessage || 'Provider returned an error';
        if (!providerErrorEmitted) this.emitProviderError(message);
        return 'error';
      }
      if (result.finishReason === 'tool_calls') return 'tool_calls';
      return result.finishReason || 'stop';
    } finally {
      this.abortController = null;
      this.busy = false;
    }
  }

  async cancelCurrentTurn(): Promise<boolean> {
    if (!this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.ready = false;
    this.starting = false;
    this.busy = false;
    // Avoid stale tool-kind entries growing across stop/restart cycles.
    this.toolKinds.clear();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isStarting(): boolean {
    return this.starting;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  private emitToolCall(toolCall: RuntimeToolCall): void {
    const kind = isWorkspaceToolName(toolCall.name) ? 'workspace' : 'browser';
    this.toolKinds.set(toolCall.id, kind);
    // If parseToolArgs throws, pass raw string so the frontend is honest
    // about what the model actually sent (not a fake {}).
    let rawInput: unknown;
    try {
      rawInput = parseToolArgs(toolCall.arguments);
    } catch {
      rawInput = toolCall.arguments;
    }
    this.callbacks?.onToolCall?.({
      toolCallId: toolCall.id,
      title: toolCall.name,
      kind,
      rawInput,
      status: 'running',
    });
  }

  private emitProviderError(message: string): void {
    console.error(`[AgentRuntime] Provider error: ${message}`);
    this.callbacks?.onError?.(message);
  }

  private logProviderStart(): void {
    const provider = this.options.provider as ChatProvider & {
      diagnostics?: () => { provider?: string; baseUrl?: string; model?: string };
    };
    const diagnostics = provider.diagnostics?.();
    if (!diagnostics) {
      console.log('[AgentRuntime] Starting provider request');
      return;
    }
    console.log(
      `[AgentRuntime] Starting ${diagnostics.provider || 'provider'} request model=${diagnostics.model || '(unset)'} baseUrl=${diagnostics.baseUrl || '(unset)'}`,
    );
  }

  private emitToolResult(result: {
    toolCallId: string;
    content: string;
    isError?: boolean;
  }): void {
    const toolKind = this.toolKinds.get(result.toolCallId) ?? 'tool';
    this.callbacks?.onToolUpdate?.({
      toolCallId: result.toolCallId,
      kind: toolKind,
      status: result.isError ? 'failed' : 'completed',
      rawOutput: result.content,
      content: [{ type: 'text', text: result.content }],
    });
  }
}

function reviewPayloadToRuntimeMessage(
  payload: ReviewPayload['payload'],
  history?: HistoryMessage[],
): RuntimeMessage {
  const blocks = buildPrompt(payload, history);
  return {
    role: 'user',
    content: blocks.map(block => {
      if (block.type === 'image') {
        return {
          type: 'image' as const,
          data: block.data,
          mediaType: block.mimeType,
        };
      }
      return {
        type: 'text' as const,
        text: block.text,
      };
    }),
  };
}

/**
 * Parse tool arguments from JSON string.
 * Throws on invalid JSON or non-object values so the caller can surface
 * a clear parse error instead of silently using {}.
 */
function parseToolArgs(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  const parsed: unknown = JSON.parse(args);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Trim message history in-place, removing oldest messages first until
 * the total estimated character count is within budget.
 */
function trimMessageHistory(messages: RuntimeMessage[], maxChars: number): void {
  let totalChars = 0;
  for (const msg of messages) {
    totalChars += estimateMessageChars(msg);
  }
  while (totalChars > maxChars && messages.length > 0) {
    const removed = messages.shift()!;
    totalChars -= estimateMessageChars(removed);
  }
}

function estimateMessageChars(msg: RuntimeMessage): number {
  let chars = JSON.stringify(msg.content).length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      chars += tc.arguments.length + tc.name.length + tc.id.length;
    }
  }
  return chars;
}
