import { describe, it } from 'node:test';
import assert from 'node:assert';
import { listBuiltInAgents, resolveAgent } from '../src/agent-presets';

describe('agent presets', () => {
  it('lists the supported built-in ACP agent presets', () => {
    const ids = listBuiltInAgents().map(agent => agent.id);
    assert.deepStrictEqual(ids, [
      'claude',
      'codex',
      'copilot',
      'gemini',
      'kimi',
      'kiro',
      'opencode',
      'qwen',
    ]);
  });

  it('resolves built-in presets to command and args', () => {
    const gemini = resolveAgent('gemini');
    assert.strictEqual(gemini.source, 'preset');
    assert.strictEqual(gemini.command, 'npx');
    assert.deepStrictEqual(gemini.args, ['@google/gemini-cli', '--experimental-acp']);

    const claude = resolveAgent('claude');
    assert.strictEqual(claude.command, 'claude-agent-acp');
    assert.deepStrictEqual(claude.args, []);
  });

  it('keeps raw ACP commands supported', () => {
    const raw = resolveAgent('my-acp-agent --flag value');
    assert.strictEqual(raw.source, 'raw');
    assert.strictEqual(raw.command, 'my-acp-agent');
    assert.deepStrictEqual(raw.args, ['--flag', 'value']);
  });
});
