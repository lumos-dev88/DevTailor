import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { zeroUsage, addTokenUsage } from '../src/runtime/usage';
import type { TokenUsage } from '../src/runtime/usage';
import type { RuntimeMessage, RuntimeToolCall, ContentPart } from '../src/runtime/message';
import type { RuntimeToolDefinition, RuntimeToolExecutionResult } from '../src/runtime/tool';
import type { StreamedMessagePart, FinishReason } from '../src/runtime/provider';

// ── usage helpers ──────────────────────────────────────────────────────

describe('addTokenUsage', () => {
  it('returns zero when adding two zero usages', () => {
    const result = addTokenUsage(zeroUsage(), zeroUsage());
    assert.deepStrictEqual(result, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('accumulates correctly', () => {
    const a: TokenUsage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
    const b: TokenUsage = { promptTokens: 5, completionTokens: 7, totalTokens: 12 };
    const result = addTokenUsage(a, b);
    assert.deepStrictEqual(result, { promptTokens: 15, completionTokens: 27, totalTokens: 42 });
  });

  it('does not mutate inputs', () => {
    const a: TokenUsage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    const b: TokenUsage = { promptTokens: 4, completionTokens: 5, totalTokens: 9 };
    addTokenUsage(a, b);
    assert.deepStrictEqual(a, { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  });
});

// ── zeroUsage ──────────────────────────────────────────────────────────

describe('zeroUsage', () => {
  it('returns an all-zero object', () => {
    const z = zeroUsage();
    assert.equal(z.promptTokens, 0);
    assert.equal(z.completionTokens, 0);
    assert.equal(z.totalTokens, 0);
  });
});

// ── message shape ──────────────────────────────────────────────────────

describe('RuntimeMessage shape', () => {
  it('accepts a valid user message', () => {
    const msg: RuntimeMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    };
    assert.equal(msg.role, 'user');
    assert.equal(msg.content[0].type, 'text');
  });

  it('accepts an assistant message with tool calls', () => {
    const call: RuntimeToolCall = { id: 'tc_1', name: 'read_file', arguments: '{"path":"/tmp"}' };
    const msg: RuntimeMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'reading...' }],
      toolCalls: [call],
    };
    assert.equal(msg.toolCalls?.[0].name, 'read_file');
  });

  it('accepts a tool result message', () => {
    const part: ContentPart = { type: 'tool_result', toolCallId: 'tc_1', content: 'file contents', isError: false };
    const msg: RuntimeMessage = { role: 'tool', content: [part] };
    assert.equal(msg.role, 'tool');
  });
});

// ── tool definition shape ──────────────────────────────────────────────

describe('RuntimeToolDefinition shape', () => {
  it('holds expected fields', () => {
    const def: RuntimeToolDefinition = {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    };
    assert.equal(def.name, 'read_file');
    assert.equal(typeof def.parameters, 'object');
  });
});

// ── tool execution result shape ────────────────────────────────────────

describe('RuntimeToolExecutionResult shape', () => {
  it('round-trips error flag', () => {
    const ok: RuntimeToolExecutionResult = { toolCallId: 'tc_1', content: 'ok' };
    const err: RuntimeToolExecutionResult = { toolCallId: 'tc_2', content: 'fail', isError: true };
    assert.equal(ok.isError, undefined);
    assert.equal(err.isError, true);
  });
});

// ── streamed part shape ────────────────────────────────────────────────

describe('StreamedMessagePart variants', () => {
  it('text_delta has type and text', () => {
    const p: StreamedMessagePart = { type: 'text_delta', text: 'hi' };
    assert.equal(p.type, 'text_delta');
  });

  it('done carries a FinishReason', () => {
    const reason: FinishReason = 'stop';
    const p: StreamedMessagePart = { type: 'done', finishReason: reason };
    assert.equal(p.type, 'done');
  });

  it('error carries message', () => {
    const p: StreamedMessagePart = { type: 'error', message: 'oops' };
    assert.equal(p.type, 'error');
  });
});
