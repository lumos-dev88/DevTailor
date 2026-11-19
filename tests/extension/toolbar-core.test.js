'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tb = require('../../content/modules/toolbar-core.js');
const bridgeCore = require('../../content/modules/bridge-core.js');

// ------------------------------------------------------------------- state

test('stateKey separates origins', () => {
  assert.notStrictEqual(tb.stateKey('http://localhost:3000'), tb.stateKey('http://localhost:5173'));
  assert.ok(tb.stateKey('http://a').startsWith('dt_toolbar:'));
});

test('serializeState / parseState round-trip, also through JSON text', () => {
  const state = { open: true, top: 123.4 };
  const stored = tb.serializeState(state);
  assert.deepStrictEqual(stored, { v: 1, open: true, top: 123 });
  assert.deepStrictEqual(tb.parseState(stored), { open: true, top: 123 });
  assert.deepStrictEqual(tb.parseState(JSON.stringify(stored)), { open: true, top: 123 });
});

test('parseState tolerates corrupt or foreign data and falls back to defaults', () => {
  const def = { open: false, top: null };
  for (const bad of [undefined, null, 0, 'oops', '{not json', '[]', [], 42, true, '"text"']) {
    assert.deepStrictEqual(tb.parseState(bad), def, String(bad));
  }
  assert.deepStrictEqual(tb.parseState({ open: 'yes', top: '100' }), def);          // wrong types
  assert.deepStrictEqual(tb.parseState({ open: true, top: NaN }), { open: true, top: null });
  assert.deepStrictEqual(tb.parseState({ open: true, top: Infinity }), { open: true, top: null });
  assert.deepStrictEqual(tb.parseState({ open: 1 }), def);                           // only literal true opens
  assert.deepStrictEqual(tb.parseState({ open: true, top: 0 }), { open: true, top: 0 }); // 0 is a real position
  assert.deepStrictEqual(tb.serializeState(undefined), { v: 1, open: false, top: null });
});

// ---------------------------------------------------------------- position

test('clampTop keeps the toolbar on screen, allows both edges and 0', () => {
  assert.strictEqual(tb.clampTop(-50, 800, 300), 0);
  assert.strictEqual(tb.clampTop(0, 800, 300), 0);
  assert.strictEqual(tb.clampTop(250, 800, 300), 250);
  assert.strictEqual(tb.clampTop(500, 800, 300), 500);
  assert.strictEqual(tb.clampTop(501, 800, 300), 500);
  assert.strictEqual(tb.clampTop(99999, 800, 300), 500);
  assert.strictEqual(tb.clampTop(10, 200, 300), 0);          // viewport shorter than the bar
  assert.strictEqual(tb.clampTop(NaN, 800, 300), 0);
  assert.strictEqual(tb.clampTop(12.6, 800, 300), 13);
});

test('defaultTop is on screen, roughly centred and a little above the middle', () => {
  for (const [vh, h] of [[900, 340], [600, 340], [320, 340], [1400, 340]]) {
    const top = tb.defaultTop(vh, h);
    assert.ok(top >= 0 && top + h <= Math.max(vh, h), `${vh}x${h} -> ${top}`);
  }
  const top = tb.defaultTop(900, 340);
  assert.ok(top < (900 - 340) / 2 && top > 100, `top=${top}`);
});

test('resolveTop re-clamps a remembered position after the window shrank', () => {
  assert.strictEqual(tb.resolveTop({ top: 700 }, 500, 300), 200);
  assert.strictEqual(tb.resolveTop({ top: null }, 800, 300), tb.defaultTop(800, 300));
  assert.strictEqual(tb.resolveTop({ top: 40 }, 800, 300), 40);
});

// --------------------------------------------------------------- approvals

test('approval tracker counts distinct pending approvals and resolves them', () => {
  const t = tb.createApprovalTracker();
  assert.strictEqual(t.count(), 0);
  assert.strictEqual(t.handle({ type: 'approval_request', approvalId: 'a1' }), true);
  assert.strictEqual(t.handle({ type: 'approval_pending', approvalId: 'a1' }), false);  // same one, seen by another UI
  assert.strictEqual(t.handle({ type: 'approval_pending', approvalId: 'a2' }), true);
  assert.strictEqual(t.count(), 2);
  assert.strictEqual(t.handle({ type: 'approval_resolved', approvalId: 'a1', decision: 'approved' }), true);
  assert.strictEqual(t.count(), 1);
  assert.strictEqual(t.handle({ type: 'approval_resolved', approvalId: 'ghost' }), false);
  assert.strictEqual(t.handle({ type: 'stream', delta: 'x' }), false);
  assert.strictEqual(t.handle(null), false);
});

test('approvals expire like the bridge timeout, reset on disconnect and on a session reset', () => {
  let now = 1000;
  const t = tb.createApprovalTracker({ now: () => now });
  t.handle({ type: 'approval_request', approvalId: 'a1' });
  now += tb.APPROVAL_TTL_MS - 1;
  assert.strictEqual(t.count(), 1);
  now += 2;
  assert.strictEqual(t.count(), 0);

  t.handle({ type: 'approval_request', approvalId: 'a2' });
  assert.strictEqual(t.reset(), true);
  assert.strictEqual(t.reset(), false);
  t.handle({ type: 'approval_request', approvalId: 'a3' });
  assert.strictEqual(t.handle({ type: 'session_reset' }), true);
  assert.strictEqual(t.count(), 0);
});

// ------------------------------------------------------------ takeover dot

test('takeoverModel: offline shows the start command from bridge-core and retries on click', () => {
  const m = tb.takeoverModel({ status: 'disconnected', active: false, startCommand: bridgeCore.BRIDGE_START_COMMAND });
  assert.strictEqual(m.key, 'offline');
  assert.strictEqual(m.action, 'reconnect');
  assert.ok(m.tip.includes(bridgeCore.BRIDGE_START_COMMAND));
  assert.strictEqual(tb.BRIDGE_START_COMMAND, bridgeCore.BRIDGE_START_COMMAND);
  assert.strictEqual(tb.takeoverModel({ status: 'connecting', active: true }).key, 'offline');
});

test('takeoverModel: connected tabs toggle between "连接当前页" and "取消接管"', () => {
  const idle = tb.takeoverModel({ status: 'connected', active: false });
  assert.deepStrictEqual([idle.key, idle.label, idle.action], ['idle', '未接管', 'activate']);
  const taken = tb.takeoverModel({ status: 'connected', active: true });
  assert.deepStrictEqual([taken.key, taken.label, taken.action], ['taken', '已接管', 'release']);
  const releasing = tb.takeoverModel({ status: 'disconnected', active: true, releasing: true });
  assert.deepStrictEqual([releasing.key, releasing.action], ['releasing', 'none']);
});
