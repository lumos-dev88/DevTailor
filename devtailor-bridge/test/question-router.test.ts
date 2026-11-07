/**
 * Question Router — Unit Tests (Story 14)
 *
 * Tests the QuestionRouter in isolation with mock transport callbacks.
 *
 * Run: npx tsx --test test/question-router.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRouter, QuestionEvent, QuestionRequestPayload } from '../src/question-router';

const payload: QuestionRequestPayload = {
  toolCallId: 'tc-1',
  questions: [
    {
      question: 'Which framework?',
      header: 'Framework',
      options: [{ label: 'React' }, { label: 'Vue' }],
    },
  ],
};

function makeRouter(opts: {
  activeClientId?: string | null;
  timeoutMs?: number;
} = {}) {
  const sent: Array<{ clientId: string; event: QuestionEvent }> = [];
  const broadcast: QuestionEvent[] = [];
  const router = new QuestionRouter(
    (clientId, event) => { sent.push({ clientId, event }); return true; },
    (event) => { broadcast.push(event); },
    () => (opts.activeClientId ?? null),
    opts.timeoutMs ?? 300_000,
  );
  return { router, sent, broadcast };
}

describe('QuestionRouter', () => {
  it('emits question_request to the active client and question_pending to others', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: 'client-A' });
    router.request(payload);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'client-A');
    assert.equal(sent[0].event.type, 'question_request');

    const pending = broadcast.find(e => e.type === 'question_pending');
    assert.ok(pending, 'should broadcast question_pending');
    assert.equal((pending as any).targetClientId, 'client-A');
  });

  it('resolves with the first answer and broadcasts question_resolved (answered)', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: 'client-A' });
    const promise = router.request(payload);

    const questionId = (sent[0].event as any).questionId;
    const accepted = router.receiveAnswer({ questionId, answers: { 'Which framework?': 'React' } });
    assert.equal(accepted, true);

    const result = await promise;
    assert.deepEqual(result, { 'Which framework?': 'React' });

    const resolved = broadcast.find(e => e.type === 'question_resolved');
    assert.ok(resolved);
    assert.equal((resolved as any).answered, true);
  });

  it('treats a null-answer (skip) as dismissed', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: 'client-A' });
    const promise = router.request(payload);
    const questionId = (sent[0].event as any).questionId;

    assert.equal(router.receiveAnswer({ questionId, answers: null }), true);
    const result = await promise;
    assert.equal(result, null);

    const resolved = broadcast.find(e => e.type === 'question_resolved');
    assert.equal((resolved as any).answered, false);
  });

  it('ignores a second answer for the same question (first wins)', async () => {
    const { router, sent } = makeRouter({ activeClientId: 'client-A' });
    const promise = router.request(payload);
    const questionId = (sent[0].event as any).questionId;

    assert.equal(router.receiveAnswer({ questionId, answers: { 'Which framework?': 'React' } }), true);
    assert.equal(router.receiveAnswer({ questionId, answers: { 'Which framework?': 'Vue' } }), false);

    const result = await promise;
    assert.deepEqual(result, { 'Which framework?': 'React' });
  });

  it('returns false for an unknown questionId', () => {
    const { router } = makeRouter({ activeClientId: 'client-A' });
    assert.equal(router.receiveAnswer({ questionId: 'nope', answers: {} }), false);
  });

  it('stays pending when no UI is active, then resolves null on timeout (never invents an answer)', async () => {
    const { router, sent } = makeRouter({ activeClientId: null, timeoutMs: 40 });
    const result = await router.request(payload);
    assert.equal(sent.length, 0);
    assert.equal(result, null);
  });

  it('resendPending re-emits in-flight requests to a (re)connecting client', async () => {
    const { router, sent } = makeRouter({ activeClientId: null, timeoutMs: 5000 });
    router.request(payload);
    assert.equal(sent.length, 0);

    router.resendPending('client-B');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'client-B');
    assert.equal(sent[0].event.type, 'question_request');
    router.stop();
  });

  it('stop() resolves pending questions as null (dismissed)', async () => {
    const { router } = makeRouter({ activeClientId: 'client-A', timeoutMs: 5000 });
    const promise = router.request(payload);
    router.stop();
    const result = await promise;
    assert.equal(result, null);
  });
});
