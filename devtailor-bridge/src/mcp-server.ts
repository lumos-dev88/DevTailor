/**
 * MCP server definition for the Claude Code channel: capabilities,
 * instructions, and the tool list (18 browser tools + `reply`).
 * Transport-agnostic; mcp-main.ts connects it to stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserToolRunner } from './agent-session';
import { ClaudeChannelHub, CHANNEL_NOTIFICATION_METHOD } from './claude-channel-session';
import { createBrowserMcpTools, McpToolResult } from './mcp-browser-tools';
import { log } from './log';

export const MCP_SERVER_NAME = 'devtailor';

export const CHANNEL_INSTRUCTIONS = [
  '浏览器里的 DevTailor 侧边栏消息以 <channel source="..."> 到达，meta 含 turn_id、page_url、client_id、kind（review 或 cancel）。',
  '用户在浏览器里看不到终端文字：回复必须调用 reply 工具。分段流式 reply(text)，结束时 reply(text, final:true)（或最后单独一次 final:true）。turn_id 默认是最近一轮，同时有多轮时请显式传入。',
  '页面操作用浏览器工具；先 get_page_snapshot 了解页面。工具返回 NO_ACTIVE_TAB 说明用户还没在扩展里“接管”页面，请让用户先接管。',
  '截图在 .devtailor/images/ 下（见消息正文/meta.image_paths），用 Read 查看。不要把 .devtailor/ 内容提交进仓库。',
  '用户选中元素的 selector 与 framework.filePath 可直接用来定位并修改源码。',
  '收到 kind=cancel 时停止当前操作，并且不再回复该 turn。',
].join('\n');

export const REPLY_TOOL = {
  name: 'reply',
  description:
    'Send a message to the DevTailor browser side panel (the user cannot see terminal output). Call it repeatedly to stream progress; pass final:true on the last call to finish the turn.',
  inputSchema: {
    type: 'object',
    properties: {
      turn_id: { type: 'string', description: 'turn_id from the <channel> tag. Defaults to the latest turn.' },
      text: { type: 'string', description: 'Markdown text to show in the side panel.' },
      final: { type: 'boolean', description: 'true on the last message of this turn.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
} as const;

export interface ChannelMcpServerOptions {
  hub: ClaudeChannelHub;
  runBrowserAction: BrowserToolRunner;
  projectDir: string;
  version?: string;
}

export function createChannelMcpServer(options: ChannelMcpServerOptions): Server {
  const { hub, runBrowserAction, projectDir } = options;
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version || '0.1.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  );

  const browserTools = createBrowserMcpTools({
    run: runBrowserAction,
    projectDir,
    onActivity: () => hub.noteActivity(),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...browserTools.list(), REPLY_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<McpToolResult> => {
    const { name } = req.params;
    const args = req.params.arguments ?? {};
    if (name === REPLY_TOOL.name) {
      const result = hub.handleReply(args);
      return { isError: !result.ok, content: [{ type: 'text', text: result.message }] };
    }
    return browserTools.call(name, args);
  });

  server.oninitialized = () => {
    const client = server.getClientVersion();
    const caps = server.getClientCapabilities();
    log(
      `[MCP] initialized client=${client?.name || '?'}@${client?.version || '?'} ` +
      `clientCapabilities=${JSON.stringify(caps || {})}`,
    );
    log(`[MCP] channel notifications are dropped silently unless Claude Code was started with --dangerously-load-development-channels server:<name> (method ${CHANNEL_NOTIFICATION_METHOD})`);
  };

  return server;
}

/** Writer used by the hub: pushes a channel notification over this server's transport. */
export function channelNotifier(server: Server) {
  return async (params: { content: string; meta: Record<string, string> }): Promise<void> => {
    await server.notification({ method: CHANNEL_NOTIFICATION_METHOD, params });
  };
}
