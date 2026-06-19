import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolve } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { ACPSession } from '../src/acp-session';
import { tmpdir } from 'os';

const mockAgent = resolve(__dirname, 'mock-acp-agent.js');
const sessionDir = resolve(tmpdir(), 'devtailor-test-acp-compat');
mkdirSync(sessionDir, { recursive: true });

let sessions: ACPSession[] = [];
afterEach(() => {
  for (const s of sessions) s.stop();
  sessions = [];
});

function readParams(file: string): Record<string, unknown> {
  assert.ok(existsSync(file), `params file should exist: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function startSession(opts: {
  label: string;
  mcpServers?: any[];
  agentId?: string;
}): Promise<{ session: ACPSession; params: Record<string, unknown> }> {
  const paramsFile = resolve(sessionDir, `${opts.label}.json`);
  const session = new ACPSession(
    'node',
    process.cwd(),
    [mockAgent],
    opts.mcpServers ?? [],
    null,
    { MOCK_PARAMS_FILE: paramsFile },
    opts.agentId,
  );
  sessions.push(session);
  await session.start();
  return { session, params: readParams(paramsFile) };
}

describe('ACP session: newSession _meta and mcpServers compatibility', () => {
  it('Claude agent sends _meta.systemPrompt with preset claude_code', async () => {
    const { params } = await startSession({
      label: 'claude-meta',
      mcpServers: [{ type: 'http', name: 'test-mcp', url: 'http://localhost:9999/mcp', headers: [] }],
      agentId: 'claude',
    });

    const meta = params._meta as Record<string, unknown>;
    assert.ok(meta, '_meta should be present for Claude');
    const sp = meta.systemPrompt as Record<string, unknown>;
    assert.strictEqual(sp.type, 'preset');
    assert.strictEqual(sp.preset, 'claude_code');
    assert.strictEqual(typeof sp.append, 'string');
    assert.ok((sp.append as string).length > 0, 'systemPrompt.append should be non-empty');
  });

  it('non-Claude agent does NOT send preset claude_code in _meta', async () => {
    const { params } = await startSession({
      label: 'gemini-meta',
      agentId: 'gemini',
    });

    const meta = params._meta as Record<string, unknown>;
    assert.ok(meta, '_meta should still be present for non-Claude (contains append)');
    const sp = meta.systemPrompt as Record<string, unknown>;
    assert.strictEqual(sp.preset, undefined, 'non-Claude must not have preset');
    assert.strictEqual(sp.type, undefined, 'non-Claude must not have systemPrompt.type');
    assert.strictEqual(typeof sp.append, 'string');
  });

  it('Claude agent receives mcpServers in newSession params', async () => {
    const browserMcp = { type: 'http', name: 'devtailor-browser', url: 'http://localhost:34781/mcp', headers: [] };
    const { params } = await startSession({
      label: 'claude-mcp',
      mcpServers: [browserMcp],
      agentId: 'claude',
    });

    const servers = params.mcpServers as any[];
    assert.ok(Array.isArray(servers), 'mcpServers should be an array');
    assert.ok(servers.length > 0, 'Claude should receive Browser MCP servers');
    assert.strictEqual(servers[0].name, 'devtailor-browser');
  });

  it('non-Claude agent receives empty mcpServers', async () => {
    const { params } = await startSession({
      label: 'gemini-mcp',
      mcpServers: [],
      agentId: 'gemini',
    });

    const servers = params.mcpServers as any[];
    assert.ok(Array.isArray(servers), 'mcpServers should be an array');
    assert.strictEqual(servers.length, 0, 'non-Claude should receive empty mcpServers');
  });
});
