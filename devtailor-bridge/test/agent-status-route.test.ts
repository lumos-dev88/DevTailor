import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSServer, AGENT_HOOK_TOKEN_FILE, AGENT_STATUS_MAX_BODY_BYTES } from '../src/ws-server';
import { ClaudeChannelHub, ClaudeChannelSession } from '../src/claude-channel-session';
import { makeClient, rawRequest, sleep, TEST_EXTENSION_ORIGIN } from './helpers';

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

async function readToken(dataDir: string): Promise<string> {
  return (await readFile(join(dataDir, AGENT_HOOK_TOKEN_FILE), 'utf8')).trim();
}

function mode(path: string): Promise<number> {
  return stat(path).then(s => s.mode & 0o777);
}

describe('agent status route: POST /agent-status', () => {
  const PORT = 17901;
  const hostOk = `127.0.0.1:${PORT}`;
  let dir: string;
  let dataDir: string;
  let server: WSServer;
  let token: string;
  let client: ReturnType<typeof makeClient>;

  const report = (
    body: unknown,
    headers: Record<string, string | undefined> = {},
    method = 'POST',
  ) => rawRequest(PORT, {
    method,
    path: '/agent-status',
    headers: { Host: hostOk, ...headers },
    body: method === 'GET' ? undefined : body,
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devtailor-agent-status-'));
    dataDir = join(dir, '.devtailor');
    server = new WSServer(PORT, dir, dataDir);
    await server.init();
    await server.start();
    token = await readToken(dataDir);
    client = makeClient(PORT);
  });

  after(async () => {
    server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a 32-char hex token to <dataDir>/agent-hook-token with mode 0600', async () => {
    const path = join(dataDir, AGENT_HOOK_TOKEN_FILE);
    assert.match(token, TOKEN_PATTERN);
    assert.strictEqual(await mode(path), 0o600);
  });

  it('rejects a missing token with 401 and no CORS headers', async () => {
    const res = await report({ event: 'PreToolUse', toolName: 'Read' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    assert.deepStrictEqual(res.json().ok, false);
  });

  it('rejects a wrong token with 401 (including a same-prefix / wrong-length one)', async () => {
    for (const value of [
      'Bearer 00000000000000000000000000000000',
      `Bearer ${token.slice(0, 31)}`,
      `Bearer ${token}0`,
      token, // no scheme
      'Basic abc',
      '',
    ]) {
      const res = await report({ event: 'PreToolUse' }, { Authorization: value });
      assert.strictEqual(res.status, 401, value);
    }
  });

  it('rejects a web page Origin even with the right token (CSRF)', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'null']) {
      const res = await report(
        { event: 'PreToolUse', toolName: 'Read' },
        { Authorization: `Bearer ${token}`, Origin: origin },
      );
      assert.strictEqual(res.status, 403, origin);
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined, origin);
    }
  });

  it('rejects a bad Host header (DNS rebinding still applies)', async () => {
    const res = await report(
      { event: 'PreToolUse' },
      { Authorization: `Bearer ${token}`, Host: `evil.example:${PORT}` },
    );
    assert.strictEqual(res.status, 403);
  });

  it('accepts a browserless request with the right token and returns {ok:true}', async () => {
    const res = await report(
      { event: 'UserPromptSubmit' },
      { Authorization: `Bearer ${token}` },
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json(), { ok: true });
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    assert.strictEqual(server.currentAgentStatus().state, 'thinking');
  });

  it('rejects malformed bodies with 400 and unknown events with 400', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    for (const body of [{}, { event: 42 }, { event: '' }]) {
      const res = await report(body, auth);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    const unknown = await report({ event: 'ToolUse' }, auth);
    assert.strictEqual(unknown.status, 400);
    assert.strictEqual(unknown.json().ok, false);
  });

  it('rejects a body larger than 8KB with 413', async () => {
    const res = await report(
      { event: 'PreToolUse', label: 'x'.repeat(AGENT_STATUS_MAX_BODY_BYTES) },
      { Authorization: `Bearer ${token}` },
    );
    assert.strictEqual(res.status, 413);
  });

  it('returns 405 for non-POST requests to /agent-status', async () => {
    const get = await report({} as any, { Authorization: `Bearer ${token}`, Origin: TEST_EXTENSION_ORIGIN }, 'GET');
    assert.strictEqual(get.status, 405);
    const put = await report({ event: 'Stop' }, { Authorization: `Bearer ${token}` }, 'PUT');
    assert.strictEqual(put.status, 405);
  });

  it('still requires an extension Origin for every other route', async () => {
    const sessions = await rawRequest(PORT, { path: '/sessions', headers: { Host: hostOk } });
    assert.strictEqual(sessions.status, 403);
    const withPageOrigin = await rawRequest(PORT, {
      path: '/sessions',
      headers: { Host: hostOk, Origin: 'http://evil.example' },
    });
    assert.strictEqual(withPageOrigin.status, 403);
    const ok = await rawRequest(PORT, {
      path: '/sessions',
      headers: { Host: hostOk, Origin: TEST_EXTENSION_ORIGIN },
    });
    assert.strictEqual(ok.status, 200);
  });

  it('broadcasts agent_status to connected SSE clients on each event', async () => {
    const stream = await client.openSse('tab-agent-status');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(message => seen.push(message));
    // `connected` + the initial snapshot are the first two messages.
    await sleep(50);

    await report({ event: 'PreToolUse', toolName: 'Read', label: '读取 src/app.ts', toolUseId: 'toolu_1' }, {
      Authorization: `Bearer ${token}`,
    });
    await sleep(50);

    const toolEvent = seen.filter(m => m.type === 'agent_status').pop();
    assert.ok(toolEvent, 'agent_status was broadcast');
    assert.strictEqual(toolEvent!.state, 'tool');
    assert.strictEqual(toolEvent!.label, '读取 src/app.ts');
    assert.strictEqual(toolEvent!.toolName, 'Read');
    assert.strictEqual(toolEvent!.activeTools, 1);
    assert.strictEqual(typeof toolEvent!.since, 'number');

    await report({ event: 'Stop' }, { Authorization: `Bearer ${token}` });
    await sleep(50);
    const idleEvent = seen.filter(m => m.type === 'agent_status').pop()!;
    assert.strictEqual(idleEvent.state, 'idle');
    assert.strictEqual(idleEvent.activeTools, 0);
    stream.close();
  });

  it('sends the current snapshot to a newly connected SSE client', async () => {
    await report({ event: 'Notification', label: '等待你的确认' }, { Authorization: `Bearer ${token}` });
    const stream = await client.openSse('tab-agent-status-new');
    const connected = await stream.next();
    assert.strictEqual(connected.type, 'connected');
    const snapshot = await stream.next();
    assert.strictEqual(snapshot.type, 'agent_status');
    assert.strictEqual(snapshot.state, 'waiting');
    assert.strictEqual(snapshot.label, '等待你的确认');
    assert.strictEqual(snapshot.activeTools, 0);
    stream.close();
    await report({ event: 'Stop' }, { Authorization: `Bearer ${token}` });
  });

  it('exposes the snapshot as agentStatus in the extension-authenticated /health', async () => {
    await report({ event: 'PreToolUse', toolName: 'Bash', label: '跑测试', toolUseId: 'toolu_h' }, {
      Authorization: `Bearer ${token}`,
    });
    const health = await rawRequest(PORT, {
      path: '/health',
      headers: { Host: hostOk, Origin: TEST_EXTENSION_ORIGIN },
    });
    assert.strictEqual(health.status, 200);
    const agentStatus = health.json().agentStatus;
    assert.strictEqual(agentStatus.state, 'tool');
    assert.strictEqual(agentStatus.toolName, 'Bash');
    assert.strictEqual(agentStatus.activeTools, 1);

    // The origin-less /health stays minimal: no status leak to web pages.
    const minimal = await rawRequest(PORT, { path: '/health', headers: { Host: hostOk } });
    assert.deepStrictEqual(Object.keys(minimal.json()).sort(), ['ok', 'protocolVersion']);
    await report({ event: 'Stop' }, { Authorization: `Bearer ${token}` });
  });

  it('regenerates the token on restart and deletes the file on stop', async () => {
    const path = join(dataDir, AGENT_HOOK_TOKEN_FILE);
    const before = token;
    server.stop();
    await assert.rejects(readFile(path, 'utf8'), 'token file is removed when the bridge stops');

    server = new WSServer(PORT, dir, dataDir);
    await server.init();
    await server.start();
    token = await readToken(dataDir);
    assert.match(token, TOKEN_PATTERN);
    assert.notStrictEqual(token, before, 'a restart never reuses a token');
    assert.strictEqual(await mode(path), 0o600);
    assert.strictEqual((await report({ event: 'Stop' }, { Authorization: `Bearer ${token}` })).status, 200);
  });
});

describe('agent status: claude channel turn boundaries', () => {
  const PORT = 17902;
  let dir: string;
  let server: WSServer | null = null;
  let hub: ClaudeChannelHub;
  let client: ReturnType<typeof makeClient>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devtailor-agent-turn-'));
    hub = new ClaudeChannelHub({
      projectDir: dir,
      notify: async () => { /* notification write succeeds */ },
      // Same wiring as src/mcp-main.ts.
      onAgentStatus: kind => server?.notifyAgentTurn(kind),
    });
    hub.setReady(true);
    server = new WSServer(
      PORT,
      dir,
      join(dir, '.devtailor'),
      'claude',
      'Claude Code',
      () => new ClaudeChannelSession(hub),
    );
    await server.init();
    await server.start();
    client = makeClient(PORT);
  });

  after(async () => {
    hub.stop();
    server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('turn_start on review dispatch and turn_end when the turn finishes', async () => {
    const stream = await client.openSse('tab-turn');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(message => seen.push(message));
    await stream.next(); // connected
    await stream.next(); // initial agent_status
    await client.activate('tab-turn');

    const review = await client.postJson('/review', {
      type: 'review',
      clientId: 'tab-turn',
      tabId: 'tab-turn',
      payload: { pageUrl: 'http://localhost:3000', userIntent: '改个颜色', items: [], screenshot: null },
    });
    assert.strictEqual(review.status, 202);

    const statuses: Array<Record<string, any>> = [];
    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      const event = seen.find(m => m.type === 'agent_status' && m.state === 'thinking');
      if (event) break;
      await sleep(20);
    }
    statuses.push(...seen.filter(m => m.type === 'agent_status'));
    assert.ok(
      statuses.some(m => m.state === 'thinking'),
      `review dispatch reports thinking: ${JSON.stringify(statuses)}`,
    );
    assert.strictEqual(server!.currentAgentStatus().state, 'thinking');

    const [turnId] = hub.activeTurnIds();
    assert.ok(turnId, 'the hub has the active turn');
    hub.handleReply({ turn_id: turnId, text: '好了', final: true });
    await sleep(50);

    statuses.push(...seen.filter(m => m.type === 'agent_status'));
    const last = statuses[statuses.length - 1];
    assert.strictEqual(last.state, 'idle', `turn end reports idle: ${JSON.stringify(statuses)}`);
    assert.strictEqual(server!.currentAgentStatus().state, 'idle');
    stream.close();
  });
});
