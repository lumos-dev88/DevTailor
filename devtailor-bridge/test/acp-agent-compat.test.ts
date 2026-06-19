import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BUILT_IN_AGENTS, resolveAgent } from '../src/agent-presets';

describe('ACP agent compatibility', () => {
  describe('npx presets include --yes', () => {
    const npxPresets = ['copilot', 'gemini', 'qwen', 'codex', 'opencode'] as const;

    for (const id of npxPresets) {
      it(`${id} preset has --yes as first arg`, () => {
        const preset = BUILT_IN_AGENTS[id];
        assert.strictEqual(preset.command, 'npx');
        assert.strictEqual(preset.args[0], '--yes', `${id} must start npx args with --yes`);
      });
    }
  });

  describe('non-npx presets do not have --yes', () => {
    it('claude preset is a direct binary without --yes', () => {
      const claude = BUILT_IN_AGENTS['claude'];
      assert.notStrictEqual(claude.command, 'npx');
      assert.ok(!claude.args.includes('--yes'));
    });

    it('kiro preset is a direct binary without --yes', () => {
      const kiro = BUILT_IN_AGENTS['kiro'];
      assert.notStrictEqual(kiro.command, 'npx');
      assert.ok(!kiro.args.includes('--yes'));
    });
  });

  describe('resolveAgent returns correct id for isClaudeAgent checks', () => {
    it('claude preset resolves with id=claude', () => {
      const agent = resolveAgent('claude');
      assert.strictEqual(agent.id, 'claude');
      assert.strictEqual(agent.command, 'claude-agent-acp');
    });

    it('gemini preset resolves with id=gemini', () => {
      const agent = resolveAgent('gemini');
      assert.strictEqual(agent.id, 'gemini');
      assert.strictEqual(agent.command, 'npx');
    });

    it('raw command resolves without id', () => {
      const agent = resolveAgent('my-agent --flag');
      assert.strictEqual(agent.id, undefined);
    });
  });
});
