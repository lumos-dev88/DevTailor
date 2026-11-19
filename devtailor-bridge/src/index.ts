#!/usr/bin/env node
/**
 * DevTailor Bridge — CLI Entry
 *
 * Usage:
 *   npx devtailor [dir] [options]
 *   npx devtailor --daemon
 *   npx devtailor stop
 *   npx devtailor status
 */

import { spawn, execFile } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { resolve, join } from 'path';
import { connect } from 'net';
import { WSServer } from './ws-server';
import { log, logError } from './log';

const VERSION = '0.1.0';
const DEFAULT_PORT = 34781;
const PID_FILE = '/tmp/devtailor-bridge.pid';

function printHelp(): void {
  log(`
DevTailor Bridge v${VERSION}

Usage:
  devtailor [dir] [options]
  devtailor <command>

Arguments:
  dir                      project directory (default: current directory)

Options:
  -d, --daemon             run in background
  -f, --follow             follow log output (used with logs)
  -h, --help               show this help message
  -v, --version            show version

Commands:
  start                    start bridge (default)
  stop                     stop daemon process
  status                   check daemon status
  logs                     show daemon logs

Examples:
  devtailor                              # start in current directory
  devtailor /path/to/project             # start in specific directory
  devtailor --daemon                     # run in background
  devtailor logs                         # show recent logs
  devtailor logs -f                      # follow logs
  devtailor stop                         # stop daemon

Note:
  The AI is Claude Code; the bridge only relays between the extension and Claude.
  真实使用请在项目目录运行 scripts/claude-devtailor.sh，由 Claude Code 拉起 Bridge
  (running this CLI standalone only serves the placeholder debug session).
  Bridge listens on 127.0.0.1:${DEFAULT_PORT} (fixed, required by extension).
  Set DEVTAILOR_EXTENSION_ID to accept requests from a single extension id only.
  `);
}

function printVersion(): void {
  log(VERSION);
}

function parseArgs(): { dir: string; daemon: boolean; command: string; follow: boolean } {
  const args = process.argv.slice(2);

  // Handle help and version first
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('-v') || args.includes('--version')) {
    printVersion();
    process.exit(0);
  }

  let dir = process.cwd();
  let daemon = false;
  let follow = false;
  let command = 'start';

  // First non-flag argument is the directory, unless it is a known command.
  if (args[0] && !args[0].startsWith('-') && !['stop', 'status', 'logs'].includes(args[0])) {
    dir = resolve(args[0]);
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--dir':
      case '--cwd':
        if (!args[i + 1]) {
          logError('Error: --dir requires a value');
          log('Run with --help for usage information');
          process.exit(1);
        }
        dir = resolve(args[++i]);
        break;

      case '-d':
      case '--daemon':
        daemon = true;
        break;

      case '-f':
      case '--follow':
        follow = true;
        break;

      case 'stop':
      case 'status':
      case 'logs':
        command = arg;
        break;

      default:
        logError(`Error: unknown option '${arg}'`);
        log('Run with --help for usage information');
        process.exit(1);
    }
  }

  return { dir, daemon, command, follow };
}
function startDaemon(dir: string): void {
  const dataDir = join(dir, '.devtailor');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    logError(`[DevTailor] Failed to create data directory ${dataDir}:`, err);
    process.exit(1);
  }
  const logPath = join(dataDir, 'bridge.log');
  let logFd: number;
  try {
    logFd = openSync(logPath, 'a');
  } catch (err) {
    logError(`[DevTailor] Failed to open log file ${logPath}:`, err);
    process.exit(1);
  }
  const child = spawn(process.execPath, [__filename, '--dir', dir], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  try {
    closeSync(logFd);
  } catch {
    // Ignore close errors; the child holds its own descriptor.
  }
  child.unref();
  log(`[DevTailor] Daemon started (PID: ${child.pid})`);
  log(`[DevTailor] Logs: ${logPath}`);
}

function tailBridgeLog(dir: string, follow: boolean): void {
  const logPath = join(dir, '.devtailor', 'bridge.log');
  if (!existsSync(logPath)) {
    log('[DevTailor] No log file found');
    return;
  }
  if (follow) {
    const tail = spawn('tail', ['-f', '-n', '100', logPath], { stdio: 'inherit' });
    tail.on('error', (err) => {
      logError(`[DevTailor] Failed to follow log: ${err.message}`);
    });
    return;
  }
  const { readFileSync } = require('fs');
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  log(lines.slice(-100).join('\n'));
}

function stopDaemon(): void {
  try {
    const pid = parseInt(require('fs').readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    log('[DevTailor] Daemon stopped');
  } catch {
    logError('[DevTailor] No running daemon found');
  }
}

function checkStatus(): void {
  try {
    const pid = parseInt(require('fs').readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    log(`[DevTailor] Daemon is running (PID: ${pid})`);
  } catch {
    log('[DevTailor] Daemon is not running');
  }
}

function findPortOwnerPid(port: number): Promise<number | null> {
  return new Promise(resolve => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const pid = parseInt(String(stdout).split('\n')[0].trim(), 10);
      resolve(Number.isFinite(pid) ? pid : null);
    });
  });
}

function isPortAccepting(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

/** Never kill another process: report who holds the port and exit non-zero. */
async function exitBecausePortInUse(port: number): Promise<never> {
  const pid = await findPortOwnerPid(port);
  let isBridge = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const info = (await res.json().catch(() => null)) as { ok?: boolean; protocolVersion?: number } | null;
    isBridge = Boolean(info && info.ok === true && typeof info.protocolVersion === 'number');
  } catch {
    // Not answering as a bridge.
  }
  const owner = pid ? ` (PID: ${pid})` : '';
  if (isBridge) {
    logError(`[DevTailor] Port ${port} is in use${owner}: 另一个 DevTailor 桥接正在运行，请关闭对应的 Claude Code 会话或进程后重试。`);
  } else {
    logError(`[DevTailor] Port ${port} is in use${owner} by another process. Free the port and try again.`);
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const { dir, daemon, command, follow } = parseArgs();

  if (command === 'stop') {
    stopDaemon();
    return;
  }

  if (command === 'status') {
    checkStatus();
    return;
  }

  if (command === 'logs') {
    tailBridgeLog(dir, follow);
    return;
  }

  if (!existsSync(dir)) {
    logError(`Error: directory does not exist: ${dir}`);
    log('Run with --help for usage information');
    process.exit(1);
  }

  if (daemon) {
    startDaemon(dir);
    return;
  }

  // Check before touching the session store so a second instance never rewrites its database.
  if (await isPortAccepting(DEFAULT_PORT)) await exitBecausePortInUse(DEFAULT_PORT);

  const dataDir = join(dir, '.devtailor');

  log(`[DevTailor] Starting bridge...`);
  log(`  Dir:   ${dir}`);
  log(`  Port:  127.0.0.1:${DEFAULT_PORT}`);

  log('[DevTailor] 真实使用请在项目目录运行 scripts/claude-devtailor.sh，由 Claude Code 拉起 Bridge；');
  log('[DevTailor] 本进程独立运行时只提供 placeholder 调试会话。');

  const server = new WSServer(DEFAULT_PORT, dir, dataDir);
  await server.init();
  try {
    await server.start();
  } catch (err: any) {
    server.stop();
    if (err?.code === 'EADDRINUSE') await exitBecausePortInUse(DEFAULT_PORT);
    logError(`[DevTailor] Failed to start bridge: ${err?.message || err}`);
    process.exit(1);
  }

  log(`[DevTailor] Session store: ${join(dataDir, 'sessions.db')}`);

  // PID file is only for `devtailor status|stop`; written after the port is ours.
  try {
    require('fs').writeFileSync(PID_FILE, String(process.pid));
  } catch {
    // Ignore PID file errors
  }

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n[DevTailor] ${signal} received, shutting down...`);
    try {
      const fs = require('fs');
      if (parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
    server.shutdown().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', reason => {
    logError('[DevTailor] unhandledRejection:', reason instanceof Error ? reason.message : reason);
  });
}

main();
