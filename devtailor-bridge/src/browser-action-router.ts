import { randomUUID } from 'crypto';
import {
  BrowserActionEvent,
  BrowserActionName,
  BrowserActionResult,
  BrowserContextState,
} from './browser-action-types';

interface PendingAction {
  resolve: (result: BrowserActionResult) => void;
  timer: NodeJS.Timeout;
}

/** Actions that can be handled locally by the Bridge without forwarding to the Extension. */
const LOCAL_ACTIONS: ReadonlySet<BrowserActionName> = new Set([
  'get_element_targets',
  'save_element_target',
  'delete_element_target',
]);

/** Optional handler for Bridge-local actions (element targets CRUD). */
export type LocalActionHandler = (
  action: BrowserActionName,
  params: Record<string, unknown>,
) => Promise<BrowserActionResult>;

export class BrowserActionRouter {
  private context: BrowserContextState = {
    activeClientId: null,
    activeProjectId: null,
    activeSessionId: null,
    lastSeenAt: 0,
  };
  private pending = new Map<string, PendingAction>();
  private localHandler: LocalActionHandler | null = null;

  constructor(
    private sendToClient: (clientId: string, event: BrowserActionEvent) => boolean,
    private timeoutMs = 15000,
  ) {}

  /** Register a handler for Bridge-local actions (e.g. element targets CRUD). */
  setLocalHandler(handler: LocalActionHandler): void {
    this.localHandler = handler;
  }

  activate(clientId: string, projectId: string | null, sessionId: string | null): void {
    this.context = {
      activeClientId: clientId,
      activeProjectId: projectId,
      activeSessionId: sessionId,
      lastSeenAt: Date.now(),
    };
  }

  deactivate(clientId: string): void {
    if (this.context.activeClientId === clientId) {
      this.context.activeClientId = null;
      this.context.activeSessionId = null;
      this.context.lastSeenAt = Date.now();
    }
  }

  get activeClientId(): string | null {
    return this.context.activeClientId;
  }

  async run(action: BrowserActionName, params: Record<string, unknown> = {}): Promise<BrowserActionResult> {
    // Bridge-local actions: handle directly without SSE round-trip to Extension
    if (LOCAL_ACTIONS.has(action) && this.localHandler) {
      return this.localHandler(action, params);
    }

    const clientId = this.context.activeClientId;
    if (!clientId) {
      return {
        requestId: '',
        ok: false,
        error: { code: 'NO_ACTIVE_TAB', message: 'No active DevTailor tab is connected' },
      };
    }

    const requestId = `browser_${randomUUID()}`;
    const event: BrowserActionEvent = {
      type: 'browser_action',
      requestId,
      action,
      params,
    };

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          requestId,
          ok: false,
          error: { code: 'ACTION_TIMEOUT', message: `Browser action timed out: ${action}` },
        });
      }, this.timeoutFor(action, params));

      this.pending.set(requestId, { resolve, timer });

      const sent = this.sendToClient(clientId, event);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({
          requestId,
          ok: false,
          error: { code: 'NO_ACTIVE_TAB', message: 'Active DevTailor tab is not connected' },
        });
      }
    });
  }

  private timeoutFor(action: BrowserActionName, params: Record<string, unknown>): number {
    if (action === 'request_user_assistance') {
      const requested = Number(params.timeoutMs);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.max(5000, Math.min(requested + 5000, 10 * 60 * 1000));
      }
      return 5 * 60 * 1000 + 5000;
    }
    if (action === 'run_js') {
      // Content script has its own timeout (default 30s). Router must wait longer.
      const requested = Number(params.timeout);
      const contentTimeout = Number.isFinite(requested) && requested > 0
        ? Math.max(1000, Math.min(requested, 120000))
        : 30000;
      return contentTimeout + 5000; // 5s buffer for round-trip
    }
    if (action === 'run_actions') {
      const actions = Array.isArray(params.actions) ? params.actions : [];
      const stepCount = actions.reduce((total, action: any) => {
        return total + (Array.isArray(action?.steps) ? action.steps.length : 0);
      }, 0);
      const stepTimeout = Number(params.stepTimeoutMs);
      const perStep = Number.isFinite(stepTimeout) && stepTimeout > 0
        ? Math.max(500, Math.min(stepTimeout, 30000))
        : 5000;
      return Math.max(this.timeoutMs, stepCount * perStep + 5000);
    }
    if (action === 'wait_for_selector' || action === 'wait_for_text') {
      const requested = Number(params.timeoutMs);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.max(this.timeoutMs, Math.min(requested + 1000, 60000));
      }
      return this.timeoutMs;
    }
    return this.timeoutMs;
  }

  receiveResult(result: BrowserActionResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    pending.resolve(result);
    return true;
  }

  stop(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        requestId,
        ok: false,
        error: { code: 'ACTION_FAILED', message: 'Bridge stopped before browser action completed' },
      });
    }
    this.pending.clear();
  }
}
