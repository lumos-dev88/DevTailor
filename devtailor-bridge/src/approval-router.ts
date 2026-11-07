import { randomUUID } from 'crypto';

/**
 * ApprovalRouter — transports high-risk tool approval requests from the agent
 * runtime to the connected extension UI(s) and collects the user's decision.
 *
 * Mirrors BrowserActionRouter's request/response pattern:
 *   - request(): emit an `approval_request` to the turn-initiating (active)
 *     client, notify other clients with `approval_pending`, and return a
 *     Promise that resolves once a decision arrives (or the timeout fires).
 *   - receiveDecision(): accept the FIRST valid decision for an approvalId,
 *     resolve the pending Promise, and broadcast `approval_resolved` to all UIs.
 *
 * Story 8 guarantees:
 *   - Never auto-approves: with no UI available the request stays pending until
 *     the timeout, which resolves to `rejected` (denied), not approved.
 *   - Only the first valid decision is honored; later/duplicate ones are ignored.
 */

export interface ApprovalRequestPayload {
  toolCallId: string;
  toolName: string;
  action: string;
  risk: string;
  detail?: unknown;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  feedback?: string;
}

export interface ApprovalDecisionResult {
  decision: 'approved' | 'rejected';
  feedback?: string;
}

export type ApprovalEvent =
  | ({ type: 'approval_request'; approvalId: string } & ApprovalRequestPayload)
  | { type: 'approval_pending'; approvalId: string; toolName: string; targetClientId: string | null }
  | { type: 'approval_resolved'; approvalId: string; decision: 'approved' | 'rejected'; reason?: string };

interface PendingApproval {
  resolve: (result: ApprovalDecisionResult) => void;
  timer: NodeJS.Timeout;
  payload: ApprovalRequestPayload;
}

export class ApprovalRouter {
  private pending = new Map<string, PendingApproval>();

  constructor(
    private sendToClient: (clientId: string, event: ApprovalEvent) => boolean,
    private broadcast: (event: ApprovalEvent) => void,
    private getActiveClientId: () => string | null,
    private timeoutMs = 300_000,
  ) {}

  /** Whether any approval is currently awaiting a decision. */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  request(payload: ApprovalRequestPayload): Promise<ApprovalDecisionResult> {
    const approvalId = `approval_${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        this.broadcast({ type: 'approval_resolved', approvalId, decision: 'rejected', reason: 'timeout' });
        resolve({ decision: 'rejected', feedback: '审批超时，已自动拒绝。' });
      }, this.timeoutMs);
      // Do not keep the process alive just for a pending timeout (the HTTP server does that).
      timer.unref();

      this.pending.set(approvalId, { resolve, timer, payload });
      this.dispatch(approvalId, payload);
    });
  }

  private dispatch(approvalId: string, payload: ApprovalRequestPayload): void {
    const active = this.getActiveClientId();
    if (active) {
      this.sendToClient(active, { type: 'approval_request', approvalId, ...payload });
    }
    // Other connected UIs observe the waiting state; the initiating client
    // (which received approval_request) ignores its own approval_pending.
    this.broadcast({ type: 'approval_pending', approvalId, toolName: payload.toolName, targetClientId: active });
  }

  /** Re-send any still-pending approval requests to a (re)connecting client. */
  resendPending(clientId: string): void {
    for (const [approvalId, p] of this.pending) {
      this.sendToClient(clientId, { type: 'approval_request', approvalId, ...p.payload });
    }
  }

  /** Accept the first valid decision for an approvalId. Returns false if unknown/late. */
  receiveDecision(input: ApprovalDecisionInput): boolean {
    const pending = this.pending.get(input.approvalId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(input.approvalId);
    pending.resolve({ decision: input.decision, feedback: input.feedback });
    this.broadcast({ type: 'approval_resolved', approvalId: input.approvalId, decision: input.decision });
    return true;
  }

  stop(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ decision: 'rejected', feedback: 'Bridge stopped before approval completed.' });
    }
    this.pending.clear();
  }
}
