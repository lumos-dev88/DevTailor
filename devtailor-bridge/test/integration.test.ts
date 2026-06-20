import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSServer } from '../src/ws-server';

describe('integration: local bridge runtime', () => {
  const PORT = 17777;
  const baseUrl = `http://localhost:${PORT}`;
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

  it('saves model config and exposes redacted status', async () => {
    const modelPort = 17778;
    const modelBaseUrl = `http://localhost:${modelPort}`;
    const modelRoot = await mkdtemp(join(tmpdir(), 'devtailor-model-config-'));
    const modelServer = new WSServer(modelPort, modelRoot, join(modelRoot, '.devtailor'));
    await modelServer.init();
    modelServer.start();
    await new Promise(r => setTimeout(r, 200));
    try {
      const saved = await postJson('/model-config', {
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://example.test/v1/',
        apiKey: 'secret-key',
        model: 'mimo-v2.5',
        maxSteps: 5,
      }, modelBaseUrl);
      assert.strictEqual(saved.status, 200);
      assert.strictEqual(saved.body.config.baseUrl, 'http://example.test/v1');
      assert.strictEqual(saved.body.config.model, 'mimo-v2.5');
      assert.strictEqual(saved.body.config.hasApiKey, true);
      assert.strictEqual(saved.body.config.apiKey, undefined);

      const loaded = await getJson('/model-config', modelBaseUrl);
      assert.strictEqual(loaded.status, 200);
      assert.strictEqual(loaded.body.config.hasApiKey, true);
      assert.strictEqual(loaded.body.config.apiKey, undefined);

      const health = await getJson('/health', modelBaseUrl);
      assert.strictEqual(health.body.agentKey, 'openai-compatible:mimo-v2.5');
      assert.strictEqual(health.body.agentLabel, 'OpenAI Compatible (mimo-v2.5)');
    } finally {
      modelServer.stop();
      await rm(modelRoot, { recursive: true, force: true });
    }
  });

  it('keeps the active display session when model config changes within the same runtime key', async () => {
    const modelPort = 17779;
    const modelBaseUrl = `http://localhost:${modelPort}`;
    const modelRoot = await mkdtemp(join(tmpdir(), 'devtailor-model-active-session-'));
    const modelServer = new WSServer(modelPort, modelRoot, join(modelRoot, '.devtailor'));
    await modelServer.init();
    modelServer.start();
    await new Promise(r => setTimeout(r, 200));
    const stream = await openSse('tab-model-active-session', modelBaseUrl);
    await stream.next();
    try {
      const created = await postJson('/new-session', {
        clientId: 'tab-model-active-session',
        tabId: 'tab-model-active-session',
      }, modelBaseUrl);
      assert.strictEqual(created.status, 200);
      const sessionId = created.body.sessionId;
      assert.ok(sessionId);

      const firstSave = await postJson('/model-config', {
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://example.test/v1/',
        apiKey: 'secret-key',
        model: 'mimo-v2.5',
        maxSteps: 5,
      }, modelBaseUrl);
      assert.strictEqual(firstSave.status, 200);

      const activeAfterFirstSave = await getJson('/sessions/active?clientId=tab-model-active-session', modelBaseUrl);
      assert.strictEqual(activeAfterFirstSave.status, 200);
      const newRuntimeSessionId = activeAfterFirstSave.body.activeSessionId;
      assert.ok(newRuntimeSessionId);

      const secondSave = await postJson('/model-config', {
        provider: 'openai-compatible',
        enabled: true,
        baseUrl: 'http://example.test/v1/',
        apiKey: 'other-secret',
        model: 'mimo-v2.5',
        maxSteps: 7,
      }, modelBaseUrl);
      assert.strictEqual(secondSave.status, 200);

      const activeAfterSecondSave = await getJson('/sessions/active?clientId=tab-model-active-session', modelBaseUrl);
      assert.strictEqual(activeAfterSecondSave.status, 200);
      assert.strictEqual(activeAfterSecondSave.body.activeSessionId, newRuntimeSessionId);
    } finally {
      stream.close();
      modelServer.stop();
      await rm(modelRoot, { recursive: true, force: true });
    }
  });

  it('sends review and receives local runtime stream + done', async () => {
    const stream = await openSse('tab-test-1');
    await stream.next();
    await activate('tab-test-1');
    const messages: Record<string, unknown>[] = [];
    respondToBrowserActions(stream);
    const done = collectUntilDone(stream, messages);

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
    await done;

    const streams = messages.filter(m => m.type === 'stream');
    const dones = messages.filter(m => m.type === 'done');

    assert.ok(streams.length > 0, 'should receive stream messages');
    assert.ok(dones.length > 0, 'should receive done message');

    const fullText = streams.map(m => m.delta).join('');
    assert.ok(fullText.includes('Bridge 已切换到本地 UI 调试后端通道'));
    stream.close();
  });

  it('sends review with screenshot and receives stream', async () => {
    const stream = await openSse('tab-test-screenshot');
    await stream.next();
    await activate('tab-test-screenshot');
    const messages: Record<string, unknown>[] = [];
    respondToBrowserActions(stream);
    const done = collectUntilDone(stream, messages);

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
    await done;

    const fullText = messages.filter(m => m.type === 'stream').map(m => m.delta).join('');
    assert.ok(fullText.includes('1 张图片'));
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
    assert.strictEqual(healthAfterActivation.body.activeSessionTitle, '刷新后应该显示会话名');

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

  it('reuses the live local agent session across consecutive messages in one display session', async () => {
    const stream = await openSse('tab-reuse-agent-session');
    await stream.next();
    await activate('tab-reuse-agent-session');
    const created = await postJson('/new-session', {
      clientId: 'tab-reuse-agent-session',
      tabId: 'tab-reuse-agent-session',
    });
    assert.strictEqual(created.status, 200);

    const firstMessages: Record<string, unknown>[] = [];
    respondToBrowserActions(stream);
    const firstDone = collectUntilDone(stream, firstMessages);
    const first = await postJson('/review', {
      type: 'review',
      clientId: 'tab-reuse-agent-session',
      tabId: 'tab-reuse-agent-session',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'reuse-agent-session-first',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(first.status, 202);
    await firstDone;
    const firstInfo = firstMessages.find(message => message.type === 'session_info' && message.agentSessionId);
    assert.ok(firstInfo?.agentSessionId);

    const secondMessages: Record<string, unknown>[] = [];
    const secondDone = collectUntilDone(stream, secondMessages);
    const second = await postJson('/review', {
      type: 'review',
      clientId: 'tab-reuse-agent-session',
      tabId: 'tab-reuse-agent-session',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'reuse-agent-session-second',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(second.status, 202);
    await secondDone;
    const secondInfo = secondMessages.find(message => message.type === 'session_info' && message.agentSessionId);
    if (secondInfo) {
      assert.strictEqual(secondInfo.agentSessionId, firstInfo.agentSessionId);
    }

    stream.close();
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
    assert.strictEqual(second.body.queued, true);
    assert.ok(second.body.queueDepth >= 1);

    await done;
    assert.ok(messages.some(message => message.type === 'queue_status' && message.isProcessing === true));
    assert.ok(messages.some(message => message.type === 'stream' && message.isProcessing === true));
    assert.strictEqual(messages.filter(message => message.type === 'done').length, 2);
    stream.close();
  });

  it('rejects review posts when per-client queue is full (429)', async () => {
    const stream = await openSse('tab-queue-full');
    await stream.next();
    await activate('tab-queue-full');
    // Do NOT resolve browser actions → reviews hang, queue fills up
    const messages: Record<string, unknown>[] = [];
    stream.onMessage(msg => messages.push(msg));

    // Post enough reviews to saturate processing (1) + MAX_REVIEW_QUEUE_DEPTH (10) = 11 accepted
    const payload = {
      pageUrl: 'http://localhost:3000',
      userIntent: 'queue-fill',
      items: [],
      screenshot: null,
    };
    for (let i = 0; i < 11; i++) {
      const res = await postJson('/review', {
        type: 'review',
        clientId: 'tab-queue-full',
        tabId: 'tab-queue-full',
        payload,
      });
      assert.ok([202, 429].includes(res.status), `post ${i} got status ${res.status}`);
      if (res.status === 202) {
        assert.strictEqual(res.body.ok, true);
      }
    }

    // The 12th post must be rejected with 429
    const overflow = await postJson('/review', {
      type: 'review',
      clientId: 'tab-queue-full',
      tabId: 'tab-queue-full',
      payload,
    });
    assert.strictEqual(overflow.status, 429);
    assert.strictEqual(overflow.body.ok, false);
    assert.ok(typeof overflow.body.queueDepth === 'number');
    assert.strictEqual(overflow.body.maxDepth, 10);
    assert.ok(overflow.body.error.includes('queue full'));

    stream.close();
  });

  it('lets the local runtime call browser tools during a review turn', async () => {
    const stream = await openSse('tab-runtime-browser-tools');
    await stream.next();
    await activate('tab-runtime-browser-tools');
    const messages: Record<string, unknown>[] = [];
    respondToBrowserActions(stream);
    const done = collectUntilDone(stream, messages);

    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-runtime-browser-tools',
      tabId: 'tab-runtime-browser-tools',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: '检查按钮间距',
        items: [],
        screenshot: null,
      },
    });

    assert.strictEqual(response.status, 202);
    await done;

    const toolCalls = messages.filter(message => message.type === 'tool_call');
    const toolUpdates = messages.filter(message => message.type === 'tool_update');
    assert.ok(toolCalls.some(message => message.toolTitle === 'get_page_snapshot'));
    assert.ok(toolUpdates.some(message => message.toolTitle === 'get_console_logs' && message.toolStatus === 'completed'));
    const fullText = messages.filter(message => message.type === 'stream').map(message => message.delta).join('');
    assert.match(fullText, /页面快照/);
    assert.match(fullText, /元素库/);
    stream.close();
  });

  it('exposes local browser tools without MCP', async () => {
    const stream = await openSse('tab-browser-tool');
    await stream.next();
    await activate('tab-browser-tool');

    const listed = await postJson('/browser-tool', {
      action: 'get_element_targets',
      params: {},
    });

    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.body.ok, true);
    assert.ok(Array.isArray(listed.body.result.targets));

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

  async function postJson(path: string, body: unknown, base = baseUrl): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  async function postRaw(path: string, body: unknown, base = baseUrl): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      text: await response.text(),
    };
  }

  async function getJson(path: string, base = baseUrl): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`);
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  async function deleteJson(path: string, base = baseUrl): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, { method: 'DELETE' });
    return {
      status: response.status,
      body: await response.json(),
    };
  }

  async function activate(clientId: string): Promise<{ status: number; body: any }> {
    return postJson('/activate', { clientId, tabId: clientId });
  }

  function collectUntilDone(
    stream: Awaited<ReturnType<typeof openSse>>,
    messages: Record<string, unknown>[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for done')), 5000);
      stream.onMessage((message) => {
        messages.push(message);
        if (message.type === 'done' || message.type === 'error') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  function waitForDoneCount(
    stream: Awaited<ReturnType<typeof openSse>>,
    messages: Record<string, unknown>[],
    count: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let doneCount = 0;
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${count} done events`)), 10000);
      stream.onMessage((message) => {
        messages.push(message);
        if (message.type === 'done' || message.type === 'error') {
          doneCount++;
          if (doneCount >= count) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });
  }

  function respondToBrowserActions(stream: Awaited<ReturnType<typeof openSse>>): void {
    stream.onMessage(async message => {
      if (message.type !== 'browser_action') return;
      const action = String(message.action || '');
      const requestId = String(message.requestId || '');
      if (!requestId) return;

      let result: unknown = { ok: true };
      if (action === 'get_page_snapshot') {
        result = {
          title: 'DevTailor Test Page',
          url: 'http://localhost:3000',
          elements: [
            { elementId: 'el_button', role: 'button', label: '保存', rect: { x: 10, y: 20, w: 80, h: 32 } },
          ],
        };
      } else if (action === 'get_console_logs') {
        result = {
          logs: [
            { type: 'warn', text: 'layout shift warning' },
          ],
        };
      }

      await postJson('/browser-action-result', {
        requestId,
        ok: true,
        result,
      });
    });
  }

  async function openSse(clientId: string, base = baseUrl): Promise<{
    next: () => Promise<Record<string, any>>;
    onMessage: (listener: (message: Record<string, any>) => void) => void;
    close: () => void;
  }> {
    const req = http.get(`${base}/events?clientId=${encodeURIComponent(clientId)}`);
    const queue: Record<string, any>[] = [];
    const listeners: Array<(message: Record<string, any>) => void> = [];
    const waiters: Array<(message: Record<string, any>) => void> = [];
    let buffer = '';

    req.on('response', res => {
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice('data: '.length));
          for (const listener of listeners) listener(msg);
          const waiter = waiters.shift();
          if (waiter) waiter(msg);
          else queue.push(msg);
        }
      });
    });

    return {
      next: () => new Promise(resolve => {
        const msg = queue.shift();
        if (msg) resolve(msg);
        else waiters.push(resolve);
      }),
      onMessage: listener => listeners.push(listener),
      close: () => req.destroy(),
    };
  }
});
