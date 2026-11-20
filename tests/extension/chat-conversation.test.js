'use strict';
const test = require('node:test');
const assert = require('node:assert');
const conversation = require('../../content/modules/chat-conversation.js');
const { createStore } = require('./helpers.js');

function setup(opts = {}) {
  const store = createStore();
  const hooks = { done: [], error: [], changes: [], metas: 0, toolStatus: [] };
  let t = 1000;
  const conv = conversation.create({
    store,
    now: () => (t += 1),
    getClientId: () => opts.clientId || null,
    onChange: (k) => hooks.changes.push(k),
    onMeta: () => { hooks.metas += 1; },
    onDone: (ev) => hooks.done.push(ev),
    onError: (ev, info) => hooks.error.push(info),
    onToolStatus: (ev) => hooks.toolStatus.push(ev),
  });
  const send = (...evs) => evs.forEach((ev) => conv.handle({ sessionId: 's1', ...ev }));
  return { store, conv, hooks, send };
}

const types = (store) => store.getAll().map((m) => m.type);

// ------------------------------------------------------------- stream
test('stream deltas without displayMessage append to one assistant message', () => {
  const { store, conv, send } = setup();
  assert.strictEqual(typeof conv.startLoading, 'undefined', 'no loading/processing state any more');
  assert.strictEqual('processing' in conv.meta, false);
  send({ type: 'stream', delta: 'Hello ' }, { type: 'stream', delta: 'world' });
  assert.deepStrictEqual(types(store), ['stream']);
  assert.strictEqual(store.getAll()[0].content, 'Hello world');
});

test('two stream events with different displayMessage.id render as two independent bubbles (no done needed)', () => {
  const { store, conv, send } = setup();
  const reply = (id, content) => ({ type: 'stream', turnId: 't1', delta: content, appendAssistantDelta: true, displayMessage: { id, role: 'assistant', content } });
  send(reply('a1', 'first whole reply'));
  assert.strictEqual(conv.isStreamingMessage(store.find((m) => m.id === 'a1')), true);
  send(reply('a2', 'second whole reply'));
  assert.deepStrictEqual(store.getAll().map((m) => [m.id, m.type, m.content]), [
    ['a1', 'stream', 'first whole reply'],
    ['a2', 'stream', 'second whole reply'],
  ]);
  assert.strictEqual(conv.isStreamingMessage(store.find((m) => m.id === 'a1')), false, 'previous bubble is closed');
  // a duplicate / shorter replay of the same id does not shrink or duplicate
  send(reply('a2', 'second'));
  assert.strictEqual(store.size, 2);
  assert.strictEqual(store.find((m) => m.id === 'a2').content, 'second whole reply');
});

test('without any done event the stream is closed by the next user message, a tool card, or an approval', () => {
  const stream = (id) => ({ type: 'stream', displayMessage: { id, role: 'assistant', type: 'stream', content: id } });
  const closers = {
    'user message': (c) => c.addUserMessage({ content: 'next' }),
    'echoed user display_message': (c, send) => send({ type: 'display_message', displayMessage: { id: 'u9', role: 'user', type: 'text', content: 'x' } }),
    'tool_status with toolName': (c, send) => send({ type: 'tool_status', toolName: 'Bash', toolStatus: 'running' }),
    'approval_request': (c, send) => send({ type: 'approval_request', approvalId: 'ap', toolName: 'Bash' }),
    'error': (c, send) => send({ type: 'error', message: 'boom' }),
  };
  for (const [name, close] of Object.entries(closers)) {
    const { store, conv, send } = setup();
    send(stream('a1'));
    const bubble = store.find((m) => m.id === 'a1');
    assert.strictEqual(conv.isStreamingMessage(bubble), true, name);
    close(conv, send);
    assert.strictEqual(conv.isStreamingMessage(bubble), false, `${name} closes the stream`);
  }
});

test('a delta-only stream after a user message starts a new bubble (previous reply is closed)', () => {
  const { store, conv, send } = setup();
  send({ type: 'stream', delta: 'one' });
  conv.addUserMessage({ content: 'q' });
  send({ type: 'stream', delta: 'two' });
  assert.deepStrictEqual(store.getAll().map((m) => [m.role, m.content]), [['assistant', 'one'], ['user', 'q'], ['assistant', 'two']]);
});

test('sending several user messages in a row never needs a done in between', () => {
  const { store, conv, send } = setup();
  conv.addUserMessage({ content: 'm1' });
  conv.addUserMessage({ content: 'm2' });
  send({ type: 'display_message', displayMessage: { id: 's1', role: 'user', type: 'text', content: 'm1' } });
  send({ type: 'display_message', displayMessage: { id: 's2', role: 'user', type: 'text', content: 'm2' } });
  send({ type: 'stream', displayMessage: { id: 'r1', role: 'assistant', content: 'ok1' } });
  send({ type: 'stream', displayMessage: { id: 'r2', role: 'assistant', content: 'ok2' } });
  assert.deepStrictEqual(store.getAll().map((m) => m.content), ['m1', 'm2', 'ok1', 'ok2']);
});

test('active session restore loads persisted messages without a taken-over tab', () => {
  const { store, conv, hooks } = setup();
  conv.applyActive({ activeSessionId: 's1', session: { id: 's1', title: 'Saved' }, messages: [
    { id: 'u1', role: 'user', type: 'text', content: 'Question' },
    { id: 'a1', role: 'assistant', type: 'stream', content: 'Saved reply' },
  ] });
  assert.strictEqual(conv.meta.sessionId, 's1');
  assert.strictEqual(conv.meta.title, 'Saved');
  assert.deepStrictEqual(store.getAll().map(m => [m.content, m.history]), [
    ['Question', true], ['Saved reply', true],
  ]);
  assert.deepStrictEqual(hooks.changes, ['history']);
});

test('session snapshots and live replies converge without duplicates or truncated text', () => {
  const { store, conv, send } = setup();
  const reply = { id: 'a1', role: 'assistant', type: 'stream', content: 'One' };
  const snapshot = { activeSessionId: 's1', session: { id: 's1' }, messages: [reply] };
  conv.applyActive(snapshot);
  send({ type: 'stream', delta: ' two', displayMessage: { ...reply, content: 'One two' } });
  conv.applyActive(snapshot); // older HTTP response arrived after the live update
  assert.deepStrictEqual(store.getAll().map(m => m.content), ['One two']);
  send({ type: 'stream', delta: ' two', displayMessage: { ...reply, content: 'One two' } });
  assert.strictEqual(store.size, 1);
  conv.applyActive({ activeSessionId: 's2', session: { id: 's2' }, messages: [] });
  assert.strictEqual(store.size, 0);
});

test('a snapshot reconciles an optimistic prompt while preserving its marks', () => {
  const { store, conv } = setup();
  conv.applyActive({ activeSessionId: 's1', session: { id: 's1' }, messages: [] });
  const optimistic = conv.addUserMessage({ content: 'Question', marks: [{ id: 'mark1' }] });
  conv.applyActive({ activeSessionId: 's1', session: { id: 's1' }, messages: [
    { id: 'older', role: 'user', type: 'text', content: 'Question', timestamp: 1 },
    { id: 'saved', role: 'user', type: 'text', content: 'Question', timestamp: optimistic.timestamp },
  ] });
  assert.deepStrictEqual(store.getAll().map(m => m.id), ['older', 'saved']);
  assert.deepStrictEqual(store.getAll()[1].marks, [{ id: 'mark1' }]);
  assert.strictEqual(store.getAll()[1].optimistic, false);
});

// ------------------------------------------------------------- done / error
test('legacy done(end_turn) is tolerated: closes the stream, no cancel notice', () => {
  const { store, conv, hooks, send } = setup();
  send({ type: 'stream', delta: 'A' });
  send({ type: 'done', reason: 'end_turn', isProcessing: false });
  assert.strictEqual(conv.isStreamingMessage(store.getAll()[0]), false);
  assert.deepStrictEqual(types(store), ['stream']);
  assert.strictEqual(store.getAll()[0].content, 'A');
  assert.strictEqual(hooks.done.length, 1);
});

test('tool_status(canceled) ends the stream', () => {
  const { store, conv, hooks, send } = setup();
  send({ type: 'stream', delta: 'A' });
  send({ type: 'tool_status', toolStatus: 'in_progress' });
  assert.strictEqual(conv.isStreamingMessage(store.getAll()[0]), true, 'non-cancel tool_status without toolName does not touch the stream');
  send({ type: 'tool_status', toolStatus: 'canceled' });
  assert.strictEqual(conv.isStreamingMessage(store.getAll()[0]), false);
  assert.deepStrictEqual(types(store), ['stream']);
  // 旧形态（无 toolName）保持原行为：不往侧边栏的极简状态条上抛事件
  assert.deepStrictEqual(hooks.toolStatus, [], 'canceled must not reach onToolStatus');
  void conv;
});

test('tool_status with a toolName reaches onToolStatus, keeps the transcript and closes the live bubble', () => {
  const { store, conv, hooks, send } = setup();
  send({ type: 'stream', delta: 'A' });
  const running = {
    type: 'tool_status', tabId: 'tab_1', toolName: 'Bash', requestId: 'r1', toolStatus: 'running',
  };
  send(running);
  assert.deepStrictEqual(types(store), ['stream']);
  assert.strictEqual(conv.isStreamingMessage(store.getAll()[0]), false);
  assert.strictEqual(hooks.toolStatus.length, 1);
  assert.deepStrictEqual(hooks.toolStatus[0], { sessionId: 's1', ...running });

  // success / error / timeout flow through the same way
  send({ type: 'tool_status', toolName: 'Bash', requestId: 'r1', toolStatus: 'success', durationMs: 1200 });
  send({ type: 'tool_status', toolName: 'Grep', requestId: 'r2', toolStatus: 'timeout' });
  assert.deepStrictEqual(hooks.toolStatus.map((ev) => ev.toolStatus), ['running', 'success', 'timeout']);

  // a callback that throws must not break event handling
  const storeB = createStore();
  const convB = conversation.create({
    store: storeB,
    now: () => 1,
    onToolStatus: () => { throw new Error('boom'); },
  });
  assert.strictEqual(convB.handle({ sessionId: 's1', type: 'tool_status', toolName: 'Read', toolStatus: 'running' }), true);
  assert.strictEqual(storeB.size, 0);
});

test('onToolStatus is optional and stays silent for events of another session', () => {
  const store = createStore();
  // no onToolStatus at all: the new shape must not throw
  const conv = conversation.create({ store, now: () => 1 });
  assert.strictEqual(conv.handle({ sessionId: 's1', type: 'tool_status', toolName: 'Bash', toolStatus: 'running' }), true);

  const calls = [];
  const conv2 = conversation.create({ store, now: () => 1, onToolStatus: (ev) => calls.push(ev) });
  conv2.handle({ type: 'session_reset', reason: 'user_requested', sessionId: 'cur' });
  // the per-session filter still applies to the new shape
  conv2.handle({ sessionId: 'other', type: 'tool_status', toolName: 'Bash', toolStatus: 'running' });
  assert.deepStrictEqual(calls, []);
  conv2.handle({ sessionId: 'cur', type: 'tool_status', toolName: 'Bash', toolStatus: 'running' });
  assert.strictEqual(calls.length, 1);
  void conv;
});

test('done(cancelled): pending approvals invalidated, "已取消" appended once', () => {
  const { store, conv, send } = setup();
  send(
    { type: 'approval_request', approvalId: 'a1', toolName: 'Bash', action: 'rm' },
    { type: 'done', reason: 'cancelled' },
  );
  const all = store.getAll();
  assert.strictEqual(all.find((m) => m.type === 'approval').status, 'cancelled');
  const notices = all.filter((m) => m.type === 'notice');
  assert.deepStrictEqual(notices.map((n) => n.content), ['已取消']);
});

test('error: shows copy by code, flags auth', () => {
  const { store, conv, hooks, send } = setup();
  send({ type: 'stream', delta: 'A' });
  send({ type: 'error', code: 'auth_required', message: 'x' });
  const notice = store.getAll().find((m) => m.type === 'notice');
  assert.match(notice.content, /`claude`/);
  assert.strictEqual(notice.tone, 'error');
  assert.strictEqual(conv.meta.authRequired, true);
  assert.strictEqual(hooks.error[0].kind, 'auth');
  send({ type: 'error', message: '找不到 bin' });
  assert.match(store.getAll().filter((m) => m.type === 'notice')[1].content, /找不到 bin/);
  send({ type: 'done', reason: 'end_turn' });
  assert.strictEqual(conv.meta.authRequired, false);
});

test('events for another session are ignored; no-session events are accepted', () => {
  const { store, conv, send } = setup();
  conv.handle({ type: 'session_reset', reason: 'user_requested', sessionId: 'cur' });
  conv.handle({ type: 'stream', sessionId: 'other', delta: 'nope' });
  assert.strictEqual(store.size, 0);
  conv.handle({ type: 'stream', sessionId: 'cur', delta: 'yes' });
  conv.handle({ type: 'stream', delta: '!' });
  assert.strictEqual(store.getAll()[0].content, 'yes!');
  void send;
});

// ------------------------------------------------------------- meta events
test('session_info updates meta only; a legacy queue_status is ignored', () => {
  const { store, conv, send } = setup();
  conv.handle({ type: 'session_reset', reason: 'user_requested', sessionId: 's1' });
  send(
    { type: 'session_info', sessionTitle: 'Fake title' },
    { type: 'queue_status', queueDepth: 2 },
  );
  assert.strictEqual(store.size, 0);
  assert.strictEqual(conv.meta.title, 'Fake title');
  assert.strictEqual('queueDepth' in conv.meta, false);
});

test('session_reset clears the transcript and adopts the new session id', () => {
  const { store, conv, send } = setup();
  send({ type: 'stream', delta: 'x' });
  conv.handle({ type: 'session_reset', reason: 'user_requested', sessionId: 's2' });
  assert.strictEqual(store.size, 0);
  assert.strictEqual(conv.meta.sessionId, 's2');
  conv.handle({ type: 'session_reset', reason: 'restarted', sessionId: 's3' });
  assert.match(store.getAll().pop().content, /会话已重建/);
});

// ------------------------------------------------------------- user messages
test('display_message reconciles with the optimistic message (no duplicates, either order)', () => {
  const a = setup();
  a.conv.addUserMessage({ content: 'hi' });
  a.send({ type: 'display_message', displayMessage: { id: 'srv1', role: 'user', type: 'text', content: 'hi', images: [], timestamp: 1 } });
  assert.strictEqual(a.store.size, 1);
  assert.strictEqual(a.store.getAll()[0].id, 'srv1');
  assert.strictEqual(a.store.getAll()[0].optimistic, false);
  // same event twice
  a.send({ type: 'display_message', displayMessage: { id: 'srv1', role: 'user', type: 'text', content: 'hi' } });
  assert.strictEqual(a.store.size, 1);
  // image-only synthetic text
  const b = setup();
  b.conv.addUserMessage({ content: '发送 2 张图片', images: ['d1', 'd2'] });
  b.send({ type: 'display_message', displayMessage: { id: 'srv2', role: 'user', type: 'text', content: '发送 2 张图片', images: ['d1', 'd2'] } });
  assert.strictEqual(b.store.size, 1);
  // message from another tab is appended
  b.send({ type: 'display_message', displayMessage: { id: 'srv3', role: 'user', type: 'text', content: 'from elsewhere' } });
  assert.strictEqual(b.store.size, 2);
});

// ------------------------------------------------------------- approvals
test('approval flow: request -> submit decision -> resolved; observer -> upgrade; timeout; resolved elsewhere', async () => {
  const { store, conv, send } = setup({ clientId: 'tab_1' });
  send({ type: 'approval_request', approvalId: 'a1', toolName: 'Bash', action: 'rm -rf build' });
  const calls = [];
  const result = await conv.submitApproval('appr_a1', 'approved', async (path, body) => {
    calls.push([path, body]);
    return { ok: true, status: 200 };
  });
  assert.deepStrictEqual(calls, [['/approval-decision', { approvalId: 'a1', decision: 'approved' }]]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(store.find((m) => m.id === 'appr_a1').status, 'approved');
  // the broadcast that follows our own click changes nothing
  send({ type: 'approval_resolved', approvalId: 'a1', decision: 'approved' });
  assert.strictEqual(store.find((m) => m.id === 'appr_a1').status, 'approved');
  // a second click on a final card is ignored
  assert.strictEqual((await conv.submitApproval('appr_a1', 'rejected', async () => { throw new Error('should not post'); })).ignored, true);

  // observing card (another tab owns it); own-target pending is skipped
  send({ type: 'approval_pending', approvalId: 'a2', toolName: 'Bash', targetClientId: 'tab_9' });
  send({ type: 'approval_pending', approvalId: 'a3', toolName: 'Bash', targetClientId: 'tab_1' });
  assert.strictEqual(store.find((m) => m.id === 'appr_a3'), null);
  const obs = store.find((m) => m.id === 'appr_a2');
  assert.strictEqual(obs.observing, true);
  assert.strictEqual((await conv.submitApproval('appr_a2', 'x', async () => { throw new Error('no'); })).ignored, true);
  send({ type: 'approval_resolved', approvalId: 'a2', decision: 'rejected', reason: 'timeout' });
  assert.strictEqual(store.find((m) => m.id === 'appr_a2').status, 'timeout');

  // failure: 409 -> expired, network -> retryable
  send({ type: 'approval_request', approvalId: 'a4', toolName: 'Bash' });
  await conv.submitApproval('appr_a4', 'approved', async () => ({ ok: false, status: 409, code: '' }));
  assert.strictEqual(store.find((m) => m.id === 'appr_a4').status, 'expired');
  send({ type: 'approval_request', approvalId: 'a5', toolName: 'Bash' });
  await conv.submitApproval('appr_a5', 'approved', async () => ({ ok: false, status: 0, code: 'bridge_offline' }));
  const a5 = store.find((m) => m.id === 'appr_a5');
  assert.strictEqual(a5.status, 'pending');
  assert.match(a5.error, /Hub 未连接.*fh hub status/);
});

test('mcp permission relay: 允许 / 拒绝 post the verdict', async () => {
  const { store, conv, send } = setup({ clientId: 'tab_1' });
  send({
    type: 'approval_request',
    approvalId: 'p1',
    toolName: 'Bash',
    action: '执行 shell 命令',
    risk: 'medium',
    detail: 'npm run build',
  });
  const card = store.find((m) => m.id === 'appr_p1');
  assert.strictEqual(card.status, 'pending');
  assert.deepStrictEqual(card.detail, { preview: 'npm run build' }, 'a plain string detail is kept for display');

  const allowCalls = [];
  const allow = await conv.submitApproval('appr_p1', 'approved', async (path, body) => {
    allowCalls.push([path, body]);
    return { ok: true, status: 200 };
  });
  assert.deepStrictEqual(allowCalls, [['/approval-decision', { approvalId: 'p1', decision: 'approved' }]]);
  assert.strictEqual(allow.ok, true);
  assert.strictEqual(store.find((m) => m.id === 'appr_p1').status, 'approved');

  send({ type: 'approval_request', approvalId: 'p2', toolName: 'Write', action: '写文件' });
  const denyCalls = [];
  await conv.submitApproval('appr_p2', 'rejected', async (path, body) => {
    denyCalls.push([path, body]);
    return { ok: true, status: 200 };
  });
  assert.deepStrictEqual(denyCalls, [['/approval-decision', { approvalId: 'p2', decision: 'rejected' }]]);
  assert.strictEqual(store.find((m) => m.id === 'appr_p2').status, 'rejected');
});

test('applyActive / reset populate meta', () => {
  const { conv, send } = setup();
  conv.applyActive({ ok: true, activeSessionId: 'x', session: { sessionId: 'x', title: 'T', cwd: '/p', isTemporary: false } });
  assert.deepStrictEqual([conv.meta.sessionId, conv.meta.title], ['x', 'T']);
  conv.applyActive({ ok: true, activeSessionId: null, session: null });
  assert.strictEqual(conv.meta.sessionId, null);
  assert.strictEqual(conv.meta.title, null);
  send({ type: 'stream', delta: 'x' });
  conv.reset();
});

test('unknown events are ignored without throwing', () => {
  const { store, conv } = setup();
  for (const type of ['ping', 'pong', 'active_client', 'session_snapshot', 'question_request', 'browser_action', 'whatever']) {
    assert.strictEqual(conv.handle({ type }), false);
  }
  assert.strictEqual(conv.handle(null), false);
  assert.strictEqual(conv.handle({ nope: 1 }), false);
  assert.strictEqual(store.size, 0);
});

test('addUserMessage keeps the marks it carried; the display_message echo does not drop them', () => {
  const { store, conv } = setup();
  const marks = [{ id: 'r_1', index: 1, desc: 'button.btn', selector: 'main > button' }];
  const msg = conv.addUserMessage({ content: '改一下', marks });
  assert.deepEqual(store.find((m) => m.id === msg.id).marks, marks);
  conv.handle({ type: 'display_message', sessionId: 's1', displayMessage: { id: 'srv1', role: 'user', content: '改一下', images: [] } });
  const users = store.filter((m) => m.role === 'user');
  assert.equal(users.length, 1);
  assert.deepEqual(users[0].marks, marks);
  assert.equal(users[0].optimistic, false);
});
