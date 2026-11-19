#!/usr/bin/env node
// Smoke-test the bundled plugin server: initialize + tools/list over stdio.
// Usage: node scripts/smoke-plugin.mjs   (after `npm run build:plugin`)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundle = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../claude-plugin/server/mcp-main.cjs');
const projectDir = mkdtempSync(join(tmpdir(), 'devtailor-smoke-'));
const port = String(35000 + Math.floor(Math.random() * 2000));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
  env: { ...process.env, DEVTAILOR_PROJECT_DIR: projectDir, DEVTAILOR_PORT: port },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', d => (stderr += d));
const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} });
let ok = false;
try {
  await client.connect(transport); // a polluted stdout would fail the handshake here
  const caps = client.getServerCapabilities();
  const tools = (await client.listTools()).tools;
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.status);
  const permission = !!caps?.experimental?.['claude/channel/permission'];
  console.log(JSON.stringify({ channel: !!caps?.experimental?.['claude/channel'], permission, tools: tools.length, health }));
  ok = !!caps?.experimental?.['claude/channel'] && permission && tools.length === 19 && tools.some(t => t.name === 'reply') && health === 200;
} catch (err) {
  console.error('smoke failed:', err, stderr);
} finally {
  await client.close().catch(() => {});
}
process.exit(ok ? 0 : 1);
