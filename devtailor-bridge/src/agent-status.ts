/**
 * "What is the AI doing right now" — pure state machine.
 *
 * Claude Code hook subprocesses report raw events (`POST /agent-status`, see
 * `ws-server.handleAgentStatus`) and this class folds them into one small
 * snapshot the side panel renders as a status badge. Bridge-internal turn
 * lifecycle (`turn_start` / `turn_end`) feeds the same machine, so a review
 * sent from the browser also leaves `thinking` → `idle` behind it.
 *
 * Rules (see docs/HANDOFF.md「AI 状态（hooks 上报）」):
 *  - UserPromptSubmit / turn_start → thinking (a new turn boundary: in-flight
 *    tools from the previous turn are dropped).
 *  - PreToolUse → tool; the reported `toolUseId` joins the in-flight set (no id
 *    → anonymous counter).
 *  - PostToolUse / PostToolUseFailure → in-flight count minus one; back to
 *    thinking at zero, otherwise still tool with the most recent label.
 *  - Notification → waiting (the AI is blocked on the user).
 *  - Stop / turn_end → in-flight set cleared, idle.
 *  - SubagentStop → thinking only when nothing else is in flight; a subagent
 *    finishing while a main-session tool runs must not end the main session.
 *  - No event for 10 minutes → `snapshot()` reports idle (never stuck).
 *
 * State is never persisted: a restarted Bridge starts idle.
 */

export type AgentState = 'idle' | 'thinking' | 'tool' | 'waiting';

/** Events accepted by {@link AgentStatus.apply}. */
export const AGENT_STATUS_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'turn_start',
  'turn_end',
] as const;

export type AgentStatusEvent = (typeof AGENT_STATUS_EVENTS)[number];

export interface AgentStatusPayload {
  event?: string;
  toolName?: string;
  /** Human-readable, already redacted/truncated by the hook script. */
  label?: string;
  toolUseId?: string;
}

export interface AgentStatusSnapshot {
  state: AgentState;
  label: string;
  toolName: string;
  /** Number of tool calls currently in flight. */
  activeTools: number;
  /** When the current state was entered (unchanged by a label change). */
  since: number;
  updatedAt: number;
}

/** Labels are display-only: cap them so a chatty hook can never flood the UI. */
export const MAX_AGENT_LABEL_CHARS = 120;
/** No event for this long → the snapshot reads as idle. */
export const AGENT_STATUS_STALE_MS = 10 * 60 * 1000;
export const DEFAULT_WAITING_LABEL = '等待你的确认';
export const DEFAULT_TOOL_LABEL = '正在执行工具';
const MAX_TOOL_USE_ID_CHARS = 200;

export function isAgentStatusEvent(value: unknown): value is AgentStatusEvent {
  return typeof value === 'string' && (AGENT_STATUS_EVENTS as readonly string[]).includes(value);
}

/** Strips control characters/newlines and truncates to {@link MAX_AGENT_LABEL_CHARS}. */
export function sanitizeAgentLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const flattened = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Array.from keeps surrogate pairs intact when cutting at the limit.
  return Array.from(flattened).slice(0, MAX_AGENT_LABEL_CHARS).join('');
}

export class AgentStatus {
  private state: AgentState = 'idle';
  private label = '';
  private toolName = '';
  private since: number;
  private updatedAt: number;
  /** Tool calls that reported a `toolUseId` (insertion order = start order). */
  private readonly activeToolIds = new Set<string>();
  /** Tool calls that did not report an id; counted instead of tracked. */
  private anonymousTools = 0;

  constructor(now = Date.now()) {
    this.since = now;
    this.updatedAt = now;
  }

  /** In-flight tool count, ids + anonymous. */
  get activeTools(): number {
    return this.activeToolIds.size + this.anonymousTools;
  }

  /**
   * Current snapshot. A state that saw no event for {@link AGENT_STATUS_STALE_MS}
   * is reported as idle; the internal state is kept so a late PostToolUse can
   * still settle it.
   */
  snapshot(now = Date.now()): AgentStatusSnapshot {
    if (this.state !== 'idle' && now - this.updatedAt > AGENT_STATUS_STALE_MS) {
      return {
        state: 'idle',
        label: '',
        toolName: '',
        activeTools: 0,
        since: this.updatedAt,
        updatedAt: this.updatedAt,
      };
    }
    return {
      state: this.state,
      label: this.label,
      toolName: this.toolName,
      activeTools: this.activeTools,
      since: this.since,
      updatedAt: this.updatedAt,
    };
  }

  /** Applies one event and returns the resulting snapshot. Throws on unknown events. */
  apply(event: AgentStatusEvent, payload: AgentStatusPayload = {}, now = Date.now()): AgentStatusSnapshot {
    if (!isAgentStatusEvent(event)) throw new Error(`Unknown agent status event: ${String(event)}`);
    const label = sanitizeAgentLabel(payload.label);
    const toolName = sanitizeAgentLabel(payload.toolName);
    const toolUseId = sanitizeAgentLabel(payload.toolUseId).slice(0, MAX_TOOL_USE_ID_CHARS);

    switch (event) {
      case 'UserPromptSubmit':
      case 'turn_start':
        // New turn: whatever was in flight belongs to the previous turn.
        this.clearActiveTools();
        this.setState('thinking', label, '', now);
        break;
      case 'PreToolUse':
        if (toolUseId) this.activeToolIds.add(toolUseId);
        else this.anonymousTools += 1;
        this.setState('tool', label || toolName || DEFAULT_TOOL_LABEL, toolName, now);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.finishTool(toolUseId);
        if (this.activeTools > 0) this.setState('tool', label || this.label, toolName || this.toolName, now);
        else this.setState('thinking', label, '', now);
        break;
      case 'Notification':
        this.setState('waiting', label || DEFAULT_WAITING_LABEL, '', now);
        break;
      case 'SubagentStop':
        // A finishing subagent never ends the main session: only report
        // thinking when nothing else is still running.
        if (this.activeTools > 0) this.setState('tool', label || this.label, this.toolName, now);
        else this.setState('thinking', label, '', now);
        break;
      case 'Stop':
      case 'turn_end':
        this.clearActiveTools();
        this.setState('idle', '', '', now);
        break;
    }
    return this.snapshot(now);
  }

  private setState(state: AgentState, label: string, toolName: string, now: number): void {
    // `since` is the entry time of the state, not of the label.
    if (state !== this.state) this.since = now;
    this.state = state;
    this.label = label;
    this.toolName = toolName;
    this.updatedAt = now;
  }

  private clearActiveTools(): void {
    this.activeToolIds.clear();
    this.anonymousTools = 0;
  }

  /**
   * Retires one in-flight tool. Never goes negative: an unknown id is a late or
   * duplicated report and is ignored; an id-less report first consumes the
   * anonymous counter, then the oldest tracked id.
   */
  private finishTool(toolUseId: string): void {
    if (toolUseId) {
      this.activeToolIds.delete(toolUseId);
      return;
    }
    if (this.anonymousTools > 0) {
      this.anonymousTools -= 1;
      return;
    }
    const oldest = this.activeToolIds.values().next();
    if (!oldest.done) this.activeToolIds.delete(oldest.value);
  }
}
