/**
 * Temporary AgentSession used until the Claude Code channel is wired in
 * (step 2). The bridge no longer ships its own AI runtime, so every review
 * immediately reports that the channel is not connected. This keeps the
 * SSE / queue / display-session machinery runnable and testable.
 *
 * Replaced by ClaudeChannelSession in step 2.
 */

import {
  AgentCallbacks,
  AgentSession,
  AgentSessionStartResult,
} from './agent-session';
import { ReviewPayload } from './types';

export const CHANNEL_NOT_CONNECTED_MESSAGE = 'Claude Code 通道尚未连接（第二步实现）';

export class PlaceholderAgentSession implements AgentSession {
  private callbacks: AgentCallbacks | null = null;
  private stopped = false;

  async start(): Promise<AgentSessionStartResult> {
    return { sessionId: null, mode: 'created' };
  }

  async sendReview(_payload: ReviewPayload['payload']): Promise<string> {
    this.callbacks?.onError(CHANNEL_NOT_CONNECTED_MESSAGE);
    return 'error';
  }

  async cancelCurrentTurn(): Promise<boolean> {
    return false;
  }

  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.stopped = true;
  }

  get isReady(): boolean {
    return !this.stopped;
  }

  get isStarting(): boolean {
    return false;
  }

  get currentSessionId(): string | null {
    return null;
  }
}
