/**
 * Permission relay — Claude Code asks for tool-use permission, the browser side
 * panel decides, the verdict goes back over the channel.
 *
 * Two layers:
 *   1. createChannelMcpServer + a fake Claude Code client over InMemoryTransport
 *      (the protocol half: which notification is sent, and when none is).
 *   2. WSServer.requestChannelPermission against a real SSE client
 *      (the browser half: approval card in, POST /approval-decision out).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  PERMISSION_DECISION_METHOD,
  PERMISSION_REQUEST_METHOD,
  ChannelPermissionRequest,
  ChannelPermissionVerdict,
  createChannelMcpServer,
} from '../src/mcp-server';
import { ClaudeChannelHub } from '../src/claude-channel-session';
import { WSServer } from '../src/ws-server';
import { makeClient, sleep } from './helpers';

interface DecisionNotification {
  method: string;
  params: { request_id: string; behavior: 'allow' | 'deny' };
}

interface RelayRig {
  dir: string;
  client: Client;
  /** Requests the server relayed to the "UI". */
  asked: ChannelPermissionRequest[];
  decisions: DecisionNotification[];
  /** Resolves once `count` requests reached the callback. */
  waitForAsked(count: number): Promise<void>;
  /** Push one permission_request notification from the Claude Code side. */
  request(params: Partial<ChannelPermissionRequest> & { requestId: string }): Promise<void>;
  cleanup(): Promise<void>;
}

/** `answer` decides the verdict for each relayed request; the default is "no answer". */
async function makeRelayRig(
  answer: (req: ChannelPermissionRequest) => Promise<ChannelPermissionVerdict> | ChannelPermissionVerdict = () => null,
  opts: { withRelay?: boolean } = {},
): Promise<RelayRig> {
  const dir = await mkdtemp(join(tmpdir(), 'devtailor-perm-'));
  const hub = new ClaudeChannelHub({ projectDir: dir, notify: async () => {} });
  const asked: ChannelPermissionRequest[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const server = createChannelMcpServer({
    hub,
    projectDir: dir,
    runBrowserAction: async () => ({ requestId: 'x', ok: true, result: {} }),
    ...(opts.withRelay === false ? {} : {
      onPermissionRequest: async (req: ChannelPermissionRequest) => {
        asked.push(req);
        for (const waiter of [...waiters]) {
          if (asked.length >= waiter.count) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        return answer(req);
      },
    }),
  });
  const client = new Client({ name: 'fake-claude', version: '0.0.0' }, { capabilities: {} });
  const decisions: DecisionNotification[] = [];
  client.fallbackNotificationHandler = async n => {
    if (n.method === PERMISSION_DECISION_METHOD) decisions.push(n as unknown as DecisionNotification);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  return {
    dir,
    client,
    asked,
    decisions,
    waitForAsked(count) {
      if (asked.length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} relayed request(s)`)), 3000);
        waiters.push({
          count,
          resolve: () => { clearTimeout(timer); resolve(); },
        });
      });
    },
    async request(params) {
      await client.notification({
        method: PERMISSION_REQUEST_METHOD,
        params: {
          request_id: params.requestId,
          tool_name: params.toolName ?? 'Bash',
          description: params.description ?? '执行 shell 命令',
          input_preview: params.inputPreview ?? 'npm run build',
        },
      });
    },
    async cleanup() {
      hub.stop();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000, what = 'condition'): Promise<T> {
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

describe('permission relay: channel MCP server', () => {
  let rig: RelayRig | null = null;
  afterEach(async () => {
    await rig?.cleanup();
    rig = null;
  });

  it('advertises experimental "claude/channel/permission" next to "claude/channel" and tools', async () => {
    rig = await makeRelayRig();
    const caps: any = rig.client.getServerCapabilities();
    assert.deepStrictEqual(caps.experimental['claude/channel'], {});
    assert.deepStrictEqual(caps.experimental['claude/channel/permission'], {});
    assert.ok(caps.tools, 'tools capability is still declared');
  });

  it('relays allow / deny back with the same request_id', async () => {
    let verdict: ChannelPermissionVerdict = 'allow';
    rig = await makeRelayRig(() => verdict);

    await rig.request({
      requestId: 'abcde',
      toolName: 'Bash',
      description: '执行 shell 命令',
      inputPreview: 'npm run build',
    });
    await waitFor(() => (rig!.decisions.length >= 1 ? rig!.decisions : undefined), 2000, 'allow decision');
    assert.deepStrictEqual(rig.asked[0], {
      requestId: 'abcde',
      toolName: 'Bash',
      description: '执行 shell 命令',
      inputPreview: 'npm run build',
    });
    assert.deepStrictEqual(
      { method: rig.decisions[0].method, params: rig.decisions[0].params },
      { method: PERMISSION_DECISION_METHOD, params: { request_id: 'abcde', behavior: 'allow' } },
    );

    verdict = 'deny';
    await rig.request({ requestId: 'vwxyz' });
    await waitFor(() => (rig!.decisions.length >= 2 ? rig!.decisions : undefined), 2000, 'deny decision');
    assert.deepStrictEqual(rig.decisions[1].params, { request_id: 'vwxyz', behavior: 'deny' });
  });

  it('sends nothing when the callback returns null (no UI answered)', async () => {
    rig = await makeRelayRig(() => null);
    await rig.request({ requestId: 'abcde' });
    await rig.waitForAsked(1);
    await sleep(150);
    assert.deepStrictEqual(rig.decisions, [], 'a null verdict must not be relayed');
  });

  it('denies when the callback throws', async () => {
    rig = await makeRelayRig(() => { throw new Error('approval exploded'); });
    await rig.request({ requestId: 'qqqqq' });
    const decision = await waitFor(() => rig!.decisions[0], 2000, 'deny on error');
    assert.deepStrictEqual(decision.params, { request_id: 'qqqqq', behavior: 'deny' });
    await sleep(100);
    assert.strictEqual(rig.decisions.length, 1);
  });

  it('ignores a duplicate request_id while the first one is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rig = await makeRelayRig(async () => { await gate; return 'allow'; });

    await rig.request({ requestId: 'abcde' });
    await rig.waitForAsked(1);
    // Same id arrives again before the user answered: dropped, not re-asked.
    await rig.request({ requestId: 'abcde' });
    await sleep(100);
    assert.strictEqual(rig.asked.length, 1);

    release();
    await waitFor(() => (rig!.decisions.length >= 1 ? rig!.decisions : undefined), 2000, 'single decision');
    assert.deepStrictEqual(rig.decisions.map(d => d.params), [{ request_id: 'abcde', behavior: 'allow' }]);
    // Once it settled, the same id is a new request and is relayed again.
    await rig.request({ requestId: 'abcde' });
    await waitFor(() => (rig!.decisions.length >= 2 ? rig!.decisions : undefined), 2000, 'second decision');
  });

  it('keeps a missing id / missing display fields from crashing the relay', async () => {
    rig = await makeRelayRig(() => 'allow');
    // Only request_id is load-bearing; tool_name/description/input_preview default.
    await rig.client.notification({
      method: PERMISSION_REQUEST_METHOD,
      params: { request_id: 'abcde' },
    });
    const decision = await waitFor(() => rig!.decisions[0], 2000, 'decision for a bare request');
    assert.deepStrictEqual(decision.params, { request_id: 'abcde', behavior: 'allow' });
    assert.deepStrictEqual(rig.asked[0], {
      requestId: 'abcde', toolName: 'tool', description: '', inputPreview: '',
    });
  });

  it('stays silent when no onPermissionRequest callback is wired', async () => {
    rig = await makeRelayRig(() => 'allow', { withRelay: false });
    await rig.request({ requestId: 'abcde' });
    await sleep(150);
    assert.deepStrictEqual(rig.asked, []);
    assert.deepStrictEqual(rig.decisions, []);
  });
});

describe('permission relay: WSServer.requestChannelPermission', () => {
  // One port per test: an SSE stream destroyed by the previous test can leave a
  // keep-alive socket that makes the next `http.get` to the same port hang.
  // Each case uses its own port: an SSE stream destroyed by a previous case can
  // leave a lingering keep-alive socket that makes the next `http.get` reuse it.
  let server: WSServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  async function start(port: number): Promise<{ web: WSServer; http: ReturnType<typeof makeClient> }> {
    server = new WSServer(port, process.cwd());
    await server.start();
    return { web: server, http: makeClient(port) };
  }

  it('returns null when no browser client is connected (terminal dialog takes over)', async () => {
    const { web } = await start(17815);
    const result = await web.requestChannelPermission({
      requestId: 'abcde', toolName: 'Bash', description: '执行 shell 命令', inputPreview: 'ls',
    });
    assert.strictEqual(result, null);
  });

  it('shows an approval card to the SSE client and maps its click to a verdict', async () => {
    const { web, http } = await start(17816);
    const stream = await http.openSse('tab-perm');
    await stream.next(); // connected
    await http.activate('tab-perm');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(message => seen.push(message));

    const ask = (requestId: string) => web.requestChannelPermission({
      requestId, toolName: 'Bash', description: '执行 shell 命令', inputPreview: 'npm run build',
    });

    // approved -> 'allow'
    const first = ask('abcde');
    const card = await waitFor(() => seen.find(m => m.type === 'approval_request'), 3000, 'approval_request');
    assert.strictEqual(card.toolName, 'Bash');
    assert.strictEqual(card.action, '执行 shell 命令');
    assert.strictEqual(card.detail, 'npm run build');
    assert.strictEqual(card.risk, 'medium');
    assert.strictEqual(card.options, undefined, 'the relay never invents an option list');
    const approved = await http.postJson('/approval-decision', { approvalId: card.approvalId, decision: 'approved' });
    assert.strictEqual(approved.status, 200);
    assert.strictEqual(await first, 'allow');

    // rejected -> 'deny'
    const second = ask('vwxyz');
    const card2 = await waitFor(
      () => seen.find(m => m.type === 'approval_request' && m.approvalId !== card.approvalId),
      3000,
      'second approval_request',
    );
    const rejected = await http.postJson('/approval-decision', { approvalId: card2.approvalId, decision: 'rejected' });
    assert.strictEqual(rejected.status, 200);
    assert.strictEqual(await second, 'deny');

    // both resolutions were broadcast to the UI
    await waitFor(() => {
      const resolved = seen.filter(m => m.type === 'approval_resolved');
      return resolved.length >= 2 ? resolved : undefined;
    }, 3000, 'approval_resolved broadcasts');
    assert.deepStrictEqual(
      seen.filter(m => m.type === 'approval_resolved').map(m => m.decision),
      ['approved', 'rejected'],
    );
    stream.close();
  });

  it('routes the card to a connected UI even when no tab has been taken over', async () => {
    const { web, http } = await start(17818);
    const stream = await http.openSse('tab-idle');
    await stream.next(); // connected, but /activate is never called
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(message => seen.push(message));

    const pending = web.requestChannelPermission({
      requestId: 'abcde', toolName: 'Bash', description: '执行 shell 命令', inputPreview: 'ls',
    });
    const card = await waitFor(() => seen.find(m => m.type === 'approval_request'), 3000, 'approval_request');
    const res = await http.postJson('/approval-decision', { approvalId: card.approvalId, decision: 'approved' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await pending, 'allow');
    stream.close();
  });

  it('returns null (no verdict) when the bridge stops while the card is pending', async () => {
    const { web, http } = await start(17817);
    const stream = await http.openSse('tab-perm-stop');
    await stream.next();
    await http.activate('tab-perm-stop');
    const seen: Array<Record<string, any>> = [];
    stream.onMessage(message => seen.push(message));

    const pending = web.requestChannelPermission({
      requestId: 'abcde', toolName: 'Write', description: '写文件', inputPreview: '/p/a.txt',
    });
    await waitFor(() => seen.find(m => m.type === 'approval_request'), 3000, 'approval_request');
    web.stop();
    assert.strictEqual(await pending, null, 'a stopped bridge must not relay a deny');
    server = null;
    stream.close();
  });
});
