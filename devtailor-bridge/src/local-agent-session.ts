import { randomUUID } from 'crypto';
import {
  AgentCallbacks,
  AgentSession,
  AgentSessionStartResult,
  BrowserToolRunner,
} from './agent-session';
import { buildPrompt, HistoryMessage } from './prompt-builder';
import { BrowserActionName, BrowserActionResult } from './browser-action-types';
import { ReviewPayload } from './types';

/**
 * Transitional in-process runtime used after removing the external agent protocol.
 *
 * This keeps Bridge, sessions, SSE, and browser-action plumbing operational
 * while a real lightweight agent runtime is wired in.
 */
export class LocalAgentSession implements AgentSession {
  private callbacks: AgentCallbacks | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private starting = false;
  private cancelled = false;

  constructor(private readonly runBrowserTool: BrowserToolRunner) {}

  async start(): Promise<AgentSessionStartResult> {
    if (this.ready) return { sessionId: this.sessionId, mode: 'reused' };
    this.starting = true;
    this.sessionId = this.sessionId || `local_${randomUUID()}`;
    this.ready = true;
    this.starting = false;
    return { sessionId: this.sessionId, mode: 'created' };
  }

  async sendReview(
    payload: ReviewPayload['payload'],
    history?: HistoryMessage[],
  ): Promise<string> {
    await this.start();
    this.cancelled = false;
    const blocks = buildPrompt(payload, history);
    const imageCount = blocks.filter(block => block.type === 'image').length;
    const markedCount = payload.items?.length || 0;
    const pageSnapshot = await this.callBrowserTool('get_page_snapshot', {
      includeStyles: true,
      includeConsoleSummary: true,
    });
    if (this.cancelled) return 'cancelled';
    const consoleLogs = await this.callBrowserTool('get_console_logs', {
      types: ['error', 'warn'],
      limit: 20,
    });
    if (this.cancelled) return 'cancelled';
    const elementTargets = await this.callBrowserTool('get_element_targets', {});
    if (this.cancelled) return 'cancelled';

    const summary = this.buildUiDebugSummary({
      payload,
      markedCount,
      imageCount,
      pageSnapshot,
      consoleLogs,
      elementTargets,
    });

    for (const chunk of chunkText(summary, 48)) {
      if (this.cancelled) return 'cancelled';
      this.callbacks?.onStream(chunk);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return this.cancelled ? 'cancelled' : 'end_turn';
  }

  async cancelCurrentTurn(): Promise<boolean> {
    this.cancelled = true;
    return this.ready;
  }

  setCallbacks(callbacks: AgentCallbacks): void {
    this.callbacks = callbacks;
  }

  stop(): void {
    this.cancelled = true;
    this.ready = false;
    this.starting = false;
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

  private async callBrowserTool(
    action: BrowserActionName,
    params: Record<string, unknown>,
  ): Promise<BrowserActionResult> {
    const toolCallId = `tool_${randomUUID()}`;
    this.callbacks?.onToolCall?.({
      toolCallId,
      title: action,
      kind: 'browser',
      rawInput: params,
      status: 'running',
    });

    let result: BrowserActionResult;
    try {
      result = await this.runBrowserTool(action, params);
    } catch (err: any) {
      result = {
        requestId: '',
        ok: false,
        error: {
          code: 'BROWSER_TOOL_ERROR',
          message: err.message || `Browser tool failed: ${action}`,
        },
      };
    }

    this.callbacks?.onToolUpdate?.({
      toolCallId,
      title: action,
      kind: 'browser',
      status: result.ok ? 'completed' : 'failed',
      rawInput: params,
      rawOutput: result.ok ? result.result : result.error,
      content: [{
        type: 'text',
        text: summarizeToolResult(action, result),
      }],
    });

    return result;
  }

  private buildUiDebugSummary(input: {
    payload: ReviewPayload['payload'];
    markedCount: number;
    imageCount: number;
    pageSnapshot: BrowserActionResult;
    consoleLogs: BrowserActionResult;
    elementTargets: BrowserActionResult;
  }): string {
    const { payload, markedCount, imageCount, pageSnapshot, consoleLogs, elementTargets } = input;
    const snapshotSummary = summarizeSnapshot(pageSnapshot.result);
    const consoleSummary = summarizeConsole(consoleLogs.result);
    const targetSummary = summarizeTargets(elementTargets.result);
    const toolFailures = [pageSnapshot, consoleLogs, elementTargets]
      .filter(result => !result.ok)
      .map(result => `${result.error?.code || 'ERROR'}: ${result.error?.message || 'unknown error'}`);

    return [
      'Bridge 已切换到本地 UI 调试后端通道。',
      `收到上下文：${markedCount} 个标记元素，${imageCount} 张图片。`,
      `用户意图：${payload.userIntent || '(未填写)'}`,
      `页面：${payload.pageUrl}`,
      '',
      '已通过本地 browser tools 收集运行态上下文：',
      `- 页面快照：${snapshotSummary}`,
      `- Console：${consoleSummary}`,
      `- 元素库：${targetSummary}`,
      toolFailures.length ? `- 工具异常：${toolFailures.join('；')}` : '- 工具异常：无',
      '',
      '当前实现已经打通 AgentSession -> BrowserActionRouter 的后端工具链路。',
      '下一步接入真正模型循环时，应复用这条 BrowserToolRunner 边界，把模型 tool_call 映射到同一组 browser tools。',
    ].join('\n');
  }
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function summarizeToolResult(action: BrowserActionName, result: BrowserActionResult): string {
  if (!result.ok) {
    return `${action} failed: ${result.error?.message || 'unknown error'}`;
  }
  return `${action} completed: ${summarizeUnknown(result.result)}`;
}

function summarizeSnapshot(result: unknown): string {
  if (!isRecord(result)) return '已返回';
  const items = Array.isArray(result.elements)
    ? result.elements
    : Array.isArray(result.interactiveElements)
      ? result.interactiveElements
      : Array.isArray(result.items)
        ? result.items
        : [];
  const title = typeof result.title === 'string' ? result.title : '';
  const url = typeof result.url === 'string' ? result.url : '';
  const parts = [];
  if (title) parts.push(`title=${title}`);
  if (url) parts.push(`url=${url}`);
  if (items.length) parts.push(`${items.length} 个可交互元素`);
  return parts.length ? parts.join('，') : summarizeUnknown(result);
}

function summarizeConsole(result: unknown): string {
  if (!isRecord(result)) return '已返回';
  const logs = Array.isArray(result.logs)
    ? result.logs
    : Array.isArray(result.messages)
      ? result.messages
      : [];
  if (!logs.length) return '未发现 error/warn';
  const counts = logs.reduce((acc: Record<string, number>, item: unknown) => {
    const type = isRecord(item) && typeof item.type === 'string' ? item.type : 'message';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([type, count]) => `${type}=${count}`).join('，');
}

function summarizeTargets(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.targets)) return '已返回';
  if (!result.targets.length) return '暂无保存目标';
  return `${result.targets.length} 个保存目标`;
}

function summarizeUnknown(value: unknown): string {
  if (value == null) return 'empty';
  if (typeof value === 'string') return truncate(value, 160);
  try {
    return truncate(JSON.stringify(value), 240);
  } catch {
    return String(value);
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
