/**
 * Approval Router — Unit Tests (Story 8)
 *
 * Tests the ApprovalRouter in isolation with mock transport callbacks.
 *
 * Run: npx tsx --test test/approval-router.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRouter, ApprovalEvent, ApprovalRequestPayload } from '../src/approval-router';

const payload: ApprovalRequestPayload = {
  toolCallId: 'tc-1',
  toolName: 'bash',
  action: 'rm -rf build',
  risk: 'executes arbitrary shell',
};

function makeRouter(opts: {
  activeClientId?: string | null;
  timeoutMs?: number;
} = {}) {
  const sent: Array<{ clientId: string; event: ApprovalEvent }> = [];
  const broadcast: ApprovalEvent[] = [];
  const router = new ApprovalRouter(
    (clientId, event) => { sent.push({ clientId, event }); return true; },
    (event) => { broadcast.push(event); },
    () => (opts.activeClientId ?? null),
    opts.timeoutMs ?? 300_000,
  );
  return { router, sent, broadcast };
}

describe('ApprovalRouter', () => {
  it('emits approval_request to the active client and approval_pending to others', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: 'client-A' });
    router.request(payload);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'client-A');
    assert.equal(sent[0].event.type, 'approval_request');

    const pending = broadcast.find(e => e.type === 'approval_pending');
    assert.ok(pending, 'should broadcast approval_pending');
    assert.equal((pending as any).targetClientId, 'client-A');
  });

  it('resolves with the first valid decision and broadcasts approval_resolved', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: 'client-A' });
    const promise = router.request(payload);

    const approvalId = (sent[0].event as any).approvalId;
    const accepted = router.receiveDecision({ approvalId, decision: 'approved' });
    assert.equal(accepted, true);

    const result = await promise;
    assert.equal(result.decision, 'approved');

    const resolved = broadcast.find(e => e.type === 'approval_resolved');
    assert.ok(resolved);
    assert.equal((resolved as any).decision, 'approved');
  });

  it('ignores a second decision for the same approval (first wins)', async () => {
    const { router, sent } = makeRouter({ activeClientId: 'client-A' });
    const promise = router.request(payload);
    const approvalId = (sent[0].event as any).approvalId;

    assert.equal(router.receiveDecision({ approvalId, decision: 'approved' }), true);
    assert.equal(router.receiveDecision({ approvalId, decision: 'rejected' }), false);

    const result = await promise;
    assert.equal(result.decision, 'approved');
  });

  it('returns false for an unknown approvalId', () => {
    const { router } = makeRouter({ activeClientId: 'client-A' });
    assert.equal(router.receiveDecision({ approvalId: 'nope', decision: 'approved' }), false);
  });

  it('stays pending when no UI is active, then rejects on timeout (never auto-approves)', async () => {
    const { router, sent } = makeRouter({ activeClientId: null, timeoutMs: 40 });
    // No active client → nothing sent, request held pending.
    const result = await router.request(payload);
    assert.equal(sent.length, 0);
    assert.equal(result.decision, 'rejected');
  });

  it('resendPending re-emits in-flight requests to a (re)connecting client', async () => {
    const { router, sent } = makeRouter({ activeClientId: null, timeoutMs: 5000 });
    router.request(payload);
    assert.equal(sent.length, 0);

    router.resendPending('client-B');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'client-B');
    assert.equal(sent[0].event.type, 'approval_request');
    router.stop();
  });

  it('accepts an explicit targetClientId when no client is active (permission relay)', async () => {
    const { router, sent, broadcast } = makeRouter({ activeClientId: null, timeoutMs: 5000 });
    const promise = router.request(payload, { targetClientId: 'client-C' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].clientId, 'client-C');
    assert.equal((broadcast.find(e => e.type === 'approval_pending') as any).targetClientId, 'client-C');
    assert.equal(router.receiveDecision({ approvalId: (sent[0].event as any).approvalId, decision: 'rejected' }), true);
    assert.equal((await promise).decision, 'rejected');
  });

  it('stop() resolves pending approvals as rejected', async () => {
    const { router } = makeRouter({ activeClientId: 'client-A', timeoutMs: 5000 });
    const promise = router.request(payload);
    router.stop();
    const result = await promise;
    assert.equal(result.decision, 'rejected');
    assert.equal(result.cancelled, true);
    assert.equal(result.reason, 'stopped');
  });
});
