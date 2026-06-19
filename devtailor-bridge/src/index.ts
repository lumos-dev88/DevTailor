#!/usr/bin/env node
/**
 * DevTailor Bridge — CLI Entry
 *
 * Usage:
 *   npx devtailor [dir] [options]
 *   npx devtailor --agent claude --dir /path/to/project
 *   npx devtailor agents
 *   npx devtailor --daemon
 *   npx devtailor stop
 *   npx devtailor status
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync } from 'fs';
import { resolve, join } from 'path';
import { WSServer } from './ws-server';
import { listBuiltInAgents, resolveAgent, ResolvedAgent } from './agent-presets';

const VERSION = '0.1.0';
const DEFAULT_PORT = 34781;
const DEFAULT_AGENT = 'claude';
const PID_FILE = '/tmp/devtailor-bridge.pid';

function printHelp(): void {
  console.log(`
DevTailor Bridge v${VERSION}

Usage:
  devtailor [dir] [options]
  devtailor <command>

Arguments:
  dir                      project directory (default: current directory)

Options:
  -a, --agent <agent>      agent type or command (default: ${DEFAULT_AGENT})
  -d, --daemon             run in background
  -f, --follow             follow log output (used with logs)
  -h, --help               show this help message
  -v, --version            show version

Commands:
  agents                   list available built-in agents
  start                    start bridge (default)
  stop                     stop daemon process
  status                   check daemon status
  logs                     show daemon logs

Examples:
  devtailor                              # start in current directory
  devtailor /path/to/project             # start in specific directory
  devtailor --agent gemini               # use gemini agent
  devtailor --daemon                     # run in background
  devtailor logs                         # show recent logs
  devtailor logs -f                      # follow logs
  devtailor agents                       # list available agents
  devtailor stop                         # stop daemon

Environment Variables:
  DEVTAILOR_AGENT          default agent (can be overridden by --agent)

Note:
  Bridge runs on fixed port ${DEFAULT_PORT} (required by extension)
  `);
}

function printVersion(): void {
  console.log(VERSION);
}

function parseArgs(): { agent: string; dir: string; daemon: boolean; command: string; follow: boolean } {
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

  // Environment variable support
  let agent = process.env.DEVTAILOR_AGENT || DEFAULT_AGENT;
  let dir = process.cwd();
  let daemon = false;
  let follow = false;
  let command = 'start';

  // First non-flag argument is the directory, unless it is a known command.
  if (args[0] && !args[0].startsWith('-') && !['stop', 'status', 'agents', 'logs'].includes(args[0])) {
    dir = resolve(args[0]);
    args.shift();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '-a':
      case '--agent':
        if (!args[i + 1]) {
          console.error('Error: --agent requires a value');
          console.log('Run with --help for usage information');
          process.exit(1);
        }
        agent = args[++i];
        break;

      case '--dir':
      case '--cwd':
        if (!args[i + 1]) {
          console.error('Error: --dir requires a value');
          console.log('Run with --help for usage information');
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
      case 'agents':
      case 'logs':
        command = arg;
        break;

      default:
        console.error(`Error: unknown option '${arg}'`);
        console.log('Run with --help for usage information');
        process.exit(1);
    }
  }

  return { agent, dir, daemon, command, follow };
}

function checkAgent(agent: ResolvedAgent): void {
  // For npx-based presets, only verify that npx itself is available.
  // We intentionally skip the old npx --dry-run precheck: many valid npx packages
  // fail --dry-run and blocking on it prevents non-Claude agents from starting.
  // A real resolution failure will surface naturally when spawn() runs.
  if (agent.command === 'npx') {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';
    const check = spawnSync(cmd, ['npx'], { stdio: 'pipe' });
    if (check.status !== 0) {
      console.error(`Error: 'npx' not found in PATH. Required to run agent '${agent.label}'.`);
      process.exit(1);
    }
    return;
  }

  // For direct binaries, try to find them in PATH.
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const check = spawnSync(cmd, [agent.command], { stdio: 'pipe' });
  if (check.status !== 0) {
    console.error(`Error: '${agent.command}' not found in PATH for agent '${agent.label}'. Please install it first.`);
    process.exit(1);
  }
}
function startDaemon(agent: string, dir: string): void {
  const dataDir = join(dir, '.devtailor');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error(`[DevTailor] Failed to create data directory ${dataDir}:`, err);
    process.exit(1);
  }
  const logPath = join(dataDir, 'bridge.log');
  let logFd: number;
  try {
    logFd = openSync(logPath, 'a');
  } catch (err) {
    console.error(`[DevTailor] Failed to open log file ${logPath}:`, err);
    process.exit(1);
  }
  const child = spawn(process.execPath, [__filename, '--agent', agent, '--dir', dir], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  try {
    closeSync(logFd);
  } catch {
    // Ignore close errors; the child holds its own descriptor.
  }
  child.unref();
  console.log(`[DevTailor] Daemon started (PID: ${child.pid})`);
  console.log(`[DevTailor] Logs: ${logPath}`);
}

function tailBridgeLog(dir: string, follow: boolean): void {
  const logPath = join(dir, '.devtailor', 'bridge.log');
  if (!existsSync(logPath)) {
    console.log('[DevTailor] No log file found');
    return;
  }
  if (follow) {
    const tail = spawn('tail', ['-f', '-n', '100', logPath], { stdio: 'inherit' });
    tail.on('error', (err) => {
      console.error(`[DevTailor] Failed to follow log: ${err.message}`);
    });
    return;
  }
  const { readFileSync } = require('fs');
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  console.log(lines.slice(-100).join('\n'));
}

function stopDaemon(): void {
  try {
    const pid = parseInt(require('fs').readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    console.log('[DevTailor] Daemon stopped');
  } catch {
    console.error('[DevTailor] No running daemon found');
  }
}

function checkStatus(): void {
  try {
    const pid = parseInt(require('fs').readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    console.log(`[DevTailor] Daemon is running (PID: ${pid})`);
  } catch {
    console.log('[DevTailor] Daemon is not running');
  }
}

function printAgents(): void {
  console.log('Built-in DevTailor ACP agents:');
  for (const { id, preset } of listBuiltInAgents()) {
    const command = [preset.command, ...preset.args].join(' ');
    console.log(`  ${id.padEnd(10)} ${preset.label.padEnd(18)} ${command}`);
  }
  console.log('\nUse: npx devtailor --agent <id> --dir <project>');
  console.log('Raw commands still work: npx devtailor --agent "my-acp-agent --flag" --dir <project>');
}

async function stopExistingBridgeIfOnPort(port: number): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const info = (await res.json().catch(() => null)) as { projectId?: string; pid?: number } | null;
    if (!info || typeof info.projectId !== 'string') {
      console.error(`[DevTailor] Port ${port} is occupied by a non-DevTailor process. Please free the port and try again.`);
      process.exit(1);
    }
    const pid = typeof info.pid === 'number' ? info.pid : null;
    if (pid && pid !== process.pid) {
      console.log(`[DevTailor] Stopping existing bridge on port ${port} (PID: ${pid})`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore kill errors; bind will fail later if process is still there.
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch {
    // No responding process on the port; proceed and let bind fail if it is occupied.
  }
}

async function main(): Promise<void> {
  const { agent, dir, daemon, command, follow } = parseArgs();

  if (command === 'agents') {
    printAgents();
    return;
  }

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
    console.error(`Error: directory does not exist: ${dir}`);
    console.log('Run with --help for usage information');
    process.exit(1);
  }

  if (daemon) {
    startDaemon(agent, dir);
    return;
  }

  const resolvedAgent = resolveAgent(agent);
  checkAgent(resolvedAgent);

  await stopExistingBridgeIfOnPort(DEFAULT_PORT);

  const dataDir = join(dir, '.devtailor');

  console.log(`[DevTailor] Starting bridge...`);
  console.log(`  Agent: ${resolvedAgent.label}`);
  console.log(`  Cmd:   ${[resolvedAgent.command, ...resolvedAgent.args].join(' ')}`);
  console.log(`  Dir:   ${dir}`);
  console.log(`  Port:  ${DEFAULT_PORT}`);

  const server = new WSServer(
    DEFAULT_PORT,
    resolvedAgent.command,
    dir,
    resolvedAgent.args,
    dataDir,
    resolvedAgent.env,
    resolvedAgent.id,
    resolvedAgent.label,
  );
  await server.init();
  server.start();

  console.log(`[DevTailor] Session store: ${join(dataDir, 'sessions.db')}`);

  // Write PID file for status/stop commands
  try {
    require('fs').writeFileSync(PID_FILE, String(process.pid));
  } catch {
    // Ignore PID file errors
  }

  function shutdown(signal: string) {
    console.log(`\n[DevTailor] ${signal} received, shutting down...`);
    server.stop();
    try {
      require('fs').unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
