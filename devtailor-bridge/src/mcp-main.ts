#!/usr/bin/env node
/**
 * DevTailor Bridge — Claude Code MCP/channel entry.
 *
 * Claude Code spawns this process over stdio. stdout belongs to the MCP
 * protocol: nothing else may write to it (all logging goes through log() ->
 * stderr). The HTTP/SSE server for the browser extension runs in-process.
 *
 * Project directory: DEVTAILOR_PROJECT_DIR, then CLAUDE_PROJECT_DIR (set by
 * Claude Code for stdio servers), then process.cwd().
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WSServer } from './ws-server';
import { ClaudeChannelHub, ClaudeChannelSession } from './claude-channel-session';
import { channelNotifier, createChannelMcpServer } from './mcp-server';
import { log, logError } from './log';

const DEFAULT_PORT = 34781;
// The extension needs 34781. DEVTAILOR_PORT exists only for tests/debugging next to a live bridge.
const PORT = Number(process.env.DEVTAILOR_PORT) > 0 ? Number(process.env.DEVTAILOR_PORT) : DEFAULT_PORT;
const VERSION = '0.1.0';

function resolveProjectDir(): { dir: string; source: string } {
  const explicit = process.env.DEVTAILOR_PROJECT_DIR;
  if (explicit) return { dir: resolve(explicit), source: 'DEVTAILOR_PROJECT_DIR' };
  const claudeDir = process.env.CLAUDE_PROJECT_DIR;
  if (claudeDir) return { dir: resolve(claudeDir), source: 'CLAUDE_PROJECT_DIR' };
  return { dir: process.cwd(), source: 'cwd' };
}

async function main(): Promise<void> {
  const { dir, source } = resolveProjectDir();
  if (!existsSync(dir)) {
    logError(`[DevTailor] project directory does not exist: ${dir} (from ${source})`);
    process.exit(1);
  }
  const dataDir = join(dir, '.devtailor');
  log(`[DevTailor] MCP channel starting dir=${dir} (from ${source}) port=127.0.0.1:${PORT}`);

  // The hub's writer is bound once the MCP server exists.
  let writer: ReturnType<typeof channelNotifier> | null = null;
  const hub = new ClaudeChannelHub({
    projectDir: dir,
    notify: async params => {
      if (!writer) throw new Error('MCP server is not connected');
      await writer(params);
    },
  });

  const web = new WSServer(PORT, dir, dataDir, 'claude', 'Claude Code', () => new ClaudeChannelSession(hub));
  await web.init();
  try {
    await web.start();
  } catch (err: any) {
    web.stop();
    if (err?.code === 'EADDRINUSE') {
      logError(`[DevTailor] Port ${PORT} is in use: 另一个 DevTailor 桥接正在运行，请关闭对应的 Claude Code 会话或进程后重试。`);
    } else {
      logError(`[DevTailor] Failed to start bridge HTTP server: ${err?.message || err}`);
    }
    process.exit(1);
  }

  const server = createChannelMcpServer({
    hub,
    runBrowserAction: (action, params) => web.runBrowserAction(action, params),
    projectDir: dir,
    version: VERSION,
  });
  writer = channelNotifier(server);

  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[DevTailor] shutting down (${reason})`);
    hub.stop();
    web.stop();
    server.close().catch(() => {}).finally(() => process.exit(0));
    // Safety net if close() never settles.
    setTimeout(() => process.exit(0), 1500).unref();
  };

  server.onclose = () => {
    hub.setReady(false);
    shutdown('mcp transport closed');
  };
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', reason => {
    logError('[DevTailor] unhandledRejection:', reason);
  });

  await server.connect(new StdioServerTransport());
  hub.setReady(true);
  log('[DevTailor] MCP channel ready');
}

main().catch(err => {
  logError('[DevTailor] fatal:', err);
  process.exit(1);
});
