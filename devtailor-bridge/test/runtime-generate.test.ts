import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generate } from '../src/runtime/generate';
import type { GenerateOptions, GenerateCallbacks } from '../src/runtime/generate';
import type {
  ChatProvider,
  StreamedMessagePart,
  RuntimeMessage,
  RuntimeToolExecutor,
  RuntimeToolDefinition,
} from '../src/runtime';

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a fake ChatProvider that yields the given parts once. */
function fakeProvider(parts: StreamedMessagePart[]): ChatProvider {
  return {
    async *chat(
      _messages: Array<{ role: string; content: unknown[] }>,
      _tools?: Array<Record<string, unknown>>,
    ): AsyncIterable<StreamedMessagePart> {
      for (const p of parts) {
        yield p;
      }
    },
  };
}

/** A provider that yields parts with delays, respecting an external signal. */
function slowProvider(
  parts: StreamedMessagePart[],
  delayMs = 10,
): ChatProvider {
  return {
    async *chat(): AsyncIterable<StreamedMessagePart> {
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, delayMs));
        yield p;
      }
    },
  };
}

function textDelta(text: string): StreamedMessagePart {
  return { type: 'text_delta', text };
}

function toolCallPart(
  id: string,
  name: string,
  args: string = '{}',
): StreamedMessagePart {
  return { type: 'tool_call', toolCall: { id, name, arguments: args } };
}

function donePart(
  finishReason: 'stop' | 'tool_calls' = 'stop',
): StreamedMessagePart {
  return { type: 'done', finishReason };
}

function donePartWithUsage(
  usage: unknown,
  finishReason: 'stop' | 'tool_calls' = 'stop',
): StreamedMessagePart {
  return { type: 'done', finishReason, usage };
}

function errorPart(message: string): StreamedMessagePart {
  return { type: 'error', message };
}

const echoExecutor: RuntimeToolExecutor = async (
  _name: string,
  args: string,
  toolCallId: string,
) => ({
  toolCallId,
  content: `echo:${args}`,
});

const failExecutor: RuntimeToolExecutor = async () => {
  throw new Error('boom');
};

const echoToolDef: RuntimeToolDefinition = {
  name: 'echo',
  description: 'Echo tool',
  parameters: { type: 'object', properties: {} },
};

const userMsg: RuntimeMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('generate', () => {
  // ── 1. Basic text-only turn ─────────────────────────────────────────

  it('returns assistant message with text for a single-turn response', async () => {
    const result = await generate({
      provider: fakeProvider([textDelta('hi '), textDelta('there'), donePart()]),
      messages: [userMsg],
      maxSteps: 1,
    });

    assert.equal(result.finishReason, 'stop');
    assert.equal(result.aborted, undefined);
    assert.equal(result.assistantMessage.role, 'assistant');
    const text = result.assistantMessage.content.find((c) => c.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(text.text, 'hi there');
    assert.equal(result.messages.length, 2); // user + assistant
  });

  // ── 2. Multi-step tool call then text ───────────────────────────────

  it('executes tool calls and loops back for a text response', async () => {
    // Step 1: provider says tool_call, step 2: provider says text
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(
        _messages: Array<{ role: string; content: unknown[] }>,
      ): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo', '{"k":"v"}');
          yield donePart('tool_calls');
        } else {
          yield textDelta('done');
          yield donePart();
        }
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
      maxSteps: 5,
    });

    assert.equal(result.finishReason, 'stop');
    const text = result.assistantMessage.content.find((c) => c.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(text.text, 'done');
    // history: user, assistant(tool_call), tool, assistant(text)
    assert.equal(result.messages.length, 4);
    assert.equal(result.messages[2].role, 'tool');
    assert.equal(callCount, 2);
  });

  // ── 3. Tool executor failure wraps as failed result, doesn't throw ──

  it('wraps tool executor errors as failed tool_result without throwing', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo');
          yield donePart('tool_calls');
        } else {
          yield textDelta('recovered');
          yield donePart();
        }
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: failExecutor,
      maxSteps: 5,
    });

    assert.equal(result.finishReason, 'stop');
    // The tool result message should have isError: true
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    const trPart = toolMsg!.content.find((c) => c.type === 'tool_result');
    assert.ok(trPart && trPart.type === 'tool_result');
    assert.equal(trPart.isError, true);
    assert.equal(trPart.content, 'boom');
  });

  // ── 4. Abort before start returns immediately ───────────────────────

  it('returns aborted result when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await generate({
      provider: fakeProvider([textDelta('never')]),
      messages: [userMsg],
      signal: ac.signal,
      maxSteps: 1,
    });

    assert.equal(result.aborted, true);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.assistantMessage.content.length, 0);
  });

  // ── 5. Abort during stream ──────────────────────────────────────────

  it('returns aborted result when signal fires during streaming', async () => {
    const ac = new AbortController();
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        yield textDelta('partial');
        ac.abort(); // abort mid-stream
        yield textDelta(' never');
        yield donePart();
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      signal: ac.signal,
      maxSteps: 1,
    });

    assert.equal(result.aborted, true);
    const text = result.assistantMessage.content.find((c) => c.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(text.text, 'partial');
  });

  // ── 6. Abort before tool execution ──────────────────────────────────

  it('returns aborted result when signal fires before tool execution', async () => {
    const ac = new AbortController();
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo');
          yield donePart('tool_calls');
          ac.abort(); // abort after stream, before tool exec
        } else {
          yield textDelta('should not reach');
          yield donePart();
        }
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
      signal: ac.signal,
      maxSteps: 5,
    });

    assert.equal(result.aborted, true);
    assert.equal(result.finishReason, 'stop');
    // Should only have 1 call to provider (never looped)
    assert.equal(callCount, 1);
  });

  // ── 7. maxSteps prevents infinite tool loop ─────────────────────────

  it('stops at maxSteps even if provider always returns tool_calls', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        yield toolCallPart(`tc${callCount}`, 'echo');
        yield donePart('tool_calls');
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
      maxSteps: 3,
    });

    assert.equal(result.finishReason, 'tool_calls');
    assert.equal(callCount, 3);
  });

  it('does not impose a default maxSteps when omitted', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount <= 6) {
          yield toolCallPart(`tc${callCount}`, 'echo');
          yield donePart('tool_calls');
          return;
        }
        yield textDelta('finished');
        yield donePart();
      },
    };

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
    });

    assert.equal(result.finishReason, 'stop');
    assert.equal(callCount, 7);
    const text = result.assistantMessage.content.find((c) => c.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.equal(text.text, 'finished');
  });

  // ── 8. No executor → returns tool_calls finishReason ────────────────

  it('returns tool_calls finishReason when no executor is provided', async () => {
    const result = await generate({
      provider: fakeProvider([toolCallPart('tc1', 'echo'), donePart('tool_calls')]),
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      maxSteps: 5,
    });

    assert.equal(result.finishReason, 'tool_calls');
  });

  // ── 9. Callbacks fire correctly ─────────────────────────────────────

  it('fires onTextDelta for each delta chunk', async () => {
    const deltas: string[] = [];
    const callbacks: GenerateCallbacks = {
      onTextDelta: (t) => deltas.push(t),
    };

    await generate({
      provider: fakeProvider([textDelta('a'), textDelta('b'), donePart()]),
      messages: [userMsg],
      callbacks,
      maxSteps: 1,
    });

    assert.deepEqual(deltas, ['a', 'b']);
  });

  it('fires onToolCall and onToolResult during tool execution', async () => {
    const calls: string[] = [];
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo');
          yield donePart('tool_calls');
        } else {
          yield textDelta('ok');
          yield donePart();
        }
      },
    };

    const callbacks: GenerateCallbacks = {
      onToolCall: (tc) => calls.push(`call:${tc.name}`),
      onToolResult: (r) => calls.push(`result:${r.toolCallId}`),
    };

    await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
      callbacks,
      maxSteps: 5,
    });

    assert.deepEqual(calls, ['call:echo', 'result:tc1']);
  });

  // ── 10. systemPrompt is prepended ───────────────────────────────────

  it('prepends a system message when systemPrompt is provided', async () => {
    let capturedMsgs: Array<{ role: string; content: unknown[] }> = [];
    const provider: ChatProvider = {
      async *chat(
        msgs: Array<{ role: string; content: unknown[] }>,
      ): AsyncIterable<StreamedMessagePart> {
        capturedMsgs = msgs;
        yield textDelta('ok');
        yield donePart();
      },
    };

    await generate({
      provider,
      systemPrompt: 'You are helpful.',
      messages: [userMsg],
      maxSteps: 1,
    });

    assert.equal(capturedMsgs[0].role, 'system');
    assert.deepEqual(capturedMsgs[0].content, [
      { type: 'text', text: 'You are helpful.' },
    ]);
    assert.equal(capturedMsgs[1].role, 'user');
  });

  // ── 11. Provider error part → finishReason 'error' ──────────────────

  it('returns error finishReason on provider error part', async () => {
    let errorMessage = '';
    const result = await generate({
      provider: fakeProvider([textDelta('partial'), errorPart('rate limited')]),
      messages: [userMsg],
      maxSteps: 1,
      callbacks: {
        onError: message => {
          errorMessage = message;
        },
      },
    });

    assert.equal(result.finishReason, 'error');
    assert.equal(result.errorMessage, 'rate limited');
    assert.equal(errorMessage, 'rate limited');
  });

  // ── 12. Multiple tool calls in one turn ──────────────────────────────

  it('executes multiple tool calls sequentially in one turn', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo', '{"a":1}');
          yield toolCallPart('tc2', 'echo', '{"b":2}');
          yield donePart('tool_calls');
        } else {
          yield textDelta('both done');
          yield donePart();
        }
      },
    };

    const results: string[] = [];
    const callbacks: GenerateCallbacks = {
      onToolResult: (r) => results.push(r.content),
    };

    const genResult = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: echoExecutor,
      callbacks,
      maxSteps: 5,
    });

    assert.equal(genResult.finishReason, 'stop');
    assert.deepEqual(results, ['echo:{"a":1}', 'echo:{"b":2}']);
    // user, assistant(2 tool_calls), tool(2 results), assistant(text)
    assert.equal(genResult.messages.length, 4);
  });

  it('normalizes OpenAI snake_case usage fields', async () => {
    const result = await generate({
      provider: fakeProvider([
        textDelta('ok'),
        donePartWithUsage({
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        }),
      ]),
      messages: [userMsg],
      maxSteps: 1,
    });

    assert.deepEqual(result.usage, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });

  it('truncates oversized tool results before adding them to history', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo');
          yield donePart('tool_calls');
        } else {
          yield textDelta('done');
          yield donePart();
        }
      },
    };
    const largeExecutor: RuntimeToolExecutor = async (_name, _args, toolCallId) => ({
      toolCallId,
      content: 'x'.repeat(200),
    });

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: largeExecutor,
      maxSteps: 5,
      maxToolResultChars: 180,
    });

    const toolMsg = result.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    const toolResult = toolMsg.content.find((part) => part.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.ok(toolResult.content.length <= 180);
    assert.match(toolResult.content, /content truncated/);
    assert.match(toolResult.content, /narrower query or range/);
  });

  it('returns an error tool result when tool execution times out', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      async *chat(): AsyncIterable<StreamedMessagePart> {
        callCount++;
        if (callCount === 1) {
          yield toolCallPart('tc1', 'echo');
          yield donePart('tool_calls');
        } else {
          yield textDelta('after timeout');
          yield donePart();
        }
      },
    };
    const hangingExecutor: RuntimeToolExecutor = async () => new Promise(() => {});

    const result = await generate({
      provider,
      messages: [userMsg],
      toolDefinitions: [echoToolDef],
      toolExecutor: hangingExecutor,
      maxSteps: 5,
      toolTimeoutMs: 5,
    });

    assert.equal(result.finishReason, 'stop');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg);
    const toolResult = toolMsg.content.find((part) => part.type === 'tool_result');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.equal(toolResult.isError, true);
    assert.match(toolResult.content, /timed out/);
  });
});
