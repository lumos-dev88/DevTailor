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
import { existsSync } from 'fs';
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
  -h, --help               show this help message
  -v, --version            show version

Commands:
  agents                   list available built-in agents
  start                    start bridge (default)
  stop                     stop daemon process
  status                   check daemon status

Examples:
  devtailor                              # start in current directory
  devtailor /path/to/project             # start in specific directory
  devtailor --agent gemini               # use gemini agent
  devtailor --daemon                     # run in background
  devtailor agents                       # list available agents
  devtailor stop                         # stop daemon

Environment Variables:
  DEVTAILOR_AGENT          default agent (overrides --agent)

Note:
  Bridge runs on fixed port ${DEFAULT_PORT} (required by extension)
  `);
}

function printVersion(): void {
  console.log(VERSION);
}

function parseArgs(): { agent: string; dir: string; daemon: boolean; command: string } {
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
  let command = 'start';

  // First non-flag argument is the directory
  if (args[0] && !args[0].startsWith('-') && !['stop', 'status', 'agents'].includes(args[0])) {
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

      case 'stop':
      case 'status':
      case 'agents':
        command = arg;
        break;

      default:
        console.error(`Error: unknown option '${arg}'`);
        console.log('Run with --help for usage information');
        process.exit(1);
    }
  }

  return { agent, dir, daemon, command };
}

function checkAgent(agent: ResolvedAgent): void {
  // Simple check: try to find the binary in PATH
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'where' : 'which';
  const check = spawnSync(cmd, [agent.command], { stdio: 'pipe' });
  if (check.status !== 0) {
    console.error(`Error: '${agent.command}' not found in PATH for agent '${agent.label}'. Please install it first.`);
    process.exit(1);
  }
}

function startDaemon(agent: string, dir: string): void {
  const child = spawn(process.execPath, [__filename, '--agent', agent, '--dir', dir], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[DevTailor] Daemon started (PID: ${child.pid})`);
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

function killProcessOnPort(port: number): void {
  try {
    const { execSync } = require('child_process');
    const stdout = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (!stdout) return;
    const pids = stdout.split('\n').filter(Boolean);
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (pid === process.pid) continue;
      console.log(`[DevTailor] Killing old process on port ${port} (PID: ${pid})`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore kill errors
      }
    }
    // Give processes a moment to die
    execSync(`sleep 0.5`, { stdio: 'ignore' });
  } catch {
    // No process on port, or lsof not available
  }
}

async function main(): Promise<void> {
  const { agent, dir, daemon, command } = parseArgs();

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

  killProcessOnPort(DEFAULT_PORT);

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
