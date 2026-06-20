import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleProvider } from '../src/runtime/openai-compatible-provider';
import { isContextOverflow, ERROR_CONTEXT_OVERFLOW } from '../src/runtime/errors';
import type { RuntimeMessage, RuntimeToolDefinition, StreamedMessagePart } from '../src/runtime';

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), { status });
}

async function collect(parts: AsyncIterable<StreamedMessagePart>): Promise<StreamedMessagePart[]> {
  const result: StreamedMessagePart[] = [];
  for await (const part of parts) result.push(part);
  return result;
}

describe('OpenAICompatibleProvider', () => {
  it('formats request URL, auth header, messages, tools, and stream flag', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(url);
      capturedInit = init;
      return streamResponse(['data: [DONE]\n\n']);
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: fetchMock as typeof fetch,
    });
    const messages: RuntimeMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mediaType: 'image/png', data: 'abc123' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'calling' }],
        toolCalls: [{ id: 'call_1', name: 'get_page_snapshot', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: '{"ok":true}' }],
      },
    ];
    const tools: RuntimeToolDefinition[] = [{
      name: 'get_page_snapshot',
      description: 'Get page snapshot',
      parameters: { type: 'object', properties: {} },
    }];

    await collect(provider.chat(messages, tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))));

    assert.equal(capturedUrl, 'http://example.test/v1/chat/completions');
    assert.equal(capturedInit?.method, 'POST');
    assert.ok(capturedInit?.signal instanceof AbortSignal);
    assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, 'mimo-v2.5');
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.messages.length, 4);
    assert.deepEqual(body.messages[0], { role: 'system', content: 'system prompt' });
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content[0].text, 'look');
    assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,abc123');
    assert.equal(body.messages[2].tool_calls[0].function.name, 'get_page_snapshot');
    assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
    assert.equal(body.tools[0].function.name, 'get_page_snapshot');
  });

  it('exposes redacted diagnostics without api key', () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test/v1/',
      apiKey: 'secret-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse(['data: [DONE]\n\n'])) as typeof fetch,
    });

    assert.deepEqual(provider.diagnostics(), {
      provider: 'openai-compatible',
      baseUrl: 'http://example.test/v1',
      model: 'mimo-v2.5',
    });
  });

  it('does not duplicate /v1 when baseUrl already includes it', async () => {
    let capturedUrl = '';
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test/v1/',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async (url: string | URL | Request) => {
        capturedUrl = String(url);
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(capturedUrl, 'http://example.test/v1/chat/completions');
  });

  it('parses streamed text deltas and done usage', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.deepEqual(parts.map(part => part.type), ['text_delta', 'text_delta', 'done']);
    assert.equal(parts[0].type === 'text_delta' ? parts[0].text : '', 'Hel');
    assert.equal(parts[1].type === 'text_delta' ? parts[1].text : '', 'lo');
    assert.equal(parts[2].type === 'done' ? parts[2].finishReason : '', 'stop');
    assert.deepEqual(parts[2].type === 'done' ? parts[2].usage : undefined, {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
  });

  it('parses chunked tool call arguments', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"run_js","arguments":"{\\"code\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"return 1\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'tool_call');
    if (parts[0].type === 'tool_call') {
      assert.equal(parts[0].toolCall.id, 'call_1');
      assert.equal(parts[0].toolCall.name, 'run_js');
      assert.equal(parts[0].toolCall.arguments, '{"code":"return 1"}');
    }
    assert.equal(parts[1].type === 'done' ? parts[1].finishReason : '', 'tool_calls');
  });

  it('yields error part on HTTP error', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => new Response('bad request', { status: 400 })) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    assert.match(parts[0].type === 'error' ? parts[0].message : '', /HTTP 400/);
  });

  // ── stream_options tests ──────────────────────────────────────────

  it('sends stream_options with include_usage true', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'k',
      model: 'm',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body));
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.deepEqual(capturedBody?.stream_options, { include_usage: true });
  });

  // ── Usage-only chunk tests ────────────────────────────────────────

  it('captures usage from a usage-only chunk (empty choices) before [DONE]', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'text_delta');
    const done = parts.find((p) => p.type === 'done');
    assert.ok(done, 'should have a done part');
    assert.equal(done!.type === 'done' ? done!.finishReason : '', 'stop');
    assert.deepEqual(done!.type === 'done' ? done!.usage : undefined, {
      prompt_tokens: 5,
      completion_tokens: 1,
      total_tokens: 6,
    });
  });

  it('usage from finish_reason chunk is preserved even without usage-only chunk', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    const done = parts.find((p) => p.type === 'done');
    assert.ok(done);
    assert.deepEqual(done!.type === 'done' ? done!.usage : undefined, {
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
    });
  });

  it('does not yield error or crash on usage-only chunk with no choices', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":0,"total_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'done');
    assert.deepEqual(parts[0].type === 'done' ? parts[0].usage : undefined, {
      prompt_tokens: 2,
      completion_tokens: 0,
      total_tokens: 2,
    });
  });

  // ── Retry tests ───────────────────────────────────────────────────

  it('retries on 429 and succeeds', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('rate limited', { status: 429 });
        }
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        ]);
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
    assert.ok(parts.some((p) => p.type === 'text_delta'));
  });

  it('retries on 500 and succeeds', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount === 1) return new Response('server error', { status: 500 });
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
  });

  it('retries on 502 and succeeds', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount === 1) return new Response('bad gateway', { status: 502 });
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
  });

  it('retries on 503 and succeeds', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount === 1) return new Response('service unavailable', { status: 503 });
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
  });

  it('retries on fetch network error and succeeds', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount === 1) throw new TypeError('fetch failed');
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
    assert.ok(parts.some((p) => p.type === 'done'));
  });

  it('yields error after exhausting retries on persistent 429', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        return new Response('rate limited', { status: 429 });
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 4); // initial + 3 retries
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    assert.match(parts[0].type === 'error' ? parts[0].message : '', /HTTP 429/);
  });

  it('yields error after exhausting retries on persistent fetch failure', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        throw new TypeError('network down');
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 4);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    assert.match(parts[0].type === 'error' ? parts[0].message : '', /network down/);
  });

  it('does not retry on 400 (non-transient 4xx)', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        return new Response('bad request', { status: 400 });
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 1);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
  });

  it('does not retry on 401', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        return new Response('unauthorized', { status: 401 });
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 1);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    assert.match(parts[0].type === 'error' ? parts[0].message : '', /HTTP 401/);
  });

  it('does not retry on 404', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 1);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    assert.match(parts[0].type === 'error' ? parts[0].message : '', /HTTP 404/);
  });

  // ── Backoff timing test ───────────────────────────────────────────

  it('uses exponential backoff between retries', async () => {
    const timestamps: number[] = [];
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        timestamps.push(Date.now());
        callCount++;
        if (callCount <= 2) return new Response('err', { status: 503 });
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 3);
    // Check backoff gaps are at least 500ms and 1000ms respectively.
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    assert.ok(gap1 >= 400, `first backoff gap ${gap1}ms should be >= ~500ms`);
    assert.ok(gap2 >= 900, `second backoff gap ${gap2}ms should be >= ~1000ms`);
  });

  // ── Compatibility: existing behavior preserved ────────────────────

  it('preserves tool call behavior with multiple tool calls', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => streamResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fn_a","arguments":"{\\\"a\\\":"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}},{"index":1,"id":"c2","function":{"name":"fn_b","arguments":"{\\"b\\":2}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      ])) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    const toolCalls = parts.filter((p) => p.type === 'tool_call');
    assert.equal(toolCalls.length, 2);
    if (toolCalls[0].type === 'tool_call') {
      assert.equal(toolCalls[0].toolCall.name, 'fn_a');
      assert.equal(toolCalls[0].toolCall.arguments, '{"a":1}');
    }
    if (toolCalls[1].type === 'tool_call') {
      assert.equal(toolCalls[1].toolCall.name, 'fn_b');
      assert.equal(toolCalls[1].toolCall.arguments, '{"b":2}');
    }
    const done = parts.find((p) => p.type === 'done');
    assert.equal(done?.type === 'done' ? done.finishReason : '', 'tool_calls');
  });

  // ── Context overflow classification ───────────────────────────────────

  it('classifies context overflow when body contains context_length_exceeded', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          JSON.stringify({ error: { message: 'context_length_exceeded: maximum context length is 8192 tokens', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, ERROR_CONTEXT_OVERFLOW);
      assert.match(parts[0].message, /context_length_exceeded/);
    }
  });

  it('classifies context overflow when body contains maximum context length', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          "This model's maximum context length is 128000 tokens",
          { status: 400 },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('classifies context overflow when body contains token limit', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          'Request exceeds the token limit for this model',
          { status: 400 },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('classifies context overflow for 413 regardless of body', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response('Payload Too Large', { status: 413 });
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('does NOT classify generic 400 as context overflow', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          JSON.stringify({ error: { message: 'Invalid request: missing required field', type: 'invalid_request_error' } }),
          { status: 400 },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, '400');
      assert.notEqual(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('does NOT classify 422 as context overflow when body has no matching pattern', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          JSON.stringify({ error: { message: 'Unprocessable Entity', type: 'invalid_request_error' } }),
          { status: 422 },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, '422');
      assert.notEqual(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('classifies context overflow for 422 when body matches pattern', async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        return new Response(
          'context_length_exceeded: request too large',
          { status: 422 },
        );
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(parts[0].type, 'error');
    if (parts[0].type === 'error') {
      assert.equal(parts[0].code, ERROR_CONTEXT_OVERFLOW);
    }
  });

  it('429 still retries and does not classify as context overflow', async () => {
    let callCount = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://example.test',
      apiKey: 'test-key',
      model: 'mimo-v2.5',
      fetch: (async () => {
        callCount++;
        if (callCount <= 1) return new Response('rate limited', { status: 429 });
        return streamResponse(['data: [DONE]\n\n']);
      }) as typeof fetch,
    });

    const parts = await collect(provider.chat([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));
    assert.equal(callCount, 2);
    const done = parts.find((p) => p.type === 'done');
    assert.ok(done, 'should have a done part after retry success');
  });

});


describe('isContextOverflow', () => {
  it('returns true for status 413 regardless of body', () => {
    assert.equal(isContextOverflow(413, ''), true);
    assert.equal(isContextOverflow(413, 'anything'), true);
  });

  it('returns true when body contains context_length_exceeded', () => {
    assert.equal(isContextOverflow(400, '{"error":"context_length_exceeded"}'), true);
  });

  it('returns true when body contains maximum context length', () => {
    assert.equal(isContextOverflow(400, "This model's maximum context length is 8192"), true);
  });

  it('returns true when body contains token limit', () => {
    assert.equal(isContextOverflow(400, 'exceeds the token limit'), true);
  });

  it('returns true when body contains context window', () => {
    assert.equal(isContextOverflow(400, 'exceeds the context window'), true);
  });

  it('returns true when body contains too many tokens', () => {
    assert.equal(isContextOverflow(400, 'too many tokens in request'), true);
  });

  it('returns false for generic 400 with unrelated body', () => {
    assert.equal(isContextOverflow(400, 'Invalid request: missing field'), false);
  });

  it('returns false for 422 with unrelated body', () => {
    assert.equal(isContextOverflow(422, 'Unprocessable Entity'), false);
  });

  it('returns false for 500', () => {
    assert.equal(isContextOverflow(500, 'Internal Server Error'), false);
  });
});
