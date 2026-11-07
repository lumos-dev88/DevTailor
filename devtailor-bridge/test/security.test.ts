import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { WSServer } from '../src/ws-server';
import { rawRequest, TEST_EXTENSION_ORIGIN } from './helpers';

describe('security: request guard', () => {
  const PORT = 17790;
  let server: WSServer;
  const hostOk = `127.0.0.1:${PORT}`;
  const get = (path: string, headers: Record<string, string | undefined>) =>
    rawRequest(PORT, { path, headers });

  before(async () => {
    delete process.env.DEVTAILOR_EXTENSION_ID;
    server = new WSServer(PORT, process.cwd());
    await server.start();
  });

  after(() => {
    delete process.env.DEVTAILOR_EXTENSION_ID;
    server.stop();
  });

  it('rejects a foreign Host header with 403 (DNS rebinding)', async () => {
    const res = await get('/sessions', { Host: `evil.example:${PORT}`, Origin: TEST_EXTENSION_ORIGIN });
    assert.strictEqual(res.status, 403);
    const health = await get('/health', { Host: `rebind.example:${PORT}` });
    assert.strictEqual(health.status, 403);
    const wrongPort = await get('/health', { Host: '127.0.0.1:1' });
    assert.strictEqual(wrongPort.status, 403);
  });

  it('accepts localhost:<port> and 127.0.0.1:<port> hosts', async () => {
    for (const host of [`localhost:${PORT}`, hostOk]) {
      const res = await get('/sessions', { Host: host, Origin: TEST_EXTENSION_ORIGIN });
      assert.strictEqual(res.status, 200, host);
    }
  });

  it('rejects requests without an Origin (403)', async () => {
    const res = await get('/sessions', { Host: hostOk });
    assert.strictEqual(res.status, 403);
    const post = await rawRequest(PORT, { method: 'POST', path: '/review', headers: { Host: hostOk }, body: '{}' });
    assert.strictEqual(post.status, 403);
    const events = await get('/events?clientId=x', { Host: hostOk });
    assert.strictEqual(events.status, 403);
  });

  it('rejects web page origins (403) and sends no CORS headers', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'https://127.0.0.1', 'null']) {
      const res = await get('/sessions/active', { Host: hostOk, Origin: origin });
      assert.strictEqual(res.status, 403, origin);
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined, origin);
      assert.ok(!res.text.includes('messages'));
    }
  });

  it('rejects dangerous routes from web pages, including text/plain simple requests', async () => {
    const res = await rawRequest(PORT, {
      method: 'POST',
      path: '/review',
      headers: { Host: hostOk, Origin: 'http://evil.example', 'Content-Type': 'text/plain' },
      body: '{"type":"review","payload":{}}',
    });
    assert.strictEqual(res.status, 403);
  });

  it('accepts chrome-extension origins and echoes the Origin instead of *', async () => {
    const res = await get('/sessions', { Host: hostOk, Origin: 'chrome-extension://abc' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'chrome-extension://abc');
    assert.match(String(res.headers['vary']), /Origin/);
  });

  it('handles OPTIONS preflight through the guard', async () => {
    const ok = await rawRequest(PORT, {
      method: 'OPTIONS',
      path: '/review',
      headers: { Host: hostOk, Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(ok.status, 204);
    assert.strictEqual(ok.headers['access-control-allow-origin'], 'chrome-extension://abc');

    const evil = await rawRequest(PORT, {
      method: 'OPTIONS',
      path: '/review',
      headers: { Host: hostOk, Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(evil.headers['access-control-allow-origin'], undefined);

    const noOrigin = await rawRequest(PORT, { method: 'OPTIONS', path: '/review', headers: { Host: hostOk } });
    assert.strictEqual(noOrigin.status, 403);
  });

  it('pins a single extension when DEVTAILOR_EXTENSION_ID is set', async () => {
    process.env.DEVTAILOR_EXTENSION_ID = 'pinnedid';
    try {
      const allowed = await get('/sessions', { Host: hostOk, Origin: 'chrome-extension://pinnedid' });
      assert.strictEqual(allowed.status, 200);
      const other = await get('/sessions', { Host: hostOk, Origin: 'chrome-extension://otherid' });
      assert.strictEqual(other.status, 403);
      const health = await get('/health', { Host: hostOk, Origin: 'chrome-extension://otherid' });
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.headers['access-control-allow-origin'], undefined);
      assert.strictEqual(health.json().projectName, undefined);
    } finally {
      delete process.env.DEVTAILOR_EXTENSION_ID;
    }
  });

  it('serves a minimal /health without Origin and without sensitive fields', async () => {
    const res = await get('/health', { Host: hostOk });
    assert.strictEqual(res.status, 200);
    const body = res.json();
    assert.deepStrictEqual(Object.keys(body).sort(), ['ok', 'protocolVersion']);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
    for (const secret of ['pid', 'projectName', 'projectId', 'activeSessionTitle', 'activeClientId']) {
      assert.ok(!(secret in body), secret);
    }
  });

  it('gives verified extensions routing info in /health but still no pid or session title', async () => {
    const res = await get('/health', { Host: hostOk, Origin: TEST_EXTENSION_ORIGIN });
    assert.strictEqual(res.status, 200);
    const body = res.json();
    assert.ok(body.projectId);
    assert.ok(!('pid' in body));
    assert.ok(!('activeSessionTitle' in body));
  });

  describe('extension client header (service-worker GETs carry no Origin)', () => {
    const H = 'X-DevTailor-Client';

    it('accepts an Origin-less request that carries the extension client header', async () => {
      const res = await get('/sessions', { Host: hostOk, [H]: 'abcdefghijklmnop' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
      const health = await get('/health', { Host: hostOk, [H]: 'abcdefghijklmnop' });
      assert.ok(health.json().projectId, 'verified client gets routing info');
      assert.ok(!('pid' in health.json()));
    });

    it('still refuses Origin-less requests with a missing or malformed header', async () => {
      for (const value of [undefined, '', 'evil id', '../x', 'a;b']) {
        const res = await get('/sessions', { Host: hostOk, [H]: value });
        assert.strictEqual(res.status, 403, String(value));
      }
    });

    it('does not let a page Origin ride on the header', async () => {
      const res = await get('/sessions', { Host: hostOk, Origin: 'http://evil.example', [H]: 'abcdefghijklmnop' });
      assert.strictEqual(res.status, 403);
      const preflight = await rawRequest(PORT, {
        method: 'OPTIONS',
        path: '/sessions',
        headers: {
          Host: hostOk,
          Origin: 'http://evil.example',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-devtailor-client',
        },
      });
      assert.strictEqual(preflight.status, 403);
      assert.strictEqual(preflight.headers['access-control-allow-origin'], undefined);
    });

    it('respects DEVTAILOR_EXTENSION_ID for the header form too', async () => {
      process.env.DEVTAILOR_EXTENSION_ID = 'pinnedid';
      try {
        assert.strictEqual((await get('/sessions', { Host: hostOk, [H]: 'pinnedid' })).status, 200);
        assert.strictEqual((await get('/sessions', { Host: hostOk, [H]: 'otherid' })).status, 403);
      } finally {
        delete process.env.DEVTAILOR_EXTENSION_ID;
      }
    });
  });

  it('only listens on the loopback interface', () => {
    const address = (server as any).server.address();
    assert.strictEqual(address.address, '127.0.0.1');
  });
});
