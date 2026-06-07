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
  type: 'review' | 'ping' | 'pong' | 'connected' | 'stream' | 'thinking' | 'tool_call' | 'tool_update' | 'tool_status' | 'done' | 'error' | 'session_info' | 'session_reset' | 'session_snapshot';
  tabId?: string;
  payload?: ReviewPayload['payload'];
  delta?: string;
  summary?: string;
  message?: string;
  agentStatus?: string;
  projectId?: string;
  projectName?: string;
  bridgeInstanceId?: string;
  toolTitle?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolKind?: string;
  toolInput?: unknown;
  toolLocations?: Array<{ path: string; line?: number | null }>;
  toolOutput?: unknown;
  toolContent?: Array<Record<string, unknown>>;
  sessionId?: string;
  acpSessionId?: string | null;
  sessionTitle?: string | null;
  updatedAt?: string | null;
  messages?: Array<Record<string, unknown>>;
  reason?: string;
}
