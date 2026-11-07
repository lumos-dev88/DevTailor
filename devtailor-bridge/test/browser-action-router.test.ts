/**
 * Browser Action Router — Unit Tests
 *
 * Tests the BrowserActionRouter in isolation using a mock sendToClient.
 *
 * Run: npx tsx --test test/browser-action-router.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserActionRouter, LocalActionHandler } from '../src/browser-action-router';
import { BrowserActionResult, BrowserActionEvent } from '../src/browser-action-types';

function makeRouter(opts: {
  sendToClient?: (clientId: string, event: BrowserActionEvent) => boolean;
  timeoutMs?: number;
  localHandler?: LocalActionHandler;
} = {}) {
  const sendToClient = opts.sendToClient ?? (() => true);
  const router = new BrowserActionRouter(sendToClient, opts.timeoutMs ?? 15000);
  if (opts.localHandler) router.setLocalHandler(opts.localHandler);
  return router;
}

describe('BrowserActionRouter', () => {
  // 1) No activeClientId → NO_ACTIVE_TAB
  it('run() returns NO_ACTIVE_TAB when there is no activeClientId', async () => {
    const router = makeRouter();
    const result = await router.run('take_visible_screenshot');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'NO_ACTIVE_TAB');
  });

  // 2) sendToClient returns false → NO_ACTIVE_TAB
  it('run() returns NO_ACTIVE_TAB when sendToClient returns false', async () => {
    const router = makeRouter({ sendToClient: () => false });
    router.activate('client-1', null, null);
    const result = await router.run('take_visible_screenshot');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'NO_ACTIVE_TAB');
  });

  // 3) Normal run + receiveResult closed loop
  it('run() resolves when receiveResult() is called with the matching requestId', async () => {
    let capturedEvent: BrowserActionEvent | null = null;
    const router = makeRouter({
      sendToClient: (_cid, event) => {
        capturedEvent = event;
        return true;
      },
    });
    router.activate('client-1', 'proj-1', 'sess-1');

    const promise = router.run('get_page_snapshot');

    // Simulate extension response
    assert.ok(capturedEvent, 'sendToClient should have been called');
    const fakeResult: BrowserActionResult = {
      requestId: capturedEvent!.requestId,
      ok: true,
      result: { html: '<p>hello</p>' },
    };
    const received = router.receiveResult(fakeResult);
    assert.equal(received, true);

    const result = await promise;
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { html: '<p>hello</p>' });
  });

  // 4) receiveResult with non-existent requestId returns false and emits warn
  it('receiveResult() returns false for unknown requestId and logs a warning', () => {
    const router = makeRouter();
    router.activate('client-1', null, null);

    const warnings: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const received = router.receiveResult({
        requestId: 'nonexistent-id',
        ok: true,
      });
      assert.equal(received, false);
      assert.equal(warnings.length, 1, 'should emit exactly one warning');
      assert.ok(warnings[0].includes('nonexistent-id'), 'warning should include the requestId');
      assert.ok(warnings[0].includes('unknown/late'), 'warning should mention unknown/late');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // 4b) receiveResult with expired (already-resolved) requestId also returns false + warn
  it('receiveResult() returns false for late/expired requestId and logs a warning', async () => {
    let capturedEvent: BrowserActionEvent | null = null;
    const router = makeRouter({
      sendToClient: (_cid, event) => {
        capturedEvent = event;
        return true;
      },
    });
    router.activate('client-1', null, null);

    const promise = router.run('get_page_snapshot');
    assert.ok(capturedEvent);
    // First receive succeeds
    const received1 = router.receiveResult({ requestId: capturedEvent!.requestId, ok: true, result: {} });
    assert.equal(received1, true);
    await promise;

    // Second receive for the same requestId is late
    const warnings: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const received2 = router.receiveResult({ requestId: capturedEvent!.requestId, ok: true, result: {} });
      assert.equal(received2, false);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('late'), 'should flag as late');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // 5) stop() resolves pending promises with ACTION_FAILED
  it('stop() resolves all pending promises with ACTION_FAILED', async () => {
    let sendCount = 0;
    const router = makeRouter({
      sendToClient: () => {
        sendCount++;
        return true;
      },
      timeoutMs: 60000, // long timeout so it won't fire naturally
    });
    router.activate('client-1', null, null);

    const p1 = router.run('take_visible_screenshot');
    const p2 = router.run('reload_page');

    assert.equal(sendCount, 2);

    router.stop();

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, false);
    assert.equal(r1.error?.code, 'ACTION_FAILED');
    assert.equal(r2.ok, false);
    assert.equal(r2.error?.code, 'ACTION_FAILED');
  });

  // 6) Local actions go through localHandler, no SSE sent
  it('local actions use localHandler and skip sendToClient', async () => {
    let sseSent = false;
    const localResults: string[] = [];
    const localHandler: LocalActionHandler = async (action, _params) => {
      localResults.push(action);
      return { requestId: '', ok: true, result: { local: true } };
    };
    const router = makeRouter({
      sendToClient: () => {
        sseSent = true;
        return true;
      },
      localHandler,
    });
    router.activate('client-1', null, null);

    const result = await router.run('get_element_targets', { sel: '#foo' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { local: true });
    assert.equal(sseSent, false, 'sendToClient should not be called for local actions');
    assert.deepEqual(localResults, ['get_element_targets']);
  });

  // 7) activate / deactivate state transitions
  it('activate sets activeClientId; deactivate clears it for the same client', async () => {
    const router = makeRouter();
    assert.equal(router.activeClientId, null);

    router.activate('client-A', 'proj-1', 'sess-1');
    assert.equal(router.activeClientId, 'client-A');

    // Deactivate a different client should be a no-op
    router.deactivate('client-B');
    assert.equal(router.activeClientId, 'client-A');

    // Deactivate the correct client
    router.deactivate('client-A');
    assert.equal(router.activeClientId, null);

    // Now run should fail with NO_ACTIVE_TAB
    const result = await router.run('take_visible_screenshot');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'NO_ACTIVE_TAB');
  });

  // 8) Short timeout → ACTION_TIMEOUT
  it('run() resolves with ACTION_TIMEOUT when timeout expires', async () => {
    const router = makeRouter({
      sendToClient: () => true,
      timeoutMs: 50, // very short
    });
    router.activate('client-1', null, null);

    const result = await router.run('take_visible_screenshot');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ACTION_TIMEOUT');
  });
});
