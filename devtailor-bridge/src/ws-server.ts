/**
 * SSE Server — Receives review requests from Chrome extension,
 * forwards to the local agent runtime, relays stream responses over Server-Sent Events.
 */

import http, { IncomingMessage, ServerResponse } from 'http';
import { createHash, randomUUID } from 'crypto';
import { basename } from 'path';
import { realpathSync } from 'fs';
import { WSMessage, ReviewPayload } from './types';
import { BrowserActionRouter } from './browser-action-router';
import { ApprovalRouter, ApprovalEvent } from './approval-router';
import { QuestionRouter, QuestionEvent } from './question-router';
import { BrowserActionEvent, BrowserActionName, BrowserActionResult } from './browser-action-types';
import { SessionStore, StoredElementTarget } from './session-store';
import { AgentSession, BrowserToolRunner, STOP_REASON_PENDING } from './agent-session';
import { PlaceholderAgentSession } from './placeholder-agent-session';
import { log, logError } from './log';

export type AgentSessionFactory = (runner: BrowserToolRunner) => AgentSession;

/** Bumped when the extension <-> bridge HTTP/SSE contract changes incompatibly. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Optional: pin the bridge to a single extension id (chrome-extension://<id>). */
const EXTENSION_ID_ENV = 'DEVTAILOR_EXTENSION_ID';

/** Lower-case header name the extension service worker sends (value: chrome.runtime.id). */
export const EXTENSION_CLIENT_HEADER = 'x-devtailor-client';

interface Client {
  id: string;
  res: ServerResponse;
}

/** State of the review turn currently being displayed for a client. */
interface ActiveTurn {
  canceled: boolean;
  summary?: string;
  /** An error was already reported to the UI for this turn. */
  errored: boolean;
  /** Settles when the agent reports done/error (async sessions) or the turn is canceled. */
  completion: Promise<void>;
  complete: () => void;
}

function createActiveTurn(): ActiveTurn {
  let complete!: () => void;
  const completion = new Promise<void>(resolve => { complete = resolve; });
  return { canceled: false, errored: false, completion, complete };
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
  agentSessionId: string | null;
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
  /**
   * How long an active client may be offline before it loses browser-tool
   * ownership. Covers page refreshes / service worker restarts, where the
   * same clientId reconnects within moments. Mutable for tests.
   */
  static activeClientGraceMs = 3000;
  /** Maximum number of queued reviews per client. Beyond this limit, new reviews are rejected with 429. */
  private static readonly MAX_REVIEW_QUEUE_DEPTH = 10;
  private server: http.Server | null = null;
  private clients = new Map<string, Client>();
  private sessions = new Map<string, AgentSession>();
  private displaySessions = new Map<string, DisplaySession>();
  private elementTargets = new Map<string, StoredElementTarget>();
  private activeDisplaySessionId: string | null = null;
  private queues = new Map<string, PendingReview[]>();
  private processing = new Set<string>();
  private processingDisplaySessions = new Map<string, string>();
  /** Per-client state of the review turn currently being displayed. */
  private activeTurns = new Map<string, ActiveTurn>();
  /** Origin accepted by the request guard, used to echo CORS headers. */
  private allowedOrigins = new WeakMap<ServerResponse, string>();
  private lastActive = new Map<string, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private releaseTimers = new Set<NodeJS.Timeout>();
  private projectInfo: { projectId: string; projectName: string; bridgeInstanceId: string; agentKey: string; agentLabel: string };
  private browserRouter: BrowserActionRouter;
  private approvalRouter: ApprovalRouter;
  private questionRouter: QuestionRouter;
  private store: SessionStore | null = null;
  private readonly idleTimeoutMs = 4 * 60 * 60 * 1000;

  constructor(
    private port: number,
    private cwd: string,
    private dataDir?: string,
    agentKey = 'claude',
    agentLabel = 'Claude Code',
    createAgentSession: AgentSessionFactory = () => new PlaceholderAgentSession(),
  ) {
    this.agentKey = agentKey;
    this.agentLabel = agentLabel;
    this.createAgentSession = createAgentSession;
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
    this.approvalRouter = new ApprovalRouter(
      (clientId, event) => this.sendApproval(clientId, event),
      (event) => this.broadcastApproval(event),
      () => this.browserRouter.activeClientId,
    );
    this.questionRouter = new QuestionRouter(
      (clientId, event) => this.sendQuestion(clientId, event),
      (event) => this.broadcastQuestion(event),
      () => this.browserRouter.activeClientId,
    );
  }

  private agentKey: string;
  private agentLabel: string;
  private createAgentSession: AgentSessionFactory;

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
    log(`[Store] Restored ${this.displaySessions.size} session(s) from SQLite`);
  }

  /** Resolves once listening; rejects if binding fails (e.g. EADDRINUSE). */
  start(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    this.server = server;

    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only: never expose the bridge on other interfaces.
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        log(`[SSE] Server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
    // Keep logging runtime errors after startup; startup errors are surfaced via the promise.
    server.on('error', (err) => {
      logError('[SSE] Server error:', err.message);
    });
    listening.catch(() => {});

    this.startHeartbeat();
    this.startIdleCleanup();
    return listening;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const guard = this.guardRequest(req, url);
    if (!guard.allowed) {
      this.rejectRequest(req, res, url, guard.reason);
      return;
    }
    if (guard.origin) this.allowedOrigins.set(res, guard.origin);
    res.setHeader('Vary', 'Origin');
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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

    if (req.method === 'POST' && url.pathname === '/approval-decision') {
      await this.handleApprovalDecision(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/question-answer') {
      await this.handleQuestionAnswer(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      this.handleHealth(url, res, guard.trusted);
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
    });
    res.write(': connected\n\n');

    const previous = this.clients.get(clientId);
    if (previous) previous.res.end();

    this.clients.set(clientId, { id: clientId, res });
    this.touch(clientId);
    log(`[SSE] Client connected: ${clientId}`);
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
        log(`[SSE] Client disconnected: ${clientId}`);
        this.scheduleActiveClientRelease(clientId);
      }
    });
  }

  /**
   * Never keep routing browser actions to a client whose stream is gone. A short
   * grace period lets a refreshed page reconnect and keep ownership.
   */
  private scheduleActiveClientRelease(clientId: string): void {
    if (this.browserRouter.activeClientId !== clientId) return;
    const timer = setTimeout(() => {
      this.releaseTimers.delete(timer);
      if (this.clients.has(clientId)) return;
      if (this.browserRouter.activeClientId !== clientId) return;
      this.browserRouter.deactivate(clientId);
      this.broadcastActiveClient();
      log(`[SSE] Active client released after disconnect: ${clientId}`);
    }, WSServer.activeClientGraceMs);
    timer.unref();
    this.releaseTimers.add(timer);
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
      const display = this.getOrCreateDisplaySession();
      const existingQueueLength = this.queues.get(clientId)?.length || 0;
      const queueDepth = existingQueueLength + 1;
      if (existingQueueLength >= WSServer.MAX_REVIEW_QUEUE_DEPTH) {
        this.sendJson(res, 429, {
          ok: false,
          error: `Review queue full (max ${WSServer.MAX_REVIEW_QUEUE_DEPTH}). Wait for current reviews to complete.`,
          queueDepth: existingQueueLength,
          maxDepth: WSServer.MAX_REVIEW_QUEUE_DEPTH,
        });
        return;
      }
      const queued = this.processing.has(clientId) || queueDepth > 1;
      this.sendJson(res, 202, {
        ok: true,
        queued,
        queueDepth,
        sessionId: display.id,
        isProcessing: this.processing.has(clientId),
      });
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
      this.browserRouter.activate(clientId, this.projectInfo.projectId, this.activeAgentSessionId());
      this.broadcastActiveClient();
      // A newly active client is the turn-owner UI; recover any in-flight approvals/questions.
      this.approvalRouter.resendPending(clientId);
      this.questionRouter.resendPending(clientId);
      const activeDisplay = this.currentDisplaySession();
      this.sendJson(res, 200, {
        ok: true,
        activeClientId: clientId,
        activeSessionId: activeDisplay?.id || null,
        activeSessionTitle: activeDisplay?.title || null,
        agentSessionId: this.activeAgentSessionId(),
      });
    } catch (err: any) {
      this.sendJson(res, 400, { ok: false, error: err.message || 'Invalid request' });
    }
  }

  private enqueueReview(clientId: string, payload: ReviewPayload['payload'], displaySessionId: string): void {
    const queue = this.queues.get(clientId) || [];
    queue.push({ payload, displaySessionId });
    this.queues.set(clientId, queue);
    this.sendRuntimeEvent(clientId, {
      type: 'queue_status',
      tabId: clientId,
      sessionId: displaySessionId,
      queueDepth: queue.length,
    } as any);
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
        this.sendRuntimeEvent(clientId, {
          type: 'queue_status',
          tabId: clientId,
          sessionId: pending.displaySessionId,
          queueDepth: queue.length,
        } as any);
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
      this.activeTurns.delete(clientId);
      this.processing.delete(clientId);
      const activeDisplay = this.currentDisplaySession();
      if (activeDisplay) {
        this.sendRuntimeEvent(clientId, {
          type: 'queue_status',
          tabId: clientId,
          sessionId: activeDisplay.id,
          queueDepth: 0,
        } as any);
      }
    }
  }

  private async handleReview(clientId: string, payload: ReviewPayload['payload'], displaySessionId: string): Promise<void> {
    this.touch(clientId);
    const queuedDisplay = this.displaySessions.get(displaySessionId);
    const display = queuedDisplay && queuedDisplay.agentKey === this.agentKey
      ? queuedDisplay
      : this.getOrCreateDisplaySession();
    const session = this.getOrCreateSession(display.id, display.agentSessionId);
    const userMessage = this.appendUserMessage(display, payload);
    const turn = createActiveTurn();
    this.activeTurns.set(clientId, turn);
    this.sendRuntimeEvent(clientId, {
      type: 'display_message',
      tabId: clientId,
      sessionId: display.id,
      displayMessage: userMessage,
    });
    this.attachSessionCallbacks(clientId, display, session, turn);

    try {
      await this.startReviewSession(clientId, display, session);
    } catch (err: any) {
      logError('[SSE] Failed to start session:', err.message);
      if (!turn.canceled) {
        turn.errored = true;
        this.sendRuntimeEvent(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message: `Session start failed: ${err.message}` } as any);
      }
      session.stop();
      this.sessions.delete(display.id);
      return;
    }

    if (turn.canceled) return;

    try {
      let stopReason = await session.sendReview(payload, { clientId, displaySessionId: display.id });
      // /cancel already told the UI the turn is over; late results are dropped.
      if (turn.canceled) return;
      if (stopReason === STOP_REASON_PENDING) {
        // Async agent (Claude Code channel): the turn stays open until the
        // agent calls onDone/onError, or the user cancels. The queue stays serial.
        await turn.completion;
        if (turn.canceled || turn.errored) return;
        stopReason = 'end_turn';
      }
      if (stopReason === 'error') return;
      this.closeActiveThinking(display);
      // The single place a normal `done` is emitted for a turn.
      this.sendRuntimeEvent(clientId, {
        type: 'done',
        tabId: clientId,
        sessionId: display.id,
        summary: stopReason === 'cancelled' ? 'Cancelled' : (turn.summary || 'Done'),
        reason: stopReason,
      } as any);
    } catch (err: any) {
      if (turn.canceled) return;
      logError('[SSE] Failed to send review:', err.message);
      // The session may already have reported this failure through onError.
      if (!turn.errored) {
        this.sendRuntimeEvent(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message: err.message } as any);
      }
      session.stop();
      this.sessions.delete(display.id);
    }
  }

  private getOrCreateSession(
    displaySessionId: string,
    _agentSessionId?: string | null,
  ): AgentSession {
    let session = this.sessions.get(displaySessionId);
    if (!session || (!session.isReady && !session.isStarting)) {
      if (session) session.stop();
      session = this.createAgentSession(
        (action, params = {}) => this.browserRouter.run(action, params),
      );
      this.sessions.set(displaySessionId, session);
    }
    return session;
  }

  private async startReviewSession(
    clientId: string,
    display: DisplaySession,
    session: AgentSession,
  ): Promise<ReviewSessionStart> {
    const result = await session.start();
    const sid = result.sessionId || session.currentSessionId;
    if (sid) {
      display.agentSessionId = sid;
      display.updatedAt = Date.now();
      this.store?.updateSession(display);
      if (this.browserRouter.activeClientId === clientId) {
        this.browserRouter.activate(clientId, this.projectInfo.projectId, sid);
      }
      this.send(clientId, {
        type: 'session_info',
        tabId: clientId,
        sessionId: display.id,
        agentSessionId: sid,
        sessionTitle: display.title,
      } as any);
    }
    return { sessionId: sid || null, mode: result.mode };
  }

  private isClientProcessingSession(clientId: string, displaySessionId: string | null): boolean {
    if (!displaySessionId || !this.processing.has(clientId)) return false;
    return (this.processingDisplaySessions.get(clientId) || this.activeDisplaySessionId) === displaySessionId;
  }

  private attachSessionCallbacks(
    clientId: string,
    display: DisplaySession,
    session: AgentSession,
    turn: ActiveTurn,
  ): void {
    // After /cancel the UI has already received `done`; drop anything the agent still emits.
    session.setCallbacks({
      onStream: (delta) => {
        if (turn.canceled) return;
        this.appendAssistantDelta(display, delta);
        this.sendRuntimeEvent(clientId, { type: 'stream', tabId: clientId, sessionId: display.id, delta } as any);
      },
      onNotice: (text) => {
        // Live-only hint: sent as a stream event but never stored in the display history.
        if (turn.canceled) return;
        this.sendRuntimeEvent(clientId, { type: 'stream', tabId: clientId, sessionId: display.id, delta: text } as any);
      },
      onThinking: (delta) => {
        if (turn.canceled) return;
        this.appendThinkingDelta(display, delta);
        this.sendRuntimeEvent(clientId, { type: 'thinking', tabId: clientId, sessionId: display.id, delta } as any);
      },
      onDone: (summary) => {
        // `done` is emitted once by handleReview (after sendReview settles, or
        // after the async completion this call resolves).
        if (turn.canceled) return;
        this.closeActiveThinking(display);
        if (summary) turn.summary = summary;
        turn.complete();
      },
      onError: (message) => {
        if (turn.canceled) return;
        this.closeActiveThinking(display);
        turn.errored = true;
        this.sendRuntimeEvent(clientId, { type: 'error', tabId: clientId, sessionId: display.id, message } as any);
        turn.complete();
      },
      onSessionInfoUpdate: (info) => {
        if (turn.canceled) return;
        this.updateDisplaySessionInfo(clientId, display, info);
      },
      onToolCall: (tool) => {
        if (turn.canceled) return;
        this.addToolDisplayMessage(display, tool);
        this.sendRuntimeEvent(clientId, {
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
        if (turn.canceled) return;
        this.updateToolDisplayMessage(display, update);
        this.sendRuntimeEvent(clientId, {
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
      onApprovalRequest: async (request) => {
        const result = await this.approvalRouter.request({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          action: request.action,
          risk: request.risk,
          detail: request.detail,
        });
        return { decision: result.decision, feedback: result.feedback };
      },
      onQuestionRequest: async (request) => {
        return this.questionRouter.request({
          toolCallId: request.toolCallId,
          turnId: request.turnId,
          questions: request.questions,
        });
      },
    });
  }

  private activeAgentSessionId(): string | null {
    const displayId = this.activeDisplaySessionId;
    if (!displayId) return null;
    return this.displaySessions.get(displayId)?.agentSessionId || null;
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
      agentSessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.displaySessions.set(session.id, session);
    this.store?.createSession(session);
    return session;
  }

  private isEmptyDisplaySession(session: DisplaySession): boolean {
    return session.messages.length === 0 && !session.agentSessionId && session.title === '新会话';
  }

  private appendUserMessage(display: DisplaySession, payload: ReviewPayload['payload']): DisplayMessage {
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
    return msg;
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
      agentSessionId: display.agentSessionId,
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
      agentSessionId: session.agentSessionId,
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
      log(`[SSE] ${reused ? 'Reused empty' : 'New'} display session for ${clientId}: ${display.id}`);
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
      this.browserRouter.activate(clientId, this.projectInfo.projectId, display.agentSessionId || null);
      this.send(clientId, { type: 'session_info', tabId: clientId, sessionId: display.id, sessionTitle: display.title });
      this.send(clientId, {
        type: 'session_snapshot',
        tabId: clientId,
        sessionId: display.id,
        sessionTitle: display.title,
        messages: display.messages,
        isProcessing: this.isClientProcessingSession(clientId, display.id),
        processingSessionId: this.processingDisplaySessions.get(clientId) || null,
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
      const agentSession = this.sessions.get(sessionId);
      if (agentSession) agentSession.stop();
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
      this.browserRouter.activate(clientId, this.projectInfo.projectId, next.agentSessionId || null);
      this.send(clientId, { type: 'session_info', tabId: clientId, sessionId: next.id, sessionTitle: next.title });
      this.send(clientId, {
        type: 'session_snapshot',
        tabId: clientId,
        sessionId: next.id,
        sessionTitle: next.title,
        messages: next.messages,
        isProcessing: this.isClientProcessingSession(clientId, next.id),
        processingSessionId: this.processingDisplaySessions.get(clientId) || null,
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
      logError('[WSServer] handleElementTargetDelete failed:', err);
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

  /**
   * Cancels the displayed turn: the UI gets `tool_status canceled` + `done`,
   * late agent output for the turn is dropped and the queue is cleared. The
   * agent session is NOT stopped; it is asked to cancel (for Claude Code this
   * pushes a `kind=cancel` channel notification).
   */
  private async handleCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const msg = await this.readJson(req) as { clientId?: string; tabId?: string };
      const clientId = msg.clientId || msg.tabId || 'default';
      const displayId = this.processingDisplaySessions.get(clientId) || this.activeDisplaySessionId;
      const queue = this.queues.get(clientId);
      if (queue) queue.length = 0;
      this.queues.delete(clientId);

      const turn = this.activeTurns.get(clientId);
      if (!turn || turn.canceled || !this.processing.has(clientId)) {
        this.sendJson(res, 200, { ok: true, canceled: false, reason: 'not_running' });
        return;
      }

      turn.canceled = true;
      turn.complete();
      const display = displayId ? this.displaySessions.get(displayId) : null;
      if (display) this.closeActiveThinking(display);
      // Tell the agent (Claude Code gets a kind=cancel channel notification).
      const agentSession = displayId ? this.sessions.get(displayId) : undefined;
      agentSession?.cancelCurrentTurn().catch(err => {
        logError('[SSE] cancelCurrentTurn failed:', err?.message || err);
      });
      this.sendJson(res, 200, { ok: true, canceled: true });
      this.send(clientId, { type: 'tool_status', tabId: clientId, sessionId: displayId, toolStatus: 'canceled' } as any);
      this.sendRuntimeEvent(clientId, {
        type: 'done',
        tabId: clientId,
        sessionId: displayId || undefined,
        summary: 'Cancelled',
        reason: 'cancelled',
      } as any);
    } catch (err: any) {
      this.sendJson(res, 400, { error: err.message || 'Invalid request' });
    }
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

  private sendRuntimeEvent(clientId: string, msg: WSMessage): void {
    const activeDisplay = this.currentDisplaySession();
    const sessionId = (msg as any).sessionId || activeDisplay?.id || null;
    this.send(clientId, {
      ...(msg as any),
      activeSessionId: activeDisplay?.id || null,
      isProcessing: sessionId ? this.isClientProcessingSession(clientId, sessionId) : this.processing.has(clientId),
      processingSessionId: this.processingDisplaySessions.get(clientId) || null,
    } as any);
  }

  private sendBrowserAction(clientId: string, event: BrowserActionEvent): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.res.destroyed) return false;
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  private sendApproval(clientId: string, event: ApprovalEvent): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.res.destroyed) return false;
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  private broadcastApproval(event: ApprovalEvent): void {
    for (const clientId of this.clients.keys()) {
      this.sendApproval(clientId, event);
    }
  }

  private async handleApprovalDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJson(req) as {
        approvalId?: string;
        decision?: string;
        feedback?: string;
      };
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
      const decision = body.decision === 'approved' ? 'approved'
        : body.decision === 'rejected' ? 'rejected'
        : null;
      if (!approvalId || !decision) {
        this.sendJson(res, 400, { ok: false, error: 'Missing approvalId or decision' });
        return;
      }
      const accepted = this.approvalRouter.receiveDecision({
        approvalId,
        decision,
        feedback: typeof body.feedback === 'string' ? body.feedback : undefined,
      });
      this.sendJson(res, accepted ? 200 : 409, { ok: accepted });
    } catch (err: any) {
      this.sendJson(res, 400, { ok: false, error: err.message || 'Invalid approval decision' });
    }
  }

  private sendQuestion(clientId: string, event: QuestionEvent): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.res.destroyed) return false;
    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  }

  private broadcastQuestion(event: QuestionEvent): void {
    for (const clientId of this.clients.keys()) {
      this.sendQuestion(clientId, event);
    }
  }

  private async handleQuestionAnswer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readJson(req) as {
        questionId?: string;
        answers?: Record<string, string | true> | null;
      };
      const questionId = typeof body.questionId === 'string' ? body.questionId : '';
      if (!questionId) {
        this.sendJson(res, 400, { ok: false, error: 'Missing questionId' });
        return;
      }
      const answers = body.answers && typeof body.answers === 'object' ? body.answers : null;
      const accepted = this.questionRouter.receiveAnswer({ questionId, answers });
      this.sendJson(res, accepted ? 200 : 409, { ok: accepted });
    } catch (err: any) {
      this.sendJson(res, 400, { ok: false, error: err.message || 'Invalid question answer' });
    }
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
    const origin = this.allowedOrigins.get(res);
    if (!origin) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DevTailor-Client');
  }

  /**
   * Request guard, runs before routing.
   * - Host must be the loopback address with our port (anti DNS rebinding).
   * - Everything except GET /health requires an `Origin` of an extension
   *   (`chrome-extension://<id>`, optionally pinned via DEVTAILOR_EXTENSION_ID).
   *   Web pages cannot forge this Origin; requests without Origin are refused.
   */
  private guardRequest(
    req: IncomingMessage,
    url: URL,
  ): { allowed: true; origin: string | null; trusted: boolean } | { allowed: false; reason: string } {
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return { allowed: false, reason: 'bad_host' };
    }

    const rawOrigin = req.headers.origin;
    const origin = typeof rawOrigin === 'string' ? rawOrigin : null;
    const isHealth = url.pathname === '/health' && (req.method === 'GET' || req.method === 'OPTIONS');

    if (!origin) {
      // Verified in real Chrome (scripts/e2e-extension.mjs): extension service-worker
      // GET requests to a host-permitted URL carry NO Origin header, exactly like a
      // page's no-cors GET. The extension therefore marks its requests with a custom
      // header. A web page cannot send a custom header without a CORS preflight
      // (OPTIONS carries the page's Origin and is refused below), and no-cors requests
      // cannot carry custom headers, so only extension code can produce this request.
      const clientError = this.validateExtensionClientHeader(req.headers[EXTENSION_CLIENT_HEADER]);
      if (!clientError) return { allowed: true, origin: null, trusted: true };
      return isHealth ? { allowed: true, origin: null, trusted: false } : { allowed: false, reason: 'missing_origin' };
    }
    const originError = this.validateExtensionOrigin(origin);
    if (originError) {
      // /health stays reachable for liveness checks, but without CORS access or details.
      return isHealth ? { allowed: true, origin: null, trusted: false } : { allowed: false, reason: originError };
    }
    return { allowed: true, origin, trusted: true };
  }

  /** Header value is the extension id (`chrome.runtime.id`); DEVTAILOR_EXTENSION_ID pins it. */
  private validateExtensionClientHeader(value: string | string[] | undefined): string | null {
    if (typeof value !== 'string' || !/^[a-z0-9]+$/i.test(value)) return 'no_client_header';
    const pinned = (process.env[EXTENSION_ID_ENV] || '').trim();
    if (pinned && pinned !== value) return 'extension_id_mismatch';
    return null;
  }

  private validateExtensionOrigin(origin: string): string | null {
    const prefix = 'chrome-extension://';
    if (!origin.startsWith(prefix)) return 'origin_not_extension';
    const id = origin.slice(prefix.length);
    if (!/^[a-z0-9]+$/i.test(id)) return 'origin_malformed';
    const pinned = (process.env[EXTENSION_ID_ENV] || '').trim();
    if (pinned && pinned !== id) return 'extension_id_mismatch';
    return null;
  }

  private rejectRequest(req: IncomingMessage, res: ServerResponse, url: URL, reason: string): void {
    let originDesc = '-';
    if (typeof req.headers.origin === 'string') {
      try {
        const o = new URL(req.headers.origin);
        originDesc = `${o.protocol}//${o.host}`;
      } catch {
        originDesc = '(unparseable)';
      }
    }
    log(`[Guard] ${new Date().toISOString()} denied ${req.method} ${url.pathname} reason=${reason} origin=${originDesc}`);
    res.writeHead(403, { 'Content-Type': 'application/json', Vary: 'Origin' });
    res.end(JSON.stringify({ error: 'Forbidden', reason }));
    // Do not keep reading a refused request body.
    req.resume();
  }

  /**
   * Public liveness check returns only `ok` and the protocol version. A verified
   * extension Origin additionally gets the routing info the UI needs (no pid,
   * no session titles).
   */
  private handleHealth(url: URL, res: ServerResponse, trusted: boolean): void {
    if (!trusted) {
      this.sendJson(res, 200, { ok: true, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      return;
    }
    const activeDisplay = this.currentDisplaySession();
    const clientId = url.searchParams.get('clientId') || '';
    const activeSessionId = activeDisplay?.id || null;
    this.sendJson(res, 200, {
      ok: true,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      ...this.projectInfo,
      activeClientId: this.browserRouter.activeClientId,
      activeSessionId,
      isProcessing: clientId ? this.isClientProcessingSession(clientId, activeSessionId) : false,
      processingSessionId: clientId ? this.processingDisplaySessions.get(clientId) || null : null,
    });
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

  /** Runs a browser action through the active tab (used by the MCP tools). */
  runBrowserAction(action: BrowserActionName, params: Record<string, unknown> = {}): Promise<BrowserActionResult> {
    return this.browserRouter.run(action, params);
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const timer of this.releaseTimers) clearTimeout(timer);
    this.releaseTimers.clear();
    this.browserRouter.stop();
    this.approvalRouter.stop();
    this.questionRouter.stop();
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
