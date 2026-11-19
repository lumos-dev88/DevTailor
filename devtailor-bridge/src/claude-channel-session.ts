/**
 * Claude Code channel session.
 *
 * The bridge runs inside Claude Code as an MCP stdio server that declares the
 * `claude/channel` capability. Browser messages are pushed to Claude with
 * `notifications/claude/channel`; Claude answers through the `reply` MCP tool.
 *
 * Structure:
 *  - ClaudeChannelHub: one per process. Owns turns, timers, image files and
 *    the notification writer. The `reply` tool talks to it.
 *  - ClaudeChannelSession: one per display session (AgentSession). Thin; keeps
 *    the display callbacks and delegates to the hub.
 *
 * See docs/CLAUDE_CHANNEL_PROTOCOL.md.
 */

import { randomUUID } from 'crypto';
import {
  AgentCallbacks,
  AgentSession,
  AgentSessionStartResult,
  ReviewContext,
  STOP_REASON_PENDING,
} from './agent-session';
import { buildPrompt } from './prompt-builder';
import { saveImage } from './image-store';
import { ReviewPayload } from './types';
import { log } from './log';

export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';

export const CANCEL_CONTENT = '用户在浏览器里取消了上一条请求，请停止相关操作，不要继续回复。';

export interface ChannelNotificationParams {
  content: string;
  meta: Record<string, string>;
}

export type ChannelNotifier = (params: ChannelNotificationParams) => Promise<void>;

export interface ClaudeChannelHubOptions {
  /** Project directory; screenshots go to `<projectDir>/.devtailor/images`. */
  projectDir: string;
  notify: ChannelNotifier;
  /** Absolute paths of enabled DESIGN.md files; may be bound after construction. */
  getDesignDocPaths?: () => string[];
  /**
   * Turn boundary for the "what is the AI doing" badge. Fired with
   * `turn_start` once the review notification was written, and `turn_end`
   * when the turn finishes (final reply, cancel, error, stop).
   * Wired to `WSServer.notifyAgentTurn` in `mcp-main.ts`, so the hub keeps
   * knowing nothing about HTTP/SSE.
   */
  onAgentStatus?: (kind: 'turn_start' | 'turn_end') => void;
}

export interface ReplyArgs {
  turn_id?: unknown;
  text?: unknown;
  final?: unknown;
}

export interface ReplyResult {
  ok: boolean;
  message: string;
}

interface Turn {
  id: string;
  session: ClaudeChannelSession;
  callbacks: AgentCallbacks;
  /** True once the turn can no longer receive replies (final, error, cancel, stop). */
  ended: boolean;
  /** True once `turn_start` was reported (a failed write never started a turn). */
  announced: boolean;
  streamed: string;
}

/** Meta values must be strings; keys are fixed identifiers (letters/digits/underscore). */
function cleanMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

export class ClaudeChannelHub {
  private readonly turns = new Map<string, Turn>();
  private ready = false;
  private stopped = false;

  constructor(private readonly options: ClaudeChannelHubOptions) {}

  get projectDir(): string {
    return this.options.projectDir;
  }

  get isReady(): boolean {
    return this.ready && !this.stopped;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
  }

  activeTurnIds(): string[] {
    return [...this.turns.values()].filter(t => !t.ended).map(t => t.id);
  }

  // -- inbound: browser -> Claude ------------------------------------------

  async dispatchReview(
    session: ClaudeChannelSession,
    callbacks: AgentCallbacks,
    payload: ReviewPayload['payload'],
    context?: ReviewContext,
  ): Promise<string> {
    const turnId = randomUUID().replace(/-/g, '').slice(0, 12);
    const images = Array.isArray(payload.screenshots)
      ? payload.screenshots
      : payload.screenshot ? [payload.screenshot] : [];

    const paths: string[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const saved = await saveImage(this.projectDir, `${turnId}-${i + 1}`, images[i]);
      if (saved.ok) paths.push(saved.path);
      else {
        skipped.push(`screenshot ${i + 1}: ${saved.reason}`);
        log(`[Channel] image skipped turn=${turnId} index=${i + 1} reason=${saved.reason}`);
      }
    }

    let content = buildPrompt(payload, { designDocPaths: this.options.getDesignDocPaths?.() ?? [] }).map(block => block.text).join('\n');
    if (images.length > 0) {
      content += '## Screenshots\n';
      for (const p of paths) content += `- ${p}\n`;
      if (paths.length > 0) content += 'Use the Read tool to view these images.\n';
      for (const note of skipped) content += `- (skipped) ${note}\n`;
      content += '\n';
    }

    const meta = cleanMeta({
      kind: 'review',
      turn_id: turnId,
      page_url: String(payload.pageUrl || '').slice(0, 500),
      client_id: context?.clientId || '',
      has_images: paths.length > 0 ? 'true' : 'false',
      image_count: String(paths.length),
      ...(paths.length > 0 ? { image_paths: paths.join(',') } : {}),
    });

    const turn: Turn = { id: turnId, session, callbacks, ended: false, announced: false, streamed: '' };
    this.turns.set(turnId, turn);
    // The turn exists before the write so an instant reply is never lost.
    try {
      await this.options.notify({ content, meta });
    } catch (err: any) {
      this.endTurn(turn);
      const message = `无法把消息发送给 Claude Code：${err?.message || err}`;
      log(`[Channel] notify failed turn=${turnId} reason=${err?.message || err}`);
      callbacks.onError(message);
      throw new Error(message);
    }
    log(`[Channel] review sent turn=${turnId} images=${paths.length} client=${context?.clientId || '-'}`);
    turn.announced = true;
    this.emitAgentStatus('turn_start');
    return STOP_REASON_PENDING;
  }

  async cancelTurn(session: ClaudeChannelSession): Promise<boolean> {
    const turn = this.latestActiveTurn(session);
    if (!turn) return false;
    // Display already moved on (bridge marks the turn canceled); drop further replies.
    this.endTurn(turn);
    try {
      await this.options.notify({
        content: CANCEL_CONTENT,
        meta: cleanMeta({ kind: 'cancel', turn_id: turn.id }),
      });
    } catch (err: any) {
      log(`[Channel] cancel notify failed turn=${turn.id} reason=${err?.message || err}`);
      return false;
    }
    log(`[Channel] cancel sent turn=${turn.id}`);
    return true;
  }

  // -- outbound: Claude -> browser (the `reply` tool) -----------------------

  handleReply(args: ReplyArgs): ReplyResult {
    const text = typeof args.text === 'string' ? args.text : '';
    const final = args.final === true;
    const requested = typeof args.turn_id === 'string' && args.turn_id ? args.turn_id : null;
    if (!text && !final) return { ok: false, message: 'text is required (or pass final:true to end the turn).' };

    let turn: Turn | undefined;
    if (requested) {
      turn = this.turns.get(requested);
      if (!turn || turn.ended) {
        return {
          ok: false,
          message: `Turn ${requested} is not active (already finished, canceled, or timed out). Do not reply to it.`,
        };
      }
    } else {
      turn = this.latestActiveTurn();
      if (!turn) return { ok: false, message: 'No browser request is waiting for a reply.' };
    }

    if (text) {
      const separator = turn.streamed === '' || turn.streamed.endsWith('\n\n')
        ? ''
        : turn.streamed.endsWith('\n') ? '\n' : '\n\n';
      const delta = separator + text;
      turn.streamed += delta;
      turn.callbacks.onStream(delta);
    }
    if (final) {
      this.endTurn(turn);
      turn.callbacks.onDone();
      return { ok: true, message: 'sent (final)' };
    }
    return { ok: true, message: 'sent' };
  }

  // -- lifecycle ----------------------------------------------------------

  /** Ends all turns of a session that is going away (display session deleted etc.). */
  endSession(session: ClaudeChannelSession): void {
    for (const turn of this.turns.values()) {
      if (turn.session !== session || turn.ended) continue;
      this.endTurn(turn);
      turn.callbacks.onDone('Session closed');
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    for (const turn of this.turns.values()) this.endTurn(turn);
  }

  // -- internals ----------------------------------------------------------

  /** Reports a turn boundary to the status badge; a broken sink never breaks a turn. */
  private emitAgentStatus(kind: 'turn_start' | 'turn_end'): void {
    try {
      this.options.onAgentStatus?.(kind);
    } catch (err: any) {
      log(`[Channel] agent status callback failed kind=${kind} reason=${err?.message || err}`);
    }
  }

  private latestActiveTurn(session?: ClaudeChannelSession): Turn | undefined {
    let found: Turn | undefined;
    for (const turn of this.turns.values()) {
      if (turn.ended) continue;
      if (session && turn.session !== session) continue;
      found = turn; // Map keeps insertion order, so the last one is the latest
    }
    return found;
  }

  private endTurn(turn: Turn): void {
    if (turn.ended) return;
    turn.ended = true;
    // The turn can no longer change the AI status badge.
    if (turn.announced) this.emitAgentStatus('turn_end');
    // Keep ended turns for a while so stale ids get a precise error; prune the old ones.
    if (this.turns.size > 50) {
      for (const [id, t] of this.turns) {
        if (t.ended && id !== turn.id) this.turns.delete(id);
        if (this.turns.size <= 25) break;
      }
    }
  }
}

export class ClaudeChannelSession implements AgentSession {
  private callbacks: AgentCallbacks | null = null;
  private stopped = false;

  constructor(private readonly hub: ClaudeChannelHub) {}

  async start(): Promise<AgentSessionStartResult> {
    if (!this.hub.isReady) throw new Error('Claude Code 通道尚未连接');
    return { sessionId: null, mode: 'created' };
  }

  async sendReview(payload: ReviewPayload['payload'], context?: ReviewContext): Promise<string> {
    const callbacks = this.callbacks;
    if (!callbacks) throw new Error('Session callbacks are not set');
    // The hub snapshots the callbacks: later turns may replace this.callbacks.
    return this.hub.dispatchReview(this, callbacks, payload, context);
  }

  async cancelCurrentTurn(): Promise<boolean> {
    return this.hub.cancelTurn(this);
  }

  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.hub.endSession(this);
  }

  get isReady(): boolean {
    return !this.stopped && this.hub.isReady;
  }

  get isStarting(): boolean {
    return false;
  }

  get currentSessionId(): string | null {
    return null;
  }
}
