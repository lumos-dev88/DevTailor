/**
 * SSE Server — Receives review requests from Chrome extension,
 * forwards to ACPSession, relays stream responses over Server-Sent Events.
 */

import http, { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomUUID } from 'crypto';
import { basename } from 'path';
import { realpathSync } from 'fs';
import { ACPSession } from './acp-session';
import { HistoryMessage } from './prompt-builder';
import { WSMessage, ReviewPayload } from './types';
import { BrowserActionRouter } from './browser-action-router';
import { BrowserMCPServer } from './browser-mcp-server';
import { BrowserActionEvent, BrowserActionName, BrowserActionResult } from './browser-action-types';
import { SessionStore, StoredElementTarget } from './session-store';

interface Client {
  id: string;
  res: ServerResponse;
}

interface PendingReview {
  payload: ReviewPayload['payload'];
  displaySessionId: string;
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  type: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

interface DisplaySession {
  id: string;
  clientId: string;
  agentKey: string;
  title: string;
  acpSessionId: string | null;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
}

type ReviewSessionStart = {
  sessionId: string | null;
  mode: 'reused' | 'created' | 'resumed';
};

export class WSServer {
  private static readonly PROJECT_SESSION_SCOPE = 'project';
  private static readonly CANCEL_FORCE_STOP_MS = 5000;
  private server: http.Server | null = null;
  private clients = new Map<string, Client>();
  private sessions = new Map<string, ACPSession>();
  private displaySessions = new Map<string, DisplaySession>();
  private elementTargets = new Map<string, StoredElementTarget>();
  private activeDisplaySessionId: string | null = null;
  private queues = new Map<string, PendingReview[]>();
  private processing = new Set<string>();
  private processingDisplaySessions = new Map<string, string>();
  private pendingCancels = new Set<string>();
  private forcedCancels = new Set<string>();
  private lastActive = new Map<string, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private projectInfo: { projectId: string; projectName: string; bridgeInstanceId: string; agentKey: string; agentLabel: string };
  private browserRouter: BrowserActionRouter;
  private browserMcpServer: BrowserMCPServer;
  private store: SessionStore | null = null;
  private readonly idleTimeoutMs = 4 * 60 * 60 * 1000; // 4 hours — ACP stdio agents cannot resume across process restarts

  constructor(
    private port: number,
    private agent: string,
    private cwd: string,
    private agentArgs: string[] = [],
    private dataDir?: string,
    private agentEnv?: Record<string, string>,
    private agentKey = WSServer.agentPersistenceKey(agent, agentArgs),
    private agentLabel = agentKey,
  ) {
    const realDir = realpathSync(cwd);
    this.projectInfo = {
      projectId: createHash('sha256').update(realDir).digest('hex').slice(0, 12),
      projectName: basename(realDir) || 'project',
      bridgeInstanceId: randomUUID(),
      agentKey: this.agentKey,
      agentLabel: this.agentLabel,
    };
    this.browserRouter = new BrowserActionRouter((clientId, event) => this.sendBrowserAction(clientId, event));
    this.browserRouter.setLocalHandler((action, params) => this.handleLocalBrowserAction(action, params));
    this.browserMcpServer = new BrowserMCPServer(this.browserRouter);
  }

  static agentPersistenceKey(agent: string, agentArgs: string[] = []): string {
    const raw = [agent, ...agentArgs].join(' ').trim();
    return `raw:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  }

  /** Async init — create SessionStore and load persisted sessions */
  async init(): Promise<void> {
    if (!this.dataDir) return;
    this.store = await SessionStore.create(this.dataDir);
    this.loadPersistedSessions();
  }

  /** Restore sessions from SQLite into memory on startup */
  private loadPersistedSessions(): void {
    if (!this.store) return;
    const allSessions = this.store.listAllSessions(this.agentKey);
    for (const session of allSessions) {
      const full = this.store.getSession(session.id);
      if (full) {
        // StoredSession.messages is StoredMessage[] (role: string);
        // DisplaySession needs DisplayMessage[] (role: "user"|"assistant").
        // Data was originally written from DisplayMessage, so the cast is safe.
        const display = { ...full, agentKey: full.agentKey || this.agentKey } as unknown as DisplaySession;
        this.displaySessions.set(full.id, display);
        // Restore the latest project-level active session for this agent.
        if (!this.activeDisplaySessionId ||
            (this.displaySessions.get(this.activeDisplaySessionId)?.updatedAt ?? 0) < full.updatedAt) {
          this.activeDisplaySessionId = full.id;
        }
      }
    }
    for (const target of this.store.listElementTargets()) {
      this.elementTargets.set(target.id, target);
    }
    console.log(`[Store] Restored ${this.displaySessions.size} session(s) from SQLite`);
  }

  start(): void {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on('error', (err) => {
      console.error('[SSE] Server error:', err.message);
    });

    this.server.listen(this.port, () => {
      console.log(`[SSE] Server listening on http://localhost:${this.port}`);
    });

    this.startHeartbeat();
    this.startIdleCleanup();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${this.port}`}`);

    if (req.method === 'GET' && url.pathname === '/events') {
      this.handleEvents(url, req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/review') {
      await this.handleReviewPost(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/activate') {
      await this.handleActivate(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/browser-action-result') {
      await this.handleBrowserActionResult(req, res);
      return;
    }

    if (url.pathname === '/mcp') {
      await this.browserMcpServer.handle(req, res, await this.readJson(req));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const activeDisplay = this.currentDisplaySession();
      const clientId = url.searchParams.get('clientId') || '';
      const activeSessionId = activeDisplay?.id || null;
      this.sendJson(res, 200, {
        ok: true,
        ...this.projectInfo,
        pid: process.pid,
        activeClientId: this.browserRouter.activeClientId,
        activeSessionId,
        activeSessionTitle: activeDisplay?.title || null,
        acpSessionId: this.activeAcpSessionId(),
        isProcessing: clientId ? this.isClientProcessingSession(clientId, activeSessionId) : false,
        processingSessionId: clientId ? this.processingDisplaySessions.get(clientId) || null : null,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/new-session') {
      await this.handleNewSession(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      await this.handleSessionsList(url, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions/active') {
      await this.handleActiveSession(url, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sessions/load') {
      await this.handleLoadSession(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sessions/delete') {
      await this.handleDeleteSession(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/cancel') {
      await this.handleCancel(req, res);
      return;
    }

    if (url.pathname === '/element-targets') {
      if (req.method === 'GET') {
        this.handleElementTargetsList(url, res);
        return;
      }
      if (req.method === 'POST') {
        await this.handleElementTargetSave(req, res);
        return;
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/element-targets/')) {
      this.handleElementTargetDelete(url, res);
      return;
    }

    this.sendJson(res, 404, { error: 'Not found' });
  }

  private handleEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
    const clientId = url.searchParams.get('clientId') || 'default';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');

    const previous = this.clients.get(clientId);
    if (previous) previous.res.end();

    this.clients.set(clientId, { id: clientId, res });
    this.touch(clientId);
    console.log(`[SSE] Client connected: ${clientId}`);
    const activeDisplay = this.currentDisplaySession();
    this.send(clientId, {
      type: 'connected',
      tabId: clientId,
      activeClientId: this.browserRouter.activeClientId,
      isActiveClient: this.browserRouter.activeClientId === clientId,
      activeSessionId: activeDisplay?.id || null,
      activeSessionTitle: activeDisplay?.title || null,
      ...this.projectInfo,
    } as any);

    req.on('close', () => {
      const current = this.clients.get(clientId);
      if (current?.res === res) {
        this.clients.delete(clientId);
        this.broadcastActiveClient();
        console.log(`[SSE] Client disconnected: ${clientId}`);
      }
    });
  }

  private async handleReviewPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as WSMessage & { clientId?: string };
      if (msg.type !== 'review' || !msg.payload) {
        this.sendJson(res, 400, { error: 'Missing review payload' });
        return;
      }

      const clientId = msg.clientId || msg.tabId || 'default';
      if (!this.clients.has(clientId)) {
        this.sendJson(res, 409, { error: 'SSE client is not connected' });
        return;
      }
      if (this.browserRouter.activeClientId !== clientId) {
        this.sendJson(res, 409, { error: 'This tab is not the active DevTailor page. Click Connect to take over the current project tab.' });
        return;
      }

      const display = this.getOrCreateDisplaySession();
      this.browserRouter.activate(clientId, this.projectInfo.projectId, display.acpSessionId || null);
      this.sendJson(res, 202, { ok: true });
      this.enqueueReview(clientId, msg.payload, display.id);
    } catch (err: any) {
      this.sendJson(res, 400, { error: err.message || 'Invalid request body' });
    }
  }

  private async handleActivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      if (!this.clients.has(clientId)) {
        this.sendJson(res, 409, { ok: false, error: 'SSE client is not connected' });
        return;
      }

      this.touch(clientId);
      this.browserRouter.activate(clientId, this.projectInfo.projectId, this.activeAcpSessionId());
      this.broadcastActiveClient();
      const activeDisplay = this.currentDisplaySession();
      this.sendJson(res, 200, {
        ok: true,
        activeClientId: clientId,
        activeSessionId: activeDisplay?.id || null,
        activeSessionTitle: activeDisplay?.title || null,
        acpSessionId: this.activeAcpSessionId(),
      });
    } catch (err: any) {
      this.sendJson(res, 400, { ok: false, error: err.message || 'Invalid request' });
    }
  }

  private enqueueReview(clientId: string, payload: ReviewPayload['payload'], displaySessionId: string): void {
    const queue = this.queues.get(clientId) || [];
    queue.push({ payload, displaySessionId });
    this.queues.set(clientId, queue);
    this.processQueue(clientId);
  }

  private async processQueue(clientId: string): Promise<void> {
    if (this.processing.has(clientId)) return;
    this.processing.add(clientId);

    try {
      const queue = this.queues.get(clientId);
      while (queue && queue.length > 0) {
        const pending = queue.shift()!;
        this.processingDisplaySessions.set(clientId, pending.displaySessionId);
        try {
          await this.handleReview(clientId, pending.payload, pending.displaySessionId);
        } finally {
          this.processingDisplaySessions.delete(clientId);
        }
      }
      if (queue && queue.length === 0) {
        this.queues.delete(clientId);
      }
    } finally {
      this.processingDisplaySessions.delete(clientId);
      this.pendingCancels.delete(clientId);
      this.forcedCancels.delete(clientId);
      this.processing.delete(clientId);
    }
  }

  private async handleReview(clientId: string, payload: ReviewPayload['payload'], displaySessionId: string): Promise<void> {
    this.touch(clientId);
    const queuedDisplay = this.displaySessions.get(displaySessionId);
    const display = queuedDisplay && queuedDisplay.agentKey === this.agentKey
      ? queuedDisplay
      : this.getOrCreateDisplaySession();
    const session = this.getOrCreateSession(display.id, display.acpSessionId);
    this.appendUserMessage(display, payload);
    this.attachSessionCallbacks(clientId, display, session);

    let startResult: ReviewSessionStart;
    try {
      startResult = await this.startReviewSession(clientId, display, session);
    } catch (err: any) {
      console.error('[SSE] Failed to start session:', err.message);
      this.send(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message: `Session start failed: ${err.message}` } as any);
      session.stop();
      this.sessions.delete(display.id);
      return;
    }

    if (this.consumePendingCancel(clientId, display)) return;

    try {
      const history = this.historyForPrompt(display, startResult.mode);
      const stopReason = await session.sendReview(payload, history);
      const wasCanceled = this.pendingCancels.delete(clientId) || this.forcedCancels.delete(clientId) || stopReason === 'cancelled';
      this.send(clientId, {
        type: 'done',
        tabId: clientId,
        sessionId: display.id,
        summary: wasCanceled ? 'Cancelled' : 'Done',
        reason: wasCanceled ? 'cancelled' : stopReason,
      } as any);
    } catch (err: any) {
      if (this.pendingCancels.delete(clientId) || this.forcedCancels.delete(clientId)) {
        this.send(clientId, {
          type: 'done',
          tabId: clientId,
          sessionId: display.id,
          summary: 'Cancelled',
          reason: 'cancelled',
        } as any);
        return;
      }
      console.error('[SSE] Failed to send review:', err.message);
      this.send(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message: err.message } as any);
      session.stop();
      this.sessions.delete(display.id);
    }
  }

  /** Returns true when the resolved agent ID matches the built-in Claude preset. */
  private get isClaudeAgent(): boolean {
    return this.agentKey === 'claude' || this.agent === 'claude-agent-acp';
  }

  private mcpServers(): any[] {
    // Non-Claude agents may not accept our Browser MCP server schema.
    // Only pass Browser MCP to Claude; others get an empty list so session creation is not blocked.
    if (!this.isClaudeAgent) return [];
    return [{
      type: 'http',
      name: 'devtailor-browser',
      url: `http://localhost:${this.port}/mcp`,
      headers: [],
    }];
  }

  private getOrCreateSession(
    displaySessionId: string,
    acpSessionId?: string | null,
  ): ACPSession {
    let session = this.sessions.get(displaySessionId);
    if (!session || (!session.isReady && !session.isStarting)) {
      if (session) session.stop();
      session = new ACPSession(this.agent, this.cwd, this.agentArgs, this.mcpServers(), acpSessionId, this.agentEnv, this.agentKey);
      this.sessions.set(displaySessionId, session);
    }
    return session;
  }

  private async startReviewSession(
    clientId: string,
    display: DisplaySession,
    session: ACPSession,
  ): Promise<ReviewSessionStart> {
    let result: { sessionId: string | null; mode: 'reused' | 'created' | 'resumed' };
    try {
      result = await session.start();
    } catch (startErr: any) {
      // Fallback: if session creation failed and we passed Browser MCP servers,
      // retry once without them. Non-Claude agents already get empty mcpServers
      // so this path is only reachable for Claude or raw agents with MCP servers.
      if (this.mcpServers().length > 0 && !session.isReady) {
        console.warn(`[ACP] Session start failed with MCP servers (${startErr.message}), retrying without MCP servers...`);
        session.stop();
        const fallbackSession = new ACPSession(
          this.agent, this.cwd, this.agentArgs, [], session.currentSessionId, this.agentEnv, this.agentKey,
        );
        this.sessions.set(display.id, fallbackSession);
        try {
          result = await fallbackSession.start();
          session = fallbackSession;
        } catch (fallbackErr: any) {
          console.error(`[ACP] Fallback session start also failed: ${fallbackErr.message}`);
          throw startErr;
        }
      } else {
        throw startErr;
      }
    }
    const sid = result.sessionId || session.currentSessionId;
    if (sid) {
      display.acpSessionId = sid;
      display.updatedAt = Date.now();
      this.store?.updateSession(display);
      this.browserRouter.activate(clientId, this.projectInfo.projectId, sid);
      this.send(clientId, {
        type: 'session_info',
        tabId: clientId,
        sessionId: display.id,
        acpSessionId: sid,
        sessionTitle: display.title,
      } as any);
    }
    return { sessionId: sid || null, mode: result.mode };
  }

  private consumePendingCancel(clientId: string, display: DisplaySession): boolean {
    if (!this.pendingCancels.delete(clientId)) return false;
    this.closeActiveThinking(display);
    this.send(clientId, {
      type: 'done',
      tabId: clientId,
      sessionId: display.id,
      summary: 'Cancelled',
      reason: 'cancelled',
    } as any);
    return true;
  }

  private isClientProcessingSession(clientId: string, displaySessionId: string | null): boolean {
    if (!displaySessionId || !this.processing.has(clientId)) return false;
    return (this.processingDisplaySessions.get(clientId) || this.activeDisplaySessionId) === displaySessionId;
  }

  private historyForPrompt(display: DisplaySession, startMode: ReviewSessionStart['mode']): HistoryMessage[] | undefined {
    if (startMode !== 'created') return undefined;
    return display.messages
      .slice(0, -1)
      .map(m => ({ role: m.role, type: m.type, content: m.content }));
  }

  private attachSessionCallbacks(
    clientId: string,
    display: DisplaySession,
    session: ACPSession,
  ): void {
    session.setCallbacks({
      onStream: (delta) => {
        this.appendAssistantDelta(display, delta);
        this.send(clientId, { type: 'stream', tabId: clientId, sessionId: display.id, delta } as any);
      },
      onThinking: (delta) => {
        this.appendThinkingDelta(display, delta);
        this.send(clientId, { type: 'thinking', tabId: clientId, sessionId: display.id, delta } as any);
      },
      onDone: (summary) => {
        this.closeActiveThinking(display);
        this.send(clientId, { type: 'done', tabId: clientId, sessionId: display.id, summary } as any);
      },
      onError: (message) => {
        this.closeActiveThinking(display);
        this.send(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message } as any);
      },
      onSessionInfoUpdate: (info) => {
        this.updateDisplaySessionInfo(clientId, display, info);
      },
      onToolCall: (tool) => {
        this.addToolDisplayMessage(display, tool);
        this.send(clientId, {
          type: 'tool_call',
          tabId: clientId,
          sessionId: display.id,
          toolTitle: tool.title,
          toolCallId: tool.toolCallId,
          toolKind: tool.kind,
          toolInput: tool.rawInput,
          toolLocations: tool.locations,
          toolStatus: tool.status,
        } as any);
      },
      onToolUpdate: (update) => {
        this.updateToolDisplayMessage(display, update);
        this.send(clientId, {
          type: 'tool_update',
          tabId: clientId,
          sessionId: display.id,
          toolCallId: update.toolCallId,
          toolTitle: update.title ?? undefined,
          toolKind: update.kind ?? undefined,
          toolStatus: update.status ?? undefined,
          toolInput: update.rawInput,
          toolOutput: update.rawOutput,
          toolLocations: update.locations ?? undefined,
          toolContent: update.content,
        } as any);
      },
    });
  }

  private activeAcpSessionId(): string | null {
    const displayId = this.activeDisplaySessionId;
    if (!displayId) return null;
    return this.displaySessions.get(displayId)?.acpSessionId || null;
  }

  private getOrCreateDisplaySession(): DisplaySession {
    const activeId = this.activeDisplaySessionId;
    if (activeId) {
      const existing = this.displaySessions.get(activeId);
      if (existing && existing.agentKey === this.agentKey) return existing;
    }
    const latest = [...this.displaySessions.values()]
      .filter(session => session.agentKey === this.agentKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) {
      this.activeDisplaySessionId = latest.id;
      return latest;
    }
    const session = this.createDisplaySession();
    this.activeDisplaySessionId = session.id;
    return session;
  }

  private currentDisplaySession(): DisplaySession | null {
    const activeId = this.activeDisplaySessionId;
    if (activeId) {
      const existing = this.displaySessions.get(activeId);
      if (existing && existing.agentKey === this.agentKey) return existing;
    }
    return [...this.displaySessions.values()]
      .filter(session => session.agentKey === this.agentKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  private createDisplaySession(): DisplaySession {
    const now = Date.now();
    const session: DisplaySession = {
      id: `dt_${randomUUID()}`,
      clientId: WSServer.PROJECT_SESSION_SCOPE,
      agentKey: this.agentKey,
      title: '新会话',
      acpSessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.displaySessions.set(session.id, session);
    this.store?.createSession(session);
    return session;
  }

  private isEmptyDisplaySession(session: DisplaySession): boolean {
    return session.messages.length === 0 && !session.acpSessionId && session.title === '新会话';
  }

  private appendUserMessage(display: DisplaySession, payload: ReviewPayload['payload']): void {
    const images = Array.isArray(payload.screenshots)
      ? payload.screenshots
      : payload.screenshot
        ? [payload.screenshot]
        : [];
    const content = payload.userIntent || (images.length ? `发送 ${images.length} 张图片` : `发送 ${payload.items?.length || 0} 个标记`);
    const msg: DisplayMessage = {
      id: `msg_${Date.now()}_${randomUUID()}`,
      role: 'user',
      type: 'text',
      content,
      images,
      image: images[0] || null,
      timestamp: Date.now(),
    };
    display.messages.push(msg);
    if (!display.title || display.title === '新会话') {
      display.title = content.slice(0, 30) || '新会话';
    }
    this.trimDisplayMessages(display);
    this.store?.addMessage(display.id, msg);
    this.store?.updateSession(display);
  }

  private appendAssistantDelta(display: DisplaySession, delta: string): void {
    this.closeActiveThinking(display);
    let msg = [...display.messages].reverse().find(item => item.role === 'assistant' && item.type === 'stream') as DisplayMessage | undefined;
    if (!msg || display.messages[display.messages.length - 1] !== msg) {
      msg = {
        id: `msg_${Date.now()}_${randomUUID()}`,
        role: 'assistant',
        type: 'stream',
        content: '',
        timestamp: Date.now(),
      };
      display.messages.push(msg);
      this.store?.addMessage(display.id, msg);
    }
    msg.content += delta;
    msg.timestamp = Date.now();
    this.store?.updateMessage(display.id, msg);
    this.trimDisplayMessages(display);
  }

  private updateDisplaySessionInfo(
    clientId: string,
    display: DisplaySession,
    info: { title?: string | null; updatedAt?: string | null },
  ): void {
    const title = typeof info.title === 'string' ? info.title.trim() : '';
    if (!title || display.title === title) return;

    display.title = title.slice(0, 80);
    display.updatedAt = Date.now();
    this.store?.updateSession(display);
    this.send(clientId, {
      type: 'session_info',
      tabId: clientId,
      sessionId: display.id,
      acpSessionId: display.acpSessionId,
      sessionTitle: display.title,
    } as any);
  }

  private appendThinkingDelta(display: DisplaySession, delta: string): void {
    let msg = [...display.messages].reverse().find(item => item.role === 'assistant' && item.type === 'thinking' && !item.closed) as DisplayMessage | undefined;
    if (!msg) {
      msg = {
        id: `msg_${Date.now()}_${randomUUID()}`,
        role: 'assistant',
        type: 'thinking',
        content: '',
        closed: false,
        timestamp: Date.now(),
      };
      display.messages.push(msg);
      this.store?.addMessage(display.id, msg);
    }
    msg.content += delta;
    msg.timestamp = Date.now();
    this.store?.updateMessage(display.id, msg);
    this.trimDisplayMessages(display);
  }

  private closeActiveThinking(display: DisplaySession): boolean {
    const msg = [...display.messages].reverse().find(item => item.role === 'assistant' && item.type === 'thinking' && !item.closed) as DisplayMessage | undefined;
    if (!msg) return false;
    msg.closed = true;
    msg.timestamp = Date.now();
    this.store?.updateMessage(display.id, msg);
    return true;
  }

  private addToolDisplayMessage(display: DisplaySession, tool: any): void {
    this.closeActiveThinking(display);
    const msg: DisplayMessage = {
      id: `msg_${Date.now()}_${randomUUID()}`,
      role: 'assistant',
      type: 'tool',
      toolCallId: tool.toolCallId,
      title: tool.title || 'Tool',
      kind: tool.kind || 'other',
      input: tool.rawInput ?? null,
      locations: tool.locations || [],
      status: tool.status || 'pending',
      output: null,
      toolContent: null,
      content: '',
      timestamp: Date.now(),
    };
    display.messages.push(msg);
    this.trimDisplayMessages(display);
    this.store?.addMessage(display.id, msg);
  }

  private updateToolDisplayMessage(display: DisplaySession, update: any): void {
    const msg = display.messages.find(item => item.type === 'tool' && item.toolCallId === update.toolCallId);
    if (!msg) return;
    if (update.title != null) msg.title = update.title;
    if (update.kind != null) msg.kind = update.kind;
    if (update.status != null) msg.status = update.status;
    if (update.rawInput !== undefined) msg.input = update.rawInput;
    if (update.rawOutput !== undefined) msg.output = update.rawOutput;
    if (update.locations !== undefined) msg.locations = update.locations || [];
    if (update.content !== undefined) msg.toolContent = update.content || null;
    msg.timestamp = Date.now();
    display.updatedAt = Date.now();
    this.store?.updateMessage(display.id, msg);
    this.store?.updateSession(display);
  }

  private trimDisplayMessages(display: DisplaySession): void {
    display.updatedAt = Date.now();
    if (display.messages.length > 80) {
      display.messages.splice(0, display.messages.length - 80);
      this.store?.trimMessages(display.id);
    }
  }

  private publicSession(session: DisplaySession): Record<string, unknown> {
    return {
      sessionId: session.id,
      acpSessionId: session.acpSessionId,
      agentKey: session.agentKey,
      title: session.title,
      updatedAt: new Date(session.updatedAt).toISOString(),
      createdAt: new Date(session.createdAt).toISOString(),
      messageCount: session.messages.length,
    };
  }

  private async handleNewSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      if (this.processing.has(clientId)) {
        this.sendJson(res, 409, { ok: false, error: 'Cannot create a new session while a request is running' });
        return;
      }

      const current = this.currentDisplaySession();
      const reused = Boolean(current && this.isEmptyDisplaySession(current));
      const display = current && reused ? current : this.createDisplaySession();
      this.activeDisplaySessionId = display.id;
      this.queues.delete(clientId);

      this.sendJson(res, 200, { ok: true, reset: true, reused, sessionId: display.id, sessionTitle: display.title });
      this.send(clientId, { type: 'session_reset', tabId: clientId, reason: 'user_requested', sessionId: display.id });
      this.send(clientId, { type: 'session_info', tabId: clientId, sessionId: display.id, sessionTitle: display.title });
      console.log(`[SSE] ${reused ? 'Reused empty' : 'New'} display session for ${clientId}: ${display.id}`);
    } catch (err: any) {
      this.sendJson(res, 400, { error: err.message || 'Invalid request' });
    }
  }

  private async handleSessionsList(url: URL, res: ServerResponse): Promise<void> {
    const activeSessionId = this.getOrCreateDisplaySession().id;
    const sessions = [...this.displaySessions.values()]
      .filter(session => session.agentKey === this.agentKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(session => this.publicSession(session));
    this.sendJson(res, 200, { ok: true, supported: true, activeSessionId, sessions });
  }

  private async handleActiveSession(url: URL, res: ServerResponse): Promise<void> {
    const clientId = url.searchParams.get('clientId') || 'default';
    const display = this.getOrCreateDisplaySession();
    this.sendJson(res, 200, {
      ok: true,
      session: this.publicSession(display),
      messages: display.messages,
      activeSessionId: display.id,
      isProcessing: this.isClientProcessingSession(clientId, display.id),
      processingSessionId: this.processingDisplaySessions.get(clientId) || null,
    });
  }

  private async handleLoadSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string; sessionId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      const sessionId = msg.sessionId;
      if (!sessionId) {
        this.sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
        return;
      }
      if (this.processing.has(clientId)) {
        this.sendJson(res, 409, { ok: false, error: 'Cannot load a session while a request is running' });
        return;
      }

      const display = this.displaySessions.get(sessionId);
      if (!display || display.agentKey !== this.agentKey) {
        this.sendJson(res, 404, { ok: false, error: 'Session not found' });
        return;
      }

      this.queues.delete(clientId);
      this.activeDisplaySessionId = display.id;
      this.browserRouter.activate(clientId, this.projectInfo.projectId, display.acpSessionId || null);
      this.send(clientId, { type: 'session_info', tabId: clientId, sessionId: display.id, sessionTitle: display.title });
      this.send(clientId, {
        type: 'session_snapshot',
        tabId: clientId,
        sessionId: display.id,
        sessionTitle: display.title,
        messages: display.messages,
      } as any);
      this.sendJson(res, 200, { ok: true, sessionId: display.id, sessionTitle: display.title, messages: display.messages });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err.message || 'Failed to load session' });
    }
  }

  private async handleDeleteSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string; sessionId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      const sessionId = msg.sessionId;
      if (!sessionId) {
        this.sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
        return;
      }
      const display = this.displaySessions.get(sessionId);
      if (!display || display.agentKey !== this.agentKey) {
        this.sendJson(res, 404, { ok: false, error: 'Session not found' });
        return;
      }
      const acpSession = this.sessions.get(sessionId);
      if (acpSession) acpSession.stop();
      this.sessions.delete(sessionId);
      this.displaySessions.delete(sessionId);
      this.store?.deleteSession(sessionId);
      const wasActive = this.activeDisplaySessionId === sessionId;
      if (!wasActive) {
        const active = this.currentDisplaySession();
        this.sendJson(res, 200, { ok: true, deleted: sessionId, activeSessionId: active?.id || null, activeSessionTitle: active?.title || null });
        return;
      }

      let next = [...this.displaySessions.values()]
        .filter(session => session.agentKey === this.agentKey)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!next) next = this.createDisplaySession();
      this.activeDisplaySessionId = next.id;
      this.browserRouter.activate(clientId, this.projectInfo.projectId, next.acpSessionId || null);
      this.send(clientId, { type: 'session_info', tabId: clientId, sessionId: next.id, sessionTitle: next.title });
      this.send(clientId, {
        type: 'session_snapshot',
        tabId: clientId,
        sessionId: next.id,
        sessionTitle: next.title,
        messages: next.messages,
      } as any);
      this.sendJson(res, 200, { ok: true, deleted: sessionId, activeSessionId: next.id, activeSessionTitle: next.title });
    } catch (err: any) {
      this.sendJson(res, 500, { ok: false, error: err.message || 'Failed to delete session' });
    }
  }

  private publicElementTarget(target: StoredElementTarget): Record<string, unknown> {
    return {
      ...target.payload,
      id: target.id,
      targetId: target.id,
      name: target.name,
      description: target.description || '',
      pagePattern: target.pagePattern || '',
      pageUrl: target.pageUrl || '',
      createdAt: new Date(target.createdAt).toISOString(),
      updatedAt: new Date(target.updatedAt).toISOString(),
    };
  }

  private handleElementTargetsList(_url: URL, res: ServerResponse): void {
    const targets = [...this.elementTargets.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(target => this.publicElementTarget(target));
    this.sendJson(res, 200, { ok: true, targets });
  }

  private async handleElementTargetSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJson(req) as Record<string, unknown>;
      const name = String(body.name || '').trim();
      if (!name) {
        this.sendJson(res, 400, { ok: false, error: 'Missing element target name' });
        return;
      }
      const selector = String(body.selector || '');
      const xpath = String(body.xpath || '');
      const locatorRecipes = Array.isArray(body.locatorRecipes) ? body.locatorRecipes : [];
      if (!selector && !xpath && locatorRecipes.length === 0) {
        this.sendJson(res, 400, { ok: false, error: 'Missing locator: selector, xpath, or locatorRecipes required' });
        return;
      }

      const now = Date.now();
      const id = String(body.id || body.targetId || `target_${randomUUID()}`);
      const previous = this.elementTargets.get(id);
      const target: StoredElementTarget = {
        id,
        name,
        description: String(body.description || ''),
        pagePattern: String(body.pagePattern || ''),
        pageUrl: String(body.pageUrl || ''),
        payload: {
          ...body,
          id,
          targetId: id,
          name,
        },
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      };
      this.elementTargets.set(id, target);
      this.store?.saveElementTarget(target);
      this.store?.flush();
      this.sendJson(res, 200, { ok: true, target: this.publicElementTarget(target) });
    } catch (err: any) {
      this.sendJson(res, 400, { ok: false, error: err.message || 'Invalid element target payload' });
    }
  }

  private handleElementTargetDelete(url: URL, res: ServerResponse): void {
    try {
      const id = decodeURIComponent(url.pathname.slice('/element-targets/'.length));
      if (!id) {
        this.sendJson(res, 400, { ok: false, error: 'Missing element target id' });
        return;
      }
      this.elementTargets.delete(id);
      this.store?.deleteElementTarget(id);
      this.store?.flush();
      this.sendJson(res, 200, { ok: true, deleted: id });
    } catch (err: any) {
      console.error('[WSServer] handleElementTargetDelete failed:', err);
      this.sendJson(res, 500, { ok: false, error: err.message || 'Delete failed' });
    }
  }

  /**
   * Handle element-target CRUD actions locally in the Bridge,
   * bypassing the SSE round-trip to the Extension.
   */
  private async handleLocalBrowserAction(
    action: BrowserActionName,
    params: Record<string, unknown>,
  ): Promise<BrowserActionResult> {
    const requestId = `local_${randomUUID()}`;
    try {
      switch (action) {
        case 'get_element_targets': {
          const targets = [...this.elementTargets.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(target => this.publicElementTarget(target));
          return { requestId, ok: true, result: { targets } };
        }
        case 'save_element_target': {
          const name = String(params.name || '').trim();
          if (!name) {
            return { requestId, ok: false, error: { code: 'INVALID_PARAMS', message: 'Missing element target name' } };
          }
          const selector = String(params.selector || '');
          const xpath = String(params.xpath || '');
          const locatorRecipes = Array.isArray(params.locatorRecipes) ? params.locatorRecipes : [];
          if (!selector && !xpath && locatorRecipes.length === 0) {
            return { requestId, ok: false, error: { code: 'INVALID_PARAMS', message: 'Missing locator: selector, xpath, or locatorRecipes required' } };
          }
          const now = Date.now();
          const id = String(params.id || params.targetId || `target_${randomUUID()}`);
          const previous = this.elementTargets.get(id);
          const target: StoredElementTarget = {
            id,
            name,
            description: String(params.description || ''),
            pagePattern: String(params.pagePattern || ''),
            pageUrl: String(params.pageUrl || ''),
            payload: { ...params, id, targetId: id, name },
            createdAt: previous?.createdAt || now,
            updatedAt: now,
          };
          this.elementTargets.set(id, target);
          this.store?.saveElementTarget(target);
          this.store?.flush();
          return { requestId, ok: true, result: { target: this.publicElementTarget(target) } };
        }
        case 'delete_element_target': {
          const targetId = String(params.targetId || '').trim();
          const targetName = String(params.targetName || '').trim().toLowerCase();
          if (!targetId && !targetName) {
            return { requestId, ok: false, error: { code: 'INVALID_PARAMS', message: 'Missing targetId or targetName' } };
          }
          // Find by id or name
          let deletedId = targetId;
          if (!targetId && targetName) {
            for (const [id, target] of this.elementTargets) {
              if (String(target.name || '').trim().toLowerCase() === targetName) {
                deletedId = id;
                break;
              }
            }
          }
          if (!deletedId || !this.elementTargets.has(deletedId)) {
            return { requestId, ok: false, error: { code: 'NOT_FOUND', message: `Element target not found: ${targetId || targetName}` } };
          }
          this.elementTargets.delete(deletedId);
          this.store?.deleteElementTarget(deletedId);
          this.store?.flush();
          return { requestId, ok: true, result: { deleted: deletedId } };
        }
        default:
          return { requestId, ok: false, error: { code: 'UNEXPECTED_ACTION', message: `Unexpected local action: ${action}` } };
      }
    } catch (err: any) {
      return { requestId, ok: false, error: { code: 'LOCAL_ACTION_ERROR', message: err.message || 'Local action failed' } };
    }
  }

  private async handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      const displayId = this.processingDisplaySessions.get(clientId) || this.activeDisplaySessionId;
      const session = displayId ? this.sessions.get(displayId) : null;
      const queue = this.queues.get(clientId);
      if (queue) queue.length = 0;
      this.queues.delete(clientId);

      if (!session || !this.processing.has(clientId)) {
        this.sendJson(res, 200, { ok: true, canceled: false, reason: 'not_running' });
        return;
      }

      const canceled = await session.cancelCurrentTurn();
      if (!canceled && this.processing.has(clientId)) {
        this.pendingCancels.add(clientId);
        this.sendJson(res, 200, { ok: true, canceled: true, pending: true });
        return;
      }
      this.pendingCancels.add(clientId);
      this.scheduleForcedCancel(clientId, displayId, session);
      this.sendJson(res, 200, { ok: true, canceled });
      if (canceled) {
        this.send(clientId, { type: 'tool_status', tabId: clientId, sessionId: displayId, toolStatus: 'canceled' } as any);
      }
    } catch (err: any) {
      this.sendJson(res, 400, { error: err.message || 'Invalid request' });
    }
  }

  private scheduleForcedCancel(clientId: string, displayId: string | null, session: ACPSession): void {
    if (!displayId) return;
    setTimeout(() => {
      if (!this.processing.has(clientId)) return;
      if (this.processingDisplaySessions.get(clientId) !== displayId) return;
      // 如果该 displaySession 已经被新 session 覆盖，不要误杀新 session
      const currentSession = this.sessions.get(displayId);
      if (currentSession !== session) return;
      this.forcedCancels.add(clientId);
      session.stop();
      this.sessions.delete(displayId);
    }, WSServer.CANCEL_FORCE_STOP_MS);
  }

  private async handleBrowserActionResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const result = await this.readJson(req) as BrowserActionResult;
      if (!result || typeof result.requestId !== 'string') {
        this.sendJson(res, 400, { error: 'Missing browser action requestId' });
        return;
      }
      const accepted = this.browserRouter.receiveResult(result);
      this.sendJson(res, accepted ? 200 : 404, { ok: accepted });
    } catch (err: any) {
      this.sendJson(res, 400, { error: err.message || 'Invalid browser action result' });
    }
  }

  private touch(clientId: string): void {
    this.lastActive.set(clientId, Date.now());
  }

  private send(clientId: string, msg: WSMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.res.destroyed) return;
    client.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  private sendBrowserAction(clientId: string, event: BrowserActionEvent): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.res.destroyed) return false;
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  private broadcastActiveClient(): void {
    const activeClientId = this.browserRouter.activeClientId;
    for (const clientId of this.clients.keys()) {
      this.send(clientId, {
        type: 'active_client',
        tabId: clientId,
        activeClientId,
        isActiveClient: activeClientId === clientId,
      } as any);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [clientId, client] of this.clients) {
        if (client.res.destroyed) {
          this.clients.delete(clientId);
          continue;
        }
        client.res.write(': heartbeat\n\n');
      }
    }, 30000);
  }

  private startIdleCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - this.idleTimeoutMs;
      for (const [clientId, lastActive] of this.lastActive) {
        if (lastActive >= cutoff || this.processing.has(clientId)) continue;
        this.queues.delete(clientId);
        this.lastActive.delete(clientId);
      }
    }, 2 * 60 * 1000);
  }

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.setCorsHeaders(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 12 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.browserRouter.stop();
    for (const session of this.sessions.values()) {
      session.stop();
    }
    this.sessions.clear();
    for (const client of this.clients.values()) {
      client.res.end();
    }
    this.clients.clear();
    this.server?.close();
    if (this.store) this.store.close();
  }
}
