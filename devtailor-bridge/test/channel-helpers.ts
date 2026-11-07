/**
 * Test helpers for the Claude channel: a fake MCP client wired to the real
 * channel MCP server through an in-memory transport.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentCallbacks, BrowserToolRunner } from '../src/agent-session';
import { ClaudeChannelHub, ClaudeChannelHubOptions, ClaudeChannelSession } from '../src/claude-channel-session';
import { channelNotifier, createChannelMcpServer } from '../src/mcp-server';

export const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface ChannelNotification {
  method: string;
  params: { content: string; meta: Record<string, string> };
}

export interface Rig {
  dir: string;
  hub: ClaudeChannelHub;
  client: Client;
  notifications: ChannelNotification[];
  newSession(): ClaudeChannelSession;
  callReply(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  cleanup(): Promise<void>;
}

export async function makeRig(opts: {
  hub?: Partial<ClaudeChannelHubOptions>;
  runBrowserAction?: BrowserToolRunner;
} = {}): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'devtailor-channel-'));
  let writer: ReturnType<typeof channelNotifier> | null = null;
  const hub = new ClaudeChannelHub({
    projectDir: dir,
    notify: async params => {
      if (!writer) throw new Error('not connected');
      await writer(params);
    },
    ...opts.hub,
  });
  const server = createChannelMcpServer({
    hub,
    projectDir: dir,
    runBrowserAction: opts.runBrowserAction || (async () => ({ requestId: 'x', ok: true, result: {} })),
  });
  writer = channelNotifier(server);
  const client = new Client({ name: 'fake-claude', version: '0.0.0' }, { capabilities: {} });
  const notifications: ChannelNotification[] = [];
  client.fallbackNotificationHandler = async n => {
    notifications.push(n as unknown as ChannelNotification);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  hub.setReady(true);

  return {
    dir,
    hub,
    client,
    notifications,
    newSession: () => new ClaudeChannelSession(hub),
    async callReply(args) {
      const res: any = await client.callTool({ name: 'reply', arguments: args });
      return { isError: res.isError === true, text: res.content?.[0]?.text ?? '' };
    },
    async cleanup() {
      hub.stop();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function recorder(): AgentCallbacks & { events: Array<[string, unknown?]>; streamed: string } {
  const events: Array<[string, unknown?]> = [];
  const rec = {
    events,
    streamed: '',
    onStream(delta: string) { events.push(['stream', delta]); rec.streamed += delta; },
    onNotice(text: string) { events.push(['notice', text]); },
    onThinking(delta: string) { events.push(['thinking', delta]); },
    onDone(summary?: string) { events.push(['done', summary]); },
    onError(message: string) { events.push(['error', message]); },
  };
  return rec;
}

export const REVIEW_PAYLOAD = {
  pageUrl: 'http://localhost:3000/dashboard',
  userIntent: '把按钮改成红色',
  items: [{
    index: 1,
    selector: 'button.primary',
    xpath: '//button',
    outerHTML: '<button class="primary">Save</button>',
    computedStyle: { color: 'rgb(0, 0, 0)' },
    annotation: '改成红色',
    text: 'Save',
    boundingBox: { x: 1, y: 2, w: 30, h: 10 },
    framework: { framework: 'react', componentName: 'SaveButton', filePath: 'src/SaveButton.tsx' },
  }],
  screenshot: null,
};

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
