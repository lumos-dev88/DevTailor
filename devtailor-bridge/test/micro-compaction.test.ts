import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { microCompactMessages } from '../src/runtime/micro-compaction';
import type { RuntimeMessage } from '../src/runtime';

describe('microCompactMessages', () => {
  function toolResultMsg(toolCallId: string, content: string): RuntimeMessage {
    return {
      role: 'tool',
      content: [{ type: 'tool_result', toolCallId, content }],
    };
  }

  function userMsg(text: string): RuntimeMessage {
    return { role: 'user', content: [{ type: 'text', text }] };
  }

  function assistantMsg(text: string): RuntimeMessage {
    return { role: 'assistant', content: [{ type: 'text', text }] };
  }

  function imageMsg(base64: string): RuntimeMessage {
    return {
      role: 'user',
      content: [{ type: 'image', data: base64, mediaType: 'image/png' }],
    };
  }

  it('does nothing when messages are fewer than keepLastN', () => {
    const msgs: RuntimeMessage[] = [
      toolResultMsg('c1', 'x'.repeat(5000)),
      assistantMsg('ok'),
    ];
    const original = JSON.parse(JSON.stringify(msgs));
    microCompactMessages(msgs);
    assert.deepEqual(msgs, original);
  });

  it('compacts old large tool results, keeps recent untouched', () => {
    // 6 messages: 0-1 are old (eligible), 2-5 are recent (keepLastN=4)
    const msgs: RuntimeMessage[] = [
      toolResultMsg('c0', 'x'.repeat(5000)),  // old — should be compacted
      userMsg('what about that?'),              // old, but no tool_result — untouched
      toolResultMsg('c1', 'y'.repeat(5000)),  // recent — untouched
      assistantMsg('looks fine'),
      toolResultMsg('c2', 'z'.repeat(5000)),  // recent — untouched
      assistantMsg('done'),
    ];
    microCompactMessages(msgs, { keepLastN: 4 });

    // msg[0] should be compacted
    assert.equal(msgs[0].role, 'tool');
    const part0 = msgs[0].content[0];
    assert.equal(part0.type, 'tool_result');
    assert.ok(part0.content.includes('compacted'));
    assert.ok(part0.content.includes('5000'));
    assert.equal(part0.toolCallId, 'c0');

    // msg[1] — user text, untouched
    assert.equal(msgs[1].content[0].type, 'text');

    // msg[2] — recent, untouched
    assert.equal(msgs[2].content[0].type, 'tool_result');
    assert.equal(msgs[2].content[0].content.length, 5000);
  });

  it('does not compact small tool results even in old messages', () => {
    const msgs: RuntimeMessage[] = [
      toolResultMsg('c0', 'small'),           // old but small
      userMsg('q'),
      assistantMsg('a'),
      toolResultMsg('c1', 'y'.repeat(5000)),  // recent
      assistantMsg('b'),
    ];
    microCompactMessages(msgs, { keepLastN: 4, maxToolResultChars: 2000 });
    assert.equal(msgs[0].content[0].content, 'small'); // untouched
  });

  it('compacts old images when compactImages is true (default)', () => {
    const msgs: RuntimeMessage[] = [
      imageMsg('a'.repeat(10000)),            // old image
      userMsg('q'),
      assistantMsg('a'),
      imageMsg('b'.repeat(10000)),            // recent image
      assistantMsg('b'),
    ];
    microCompactMessages(msgs, { keepLastN: 4 });

    // Old image replaced with text marker
    assert.equal(msgs[0].content[0].type, 'text');
    assert.ok(msgs[0].content[0].text.includes('compacted'));
    assert.ok(msgs[0].content[0].text.includes('image/png'));

    // Recent image untouched
    assert.equal(msgs[3].content[0].type, 'image');
  });

  it('does not compact images when compactImages is false', () => {
    const msgs: RuntimeMessage[] = [
      imageMsg('a'.repeat(10000)),
      userMsg('q'),
      assistantMsg('a'),
      imageMsg('b'.repeat(10000)),
      assistantMsg('b'),
    ];
    microCompactMessages(msgs, { keepLastN: 4, compactImages: false });

    // Old image untouched
    assert.equal(msgs[0].content[0].type, 'image');
  });

  it('handles empty content gracefully', () => {
    const msgs: RuntimeMessage[] = [
      { role: 'assistant', content: [] },
      userMsg('q'),
      assistantMsg('a'),
      assistantMsg('b'),
      assistantMsg('c'),
    ];
    // Should not throw
    microCompactMessages(msgs, { keepLastN: 4 });
    assert.equal(msgs[0].content.length, 0);
  });

  it('respects custom maxToolResultChars', () => {
    const msgs: RuntimeMessage[] = [
      toolResultMsg('c0', 'x'.repeat(100)),
      userMsg('q'),
      assistantMsg('a'),
      toolResultMsg('c1', 'y'.repeat(100)),
      assistantMsg('b'),
    ];
    microCompactMessages(msgs, { keepLastN: 4, maxToolResultChars: 50 });

    // 100 chars > 50 threshold → compacted
    assert.ok(msgs[0].content[0].content.includes('compacted'));
  });

  it('returns the same array reference', () => {
    const msgs: RuntimeMessage[] = [
      toolResultMsg('c0', 'x'.repeat(5000)),
      userMsg('q'),
      assistantMsg('a'),
      assistantMsg('b'),
      assistantMsg('c'),
    ];
    const result = microCompactMessages(msgs, { keepLastN: 4 });
    assert.equal(result, msgs);
  });

  it('preserves isError flag on compacted tool results', () => {
    const msgs: RuntimeMessage[] = [
      {
        role: 'tool',
        content: [{
          type: 'tool_result',
          toolCallId: 'c0',
          content: 'x'.repeat(5000),
          isError: true,
        }],
      },
      userMsg('q'),
      assistantMsg('a'),
      assistantMsg('b'),
      assistantMsg('c'),
    ];
    microCompactMessages(msgs, { keepLastN: 4 });
    assert.equal(msgs[0].content[0].isError, true);
  });
});
