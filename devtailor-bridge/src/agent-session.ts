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

export interface ApprovalRequestInfo {
  /** Tool call id the approval belongs to. */
  toolCallId: string;
  /** Tool name, e.g. bash, write_file, click_page. */
  toolName: string;
  /** Human-readable one-line summary of the action. */
  action: string;
  /** Why this operation is considered high-risk. */
  risk: string;
  /** Structured display/params for optional expansion in the UI. */
  detail?: unknown;
}

export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  feedback?: string;
}

export interface QuestionOptionInfo {
  label: string;
  description?: string;
}

export interface QuestionItemInfo {
  /** The question text — also the key under which its answer is returned. */
  question: string;
  /** Short chip label (may be empty). */
  header?: string;
  /** Optional longer body/context. */
  body?: string;
  options: QuestionOptionInfo[];
  /** When true, multiple options may be selected. */
  multiSelect?: boolean;
  /** Label for the free-text "Other" choice, if offered. */
  otherLabel?: string;
  otherDescription?: string;
}

export interface QuestionRequestInfo {
  /** Tool call id (present when triggered by a tool). */
  toolCallId?: string;
  turnId?: number;
  questions: QuestionItemInfo[];
}

/**
 * Answers keyed by question TEXT. Value is the selected option label, or the
 * user's free-text for an "Other" choice. `true` marks a boolean/acknowledged
 * question with no explicit label.
 */
export type QuestionAnswers = Record<string, string | true>;

export interface AgentCallbacks {
  onStream: (delta: string) => void;
  /**
   * Transient, non-persistent hint for the UI (e.g. "waiting for Claude Code").
   * Shown live only; never stored in the display session history.
   */
  onNotice?: (text: string) => void;
  onThinking: (delta: string) => void;
  onDone: (summary?: string) => void;
  onError: (message: string) => void;
  onSessionInfoUpdate?: (info: {
    title?: string | null;
    updatedAt?: string | null;
  }) => void;
  onToolCall?: (tool: ToolCallInfo) => void;
  onToolUpdate?: (update: ToolUpdateInfo) => void;
  /**
   * Invoked when a high-risk tool call requires user approval. Resolves with
   * the user's decision. If not provided, high-risk calls are rejected (never
   * auto-approved).
   */
  onApprovalRequest?: (request: ApprovalRequestInfo) => Promise<ApprovalDecision>;
  /**
   * Invoked when the agent needs more information and asks the user question(s).
   * Resolves with the user's answers keyed by question text, or `null` when the
   * question is dismissed / no UI is available (a valid "no answer" outcome —
   * unlike approval, questions are not rejected, they are simply unanswered).
   */
  onQuestionRequest?: (request: QuestionRequestInfo) => Promise<QuestionAnswers | null>;
}

export type BrowserToolRunner = (
  action: BrowserActionName,
  params?: Record<string, unknown>,
) => Promise<BrowserActionResult>;

/** Routing info the bridge knows about a review and the agent may want to see. */
export interface ReviewContext {
  clientId: string;
  displaySessionId: string;
}

/**
 * `sendReview` resolves with a stop reason. The value `'pending'` means the
 * request was handed off and the turn completes later through
 * `AgentCallbacks.onDone` / `onError` (the Claude Code channel works this way).
 */
export const STOP_REASON_PENDING = 'pending';

export interface AgentSession {
  start(): Promise<AgentSessionStartResult>;
  sendReview(payload: ReviewPayload['payload'], context?: ReviewContext): Promise<string>;
  cancelCurrentTurn(): Promise<boolean>;
  setCallbacks(callbacks: AgentCallbacks): void;
  stop(): void;

  readonly isReady: boolean;
  readonly isStarting: boolean;
  readonly currentSessionId: string | null;
}
