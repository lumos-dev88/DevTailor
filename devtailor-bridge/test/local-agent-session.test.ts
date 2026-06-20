/**
 * LocalAgentSession — Unit Tests
 *
 * Tests the public API of LocalAgentSession against a mock BrowserToolRunner.
 * Run: npx tsx --test test/local-agent-session.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentSession } from '../src/local-agent-session';
import {
  BrowserToolRunner,
  BrowserActionResult,
  AgentCallbacks,
} from '../src/agent-session';
import { ReviewPayload } from '../src/types';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResult(result?: unknown): BrowserActionResult {
  return { requestId: `req_${randomUUID()}`, ok: true, result };
}

function failResult(code: string, message: string): BrowserActionResult {
  return { requestId: `req_${randomUUID()}`, ok: false, error: { code, message } };
}

function createCallTrackingRunner(
  results: BrowserActionResult[],
): { runner: BrowserToolRunner; calls: Array<{ action: string; params: unknown }> } {
  const calls: Array<{ action: string; params: unknown }> = [];
  let callIndex = 0;
  const runner: BrowserToolRunner = async (action, params) => {
    calls.push({ action, params: params ?? {} });
    if (callIndex < results.length) return results[callIndex++];
    return okResult({});
  };
  return { runner, calls };
}

function minimalPayload(overrides?: Partial<ReviewPayload['payload']>): ReviewPayload['payload'] {
  return {
    pageUrl: 'https://example.com',
    userIntent: 'test intent',
    items: [],
    screenshot: null,
    ...overrides,
  };
}

function createCallbacks(): {
  cbs: AgentCallbacks;
  streamChunks: string[];
  toolCalls: Array<Record<string, unknown>>;
  toolUpdates: Array<Record<string, unknown>>;
} {
  const streamChunks: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolUpdates: Array<Record<string, unknown>> = [];
  const cbs: AgentCallbacks = {
    onStream: (delta) => streamChunks.push(delta),
    onThinking: () => {},
    onDone: () => {},
    onError: () => {},
    onToolCall: (info) => toolCalls.push({ ...info }),
    onToolUpdate: (info) => toolUpdates.push({ ...info }),
  };
  return { cbs, streamChunks, toolCalls, toolUpdates };
}

/** Controllable Promise gate — avoids sleep-based timing */
function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalAgentSession', () => {
  // 1. start() — created vs reused
  describe('start()', () => {
    it('first call returns mode=created', async () => {
      const session = new LocalAgentSession(async () => okResult());
      const result = await session.start();
      assert.equal(result.mode, 'created');
      assert.ok(result.sessionId?.startsWith('local_'));
      assert.equal(session.isReady, true);
      assert.equal(session.currentSessionId, result.sessionId);
    });

    it('subsequent call returns mode=reused with same sessionId', async () => {
      const session = new LocalAgentSession(async () => okResult());
      const first = await session.start();
      const second = await session.start();
      assert.equal(second.mode, 'reused');
      assert.equal(second.sessionId, first.sessionId);
    });
  });

  // 2. sendReview() calls get_page_snapshot / get_console_logs / get_element_targets
  describe('sendReview() — browser tool calls', () => {
    it('invokes the three expected actions in order', async () => {
      const { runner, calls } = createCallTrackingRunner([
        okResult({ title: 'Page', url: 'https://example.com', elements: [] }),
        okResult({ logs: [{ type: 'error', text: 'fail' }] }),
        okResult({ targets: [{ id: 't1' }] }),
      ]);
      const session = new LocalAgentSession(runner);
      await session.start();
      await session.sendReview(minimalPayload());
      assert.equal(calls.length, 3);
      assert.equal(calls[0].action, 'get_page_snapshot');
      assert.deepEqual(calls[0].params, { includeStyles: true, includeConsoleSummary: true });
      assert.equal(calls[1].action, 'get_console_logs');
      assert.deepEqual(calls[1].params, { types: ['error', 'warn'], limit: 20 });
      assert.equal(calls[2].action, 'get_element_targets');
      assert.deepEqual(calls[2].params, {});
    });
  });

  // 3. 3 tool_call + 3 tool_update, all completed
  describe('sendReview() — callbacks', () => {
    it('emits 3 tool_call and 3 tool_update with status=completed on success', async () => {
      const { runner } = createCallTrackingRunner([
        okResult({ title: 'Page', url: 'https://example.com', elements: [{ id: 1 }] }),
        okResult({ logs: [] }),
        okResult({ targets: [] }),
      ]);
      const session = new LocalAgentSession(runner);
      const { cbs, toolCalls, toolUpdates } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      const result = await session.sendReview(minimalPayload());

      assert.equal(toolCalls.length, 3);
      assert.equal(toolUpdates.length, 3);
      assert.equal(toolUpdates[0].status, 'completed');
      assert.equal(toolUpdates[1].status, 'completed');
      assert.equal(toolUpdates[2].status, 'completed');
      assert.equal(result, 'end_turn');
    });
  });

  // 4. tool failure → corresponding tool_update.status=failed, still returns end_turn
  describe('sendReview() — tool failure handling', () => {
    it('failed tool emits status=failed, still returns end_turn', async () => {
      const { runner, calls } = createCallTrackingRunner([
        okResult({ title: 'Page', url: 'https://example.com', elements: [] }),
        failResult('CONSOLE_ERROR', 'Console unavailable'),
        okResult({ targets: [] }),
      ]);
      const session = new LocalAgentSession(runner);
      const { cbs, toolUpdates } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      const result = await session.sendReview(minimalPayload());

      assert.equal(calls.length, 3);
      assert.equal(toolUpdates.length, 3);
      assert.equal(toolUpdates[0].status, 'completed');
      assert.equal(toolUpdates[1].status, 'failed');
      assert.equal(toolUpdates[2].status, 'completed');
      assert.equal(result, 'end_turn');
    });

    it('all tools failed still returns end_turn', async () => {
      const runner: BrowserToolRunner = async () => {
        throw new Error('boom');
      };
      const session = new LocalAgentSession(runner);
      const { cbs, toolUpdates } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      const result = await session.sendReview(minimalPayload());

      assert.equal(toolUpdates.length, 3);
      for (const u of toolUpdates) assert.equal(u.status, 'failed');
      assert.equal(result, 'end_turn');
    });
  });

  // 5. screenshots → stream content references correct image count
  describe('sendReview() — screenshot image count', () => {
    it('reports image count in stream for screenshots', async () => {
      const screenshot1 = 'data:image/png;base64,aGVsbG8=';
      const screenshot2 = 'data:image/png;base64,d29ybGQ=';
      const { runner } = createCallTrackingRunner([
        okResult({}),
        okResult({}),
        okResult({}),
      ]);
      const session = new LocalAgentSession(runner);
      const { cbs, streamChunks } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      await session.sendReview(minimalPayload({
        screenshots: [screenshot1, screenshot2],
      }));

      const fullStream = streamChunks.join('');
      assert.ok(
        fullStream.includes('2 张图片'),
        `Expected stream to contain "2 张图片", got: ${fullStream.slice(0, 200)}`,
      );
    });

    it('reports 0 images when no screenshots', async () => {
      const runner: BrowserToolRunner = async () => okResult({});
      const session = new LocalAgentSession(runner);
      const { cbs, streamChunks } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      await session.sendReview(minimalPayload({ screenshot: null, screenshots: [] }));
      const fullStream = streamChunks.join('');
      assert.ok(
        fullStream.includes('0 张图片'),
        `Expected stream to contain "0 张图片", got: ${fullStream.slice(0, 200)}`,
      );
    });
  });

  // 6. stop() → isReady=false
  describe('stop()', () => {
    it('sets isReady to false', async () => {
      const session = new LocalAgentSession(async () => okResult());
      await session.start();
      assert.equal(session.isReady, true);
      session.stop();
      assert.equal(session.isReady, false);
      assert.equal(session.isStarting, false);
    });

    it('start() after stop() creates a new session', async () => {
      const session = new LocalAgentSession(async () => okResult());
      const first = await session.start();
      session.stop();
      const second = await session.start();
      // stop resets ready=false, so next start returns 'created' (sessionId preserved on instance)
      assert.equal(second.mode, 'created');
      assert.equal(second.sessionId, first.sessionId);
    });
  });

  // 7. cancelCurrentTurn interrupts in-flight sendReview using Promise gate (no sleep)
  describe('cancelCurrentTurn() — interrupts sendReview', () => {
    it('cancels mid-flow after first tool and returns cancelled', async () => {
      // Promise gate: blocks the second browser tool call until we explicitly resolve.
      // Flow: get_page_snapshot (instant) → get_console_logs (blocks on gate) → cancel → release → cancelled
      const gate = createGate();
      let runnerCallCount = 0;
      const runner: BrowserToolRunner = async (action) => {
        runnerCallCount++;
        if (action === 'get_console_logs') {
          // Block until the test cancels and releases the gate
          await gate.promise;
        }
        return okResult({});
      };

      const session = new LocalAgentSession(runner);
      await session.start();

      // Fire sendReview without awaiting — first tool resolves, second blocks
      const reviewPromise = session.sendReview(minimalPayload());

      // Let the first tool call (get_page_snapshot) complete via microtask flush
      await new Promise(r => setImmediate(r));

      // Cancel — sets cancelled=true, but second tool is still blocked on gate
      const cancelResult = await session.cancelCurrentTurn();
      assert.equal(cancelResult, true);

      // Release the gate so the blocked get_console_logs can finish
      gate.resolve();

      const result = await reviewPromise;
      // After get_console_logs returns, the cancelled check triggers → returns 'cancelled'
      assert.equal(result, 'cancelled');
      // get_console_logs ran (blocked on gate), get_element_targets was skipped
      assert.equal(runnerCallCount, 2);
    });

    it('pre-cancel is overwritten by sendReview (cancelled resets to false)', async () => {
      // This verifies actual implementation behavior: sendReview resets cancelled=false
      // at the top, so a pre-cancel does not prevent the turn from running.
      let runnerCalled = false;
      const runner: BrowserToolRunner = async () => {
        runnerCalled = true;
        return okResult({});
      };

      const session = new LocalAgentSession(runner);
      await session.start();

      // Cancel before sendReview
      await session.cancelCurrentTurn();

      // sendReview resets cancelled=false at the top, so it proceeds normally
      const result = await session.sendReview(minimalPayload());
      assert.equal(runnerCalled, true);
      assert.equal(result, 'end_turn');
    });
  });

  // Edge: setCallbacks before start
  describe('setCallbacks()', () => {
    it('can set callbacks before start', async () => {
      const session = new LocalAgentSession(async () => okResult());
      const { cbs, streamChunks } = createCallbacks();
      session.setCallbacks(cbs);
      await session.start();
      await session.sendReview(minimalPayload());
      assert.ok(streamChunks.length > 0, 'Should have received stream chunks');
    });
  });

  // Edge: isStarting flag
  describe('isStarting', () => {
    it('is false before and after start', async () => {
      const session = new LocalAgentSession(async () => okResult());
      assert.equal(session.isStarting, false);
      await session.start();
      assert.equal(session.isStarting, false);
    });
  });
});
