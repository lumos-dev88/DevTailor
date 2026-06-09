import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WSServer } from '../src/ws-server';
import { resolve } from 'path';

describe('integration: sse-server -> acp-session -> mock agent', () => {
  const PORT = 17777;
  const baseUrl = `http://localhost:${PORT}`;
  const mockAgent = resolve(__dirname, 'mock-acp-agent.js');
  let server: WSServer;

  before(async () => {
    server = new WSServer(PORT, 'node', process.cwd(), [mockAgent]);
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

  it('sends review and receives stream + done', async () => {
    const stream = await openSse('tab-test-1');
    await stream.next();
    await activate('tab-test-1');
    const messages: Record<string, unknown>[] = [];
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
    assert.ok(fullText.includes('Mock'), 'stream should contain mock response');
    stream.close();
  });

  it('sends review with screenshot and receives stream', async () => {
    const stream = await openSse('tab-test-screenshot');
    await stream.next();
    await activate('tab-test-screenshot');
    const messages: Record<string, unknown>[] = [];
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

    const streams = messages.filter(m => m.type === 'stream');
    const dones = messages.filter(m => m.type === 'done');

    assert.ok(streams.length > 0, 'should receive stream messages');
    assert.ok(dones.length > 0, 'should receive done message');

    const fullText = streams.map(m => m.delta).join('');
    assert.ok(fullText.includes('1 images'), 'stream should mention image count');
    stream.close();
  });

  it('updates display session title from ACP session_info_update', async () => {
    const stream = await openSse('tab-session-title-update');
    await stream.next();
    await activate('tab-session-title-update');
    const created = await postJson('/new-session', {
      clientId: 'tab-session-title-update',
      tabId: 'tab-session-title-update',
    });
    assert.strictEqual(created.status, 200);
    const sessionId = created.body.sessionId;
    const messages: Record<string, unknown>[] = [];
    const done = collectUntilDone(stream, messages);

    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-session-title-update',
      tabId: 'tab-session-title-update',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'trigger-session-title-update',
        items: [],
        screenshot: null,
      },
    });

    assert.strictEqual(response.status, 202);
    await done;

    assert.ok(messages.some(message =>
      message.type === 'session_info'
      && message.sessionId === sessionId
      && message.sessionTitle === 'Agent Generated Title'
    ));

    const health = await getJson('/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.activeSessionTitle, 'Agent Generated Title');

    const list = await getJson('/sessions?clientId=tab-session-title-update');
    assert.strictEqual(list.status, 200);
    assert.ok(list.body.sessions.some((session: any) =>
      session.sessionId === sessionId && session.title === 'Agent Generated Title'
    ));
    stream.close();
  });

  it('keeps ACP title updates emitted during session startup', async () => {
    const startupPort = 17778;
    const startupBaseUrl = `http://localhost:${startupPort}`;
    const startupServer = new WSServer(
      startupPort,
      'node',
      process.cwd(),
      [mockAgent],
      undefined,
      { MOCK_STARTUP_TITLE: 'Agent Startup Title' },
    );
    startupServer.start();
    await new Promise(resolve => setTimeout(resolve, 200));

    let stream: Awaited<ReturnType<typeof openSse>> | null = null;
    try {
      stream = await openSse('tab-session-startup-title', startupBaseUrl);
      await stream.next();
      const activation = await postJson('/activate', {
        clientId: 'tab-session-startup-title',
        tabId: 'tab-session-startup-title',
      }, startupBaseUrl);
      assert.strictEqual(activation.status, 200);
      const created = await postJson('/new-session', {
        clientId: 'tab-session-startup-title',
        tabId: 'tab-session-startup-title',
      }, startupBaseUrl);
      assert.strictEqual(created.status, 200);
      const sessionId = created.body.sessionId;
      const messages: Record<string, unknown>[] = [];
      const done = collectUntilDone(stream, messages);

      const response = await postJson('/review', {
        type: 'review',
        clientId: 'tab-session-startup-title',
        tabId: 'tab-session-startup-title',
        payload: {
          pageUrl: 'http://localhost:3000',
          userIntent: 'fallback title should not win',
          items: [],
          screenshot: null,
        },
      }, startupBaseUrl);

      assert.strictEqual(response.status, 202);
      await done;

      assert.ok(messages.some(message =>
        message.type === 'session_info'
        && message.sessionId === sessionId
        && message.sessionTitle === 'Agent Startup Title'
      ));

      const list = await getJson('/sessions?clientId=tab-session-startup-title', startupBaseUrl);
      assert.strictEqual(list.status, 200);
      assert.ok(list.body.sessions.some((session: any) =>
        session.sessionId === sessionId && session.title === 'Agent Startup Title'
      ));
    } finally {
      stream?.close();
      startupServer.stop();
    }
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
    if (created.body.reused) {
      assert.strictEqual(created.body.sessionId, firstSessionId);
    } else {
      assert.notStrictEqual(created.body.sessionId, firstSessionId);
    }

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
    assert.strictEqual(
      list.body.sessions.filter((session: any) => session.sessionId === first.body.sessionId).length,
      1,
    );
    stream.close();
  });

  it('shares display sessions across tabs in the same project and agent', async () => {
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

    const rejected = await postJson('/review', {
      type: 'review',
      clientId: 'tab-active-a',
      tabId: 'tab-active-a',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'should be rejected',
        items: [],
        screenshot: null,
      },
    });
    assert.strictEqual(rejected.status, 409);
    assert.match(rejected.body.error, /not the active/i);

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

    const messages: Record<string, unknown>[] = [];
    const done = collectUntilDone(refreshedStream, messages);
    const response = await postJson('/review', {
      type: 'review',
      clientId: 'tab-refresh-stable',
      tabId: 'tab-refresh-stable',
      payload: {
        pageUrl: 'http://localhost:3000',
        userIntent: 'refresh should not require re-activation',
        items: [],
        screenshot: null,
      },
    });

    assert.strictEqual(response.status, 202);
    await done;
    assert.ok(messages.some(message => message.type === 'done'));

    refreshedStream.close();
  });

  it('handles MCP JSON-RPC notifications without returning a null response body', async () => {
    const response = await postRaw('/mcp', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });

    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.text, '');
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

  function openSse(clientId: string, base = baseUrl): Promise<{
    next: () => Promise<Record<string, unknown>>;
    onMessage: (callback: (message: Record<string, unknown>) => void) => void;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const callbacks: Array<(message: Record<string, unknown>) => void> = [];
      const queue: Record<string, unknown>[] = [];
      const waiters: Array<(message: Record<string, unknown>) => void> = [];
      let buffer = '';

      const req = http.get(`${base}/events?clientId=${encodeURIComponent(clientId)}`, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            const message = JSON.parse(line.slice(6));
            callbacks.forEach(callback => callback(message));
            const waiter = waiters.shift();
            if (waiter) waiter(message);
            else queue.push(message);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(2000, () => reject(new Error('Timed out opening SSE stream')));

      resolve({
        next: () => new Promise(resolveNext => {
          const message = queue.shift();
          if (message) resolveNext(message);
          else waiters.push(resolveNext);
        }),
        onMessage: (callback) => {
          callbacks.push(callback);
        },
        close: () => {
          req.destroy();
        },
      });
    });
  }
});
