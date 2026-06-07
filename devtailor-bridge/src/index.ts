#!/usr/bin/env node
/**
 * DevTailor Bridge — CLI Entry
 *
 * Usage:
 *   npx devtailor --agent claude --dir /path/to/project
 *   npx devtailor --agent gemini --dir . --port 7777
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

const DEFAULT_PORT = 34781;
const DEFAULT_AGENT = 'claude';
const PID_FILE = '/tmp/devtailor-bridge.pid';

function parseArgs(): { agent: string; dir: string; port: number; daemon: boolean; command: string } {
  const args = process.argv.slice(2);
  let agent = DEFAULT_AGENT;
  let dir = process.cwd();
  let port = DEFAULT_PORT;
  let daemon = false;
  let command = 'start';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--agent':
        agent = args[++i] || agent;
        break;
      case '--dir':
      case '--cwd':
        dir = resolve(args[++i] || dir);
        break;
      case '--port':
        port = parseInt(args[++i] || String(port), 10);
        break;
      case '--daemon':
        daemon = true;
        break;
      case 'stop':
      case 'status':
      case 'agents':
        command = arg;
        break;
    }
  }

  return { agent, dir, port, daemon, command };
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

function startDaemon(agent: string, dir: string, port: number): void {
  const child = spawn(process.execPath, [__filename, '--agent', agent, '--dir', dir, '--port', String(port)], {
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
  const { agent, dir, port, daemon, command } = parseArgs();

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
    console.error(`Error: dir does not exist: ${dir}`);
    process.exit(1);
  }

  if (daemon) {
    startDaemon(agent, dir, port);
    return;
  }

  const resolvedAgent = resolveAgent(agent);
  checkAgent(resolvedAgent);

  killProcessOnPort(port);

  const dataDir = join(dir, '.devtailor');

  console.log(`[DevTailor] Starting bridge...`);
  console.log(`  Agent: ${resolvedAgent.label}`);
  console.log(`  Cmd:   ${[resolvedAgent.command, ...resolvedAgent.args].join(' ')}`);
  console.log(`  Dir:   ${dir}`);
  console.log(`  Port:  ${port}`);

  const server = new WSServer(
    port,
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
