#!/usr/bin/env node
/**
 * Mock ACP Agent — Simulates claude-agent-acp for testing
 *
 * Speaks full ACP protocol over stdio (NDJSON).
 * Handles initialize → session/new → session/prompt lifecycle.
 */

const { stdin, stdout } = process;
let buffer = '';
let requestId = 0;

stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    handleLine(line.trim());
  }
});

function write(obj) {
  stdout.write(JSON.stringify(obj) + '\n');
}

function handleLine(line) {
  if (!line) return;
  try {
    const req = JSON.parse(line);
    if (!req || typeof req !== 'object') return;

    const id = req.id;
    const method = req.method;

    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-01',
          agentInfo: { name: 'mock-agent', version: '0.0.1' },
          agentCapabilities: {},
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = 'test-session-' + Date.now();
      if (process.env.MOCK_STARTUP_TITLE) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              title: process.env.MOCK_STARTUP_TITLE,
              updatedAt: new Date().toISOString(),
            },
          },
        });
      }
      write({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          configOptions: [],
        },
      });
      return;
    }

    if (method === 'session/prompt') {
      const prompt = req.params?.prompt || [];
      const textBlocks = prompt.filter((b) => b.type === 'text');
      const imageBlocks = prompt.filter((b) => b.type === 'image');
      const totalText = textBlocks.map((b) => b.text).join(' ');
      const wordCount = totalText.split(/\s+/).filter(Boolean).length;

      const sessionId = req.params?.sessionId || 'test-session';

      if (totalText.includes('trigger-session-title-update')) {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              title: 'Agent Generated Title',
              updatedAt: new Date().toISOString(),
            },
          },
        });
      }

      // Stream response word by word
      const words = [
        'Mock',
        'response',
        'for',
        'prompt',
        'with',
        String(wordCount),
        'words',
        'and',
        String(imageBlocks.length),
        'images.',
      ];

      let idx = 0;
      const interval = setInterval(() => {
        if (idx >= words.length) {
          clearInterval(interval);
          write({
            jsonrpc: '2.0',
            id,
            result: {
              stopReason: 'end_turn',
            },
          });
          return;
        }

        const word = words[idx++];
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: word + (idx < words.length ? ' ' : ''),
              },
            },
          },
        });
      }, 30);
      return;
    }

    // Unknown method
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch {
    // Ignore invalid lines
  }
}
