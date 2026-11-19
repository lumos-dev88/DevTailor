import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  AGENT_STATUS_STALE_MS,
  AgentStatus,
  DEFAULT_WAITING_LABEL,
  MAX_AGENT_LABEL_CHARS,
  isAgentStatusEvent,
  sanitizeAgentLabel,
} from '../src/agent-status';

const T0 = 1_700_000_000_000;

describe('AgentStatus: state machine', () => {
  it('starts idle with an empty label and a stable since', () => {
    const status = new AgentStatus(T0);
    assert.deepStrictEqual(status.snapshot(T0), {
      state: 'idle',
      label: '',
      toolName: '',
      activeTools: 0,
      since: T0,
      updatedAt: T0,
    });
  });

  it('UserPromptSubmit and turn_start put the AI into thinking', () => {
    const status = new AgentStatus(T0);
    assert.strictEqual(status.apply('UserPromptSubmit', {}, T0 + 10).state, 'thinking');
    const viaTurnStart = new AgentStatus(T0).apply('turn_start', {}, T0 + 10);
    assert.strictEqual(viaTurnStart.state, 'thinking');
    assert.strictEqual(viaTurnStart.since, T0 + 10);
  });

  it('PreToolUse goes to tool and records the label + tool name', () => {
    const status = new AgentStatus(T0);
    const snap = status.apply('PreToolUse', {
      toolName: 'Read',
      label: '读取 src/app.ts',
      toolUseId: 'toolu_1',
    }, T0 + 100);
    assert.strictEqual(snap.state, 'tool');
    assert.strictEqual(snap.label, '读取 src/app.ts');
    assert.strictEqual(snap.toolName, 'Read');
    assert.strictEqual(snap.activeTools, 1);
    assert.strictEqual(snap.since, T0 + 100);
  });

  it('PostToolUse returns to thinking when the last tool finishes', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolName: 'Read', label: '读取 a', toolUseId: 'toolu_1' }, T0 + 100);
    const snap = status.apply('PostToolUse', { toolName: 'Read', toolUseId: 'toolu_1' }, T0 + 200);
    assert.strictEqual(snap.state, 'thinking');
    assert.strictEqual(snap.activeTools, 0);
    assert.strictEqual(snap.since, T0 + 200, 'entering thinking re-stamps since');
  });

  it('PostToolUseFailure is treated like PostToolUse', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolName: 'Bash', toolUseId: 'toolu_1' }, T0 + 100);
    const snap = status.apply('PostToolUseFailure', { toolName: 'Bash', toolUseId: 'toolu_1' }, T0 + 150);
    assert.strictEqual(snap.state, 'thinking');
    assert.strictEqual(snap.activeTools, 0);
  });

  it('tracks parallel tools and stays in tool until all of them finish', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolName: 'Read', label: '读取 a.ts', toolUseId: 'toolu_a' }, T0 + 100);
    let snap = status.apply('PreToolUse', { toolName: 'Grep', label: '搜索 foo', toolUseId: 'toolu_b' }, T0 + 110);
    assert.strictEqual(snap.activeTools, 2);
    assert.strictEqual(snap.state, 'tool');

    snap = status.apply('PostToolUse', { toolUseId: 'toolu_a' }, T0 + 200);
    assert.strictEqual(snap.state, 'tool');
    assert.strictEqual(snap.activeTools, 1);
    assert.strictEqual(snap.label, '搜索 foo', 'keeps the most recent label');

    snap = status.apply('PostToolUse', { toolUseId: 'toolu_b' }, T0 + 300);
    assert.strictEqual(snap.state, 'thinking');
    assert.strictEqual(snap.activeTools, 0);
  });

  it('handles out-of-order PostToolUse reports without going negative', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolUseId: 'toolu_a' }, T0 + 100);
    status.apply('PreToolUse', { toolUseId: 'toolu_b' }, T0 + 110);

    // b finishes first even though a started first
    let snap = status.apply('PostToolUse', { toolUseId: 'toolu_b' }, T0 + 200);
    assert.strictEqual(snap.activeTools, 1);
    assert.strictEqual(snap.state, 'tool');

    // a duplicate/unknown completion must not decrement below zero
    snap = status.apply('PostToolUse', { toolUseId: 'toolu_b' }, T0 + 210);
    assert.strictEqual(snap.activeTools, 1, 'duplicate completion is ignored');
    snap = status.apply('PostToolUse', { toolUseId: 'toolu_unknown' }, T0 + 220);
    assert.strictEqual(snap.activeTools, 1, 'unknown id is ignored');

    snap = status.apply('PostToolUse', { toolUseId: 'toolu_a' }, T0 + 230);
    assert.strictEqual(snap.activeTools, 0);
    assert.strictEqual(snap.state, 'thinking');
  });

  it('counts tools that report no toolUseId', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolName: 'Read' }, T0 + 100);
    let snap = status.apply('PreToolUse', { toolName: 'Read' }, T0 + 110);
    assert.strictEqual(snap.activeTools, 2);
    snap = status.apply('PostToolUse', {}, T0 + 200);
    assert.strictEqual(snap.activeTools, 1);
    assert.strictEqual(snap.state, 'tool');
    snap = status.apply('PostToolUse', {}, T0 + 300);
    assert.strictEqual(snap.activeTools, 0);
    assert.strictEqual(snap.state, 'thinking');
  });

  it('Notification is waiting with the default label', () => {
    const status = new AgentStatus(T0);
    const snap = status.apply('Notification', {}, T0 + 100);
    assert.strictEqual(snap.state, 'waiting');
    assert.strictEqual(snap.label, DEFAULT_WAITING_LABEL);
  });

  it('Stop and turn_end clear in-flight tools and return to idle', () => {
    for (const event of ['Stop', 'turn_end'] as const) {
      const status = new AgentStatus(T0);
      status.apply('PreToolUse', { toolUseId: 'toolu_a' }, T0 + 100);
      status.apply('PreToolUse', { toolUseId: 'toolu_b' }, T0 + 110);
      const snap = status.apply(event, {}, T0 + 200);
      assert.strictEqual(snap.state, 'idle', event);
      assert.strictEqual(snap.activeTools, 0, event);
      assert.strictEqual(snap.label, '', event);
      assert.strictEqual(snap.since, T0 + 200, event);
    }
  });

  it('SubagentStop goes to thinking when nothing else is in flight', () => {
    const status = new AgentStatus(T0);
    status.apply('UserPromptSubmit', {}, T0 + 100);
    const snap = status.apply('SubagentStop', {}, T0 + 200);
    assert.strictEqual(snap.state, 'thinking', 'a subagent finishing never ends the main session');
  });

  it('SubagentStop keeps tool while another tool is in flight', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolName: 'Bash', label: '跑测试', toolUseId: 'toolu_main' }, T0 + 100);
    const snap = status.apply('SubagentStop', {}, T0 + 200);
    assert.strictEqual(snap.state, 'tool');
    assert.strictEqual(snap.activeTools, 1);
    assert.strictEqual(snap.label, '跑测试');
  });

  it('does not reset since when only the label changes inside the same state', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { label: '读取 a', toolUseId: 'toolu_a' }, T0 + 100);
    const snap = status.apply('PreToolUse', { label: '搜索 b', toolUseId: 'toolu_b' }, T0 + 500);
    assert.strictEqual(snap.label, '搜索 b');
    assert.strictEqual(snap.since, T0 + 100, 'since is the state entry time');
    assert.strictEqual(snap.updatedAt, T0 + 500);
  });

  it('reports idle after 10 minutes without any event', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { label: '读取 a', toolUseId: 'toolu_a' }, T0 + 100);
    const fresh = status.snapshot(T0 + 100 + AGENT_STATUS_STALE_MS);
    assert.strictEqual(fresh.state, 'tool', 'exactly at the limit is still live');
    const stale = status.snapshot(T0 + 100 + AGENT_STATUS_STALE_MS + 1);
    assert.strictEqual(stale.state, 'idle');
    assert.strictEqual(stale.label, '');
    assert.strictEqual(stale.activeTools, 0);
    // A late event still settles the machine.
    const recovered = status.apply('PostToolUse', { toolUseId: 'toolu_a' }, T0 + AGENT_STATUS_STALE_MS + 500);
    assert.strictEqual(recovered.state, 'thinking');
  });

  it('applies the same staleness rule to thinking and waiting', () => {
    for (const event of ['UserPromptSubmit', 'Notification'] as const) {
      const status = new AgentStatus(T0);
      status.apply(event, {}, T0 + 100);
      assert.strictEqual(status.snapshot(T0 + 200).state === 'idle', false, event);
      assert.strictEqual(status.snapshot(T0 + 100 + AGENT_STATUS_STALE_MS + 1).state, 'idle', event);
    }
  });

  it('a new turn drops in-flight tools left over from the previous turn', () => {
    const status = new AgentStatus(T0);
    status.apply('PreToolUse', { toolUseId: 'toolu_a' }, T0 + 100);
    status.apply('PreToolUse', { toolUseId: 'toolu_b' }, T0 + 110);
    const snap = status.apply('UserPromptSubmit', {}, T0 + 200);
    assert.strictEqual(snap.state, 'thinking');
    assert.strictEqual(snap.activeTools, 0);
  });

  it('rejects unknown events', () => {
    const status = new AgentStatus(T0);
    assert.throws(() => status.apply('ToolUse' as any, {}, T0));
    assert.strictEqual(isAgentStatusEvent('PreToolUse'), true);
    assert.strictEqual(isAgentStatusEvent('turn_start'), true);
    assert.strictEqual(isAgentStatusEvent('nope'), false);
    assert.strictEqual(isAgentStatusEvent(undefined), false);
  });
});

describe('AgentStatus: label sanitizing', () => {
  it('strips control characters and newlines', () => {
    assert.strictEqual(sanitizeAgentLabel('读取\na.ts\r\n第二行'), '读取 a.ts 第二行');
    assert.strictEqual(sanitizeAgentLabel('a\u0000b\u001fc\u007fd'), 'a b c d');
    assert.strictEqual(sanitizeAgentLabel('  \t  '), '');
  });

  it('truncates to 120 characters and keeps the payload label capped in the snapshot', () => {
    const long = 'x'.repeat(500);
    assert.strictEqual(sanitizeAgentLabel(long).length, MAX_AGENT_LABEL_CHARS);
    const status = new AgentStatus(T0);
    const snap = status.apply('PreToolUse', { label: `\n${long}\n`, toolUseId: 'toolu_1' }, T0 + 10);
    assert.strictEqual(snap.label.length, MAX_AGENT_LABEL_CHARS);
    assert.ok(!snap.label.includes('\n'));
  });

  it('ignores non-string labels', () => {
    assert.strictEqual(sanitizeAgentLabel(undefined), '');
    assert.strictEqual(sanitizeAgentLabel(42 as any), '');
    const snap = new AgentStatus(T0).apply('PreToolUse', { label: 42 as any, toolUseId: 'toolu_1' }, T0 + 10);
    assert.strictEqual(snap.state, 'tool');
    assert.ok(snap.label.length > 0, 'falls back to a default label');
  });
});
