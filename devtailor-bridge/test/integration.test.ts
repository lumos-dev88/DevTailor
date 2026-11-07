import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSServer } from '../src/ws-server';
import { AgentCallbacks, AgentSession } from '../src/agent-session';
import { CHANNEL_NOT_CONNECTED_MESSAGE } from '../src/placeholder-agent-session';
import { makeClient, sleep } from './helpers';

describe('integration: bridge with placeholder channel session', () => {
  const PORT = 17777;
  const {
    postJson, postRaw, getJson, deleteJson, activate, openSse,
    collectUntilDone, waitForDoneCount, respondToBrowserActions,
  } = makeClient(PORT);
  let server: WSServer;

  before(async () => {
    server = new WSServer(PORT, process.cwd());
    server.start();
    await new Promise(r => setTimeout(r, 200));
  });

  after(() => {
    server.stop();
  });

  it('opens an SSE stream', async () => {
    const stream = await openSse('tab-health');
    const message = await stream.next();

    assert.strictEqual(message.type, 'connected');
    stream.close();
  });

  it('echoes the user message and reports that the Claude channel is not connected', async () => {
    const stream = await openSse('tab-test-1');
    await stream.next();
    await activate('tab-test-1');
    const messages: Record<string, unknown>[] = [];
    const finished = collectUntilDone(stream, messages);

    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-test-1',
      tabId: 'tab-test-1',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: '测试意图',
        items: [
          {
            index: 1,
            selector: 'div.test',
            xpath: '//div',
            outerHTML: '<div class="test">Hello</div>',
            computedStyle: { color: '#333' },
            annotation: '改颜色',
            text: 'Hello',
            boundingBox: { x: 0, y: 0, w: 100, h: 50 },
            framework: null,
          },
        ],
        screenshot: null,
      },
    });

    assert.strictEqual(response.status, 202);
    await finished;

    const errors = messages.filter(m => m.type === 'error');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].message, CHANNEL_NOT_CONNECTED_MESSAGE);
    assert.ok(messages.some(message => {
      const displayMessage = message.displayMessage as Record<string, unknown> | undefined;
      return message.type === 'display_message' && displayMessage?.role === 'user' && displayMessage.content === '测试意图';
    }), 'should project the persisted user message to other chat surfaces');
    stream.close();
  });

  it('keeps screenshots on the displayed user message', async () => {
    const stream = await openSse('tab-test-screenshot');
    await stream.next();
    await activate('tab-test-screenshot');
    const messages: Record<string, unknown>[] = [];
    const finished = collectUntilDone(stream, messages);

    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-test-screenshot',
      tabId: 'tab-test-screenshot',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: '调整样式',
        items: [],
        screenshot: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
      },
    });

    assert.strictEqual(response.status, 202);
    await finished;

    const display = messages.find(m => m.type === 'display_message') as any;
    assert.deepStrictEqual(display.displayMessage.images, ['data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==']);
    stream.close();
  });

  it('handles missing payload gracefully', async () => {
    const stream = await openSse('tab-test-2');
    await stream.next();
    await activate('tab-test-2');

    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-test-2',
      tabId: 'tab-test-2',
    });

    assert.strictEqual(response.status, 400);
    assert.ok(response.body.error.includes('Missing review payload'));
    stream.close();
  });

  it('lists, switches, and deletes bridge display sessions', async () => {
    const stream = await openSse('tab-session-ui');
    await stream.next();

    let list = await getJson('/sessions?clientId=tab-session-ui');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.ok, true);
    assert.ok(Array.isArray(list.body.sessions));
    const firstSessionId = list.body.activeSessionId;
    assert.ok(firstSessionId, 'should create an active display session');

    const created = await postJson('/new-session', {
      clientId: 'tab-session-ui',
      tabId: 'tab-session-ui',
    });
    assert.strictEqual(created.status, 200);
    assert.ok(created.body.sessionId);

    const loaded = await postJson('/sessions/load', {
      clientId: 'tab-session-ui',
      sessionId: firstSessionId,
    });
    assert.strictEqual(loaded.status, 200);
    assert.strictEqual(loaded.body.sessionId, firstSessionId);
    assert.ok(Array.isArray(loaded.body.messages));

    const deleted = await postJson('/sessions/delete', {
      clientId: 'tab-session-ui',
      sessionId: firstSessionId,
    });
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual(deleted.body.deleted, firstSessionId);

    list = await getJson('/sessions?clientId=tab-session-ui');
    assert.strictEqual(list.status, 200);
    assert.ok(!list.body.sessions.some((session: any) => session.sessionId === firstSessionId));
    stream.close();
  });

  it('reuses the current empty new session instead of saving duplicate blank history', async () => {
    const stream = await openSse('tab-empty-new-session');
    await stream.next();

    const first = await postJson('/new-session', {
      clientId: 'tab-empty-new-session',
      tabId: 'tab-empty-new-session',
    });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.sessionTitle, '新会话');

    const beforeSecond = await getJson('/sessions?clientId=tab-empty-new-session');
    assert.strictEqual(beforeSecond.status, 200);
    const countBeforeSecond = beforeSecond.body.sessions.length;

    const second = await postJson('/new-session', {
      clientId: 'tab-empty-new-session',
      tabId: 'tab-empty-new-session',
    });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.body.sessionId, first.body.sessionId);
    assert.strictEqual(second.body.reused, true);

    const list = await getJson('/sessions?clientId=tab-empty-new-session');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.sessions.length, countBeforeSecond);
    stream.close();
  });

  it('shares display sessions across tabs in the same project and runtime', async () => {
    const streamA = await openSse('tab-project-a');
    await streamA.next();
    const streamB = await openSse('tab-project-b');
    await streamB.next();

    const created = await postJson('/new-session', {
      clientId: 'tab-project-a',
      tabId: 'tab-project-a',
    });
    assert.strictEqual(created.status, 200);
    const sessionId = created.body.sessionId;
    assert.ok(sessionId);

    const listFromB = await getJson('/sessions?clientId=tab-project-b');
    assert.strictEqual(listFromB.status, 200);
    assert.ok(listFromB.body.sessions.some((session: any) => session.sessionId === sessionId));

    const loadedFromB = await postJson('/sessions/load', {
      clientId: 'tab-project-b',
      tabId: 'tab-project-b',
      sessionId,
    });
    assert.strictEqual(loadedFromB.status, 200);
    assert.strictEqual(loadedFromB.body.sessionId, sessionId);

    streamA.close();
    streamB.close();
  });

  it('requires explicit tab activation and lets a new tab take over', async () => {
    const streamA = await openSse('tab-active-a');
    await streamA.next();
    const streamB = await openSse('tab-active-b');
    await streamB.next();

    let activation = await activate('tab-active-a');
    assert.strictEqual(activation.status, 200);
    assert.strictEqual(activation.body.activeClientId, 'tab-active-a');

    activation = await activate('tab-active-b');
    assert.strictEqual(activation.status, 200);
    assert.strictEqual(activation.body.activeClientId, 'tab-active-b');

    respondToBrowserActions(streamB);
    const messages: Record<string, unknown>[] = [];
    const done = collectUntilDone(streamA, messages);
    const accepted = await postJson('/review', {
      type: 'review',
      clientId: 'tab-active-a',
      tabId: 'tab-active-a',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'non-active tab can still send',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(accepted.status, 202);
    await done;

    const health = await getJson('/health?clientId=tab-active-a');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.activeClientId, 'tab-active-b');

    streamA.close();
    streamB.close();
  });

  it('allows a connected non-active tab to send review without taking browser-tool ownership', async () => {
    const streamA = await openSse('tab-send-active-owner');
    await streamA.next();
    const streamB = await openSse('tab-send-non-active');
    await streamB.next();
    const activation = await activate('tab-send-active-owner');
    assert.strictEqual(activation.status, 200);
    assert.strictEqual(activation.body.activeClientId, 'tab-send-active-owner');

    const messages: Record<string, unknown>[] = [];
    respondToBrowserActions(streamA);
    const done = collectUntilDone(streamB, messages);
    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-send-non-active',
      tabId: 'tab-send-non-active',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'non-active tab can send',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(response.status, 202);
    await done;

    const health = await getJson('/health?clientId=tab-send-non-active');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.activeClientId, 'tab-send-active-owner');

    streamA.close();
    streamB.close();
  });

  it('keeps active tab ownership across frontend refresh reconnects', async () => {
    const firstStream = await openSse('tab-refresh-stable');
    await firstStream.next();

    const activation = await activate('tab-refresh-stable');
    assert.strictEqual(activation.status, 200);
    assert.strictEqual(activation.body.activeClientId, 'tab-refresh-stable');

    const created = await postJson('/new-session', {
      clientId: 'tab-refresh-stable',
      tabId: 'tab-refresh-stable',
    });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.sessionTitle, '新会话');

    const firstMessages: Record<string, unknown>[] = [];
    respondToBrowserActions(firstStream);
    const firstDone = collectUntilDone(firstStream, firstMessages);
    const firstResponse = await postJson('/review', {
      type: 'review',
      clientId: 'tab-refresh-stable',
      tabId: 'tab-refresh-stable',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: '刷新后应该显示会话名',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(firstResponse.status, 202);
    await firstDone;

    const healthAfterActivation = await getJson('/health');
    assert.strictEqual(healthAfterActivation.status, 200);
    assert.strictEqual(healthAfterActivation.body.activeClientId, 'tab-refresh-stable');
    assert.strictEqual(healthAfterActivation.body.activeSessionTitle, undefined);

    firstStream.close();
    await new Promise(resolve => setTimeout(resolve, 50));

    const refreshedStream = await openSse('tab-refresh-stable');
    const connected = await refreshedStream.next();
    assert.strictEqual(connected.type, 'connected');
    assert.strictEqual(connected.activeClientId, 'tab-refresh-stable');
    assert.strictEqual(connected.isActiveClient, true);
    assert.strictEqual(connected.activeSessionTitle, '刷新后应该显示会话名');

    refreshedStream.close();
  });

  it('accepts consecutive review posts and reports backend queue state', async () => {
    const stream = await openSse('tab-backend-queue');
    await stream.next();
    await activate('tab-backend-queue');
    respondToBrowserActions(stream);
    const messages: Record<string, unknown>[] = [];
    const done = waitForDoneCount(stream, messages, 2);

    const first = await postJson('/review', {
      type: 'review',
      clientId: 'tab-backend-queue',
      tabId: 'tab-backend-queue',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'backend-queue-first',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(first.status, 202);
    assert.strictEqual(first.body.ok, true);

    const second = await postJson('/review', {
      type: 'review',
      clientId: 'tab-backend-queue',
      tabId: 'tab-backend-queue',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'backend-queue-second',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(second.status, 202);
    assert.strictEqual(second.body.ok, true);

    await done;
    assert.ok(messages.some(message => message.type === 'queue_status' && message.isProcessing === true));
    assert.strictEqual(messages.filter(message => message.type === 'error').length, 2);
    stream.close();
  });

  it('no longer exposes the unapproved /browser-tool channel or MCP', async () => {
    const stream = await openSse('tab-browser-tool');
    await stream.next();
    await activate('tab-browser-tool');

    const removed = await postRaw('/browser-tool', { action: 'run_js', params: { code: '1' } });
    assert.strictEqual(removed.status, 404);

    const unsupportedMcp = await postRaw('/mcp', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    assert.strictEqual(unsupportedMcp.status, 404);
    stream.close();
  });

  it('saves, lists, and deletes project element targets', async () => {
    const saved = await postJson('/element-targets', {
      name: '登录按钮',
      description: '登录表单提交按钮',
      pagePattern: 'http://localhost:3000/login',
      pageUrl: 'http://localhost:3000/login?debug=1',
      selector: 'button[type="submit"]',
      semantic: { role: 'button', label: '登录' },
      locatorRecipes: [{ type: 'role+label', role: 'button', label: '登录' }],
    });

    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.ok, true);
    assert.ok(saved.body.target.targetId);

    const listed = await getJson('/element-targets');
    assert.strictEqual(listed.status, 200);
    assert.ok(listed.body.targets.some((target: any) => target.targetId === saved.body.target.targetId));

    const deleted = await deleteJson(`/element-targets/${encodeURIComponent(saved.body.target.targetId)}`);
    assert.strictEqual(deleted.status, 200);
    assert.strictEqual(deleted.body.deleted, saved.body.target.targetId);
  });
});

/** Scriptable AgentSession so queue / cancel / done semantics can be tested. */
class FakeAgentSession implements AgentSession {
  static instances: FakeAgentSession[] = [];
  callbacks!: AgentCallbacks;
  stopped = false;
  sent = 0;
  /** When set, sendReview waits for it before returning. */
  gate: Promise<void> | null = null;
  constructor(private runner: (a: any, p?: any) => Promise<any>, private mode: 'stream' | 'block' | 'tools') {
    FakeAgentSession.instances.push(this);
  }
  async start() { return { sessionId: 'fake-agent-session', mode: 'created' as const }; }
  async sendReview() {
    this.sent++;
    if (this.mode === 'tools') {
      const snapshot = await this.runner('get_page_snapshot', {});
      this.callbacks.onToolCall?.({ toolCallId: 't1', title: 'get_page_snapshot', status: 'pending' });
      this.callbacks.onStream(JSON.stringify(snapshot.result));
      this.callbacks.onDone('tools done');
      return 'end_turn';
    }
    if (this.mode === 'block') {
      await new Promise<void>(resolve => { this.release = resolve; });
      this.callbacks.onStream('late text');
      this.callbacks.onDone('late done');
      return 'end_turn';
    }
    this.callbacks.onStream('hello');
    this.callbacks.onDone('all good');
    return 'end_turn';
  }
  release: () => void = () => {};
  async cancelCurrentTurn() { return false; }
  setCallbacks(cb: AgentCallbacks) { this.callbacks = cb; }
  stop() { this.stopped = true; }
  get isReady() { return !this.stopped; }
  get isStarting() { return false; }
  get currentSessionId() { return 'fake-agent-session'; }
}

describe('integration: review lifecycle with a scripted agent session', () => {
  const reviewPayload = (userIntent: string) => ({
    pageUrl: 'http://localhost:3000',
    userIntent,
    items: [],
    screenshot: null,
  });

  async function withServer(
    port: number,
    mode: 'stream' | 'block' | 'tools',
    fn: (ctx: ReturnType<typeof makeClient>) => Promise<void>,
  ): Promise<void> {
    FakeAgentSession.instances = [];
    const root = await mkdtemp(join(tmpdir(), 'devtailor-lifecycle-'));
    const server = new WSServer(port, root, undefined, 'fake', 'Fake', runner => new FakeAgentSession(runner, mode));
    await server.start();
    try {
      await fn(makeClient(port));
    } finally {
      server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }

  it('emits exactly one done per turn', async () => {
    await withServer(17780, 'stream', async c => {
      const stream = await c.openSse('tab-done-once');
      await stream.next();
      const messages: Record<string, unknown>[] = [];
      const finished = c.collectUntilDone(stream, messages);
      assert.strictEqual((await c.postJson('/review', { type: 'review', clientId: 'tab-done-once', payload: reviewPayload('hi') })).status, 202);
      await finished;
      await sleep(100);
      const dones = messages.filter(m => m.type === 'done');
      assert.strictEqual(dones.length, 1);
      assert.strictEqual(dones[0].summary, 'all good');
      assert.ok(messages.some(m => m.type === 'stream' && m.delta === 'hello'));
      stream.close();
    });
  });

  it('routes browser tool calls from the agent through the extension SSE channel', async () => {
    await withServer(17781, 'tools', async c => {
      const stream = await c.openSse('tab-tools');
      await stream.next();
      await c.activate('tab-tools');
      c.respondToBrowserActions(stream);
      const messages: Record<string, unknown>[] = [];
      const finished = c.collectUntilDone(stream, messages);
      await c.postJson('/review', { type: 'review', clientId: 'tab-tools', payload: reviewPayload('tools') });
      await finished;
      assert.ok(messages.some(m => m.type === 'browser_action' && m.action === 'get_page_snapshot'));
      assert.ok(messages.some(m => m.type === 'stream' && String(m.delta).includes('DevTailor Test Page')));
      stream.close();
    });
  });

  it('reuses the live agent session for consecutive messages', async () => {
    await withServer(17782, 'stream', async c => {
      const stream = await c.openSse('tab-reuse');
      await stream.next();
      const messages: Record<string, unknown>[] = [];
      const finished = c.waitForDoneCount(stream, messages, 2);
      await c.postJson('/review', { type: 'review', clientId: 'tab-reuse', payload: reviewPayload('one') });
      await c.postJson('/review', { type: 'review', clientId: 'tab-reuse', payload: reviewPayload('two') });
      await finished;
      assert.strictEqual(FakeAgentSession.instances.length, 1);
      assert.strictEqual(FakeAgentSession.instances[0].sent, 2);
      stream.close();
    });
  });

  it('rejects review posts when the per-client queue is full (429)', async () => {
    await withServer(17783, 'block', async c => {
      const stream = await c.openSse('tab-queue-full');
      await stream.next();
      for (let i = 0; i < 11; i++) {
        const res = await c.postJson('/review', { type: 'review', clientId: 'tab-queue-full', payload: reviewPayload('queue-fill') });
        assert.strictEqual(res.status, 202, `post ${i}`);
      }
      const overflow = await c.postJson('/review', { type: 'review', clientId: 'tab-queue-full', payload: reviewPayload('queue-fill') });
      assert.strictEqual(overflow.status, 429);
      assert.strictEqual(overflow.body.ok, false);
      assert.strictEqual(overflow.body.maxDepth, 10);
      assert.ok(overflow.body.error.includes('queue full'));
      stream.close();
    });
  });

  it('cancel marks the displayed turn canceled without stopping the agent session', async () => {
    await withServer(17784, 'block', async c => {
      const stream = await c.openSse('tab-cancel');
      await stream.next();
      const messages: Record<string, unknown>[] = [];
      stream.onMessage(m => messages.push(m));
      await c.postJson('/review', { type: 'review', clientId: 'tab-cancel', payload: reviewPayload('long task') });
      await sleep(100);

      const cancel = await c.postJson('/cancel', { clientId: 'tab-cancel' });
      assert.strictEqual(cancel.status, 200);
      assert.strictEqual(cancel.body.canceled, true);
      await sleep(50);
      assert.ok(messages.some(m => m.type === 'tool_status' && m.toolStatus === 'canceled'));
      const donesAfterCancel = messages.filter(m => m.type === 'done');
      assert.strictEqual(donesAfterCancel.length, 1);
      assert.strictEqual(donesAfterCancel[0].reason, 'cancelled');

      // The agent finishes later: its output is dropped and no second done is emitted.
      FakeAgentSession.instances[0].release();
      await sleep(150);
      assert.strictEqual(FakeAgentSession.instances[0].stopped, false);
      assert.strictEqual(messages.filter(m => m.type === 'done').length, 1);
      assert.ok(!messages.some(m => m.type === 'stream' && m.delta === 'late text'));

      const again = await c.postJson('/cancel', { clientId: 'tab-cancel' });
      assert.strictEqual(again.body.canceled, false);
      stream.close();
    });
  });

  it('reports queued state for a review posted while another is running', async () => {
    await withServer(17786, 'block', async c => {
      const stream = await c.openSse('tab-queued');
      await stream.next();
      const first = await c.postJson('/review', { type: 'review', clientId: 'tab-queued', payload: reviewPayload('a') });
      assert.strictEqual(first.body.queued, false);
      await sleep(50);
      const second = await c.postJson('/review', { type: 'review', clientId: 'tab-queued', payload: reviewPayload('b') });
      assert.strictEqual(second.body.queued, true);
      assert.ok(second.body.queueDepth >= 1);
      stream.close();
    });
  });

  it('releases the active browser client after its SSE stream stays disconnected', async () => {
    const previousGrace = WSServer.activeClientGraceMs;
    WSServer.activeClientGraceMs = 100;
    try {
      await withServer(17785, 'stream', async c => {
        const stream = await c.openSse('tab-disconnect');
        await stream.next();
        await c.activate('tab-disconnect');
        assert.strictEqual((await c.getJson('/health')).body.activeClientId, 'tab-disconnect');
        stream.close();
        await sleep(300);
        assert.strictEqual((await c.getJson('/health')).body.activeClientId, null);
      });
    } finally {
      WSServer.activeClientGraceMs = previousGrace;
    }
  });

  it('keeps the active client when the same clientId reconnects within the grace period', async () => {
    const previousGrace = WSServer.activeClientGraceMs;
    WSServer.activeClientGraceMs = 300;
    try {
      await withServer(17787, 'stream', async c => {
        const first = await c.openSse('tab-flap');
        await first.next();
        await c.activate('tab-flap');
        first.close();
        await sleep(50);
        const second = await c.openSse('tab-flap');
        await second.next();
        await sleep(450);
        assert.strictEqual((await c.getJson('/health')).body.activeClientId, 'tab-flap');
        second.close();
      });
    } finally {
      WSServer.activeClientGraceMs = previousGrace;
    }
  });
});
