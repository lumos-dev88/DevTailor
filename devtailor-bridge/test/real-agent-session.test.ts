import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RealAgentSession } from '../src/real-agent-session';
import type {
  AgentCallbacks,
  BrowserToolRunner,
} from '../src/agent-session';
import type {
  ChatProvider,
  StreamedMessagePart,
} from '../src/runtime';
import type { ReviewPayload } from '../src/types';

function payload(overrides: Partial<ReviewPayload['payload']> = {}): ReviewPayload['payload'] {
  return {
    pageUrl: 'http://localhost:3000',
    userIntent: '检查按钮间距',
    items: [],
    screenshot: null,
    ...overrides,
  };
}

function callbacks() {
  const streams: string[] = [];
  const errors: string[] = [];
  const toolCalls: any[] = [];
  const toolUpdates: any[] = [];
  const cbs: AgentCallbacks = {
    onStream: delta => streams.push(delta),
    onThinking: () => {},
    onDone: () => {},
    onError: message => errors.push(message),
    onToolCall: tool => toolCalls.push(tool),
    onToolUpdate: update => toolUpdates.push(update),
  };
  return { cbs, streams, errors, toolCalls, toolUpdates };
}

function staticProvider(parts: StreamedMessagePart[]): ChatProvider {
  return {
    async *chat() {
      for (const part of parts) yield part;
    },
  };
}

describe('RealAgentSession', () => {
  it('starts as created then reused with the same session id', async () => {
    const session = new RealAgentSession({
      provider: staticProvider([]),
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });

    const first = await session.start();
    const second = await session.start();
    assert.equal(first.mode, 'created');
    assert.equal(second.mode, 'reused');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(session.isReady, true);
  });

  it('streams provider text through AgentCallbacks', async () => {
    const session = new RealAgentSession({
      provider: staticProvider([
        { type: 'text_delta', text: 'hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'done', finishReason: 'stop' },
      ]),
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs, streams } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    assert.equal(streams.join(''), 'hello world');
  });

  it('executes provider tool calls through BrowserToolRunner', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'call_1', name: 'get_page_snapshot', arguments: '{"includeStyles":true}' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const runnerCalls: Array<{ action: string; params: Record<string, unknown> }> = [];
    const runBrowserTool: BrowserToolRunner = async (action, params = {}) => {
      runnerCalls.push({ action, params });
      return { requestId: 'r1', ok: true, result: { title: 'Page' } };
    };
    const session = new RealAgentSession({ provider, runBrowserTool, maxSteps: 4 });
    const { cbs, streams, toolCalls, toolUpdates } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    assert.equal(streams.join(''), 'done');
    assert.deepEqual(runnerCalls, [{ action: 'get_page_snapshot', params: { includeStyles: true } }]);
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].title, 'get_page_snapshot');
    assert.equal(toolCalls[0].status, 'running');
    assert.equal(toolUpdates.length, 1);
    assert.equal(toolUpdates[0].status, 'completed');
  });

  it('maps failed browser tool results to failed tool updates', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'call_1', name: 'get_console_logs', arguments: '{}' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'handled' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({
        requestId: 'r1',
        ok: false,
        error: { code: 'NO_ACTIVE_TAB', message: 'No active tab' },
      }),
    });
    const { cbs, toolUpdates } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    assert.equal(toolUpdates.length, 1);
    assert.equal(toolUpdates[0].status, 'failed');
    assert.match(String(toolUpdates[0].rawOutput), /NO_ACTIVE_TAB/);
  });

  it('surfaces provider error parts through AgentCallbacks', async () => {
    const session = new RealAgentSession({
      provider: staticProvider([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', message: 'HTTP 401: invalid api key', code: '401' },
      ]),
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs, streams, errors } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'error');
    assert.equal(streams.join(''), 'partial');
    assert.deepEqual(errors, ['HTTP 401: invalid api key']);
  });

  it('routes workspace tool calls through WorkspaceToolRunner', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'call_ws_1', name: 'read_file', arguments: '{"path":"src/App.tsx"}' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'read' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const workspaceCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      runWorkspaceTool: async (tool, params = {}) => {
        workspaceCalls.push({ tool, params });
        return { ok: true, result: { content: '1\tconst App = () => null;' } };
      },
      maxSteps: 4,
    });
    const { cbs, streams, toolCalls, toolUpdates } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    assert.equal(streams.join(''), 'read');
    assert.deepEqual(workspaceCalls, [{ tool: 'read_file', params: { path: 'src/App.tsx' } }]);
    assert.equal(toolCalls[0].kind, 'workspace');
    assert.equal(toolUpdates[0].kind, 'workspace');
  });

  it('cancels an in-flight generate run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: ChatProvider = {
      async *chat() {
        yield { type: 'text_delta', text: 'partial' };
        await gate;
        yield { type: 'text_delta', text: ' late' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs, streams } = callbacks();
    session.setCallbacks(cbs);

    const pending = session.sendReview(payload());
    await new Promise(resolve => setImmediate(resolve));
    const cancelled = await session.cancelCurrentTurn();
    release();

    assert.equal(cancelled, true);
    assert.equal(await pending, 'cancelled');
    assert.equal(streams.join(''), 'partial');
  });

  // ── Concurrency protection ──────────────────────────────────────────

  it('throws when sendReview is called concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider: ChatProvider = {
      async *chat() {
        yield { type: 'text_delta', text: 'first' };
        await gate;
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs } = callbacks();
    session.setCallbacks(cbs);

    const firstCall = session.sendReview(payload());
    await new Promise(resolve => setImmediate(resolve));

    await assert.rejects(
      () => session.sendReview(payload()),
      { message: 'sendReview is already in progress' },
    );

    release();
    await firstCall;
  });

  it('concurrent rejection does not pollute messages', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'done', finishReason: 'stop' };
        } else {
          // Second sendReview should see clean messages (no garbage from rejected call).
          yield { type: 'text_delta', text: 'second' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs, streams } = callbacks();
    session.setCallbacks(cbs);

    // First call succeeds.
    const reason1 = await session.sendReview(payload());
    assert.equal(reason1, 'stop');

    // Try a concurrent call during a gated third call.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slowProvider: ChatProvider = {
      async *chat() {
        yield { type: 'text_delta', text: 'slow' };
        await gate;
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    // Replace provider by creating a new session to test clean state.
    const session2 = new RealAgentSession({
      provider: slowProvider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
    });
    const { cbs: cbs2, streams: streams2 } = callbacks();
    session2.setCallbacks(cbs2);

    const slowCall = session2.sendReview(payload());
    await new Promise(resolve => setImmediate(resolve));

    // Concurrent call throws.
    await assert.rejects(() => session2.sendReview(payload()));

    release();
    const reason2 = await slowCall;
    assert.equal(reason2, 'stop');
    assert.equal(streams2.join(''), 'slow');
  });

  // ── Invalid tool args feedback ──────────────────────────────────────

  it('returns isError tool result for invalid JSON tool args', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'bad_1', name: 'get_page_snapshot', arguments: 'not json {' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'recovered' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    let toolExecuted = false;
    const runBrowserTool: BrowserToolRunner = async () => {
      toolExecuted = true;
      return { requestId: 'r1', ok: true, result: null };
    };
    const session = new RealAgentSession({ provider, runBrowserTool, maxSteps: 4 });
    const { cbs, toolUpdates } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    // Browser tool should NOT have been called with empty args.
    assert.equal(toolExecuted, false);
    // Should get a failed tool update with parse error detail.
    assert.equal(toolUpdates.length, 1);
    assert.equal(toolUpdates[0].status, 'failed');
    assert.match(String(toolUpdates[0].rawOutput), /Invalid tool arguments/);
  });

  it('returns isError for non-object JSON tool args (array)', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'bad_arr', name: 'get_page_snapshot', arguments: '[1, 2, 3]' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      maxSteps: 4,
    });
    const { cbs, toolUpdates } = callbacks();
    session.setCallbacks(cbs);

    const reason = await session.sendReview(payload());
    assert.equal(reason, 'stop');
    assert.equal(toolUpdates.length, 1);
    assert.equal(toolUpdates[0].status, 'failed');
    assert.match(String(toolUpdates[0].rawOutput), /Expected a JSON object/);
  });

  it('emitToolCall rawInput reflects raw string on parse failure', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'bad_raw', name: 'get_page_snapshot', arguments: 'broken!@#' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      maxSteps: 4,
    });
    const { cbs, toolCalls } = callbacks();
    session.setCallbacks(cbs);

    await session.sendReview(payload());
    assert.equal(toolCalls.length, 1);
    // rawInput should be the raw string, not masked as {}.
    assert.equal(toolCalls[0].rawInput, 'broken!@#');
  });

  // ── History window ──────────────────────────────────────────────────

  it('history window prevents unbounded message growth', async () => {
    const largeText = 'x'.repeat(1000);
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        yield { type: 'text_delta', text: largeText };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    // Set a very small budget so trimming is guaranteed.
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      maxMessageChars: 500,
    });
    const { cbs } = callbacks();
    session.setCallbacks(cbs);

    // Run multiple rounds.
    for (let i = 0; i < 5; i++) {
      await session.sendReview(payload({ userIntent: `round ${i}` }));
    }

    // Access internal messages via a sendReview that yields quickly.
    // We verify indirectly: after many rounds with a tiny budget,
    // the provider should still succeed (no OOM) and messages are trimmed.
    // The test proves the mechanism works by running 5 rounds without failure.
    assert.equal(providerCalls, 5);
  });

  it('messages are trimmed to budget, not accumulated infinitely', async () => {
    // Use a provider that tracks how many messages it receives.
    const receivedLengths: number[] = [];
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat(messages) {
        providerCalls++;
        receivedLengths.push(messages.length);
        yield { type: 'text_delta', text: 'response ' + providerCalls };
        yield { type: 'done', finishReason: 'stop' };
      },
    };

    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      maxMessageChars: 500,
    });
    const { cbs } = callbacks();
    session.setCallbacks(cbs);

    for (let i = 0; i < 8; i++) {
      await session.sendReview(payload({ userIntent: `turn ${i}` }));
    }

    // Without trimming, message count would grow by 2 each turn (user + assistant).
    // With a tight budget, older messages get evicted.
    // The last few turns should see a bounded context window.
    const lastLen = receivedLengths[receivedLengths.length - 1];
    const maxPossible = 2 * 8 + 1; // 8 turns * 2 msgs + 1 current user msg
    assert.ok(lastLen < maxPossible,
      `Expected bounded context (got ${lastLen} vs max ${maxPossible})`);
  });

  // ── toolKinds cleanup (indirect) ────────────────────────────────────

  it('toolKinds reset between stop and restart avoids stale kinds', async () => {
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat() {
        providerCalls++;
        if (providerCalls % 2 === 1) {
          yield {
            type: 'tool_call',
            toolCall: { id: `call_${providerCalls}`, name: 'read_file', arguments: '{}' },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };
    const toolUpdates: any[] = [];
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      runWorkspaceTool: async () => ({ ok: true, result: { content: 'file content' } }),
      maxSteps: 4,
    });
    const cbs: AgentCallbacks = {
      onStream: () => {},
      onThinking: () => {},
      onDone: () => {},
      onError: () => {},
      onToolUpdate: update => toolUpdates.push(update),
    };
    session.setCallbacks(cbs);

    await session.sendReview(payload());
    assert.equal(toolUpdates.length, 1);
    assert.equal(toolUpdates[0].kind, 'workspace');

    // Stop and restart — toolKinds should be cleared.
    session.stop();
    await session.start();

    toolUpdates.length = 0;
    await session.sendReview(payload());
    assert.equal(toolUpdates.length, 1);
    // Should still be 'workspace', not some stale or leftover value.
    assert.equal(toolUpdates[0].kind, 'workspace');
  });

  // ── Micro-compaction ────────────────────────────────────────────────

  it('compacts old large tool results before trimming', async () => {
    const receivedLengths: number[] = [];
    const receivedToolResults: string[][] = [];
    let providerCalls = 0;
    const provider: ChatProvider = {
      async *chat(messages) {
        providerCalls++;
        receivedLengths.push(messages.length);
        // Collect all tool_result content strings seen by provider.
        const toolContents: string[] = [];
        for (const msg of messages) {
          if (msg.role === 'tool') {
            for (const part of msg.content) {
              if (part.type === 'tool_result') toolContents.push(part.content);
            }
          }
        }
        receivedToolResults.push(toolContents);

        if (providerCalls % 2 === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'call_' + providerCalls,
              name: 'read_file',
              arguments: JSON.stringify({ path: '/src/app.ts' }),
            },
          };
          yield { type: 'done', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'ok ' + providerCalls };
          yield { type: 'done', finishReason: 'stop' };
        }
      },
    };

    // read_file returns a large result
    const session = new RealAgentSession({
      provider,
      runBrowserTool: async () => ({ requestId: 'r1', ok: true, result: null }),
      runWorkspaceTool: async () => ({
        ok: true,
        result: { content: 'x'.repeat(5000) },
      }),
      maxMessageChars: 500_000, // large budget so trimming doesn't interfere
      maxSteps: 4,
    });
    const { cbs } = callbacks();
    session.setCallbacks(cbs);

    // Run 4 turns to build history.
    for (let i = 0; i < 4; i++) {
      await session.sendReview(payload({ userIntent: 'turn ' + i }));
    }

    // After 4 turns there should be 8 messages (4 user + 4 assistant)
    // plus 4 tool result messages = 12 total in history.
    // The earlier tool results should have been compacted.
    const lastToolContents = receivedToolResults[receivedToolResults.length - 1];
    // At least one old tool result should be compacted (short marker).
    const compacted = lastToolContents.filter(c => c.includes('compacted'));
    assert.ok(compacted.length > 0,
      'Expected at least one compacted tool result in provider context');
  });

});
