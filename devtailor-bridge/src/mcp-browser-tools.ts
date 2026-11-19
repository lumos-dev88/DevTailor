/**
 * Browser tools exposed as MCP tools.
 *
 * Definitions come from createBrowserToolDefinitions() (parameters ->
 * inputSchema). Calls go through the BrowserToolRunner (BrowserActionRouter.run);
 * the three element-target tools are handled locally by the router's local
 * handler, so they need no special casing here.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserToolRunner } from './agent-session';
import { BrowserActionResult } from './browser-action-types';
import { createBrowserToolDefinitions, isBrowserToolName } from './browser-tool-definitions';
import { saveImage } from './image-store';
import { log } from './log';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  [key: string]: unknown;
  content: McpContentBlock[];
  isError?: boolean;
}

export const NO_ACTIVE_TAB_HINT = '请先在浏览器扩展里点击“接管”当前页面';

const MAX_IMAGES_PER_RESULT = 8;

export function listBrowserMcpTools(): McpToolDescriptor[] {
  return createBrowserToolDefinitions().map(def => ({
    name: def.name,
    description: def.description,
    inputSchema: def.parameters,
  }));
}

export interface BrowserMcpToolsOptions {
  run: BrowserToolRunner;
  projectDir: string;
}

export function createBrowserMcpTools(options: BrowserMcpToolsOptions) {
  const { run, projectDir } = options;

  async function call(name: string, args: unknown): Promise<McpToolResult> {
    if (!isBrowserToolName(name)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown browser tool: ${name}` }] };
    }
    const params = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    let result: BrowserActionResult;
    try {
      result = await run(name, params);
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'ACTION_FAILED', message: err?.message || String(err) } }) }],
      };
    }
    return toMcpResult(name, result);
  }

  async function toMcpResult(name: string, result: BrowserActionResult): Promise<McpToolResult> {
    if (!result.ok) {
      const error = result.error
        ? { ...result.error, ...(result.error.code === 'NO_ACTIVE_TAB' ? { hint: NO_ACTIVE_TAB_HINT } : {}) }
        : { code: 'ACTION_FAILED', message: 'Browser action failed' };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error }) }] };
    }
    const images: Array<{ mimeType: string; data: string }> = [];
    const stripped = await extractImages(result.result, name, projectDir, images);
    const content: McpContentBlock[] = [
      { type: 'text', text: JSON.stringify({ ok: true, result: stripped }) },
    ];
    for (const image of images) content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    return { content };
  }

  return { list: listBrowserMcpTools, call };
}

/**
 * Replaces every `data:image/...;base64,...` string in a tool result with a
 * short note, returns the images as raw base64 for MCP image content, and
 * saves a copy under .devtailor/images (fallback if image content is not
 * rendered by the client).
 */
async function extractImages(
  value: unknown,
  toolName: string,
  projectDir: string,
  images: Array<{ mimeType: string; data: string }>,
): Promise<unknown> {
  let counter = 0;
  const stamp = Date.now();

  async function walk(node: unknown, depth: number): Promise<unknown> {
    if (typeof node === 'string') {
      if (!node.startsWith('data:image/')) return node;
      counter += 1;
      if (images.length >= MAX_IMAGES_PER_RESULT) return '[image omitted: too many images in one result]';
      const saved = await saveImage(projectDir, `shot-${stamp}-${counter}`, node);
      if (!saved.ok) {
        log(`[McpTools] image not returned tool=${toolName} reason=${saved.reason}`);
        return `[image omitted: ${saved.reason}]`;
      }
      images.push({ mimeType: saved.mimeType, data: saved.base64 });
      return `[image ${images.length} returned as image content; copy saved at ${saved.path}]`;
    }
    if (depth > 8 || node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) out.push(await walk(item, depth + 1));
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      out[key] = await walk(item, depth + 1);
    }
    return out;
  }

  return walk(value, 0);
}

export const MCP_SERVER_NAME = 'devtailor';

export interface BrowserToolsServerOptions {
  run: BrowserToolRunner;
  projectDir: string;
  version?: string;
  instructions: string;
  /** Extra server capabilities besides `tools` (e.g. the channel's `experimental`). */
  capabilities?: Record<string, unknown>;
  /** Additional tools (the channel's `reply`) listed after the browser tools. */
  extraTools?: Array<Record<string, unknown>>;
  /** Handles calls for `extraTools`; return undefined to fall through to browser tools. */
  handleExtraCall?: (name: string, args: unknown) => McpToolResult | undefined;
}

/**
 * Builds the MCP server that exposes the browser tools. Shared by the stdio
 * channel entry (plus `reply`); Claude Code connects to it over the channel's
 * stdio MCP transport.
 */
export function createBrowserToolsServer(options: BrowserToolsServerOptions): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version || '0.1.0' },
    { capabilities: { ...(options.capabilities ?? {}), tools: {} }, instructions: options.instructions },
  );
  const browserTools = createBrowserMcpTools({
    run: options.run,
    projectDir: options.projectDir,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...browserTools.list(), ...(options.extraTools ?? [])] as any,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<McpToolResult> => {
    const { name } = req.params;
    const args = req.params.arguments ?? {};
    const extra = options.handleExtraCall?.(name, args);
    if (extra) return extra;
    return browserTools.call(name, args);
  });
  return server;
}
