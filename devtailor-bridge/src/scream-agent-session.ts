/**
 * ScreamAgentSession — AgentSession implementation backed by the Scream node-sdk.
 *
 * Capabilities:
 *   - Import the Scream ESM bundle in-process via dynamic import().
 *   - Map DevTailor ModelConfig → ScreamConfigPatch (openai-compatible provider).
 *   - Create a ScreamHarness scoped to {projectDir}/.devtailor/scream-home.
 *   - Create a Scream Session per AgentSession lifetime (permission: 'yolo').
 *   - Forward Scream events → AgentCallbacks.
 *   - When runBrowserTool is provided, registers browser tools with the Scream
 *     session and routes model tool calls back to the extension via runBrowserTool.
 *   - Scream handles workspace tools natively; runWorkspaceTool is ignored.
 */

import { randomUUID } from 'crypto';
import path from 'path';
import {
  AgentCallbacks,
  AgentSession,
  AgentSessionStartResult,
  BrowserToolRunner,
  ToolCallInfo,
  ToolUpdateInfo,
} from './agent-session';
import { HistoryMessage } from './prompt-builder';
import { ReviewPayload } from './types';
import { WorkspaceToolRunner } from './workspace-tool-runner';
import { ModelConfig, normalizeModelConfig } from './model-config';
import { createBrowserToolDefinitions, isBrowserToolName } from './browser-tool-definitions';

// ── Scream SDK types (loaded dynamically so CommonJS build works) ───────────

// Minimal type aliases we need from the SDK. Full types live in the
// vendored index.d.mts; we only inline what this file references so tsc
// can compile without resolving the ESM bundle's types.

interface ScreamHarnessOptions {
  homeDir?: string;
  configPath?: string;
  autoLoadConfig?: boolean;
}

interface ScreamConfigPatch {
  providers?: Record<string, {
    type?: 'anthropic' | 'openai' | 'scream' | 'google-genai' | 'openai_responses' | 'vertexai';
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
    customHeaders?: Record<string, string>;
  }>;
  models?: Record<string, {
    provider?: string;
    model?: string;
    maxContextSize?: number;
  }>;
  defaultProvider?: string;
  defaultModel?: string;
}

interface CreateSessionOptions {
  workDir: string;
  model?: string;
  permission?: 'yolo' | 'manual' | 'auto';
}

type PromptPart = { type: 'text'; text: string };
type PromptInput = readonly PromptPart[];

// Minimal AgentEvent shape for our event handler
interface MinimalEvent {
  type: string;
  [key: string]: unknown;
}

type Unsubscribe = () => void;

interface ScreamSession {
  id: string;
  prompt(input: string | PromptInput): Promise<void>;
  cancel(): Promise<void>;
  onEvent(listener: (event: MinimalEvent) => void): Unsubscribe;
  close(opts?: { extractMemories?: boolean }): Promise<void>;
  registerUserTool(tool: { name: string; description: string; parameters: Record<string, unknown> }): Promise<void>;
  unregisterUserTool(name: string): Promise<void>;
  setToolCallHandler(handler: (request: { turnId?: number; toolCallId: string; args: unknown }) => Promise<{ output: string | unknown[]; isError?: boolean }>): void;
}

interface ScreamHarness {
  ensureConfigFile(): Promise<void>;
  setConfig(patch: ScreamConfigPatch): Promise<unknown>;
  createSession(options: CreateSessionOptions): Promise<ScreamSession>;
  close(): Promise<void>;
}

// ── SDK loader ───────────────────────────────────────────────────────────────

/** Cached module exports — loaded once per process. */
let sdkCache: { ScreamHarness: new (opts: ScreamHarnessOptions) => ScreamHarness } | null = null;

/** Absolute path to the vendored Scream ESM bundle. */
const SDK_PATH = path.resolve(
  __dirname,
  '../../scream-code-main/runtime/node-sdk/dist/index.mjs',
);

async function loadSdk(): Promise<{ ScreamHarness: new (opts: ScreamHarnessOptions) => ScreamHarness }> {
  if (sdkCache) return sdkCache;
  // Dynamic import works in both tsx (native ESM) and CommonJS node (Node 22+
  // supports import() of ESM from CJS). Node resolves the ESM bundle's
  // external npm deps against scream-code-main's node_modules automatically
  // because the bundle lives under that tree.
  const mod = await import(SDK_PATH) as { ScreamHarness: new (opts: ScreamHarnessOptions) => ScreamHarness };
  sdkCache = mod;
  return sdkCache;
}

// ── Config mapping ───────────────────────────────────────────────────────────

const PROVIDER_NAME = 'devtailor';
const MODEL_ALIAS = 'devtailor-model';
const DEFAULT_MAX_CONTEXT_SIZE = 128_000;

function buildScreamConfigPatch(config: ModelConfig): ScreamConfigPatch {
  const normalized = normalizeModelConfig(config);
  return {
    providers: {
      [PROVIDER_NAME]: {
        type: 'openai',
        apiKey: normalized.apiKey,
        baseUrl: normalized.baseUrl,
        defaultModel: normalized.model,
      },
    },
    models: {
      [MODEL_ALIAS]: {
        provider: PROVIDER_NAME,
        model: normalized.model,
        maxContextSize: DEFAULT_MAX_CONTEXT_SIZE,
      },
    },
    defaultProvider: PROVIDER_NAME,
    defaultModel: MODEL_ALIAS,
  };
}

// ── Session implementation ───────────────────────────────────────────────────

export interface ScreamAgentSessionOptions {
  modelConfig: ModelConfig;
  /** Project root directory — Scream home will be at {projectDir}/.devtailor/scream-home */
  projectDir: string;
  /** When provided, browser tools are registered with the Scream session and routed to this runner. */
  runBrowserTool?: BrowserToolRunner;
  /** Accepted for API compatibility; Scream handles workspace tools natively. */
  runWorkspaceTool?: WorkspaceToolRunner;
}

export class ScreamAgentSession implements AgentSession {
  private callbacks: AgentCallbacks | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private starting = false;
  private busy = false;

  private harness: ScreamHarness | null = null;
  private screamSession: ScreamSession | null = null;
  private unsubscribeEvents: Unsubscribe | null = null;
  private readonly toolNameById = new Map<string, string>();

  constructor(private readonly options: ScreamAgentSessionOptions) {}

  // ── AgentSession interface ─────────────────────────────────────────────

  async start(): Promise<AgentSessionStartResult> {
    if (this.ready) return { sessionId: this.sessionId, mode: 'reused' };
    if (this.starting) {
      // Wait for in-flight start to complete
      await this.waitReady();
      return { sessionId: this.sessionId, mode: 'reused' };
    }
    this.starting = true;
    try {
      this.sessionId = this.sessionId || `scream_${randomUUID()}`;
      const { ScreamHarness } = await loadSdk();

      const homeDir = path.join(this.options.projectDir, '.devtailor', 'scream-home');
      this.harness = new ScreamHarness({ homeDir, autoLoadConfig: false });
      await this.harness.ensureConfigFile();
      await this.harness.setConfig(buildScreamConfigPatch(this.options.modelConfig));

      this.screamSession = await this.harness.createSession({
        workDir: this.options.projectDir,
        model: MODEL_ALIAS,
        permission: 'yolo',
      });

      const runBrowserTool = this.options.runBrowserTool;
      if (runBrowserTool) {
        for (const def of createBrowserToolDefinitions()) {
          await this.screamSession.registerUserTool(def);
        }
        this.screamSession.setToolCallHandler(async (request) => {
          const name = this.toolNameById.get(request.toolCallId);
          if (!name || !isBrowserToolName(name)) {
            return {
              output: JSON.stringify({ error: `Unknown tool: ${name ?? request.toolCallId}` }),
              isError: true,
            };
          }
          try {
            const browserResult = await runBrowserTool(name, (request.args ?? {}) as Record<string, unknown>);
            return {
              output: JSON.stringify(browserResult.ok ? (browserResult.result ?? null) : (browserResult.error ?? null)),
              isError: !browserResult.ok,
            };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              output: JSON.stringify({ error: message }),
              isError: true,
            };
          }
        });
      }

      this.ready = true;
      this.starting = false;
      return { sessionId: this.sessionId, mode: 'created' };
    } catch (err) {
      this.starting = false;
      throw err;
    }
  }

  async sendReview(
    payload: ReviewPayload['payload'],
    _history?: HistoryMessage[],
  ): Promise<string> {
    if (this.busy) throw new Error('sendReview is already in progress');
    await this.start();
    if (!this.screamSession) throw new Error('Scream session not initialized');

    this.busy = true;
    let accumulated = '';
    let turnEndReason: string = 'completed';
    let turnError: string | null = null;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.busy = false;
        if (this.unsubscribeEvents) {
          this.unsubscribeEvents();
          this.unsubscribeEvents = null;
        }
        fn();
      };

      this.unsubscribeEvents = this.screamSession!.onEvent((rawEvent) => {
        const event = rawEvent as MinimalEvent;
        this.handleEvent(event, {
          onDelta: (delta) => { accumulated += delta; },
          onTurnEnded: (reason, errorMsg) => {
            turnEndReason = reason;
            turnError = errorMsg ?? null;
            settle(() => {
              if (reason === 'completed') {
                this.callbacks?.onDone?.(accumulated);
                resolve(accumulated);
              } else if (reason === 'cancelled') {
                this.callbacks?.onDone?.('cancelled');
                resolve('cancelled');
              } else {
                const msg = turnError || 'Turn failed';
                this.callbacks?.onError?.(msg);
                resolve('error');
              }
            });
          },
          onError: (msg) => {
            settle(() => {
              this.callbacks?.onError?.(msg);
              reject(new Error(msg));
            });
          },
        });
      });

      // Build text-only PromptInput from the review payload (Phase 1: text only)
      const text = buildTextPrompt(payload);
      const promptInput: PromptInput = [{ type: 'text', text }];

      this.screamSession!.prompt(promptInput).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        settle(() => {
          this.callbacks?.onError?.(msg);
          reject(new Error(msg));
        });
      });
    }).finally(() => {
      void turnEndReason; // satisfy TS unused var
      void turnError;
      this.busy = false;
    });
  }

  async cancelCurrentTurn(): Promise<boolean> {
    if (!this.screamSession || !this.busy) return false;
    try {
      await this.screamSession.cancel();
      return true;
    } catch {
      return false;
    }
  }

  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    if (this.screamSession) {
      this.screamSession.close({ extractMemories: false }).catch(() => {});
      this.screamSession = null;
    }
    if (this.harness) {
      this.harness.close().catch(() => {});
      this.harness = null;
    }
    this.ready = false;
    this.starting = false;
    this.busy = false;
  }

  get isReady(): boolean { return this.ready; }
  get isStarting(): boolean { return this.starting; }
  get currentSessionId(): string | null { return this.sessionId; }

  // ── Event mapping ──────────────────────────────────────────────────────

  private handleEvent(
    event: MinimalEvent,
    hooks: {
      onDelta: (delta: string) => void;
      onTurnEnded: (reason: string, errorMsg?: string) => void;
      onError: (msg: string) => void;
    },
  ): void {
    switch (event.type) {
      case 'assistant.delta': {
        const delta = String(event['delta'] ?? '');
        this.callbacks?.onStream?.(delta);
        hooks.onDelta(delta);
        break;
      }

      case 'thinking.delta': {
        const delta = String(event['delta'] ?? '');
        this.callbacks?.onThinking?.(delta);
        break;
      }

      case 'tool.call.started': {
        const toolCallId = String(event['toolCallId'] ?? '');
        const name = String(event['name'] ?? 'tool');
        const args = event['args'];
        this.toolNameById.set(toolCallId, name);
        const info: ToolCallInfo = {
          toolCallId,
          title: name,
          rawInput: args,
          status: 'in_progress',
        };
        this.callbacks?.onToolCall?.(info);
        break;
      }

      case 'tool.progress': {
        const toolCallId = String(event['toolCallId'] ?? '');
        const update = event['update'] as Record<string, unknown> | undefined;
        const info: ToolUpdateInfo = {
          toolCallId,
          status: 'in_progress',
          rawOutput: update?.text ?? update,
        };
        this.callbacks?.onToolUpdate?.(info);
        break;
      }

      case 'tool.result': {
        const toolCallId = String(event['toolCallId'] ?? '');
        const isError = Boolean(event['isError']);
        const output = event['output'];
        this.toolNameById.delete(toolCallId);
        const info: ToolUpdateInfo = {
          toolCallId,
          status: isError ? 'failed' : 'completed',
          rawOutput: output,
        };
        this.callbacks?.onToolUpdate?.(info);
        break;
      }

      case 'turn.ended': {
        const reason = String(event['reason'] ?? 'completed');
        let errorMsg: string | undefined;
        if (reason === 'failed') {
          const errPayload = event['error'] as Record<string, unknown> | undefined;
          errorMsg = errPayload
            ? String(errPayload['message'] ?? 'Turn failed')
            : 'Turn failed';
        }
        hooks.onTurnEnded(reason, errorMsg);
        break;
      }

      case 'error': {
        const msg = String(event['message'] ?? 'Unknown Scream error');
        hooks.onError(msg);
        break;
      }

      case 'warning': {
        const msg = String(event['message'] ?? '');
        if (msg) {
          console.warn('[ScreamAgentSession] Warning:', msg);
        }
        break;
      }

      case 'session.meta.updated': {
        const title = event['title'] != null ? String(event['title']) : undefined;
        this.callbacks?.onSessionInfoUpdate?.({ title });
        break;
      }

      default:
        // Other events (turn.started, tool.call.delta, agent.status.updated, etc.)
        // are intentionally ignored in Phase 1.
        break;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private waitReady(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.starting) { resolve(); return; }
        setTimeout(check, 50);
      };
      check();
    });
  }
}

// ── Prompt builder (Phase 1: text only) ─────────────────────────────────────

function buildTextPrompt(payload: ReviewPayload['payload']): string {
  const parts: string[] = [];

  if (payload.pageUrl) {
    parts.push(`Page URL: ${payload.pageUrl}`);
  }

  if (payload.userIntent) {
    parts.push(payload.userIntent);
  }

  // Include marked elements as structured text
  if (payload.items && payload.items.length > 0) {
    parts.push('\nMarked elements:');
    for (const item of payload.items) {
      const elementParts = [`  - selector: ${item.selector}`];
      if (item.annotation) elementParts.push(`    annotation: ${item.annotation}`);
      if (item.text) elementParts.push(`    text: ${item.text}`);
      if (item.outerHTML) elementParts.push(`    html: ${item.outerHTML.slice(0, 200)}`);
      parts.push(elementParts.join('\n'));
    }
  }

  // Phase 1: screenshots/images are ignored
  return parts.join('\n');
}
