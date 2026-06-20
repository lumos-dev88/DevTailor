import { HistoryMessage } from './prompt-builder';
import { ReviewPayload } from './types';
import { BrowserActionName, BrowserActionResult } from './browser-action-types';

export type AgentSessionStartMode = 'reused' | 'created' | 'resumed';

export interface AgentSessionStartResult {
  sessionId: string | null;
  mode: AgentSessionStartMode;
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
  status?: string;
}

export interface ToolUpdateInfo {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }> | null;
  content?: Array<Record<string, unknown>>;
}

export interface AgentCallbacks {
  onStream: (delta: string) => void;
  onThinking: (delta: string) => void;
  onDone: (summary?: string) => void;
  onError: (message: string) => void;
  onSessionInfoUpdate?: (info: {
    title?: string | null;
    updatedAt?: string | null;
  }) => void;
  onToolCall?: (tool: ToolCallInfo) => void;
  onToolUpdate?: (update: ToolUpdateInfo) => void;
}

export type BrowserToolRunner = (
  action: BrowserActionName,
  params?: Record<string, unknown>,
) => Promise<BrowserActionResult>;

export interface AgentSession {
  start(): Promise<AgentSessionStartResult>;
  sendReview(payload: ReviewPayload['payload'], history?: HistoryMessage[]): Promise<string>;
  cancelCurrentTurn(): Promise<boolean>;
  setCallbacks(callbacks: AgentCallbacks): void;
  stop(): void;

  readonly isReady: boolean;
  readonly isStarting: boolean;
  readonly currentSessionId: string | null;
}
