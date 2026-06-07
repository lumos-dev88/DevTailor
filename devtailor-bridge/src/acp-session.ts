/**
 * ACP Session — Persistent agent process via ACP SDK
 *
 * Spawns claude-agent-acp, manages ClientSideConnection,
 * and streams agent_message_chunk deltas back to the extension.
 */

import { spawn, ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import { buildPrompt, buildSystemPrompt, HistoryMessage } from './prompt-builder';
import { ReviewPayload } from './types';

export interface SessionCallbacks {
  onStream: (delta: string) => void;
  onThinking: (delta: string) => void;
  onDone: (summary?: string) => void;
  onError: (message: string) => void;
  onToolCall?: (tool: {
    toolCallId: string;
    title: string;
    kind?: string;
    rawInput?: unknown;
    locations?: Array<{ path: string; line?: number | null }>;
    status?: string;
  }) => void;
  onToolUpdate?: (update: {
    toolCallId: string;
    title?: string | null;
    kind?: string | null;
    status?: string | null;
    rawInput?: unknown;
    rawOutput?: unknown;
    locations?: Array<{ path: string; line?: number | null }> | null;
    content?: Array<Record<string, unknown>>;
  }) => void;
}

function stringifyAny(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}' && json !== '[]') return json;
  } catch {}
  return fallback;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolTitle(value: unknown, fallback = 'Tool'): string {
  const obj = objectValue(value);
  if (obj && typeof obj.title === 'string' && obj.title.trim()) {
    return obj.title;
  }
  return stringifyAny(value, fallback);
}

function toolKind(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

class DevTailorClient implements acp.Client {
  private chunks: string[] = [];
  private callbacks: SessionCallbacks | null = null;

  setCallbacks(callbacks: SessionCallbacks): void {
    this.callbacks = callbacks;
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const allowOpt = params.options.find(
      (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? 'allow';
    return { outcome: { outcome: 'selected', optionId } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text') {
          this.chunks.push(update.content.text);
          this.callbacks?.onStream(update.content.text);
        }
        break;
      }
      case 'tool_call': {
        const safeTitle = toolTitle(update.title, 'Tool');
        const safeKind = toolKind(update.kind);
        console.log('[ACP] tool_call', update.toolCallId, safeTitle, safeKind, update.status);
        this.callbacks?.onToolCall?.({
          toolCallId: update.toolCallId,
          title: safeTitle,
          kind: safeKind,
          rawInput: update.rawInput,
          locations: update.locations,
          status: update.status,
        });
        break;
      }
      case 'tool_call_update': {
        const safeTitleUp = update.title == null ? undefined : toolTitle(update.title);
        const safeKindUp = update.kind == null
          ? undefined
          : toolKind(update.kind);
        console.log('[ACP] tool_call_update', update.toolCallId, safeTitleUp, update.status);
        this.callbacks?.onToolUpdate?.({
          toolCallId: update.toolCallId,
          title: safeTitleUp,
          kind: safeKindUp,
          status: update.status,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          locations: update.locations,
          content: update.content?.map(normalizeToolContent),
        });
        break;
      }
      case 'agent_thought_chunk': {
        if (update.content.type === 'text') {
          this.callbacks?.onThinking(update.content.text);
        }
        break;
      }
    }
  }

  flush(): string {
    const text = this.chunks.join('');
    this.chunks = [];
    return text;
  }
}

function normalizeToolContent(content: any): Record<string, unknown> {
  if (!content || typeof content !== 'object') {
    return { type: 'content', text: stringifyAny(content) };
  }
  if (content.type === 'content') {
    const block = content.content;
    if (block?.type === 'text') {
      return { type: 'content', text: block.text || '' };
    }
    if (block?.type === 'image') {
      return { type: 'content', text: '[image]' };
    }
    return { type: 'content', text: stringifyAny(block), content: block };
  }
  if (content.type === 'diff') {
    return {
      type: 'diff',
      path: content.path,
      oldText: content.oldText ?? null,
      newText: content.newText ?? '',
    };
  }
  if (content.type === 'terminal') {
    return {
      type: 'terminal',
      terminalId: content.terminalId,
    };
  }
  return {
    type: stringifyAny(content.type, 'content'),
    text: stringifyAny(content),
  };
}

export class ACPSession {
  private child: ChildProcess | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private client = new DevTailorClient();
  private ready = false;
  private starting = false;
  private startPromise: Promise<void> | null = null;

  constructor(
    private agent: string,
    private cwd: string,
    private agentArgs: string[] = [],
    private mcpServers: acp.McpServer[] = [],
    private previousSessionId?: string | null,
    private agentEnv?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) {
      return this.startPromise!;
    }
    this.starting = true;
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    try {
      const useShell = process.platform === 'win32';
      console.log(`[ACP] Spawning agent: ${this.agent} ${this.agentArgs.join(' ')}`);

      this.child = spawn(this.agent, this.agentArgs, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, ...this.agentEnv, FORCE_COLOR: '0', NO_COLOR: '1' },
        shell: useShell,
        windowsHide: true,
      });

      this.child.on('error', (err) => {
        console.error('[ACP] Agent process error:', err.message);
      });

      this.child.on('exit', (code, signal) => {
        console.log(`[ACP] Agent process exited: code=${code} signal=${signal}`);
        this.ready = false;
        this.starting = false;
      });

      if (!this.child.stdin || !this.child.stdout) {
        this.child.kill();
        throw new Error('Failed to get agent process stdio');
      }

      const input = Writable.toWeb(this.child.stdin);
      const output = Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      this.connection = new acp.ClientSideConnection(() => this.client, stream);

      console.log('[ACP] Initializing...');
      const initResult = await this.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: {
          name: 'devtailor-bridge',
          title: 'DevTailor Bridge',
          version: '0.1.0',
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      });
      console.log(`[ACP] Initialized (protocol v${initResult.protocolVersion})`);

      const systemPrompt = buildSystemPrompt();

      // Try to resume previous session if available (agent may or may not support it)
      if (this.previousSessionId) {
        try {
          console.log(`[ACP] Attempting to resume session: ${this.previousSessionId}...`);
          await this.connection.resumeSession({
            cwd: this.cwd,
            mcpServers: this.mcpServers,
            sessionId: this.previousSessionId,
          });
          this.sessionId = this.previousSessionId;
          console.log(`[ACP] Session resumed: ${this.sessionId}`);
        } catch (resumeErr: any) {
          console.warn(`[ACP] Resume failed (${resumeErr.message}), falling back to newSession...`);
          this.previousSessionId = null;
        }
      }

      if (!this.sessionId) {
        console.log('[ACP] Creating session...');
        const sessionResult = await this.connection.newSession({
          cwd: this.cwd,
          mcpServers: this.mcpServers,
          _meta: {
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: systemPrompt,
            },
          },
        });
        this.sessionId = sessionResult.sessionId;
        console.log(`[ACP] Session created: ${this.sessionId}`);
      }

      this.ready = true;
    } catch (err) {
      this.starting = false;
      throw err;
    }
  }

  async sendReview(
    payload: ReviewPayload['payload'],
    history?: HistoryMessage[],
  ): Promise<acp.PromptResponse['stopReason']> {
    await this.start();

    if (!this.connection || !this.sessionId) {
      throw new Error('ACP session not ready');
    }

    const promptBlocks = buildPrompt(payload, history);

    try {
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: promptBlocks,
      });

      const remaining = this.client.flush();
      if (remaining) {
        // Ensure any final buffered text is streamed
        // (should already be sent via onStream, but just in case)
      }

      return result.stopReason;
    } catch (err: any) {
      console.error('[ACP] Prompt error:', err.message);
      throw err;
    }
  }

  async cancelCurrentTurn(): Promise<boolean> {
    if (!this.connection || !this.sessionId || !this.ready) {
      return false;
    }
    await this.connection.cancel({ sessionId: this.sessionId });
    return true;
  }

  setCallbacks(callbacks: SessionCallbacks): void {
    this.client.setCallbacks(callbacks);
  }

  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill('SIGKILL');
        }
      }, 5000);
    }
    this.ready = false;
    this.starting = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}
