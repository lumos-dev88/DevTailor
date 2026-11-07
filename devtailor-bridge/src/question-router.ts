import { randomUUID } from 'crypto';

/**
 * QuestionRouter — transports agent "I need more info" questions from the agent
 * runtime to the connected extension UI(s) and collects the user's answers.
 *
 * Mirrors ApprovalRouter's request/response pattern:
 *   - request(): emit a `question_request` to the turn-initiating (active)
 *     client, notify other clients with `question_pending`, and return a
 *     Promise that resolves once an answer arrives (or the timeout fires).
 *   - receiveAnswer(): accept the FIRST answer for a questionId, resolve the
 *     pending Promise, and broadcast `question_resolved` to all UIs.
 *
 * Story 14 semantics (differs from approval):
 *   - Questions are never "rejected". With no UI available the request stays
 *     pending until the timeout, which resolves to `null` (dismissed / no
 *     answer). The agent then continues without inventing an answer.
 *   - Only the first answer for a questionId is honored; later ones are ignored.
 */

export interface QuestionOptionPayload {
  label: string;
  description?: string;
}

export interface QuestionItemPayload {
  question: string;
  header?: string;
  body?: string;
  options: QuestionOptionPayload[];
  multiSelect?: boolean;
  otherLabel?: string;
  otherDescription?: string;
}

export interface QuestionRequestPayload {
  toolCallId?: string;
  turnId?: number;
  questions: QuestionItemPayload[];
}

/** Answers keyed by question text; value is a selected label or free text. */
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionAnswerInput {
  questionId: string;
  /** null / omitted → dismissed (no answer). */
  answers?: QuestionAnswers | null;
}

export type QuestionEvent =
  | ({ type: 'question_request'; questionId: string } & QuestionRequestPayload)
  | { type: 'question_pending'; questionId: string; targetClientId: string | null }
  | { type: 'question_resolved'; questionId: string; answered: boolean; reason?: string };

interface PendingQuestion {
  resolve: (result: QuestionAnswers | null) => void;
  timer: NodeJS.Timeout;
  payload: QuestionRequestPayload;
}

export class QuestionRouter {
  private pending = new Map<string, PendingQuestion>();

  constructor(
    private sendToClient: (clientId: string, event: QuestionEvent) => boolean,
    private broadcast: (event: QuestionEvent) => void,
    private getActiveClientId: () => string | null,
    private timeoutMs = 300_000,
  ) {}

  /** Whether any question is currently awaiting an answer. */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  request(payload: QuestionRequestPayload): Promise<QuestionAnswers | null> {
    const questionId = `question_${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(questionId);
        this.broadcast({ type: 'question_resolved', questionId, answered: false, reason: 'timeout' });
        resolve(null);
      }, this.timeoutMs);
      // Do not keep the process alive just for a pending timeout (the HTTP server does that).
      timer.unref();

      this.pending.set(questionId, { resolve, timer, payload });
      this.dispatch(questionId, payload);
    });
  }

  private dispatch(questionId: string, payload: QuestionRequestPayload): void {
    const active = this.getActiveClientId();
    if (active) {
      this.sendToClient(active, { type: 'question_request', questionId, ...payload });
    }
    // Other connected UIs observe the waiting state; the initiating client
    // (which received question_request) ignores its own question_pending.
    this.broadcast({ type: 'question_pending', questionId, targetClientId: active });
  }

  /** Re-send any still-pending question requests to a (re)connecting client. */
  resendPending(clientId: string): void {
    for (const [questionId, p] of this.pending) {
      this.sendToClient(clientId, { type: 'question_request', questionId, ...p.payload });
    }
  }

  /** Accept the first answer for a questionId. Returns false if unknown/late. */
  receiveAnswer(input: QuestionAnswerInput): boolean {
    const pending = this.pending.get(input.questionId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(input.questionId);
    const answers = input.answers ?? null;
    pending.resolve(answers);
    this.broadcast({
      type: 'question_resolved',
      questionId: input.questionId,
      answered: answers != null,
    });
    return true;
  }

  stop(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }
}
