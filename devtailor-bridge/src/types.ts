/**
 * Shared types for devtailor-bridge
 */

export interface ReviewItem {
  index: number;
  selector: string;
  xpath: string;
  outerHTML: string;
  computedStyle: Record<string, string>;
  annotation: string;
  text: string;
  boundingBox: { x: number; y: number; w: number; h: number } | null;
  framework: {
    framework?: string;
    componentName?: string;
    filePath?: string;
  } | null;
}

export interface ReviewPayload {
  type: 'review';
  payload: {
    pageUrl: string;
    userIntent: string;
    items: ReviewItem[];
    screenshots?: string[];
    screenshot: string | null;
  };
}

export interface WSMessage {
  type: 'review' | 'ping' | 'pong' | 'connected' | 'stream' | 'tool_status' | 'done' | 'error' | 'display_message' | 'session_info' | 'session_reset' | 'session_snapshot'
    | 'queue_status'
    | 'agent_status';
  tabId?: string;
  payload?: ReviewPayload['payload'];
  delta?: string;
  summary?: string;
  message?: string;
  displayMessage?: Record<string, unknown>;
  agentStatus?: string;
  /** `agent_status` event: what the AI is doing right now (see src/agent-status.ts). */
  state?: 'idle' | 'thinking' | 'tool' | 'waiting';
  label?: string;
  toolName?: string;
  activeTools?: number;
  since?: number;
  projectId?: string;
  projectName?: string;
  bridgeInstanceId?: string;
  toolStatus?: string;
  toolCallId?: string;
  sessionId?: string;
  agentSessionId?: string | null;
  sessionTitle?: string | null;
  updatedAt?: string | null;
  messages?: Array<Record<string, unknown>>;
  reason?: string;
}
