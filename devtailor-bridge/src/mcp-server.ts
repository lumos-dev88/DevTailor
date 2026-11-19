/**
 * MCP server definition for the Claude Code channel: capabilities,
 * instructions, and the tool list (19 browser tools + `reply`).
 * Transport-agnostic; mcp-main.ts connects it to stdio.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import { BrowserToolRunner } from './agent-session';
import { ClaudeChannelHub, CHANNEL_NOTIFICATION_METHOD } from './claude-channel-session';
import { createBrowserToolsServer, MCP_SERVER_NAME } from './mcp-browser-tools';
import { log } from './log';

export { MCP_SERVER_NAME };

/** Claude Code -> channel server: a tool call needs the user's permission. */
export const PERMISSION_REQUEST_METHOD = 'notifications/claude/channel/permission_request';
/** Channel server -> Claude Code: the user's verdict for one permission request. */
export const PERMISSION_DECISION_METHOD = 'notifications/claude/channel/permission';

/** `notifications/claude/channel/permission_request` params (request_id: 5 lowercase letters, no `l`). */
export const PermissionRequestNotificationSchema = z.object({
  method: z.literal(PERMISSION_REQUEST_METHOD),
  params: z.object({
    request_id: z.string(),
    // Tolerate missing display fields: only the id is needed to answer.
    tool_name: z.string().default('tool'),
    description: z.string().default(''),
    input_preview: z.string().default(''),
  }),
});

export interface ChannelPermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

/**
 * `'allow'` / `'deny'` relay a verdict to Claude Code; `null` relays nothing so
 * the terminal's own permission dialog stays in charge.
 */
export type ChannelPermissionVerdict = 'allow' | 'deny' | null;

/** Writes one permission verdict over the server's transport. */
export async function sendPermissionDecision(
  server: Server,
  requestId: string,
  behavior: 'allow' | 'deny',
): Promise<void> {
  await server.notification({
    method: PERMISSION_DECISION_METHOD,
    params: { request_id: requestId, behavior },
  });
}

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
  /**
   * Relays a Claude Code permission request to a browser UI. Resolves with the
   * user's verdict, or `null` when no UI could answer (nothing is relayed then,
   * so the terminal's dialog keeps control). Throw to deny.
   */
  onPermissionRequest?: (req: ChannelPermissionRequest) => Promise<ChannelPermissionVerdict>;
}

export function createChannelMcpServer(options: ChannelMcpServerOptions): Server {
  const { hub, runBrowserAction, projectDir } = options;
  const server = createBrowserToolsServer({
    run: runBrowserAction,
    projectDir,
    version: options.version,
    instructions: CHANNEL_INSTRUCTIONS,
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    extraTools: [REPLY_TOOL],
    handleExtraCall: (name, args) => {
      if (name !== REPLY_TOOL.name) return undefined;
      const result = hub.handleReply(args as Parameters<typeof hub.handleReply>[0]);
      return { isError: !result.ok, content: [{ type: 'text', text: result.message }] };
    },
  });

  /** request_ids currently being relayed: duplicates are dropped, not re-asked. */
  const inFlight = new Set<string>();

  server.setNotificationHandler(PermissionRequestNotificationSchema, async notification => {
    const { request_id: requestId, tool_name: toolName, description, input_preview: inputPreview } = notification.params;
    const relay = options.onPermissionRequest;
    if (!relay) return;
    if (!requestId) {
      log('[MCP] permission_request without request_id; ignored');
      return;
    }
    if (inFlight.has(requestId)) {
      log(`[MCP] permission_request ${requestId} already in flight; ignored`);
      return;
    }
    inFlight.add(requestId);
    try {
      const verdict = await relay({ requestId, toolName, description, inputPreview });
      // null = nobody answered (no browser UI / approval timed out or was
      // cancelled): say nothing and let the terminal's permission dialog decide.
      if (verdict === 'allow' || verdict === 'deny') {
        await sendPermissionDecision(server, requestId, verdict);
        log(`[MCP] permission ${requestId} tool=${toolName} -> ${verdict}`);
      } else {
        log(`[MCP] permission ${requestId} tool=${toolName} -> no verdict relayed`);
      }
    } catch (err: any) {
      log(`[MCP] permission ${requestId} relay failed (${err?.message || err}); denying`);
      try {
        await sendPermissionDecision(server, requestId, 'deny');
      } catch (sendErr: any) {
        log(`[MCP] permission ${requestId} deny could not be sent: ${sendErr?.message || sendErr}`);
      }
    } finally {
      inFlight.delete(requestId);
    }
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
