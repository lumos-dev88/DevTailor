/**
 * End-to-end: spawn the real `node dist/mcp-main.js` over stdio, talk to it
 * with the MCP SDK client, and drive the HTTP/SSE side like the extension.
 * Requires `npm run build` (the npm test script does it).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeClient, sleep } from './helpers';
import { TINY_PNG_DATA_URL, REVIEW_PAYLOAD } from './channel-helpers';

const MAIN = join(__dirname, '..', 'dist', 'mcp-main.js');

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 5000, what = 'condition'): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value !== undefined) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe('mcp-main over stdio', () => {
  const PORT = 17811;
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;
  const transportErrors: Error[] = [];
  const stderrChunks: string[] = [];
  const notifications: Array<{ method: string; params: any }> = [];
  const http = makeClient(PORT);

  before(async () => {
    assert.ok(existsSync(MAIN), 'dist/mcp-main.js missing, run `npm run build`');
    dir = await mkdtemp(join(tmpdir(), 'devtailor-stdio-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: { DEVTAILOR_PROJECT_DIR: dir, DEVTAILOR_PORT: String(PORT) },
      stderr: 'pipe',
    });
    transport.onerror = err => { transportErrors.push(err); };
    transport.stderr?.on('data', chunk => stderrChunks.push(String(chunk)));
    client = new Client({ name: 'fake-claude', version: '0.0.0' }, { capabilities: {} });
    client.fallbackNotificationHandler = async n => { notifications.push(n as any); };
    await client.connect(transport);
  });

  after(async () => {
    await client?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it('initializes with channel + tools capabilities and instructions', () => {
    const caps: any = client.getServerCapabilities();
    assert.deepStrictEqual(caps.experimental['claude/channel'], {});
    assert.ok(caps.tools);
    assert.strictEqual(caps.experimental['claude/channel/permission'], undefined);
    assert.match(client.getInstructions() || '', /reply/);
  });

  it('lists 18 browser tools plus reply', async () => {
    const { tools } = await client.listTools();
    assert.strictEqual(tools.length, 19);
    assert.ok(tools.some(t => t.name === 'reply'));
    assert.ok(tools.some(t => t.name === 'run_js'));
  });

  it('keeps stdout protocol-only (no stray output, logs on stderr)', () => {
    assert.deepStrictEqual(transportErrors.map(e => e.message), []);
    const stderr = stderrChunks.join('');
    assert.match(stderr, /MCP channel ready/);
    assert.match(stderr, new RegExp(`127.0.0.1:${PORT}`));
  });

  it('serves the HTTP guard unchanged (no Origin -> 403)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/sessions`);
    assert.strictEqual(res.status, 403);
  });

  it('delivers /review as a channel notification and streams reply back over SSE', async () => {
    const stream = await http.openSse('tab-e2e');
    assert.strictEqual((await stream.next()).type, 'connected');
    await http.activate('tab-e2e');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(m => seen.push(m));

    const posted = await http.postJson('/review', {
      type: 'review', clientId: 'tab-e2e', tabId: 'tab-e2e',
      payload: { ...REVIEW_PAYLOAD, screenshots: [TINY_PNG_DATA_URL] },
    });
    assert.strictEqual(posted.status, 202);

    const note = await waitFor(() => notifications.find(n => n.params?.meta?.kind === 'review'), 5000, 'review notification');
    assert.strictEqual(note.method, 'notifications/claude/channel');
    assert.strictEqual(note.params.meta.client_id, 'tab-e2e');
    assert.strictEqual(note.params.meta.page_url, REVIEW_PAYLOAD.pageUrl);
    assert.ok(note.params.content.includes('button.primary'));
    assert.strictEqual(note.params.meta.image_count, '1');
    assert.strictEqual((await readdir(join(dir, '.devtailor', 'images'))).length, 1);

    // Turn stays open: no `done` before Claude says final.
    await sleep(100);
    assert.ok(!seen.some(m => m.type === 'done'));

    const turnId = note.params.meta.turn_id;
    const r1: any = await client.callTool({ name: 'reply', arguments: { turn_id: turnId, text: '先看一下' } });
    assert.notStrictEqual(r1.isError, true);
    const r2: any = await client.callTool({ name: 'reply', arguments: { turn_id: turnId, text: '改好了', final: true } });
    assert.notStrictEqual(r2.isError, true);

    const done = await waitFor(() => seen.find(m => m.type === 'done'), 5000, 'done event');
    assert.strictEqual(done.reason, 'end_turn');
    const deltas = seen.filter(m => m.type === 'stream').map(m => m.delta);
    assert.deepStrictEqual(deltas, ['先看一下', '\n\n改好了']);
    await sleep(100);
    assert.strictEqual(seen.filter(m => m.type === 'done').length, 1);
    stream.close();
  });

  it('forwards browser tool calls to the active tab and returns the result', async () => {
    const stream = await http.openSse('tab-tools');
    await stream.next();
    await http.activate('tab-tools');
    stream.onMessage(async m => {
      if (m.type === 'browser_action') {
        await http.postJson('/browser-action-result', { requestId: m.requestId, ok: true, result: { title: 'Hello' } });
      }
    });
    const res: any = await client.callTool({ name: 'get_page_snapshot', arguments: {} });
    assert.notStrictEqual(res.isError, true);
    assert.deepStrictEqual(JSON.parse(res.content[0].text), { ok: true, result: { title: 'Hello' } });
    stream.close();
  });

  it('/cancel ends the displayed turn and pushes a kind=cancel notification', async () => {
    const stream = await http.openSse('tab-cancel');
    await stream.next();
    await http.activate('tab-cancel');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(m => seen.push(m));
    const before = notifications.length;
    await http.postJson('/review', {
      type: 'review', clientId: 'tab-cancel', tabId: 'tab-cancel',
      payload: { ...REVIEW_PAYLOAD, screenshot: null },
    });
    const review = await waitFor(() => notifications.slice(before).find(n => n.params?.meta?.client_id === 'tab-cancel'), 5000, 'review');

    const res = await http.postJson('/cancel', { clientId: 'tab-cancel' });
    assert.strictEqual(res.body.canceled, true);
    const cancel = await waitFor(() => notifications.slice(before).find(n => n.params?.meta?.kind === 'cancel'), 5000, 'cancel notification');
    assert.strictEqual(cancel.params.meta.turn_id, review.params.meta.turn_id);
    const done = await waitFor(() => seen.find(m => m.type === 'done'), 5000, 'done');
    assert.strictEqual(done.reason, 'cancelled');

    const late: any = await client.callTool({ name: 'reply', arguments: { turn_id: review.params.meta.turn_id, text: 'late', final: true } });
    assert.strictEqual(late.isError, true);
    await sleep(100);
    assert.strictEqual(seen.filter(m => m.type === 'done').length, 1);
    stream.close();
  });
});

describe('mcp-main shutdown', () => {
  it('exits cleanly when stdin closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devtailor-stdin-'));
    const child = spawn(process.execPath, [MAIN], {
      env: { ...process.env, DEVTAILOR_PROJECT_DIR: dir, DEVTAILOR_PORT: '17812' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    try {
      await waitFor(() => (stderr.includes('MCP channel ready') ? true : undefined), 8000, 'ready');
      const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
      child.stdin.end();
      const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
      assert.strictEqual(code, 0);
      assert.strictEqual(stdout, ''); // nothing was written to stdout without a client
      assert.match(stderr, /shutting down \(stdin closed\)/);
      // HTTP server is gone with the process
      await assert.rejects(() => fetch('http://127.0.0.1:17812/health'));
    } finally {
      child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });
});
