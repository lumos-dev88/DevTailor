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
  const state = { open: true, top: 123.4, left: 10 };
  const stored = tb.serializeState(state);
  assert.deepStrictEqual(stored, { v: 1, open: false, top: 123, left: 10 }); // `open` is legacy, never persisted
  assert.deepStrictEqual(tb.parseState(stored), { open: false, top: 123, left: 10 });
  assert.deepStrictEqual(tb.parseState(JSON.stringify(stored)), { open: false, top: 123, left: 10 });
  // a legacy value carrying `open: true` still loads (tolerated, not honoured)
  assert.deepStrictEqual(tb.parseState({ v: 1, open: true, top: 7 }), { open: true, top: 7, left: null });
});

test('parseState tolerates corrupt, foreign and legacy values and falls back to defaults', () => {
  const def = { open: false, top: null, left: null };
  for (const bad of [undefined, null, 0, 'oops', '{not json', '[]', [], 42, true, '"text"']) {
    assert.deepStrictEqual(tb.parseState(bad), def, String(bad));
  }
  assert.deepStrictEqual(tb.parseState({ open: 'yes', top: '100', left: 'x' }), def); // wrong types
  assert.deepStrictEqual(tb.parseState({ open: true, top: NaN }), { open: true, top: null, left: null });
  assert.deepStrictEqual(tb.parseState({ open: true, top: Infinity }), { open: true, top: null, left: null });
  assert.deepStrictEqual(tb.parseState({ open: 1 }), def);                           // only literal true opens
  assert.deepStrictEqual(tb.parseState({ open: true, top: 0 }), { open: true, top: 0, left: null });
  assert.deepStrictEqual(tb.parseState({ open: true, top: 12, left: 0 }), { open: true, top: 12, left: 0 }); // 0 is a real position
  assert.deepStrictEqual(tb.parseState({ open: true, top: 40 }), { open: true, top: 40, left: null });       // legacy: no left yet
  assert.deepStrictEqual(tb.serializeState(undefined), { v: 1, open: false, top: null, left: null });
});

// ---------------------------------------------------------------- position

test('clampPosition keeps the bar on screen on both axes, allowing both edges and 0', () => {
  const c = (left, top, vw = 800, vh = 600, w = 48, h = 340) => tb.clampPosition({ left, top }, vw, vh, w, h);
  assert.deepStrictEqual(c(-50, -20), { left: 0, top: 0 });
  assert.deepStrictEqual(c(10, 10), { left: 10, top: 10 });
  assert.deepStrictEqual(c(790, 590), { left: 752, top: 260 });   // clamped into the viewport
  assert.deepStrictEqual(c(NaN, undefined), { left: 0, top: 0 });
  assert.deepStrictEqual(c(12.6, 4.2), { left: 13, top: 4 });
  assert.deepStrictEqual(c(10, 200, 100, 500, 48, 340), { left: 10, top: 160 }); // narrow viewport (clamped top)
});

test('defaultPosition docks left, on screen, a little above the middle', () => {
  for (const [vw, vh, w, h] of [[1200, 900, 48, 340], [600, 400, 48, 340], [200, 200, 48, 340]]) {
    const p = tb.defaultPosition(vw, vh, w, h);
    assert.strictEqual(p.left, 0);
    assert.ok(p.top >= 0 && p.top + h <= Math.max(vh, h), `${vw}x${vh} -> ${JSON.stringify(p)}`);
  }
  const p = tb.defaultPosition(1200, 900, 48, 340);
  assert.ok(p.top < (900 - 340) / 2 && p.top > 100, `top=${p.top}`);
});

test('resolvePosition re-clamps a remembered position after the window shrank and fills missing axes', () => {
  assert.deepStrictEqual(tb.resolvePosition({ top: 700, left: 120 }, 500, 300, 48, 300), { left: 120, top: 0 });
  const def = tb.defaultPosition(800, 600, 48, 340);
  assert.deepStrictEqual(tb.resolvePosition({ top: null, left: null }, 800, 600, 48, 340), def);
  assert.deepStrictEqual(tb.resolvePosition({ top: 40, left: 8 }, 800, 600, 48, 340), { left: 8, top: 40 });
  assert.deepStrictEqual(tb.resolvePosition({ top: 40 }, 800, 600, 48, 340), { left: def.left, top: 40 }); // legacy state
});

// -------------------------------------------------------------- shortcuts

test('matchShortcut: plain V/S/R fire; modifiers, IME composition and unknown keys do not', () => {
  assert.strictEqual(tb.matchShortcut('v'), 'pick');
  assert.strictEqual(tb.matchShortcut('V'), 'pick');
  assert.strictEqual(tb.matchShortcut('s'), 'screenshot');
  assert.strictEqual(tb.matchShortcut('S'), 'screenshot');
  assert.strictEqual(tb.matchShortcut('r'), 'reference');
  assert.strictEqual(tb.matchShortcut('R'), 'reference');
  assert.deepStrictEqual([...Object.keys(tb.SHORTCUTS)].sort(), ['r', 's', 'v']);
  assert.strictEqual(tb.matchShortcut('Escape'), null);
  assert.strictEqual(tb.matchShortcut('Enter'), null);
  assert.strictEqual(tb.matchShortcut('x'), null);
  assert.strictEqual(tb.matchShortcut(null), null);
  assert.strictEqual(tb.matchShortcut('v', { modifierKeys: [true, false] }), null); // ctrl/meta held
  assert.strictEqual(tb.matchShortcut('v', { modifierKeys: [] }), 'pick');
  assert.strictEqual(tb.matchShortcut('v', { composing: true }), null);            // IME composition
  assert.strictEqual(tb.matchShortcut('r', { modifierKeys: [false, false, false] }), 'reference');
  assert.strictEqual(tb.matchShortcut('Process'), null);
});

function fakeEl(tag) {
  const name = String(tag);
  return {
    tagName: name.toUpperCase(),
    matches: (sel) => sel.split(',').some((part) => {
      const s = part.trim();
      return s === name || s.startsWith(`${name}[`) || s.startsWith(`${name}:`) || s.startsWith(`${name}.`);
    }),
  };
}

test('isEditableTarget sees through shadow roots and nested active elements', () => {
  const doc = { activeElement: null };
  assert.strictEqual(tb.isEditableTarget(null, doc), false);
  assert.strictEqual(tb.isEditableTarget(fakeEl('input'), doc), true);
  assert.strictEqual(tb.isEditableTarget(fakeEl('textarea'), doc), true);
  assert.strictEqual(tb.isEditableTarget(fakeEl('select'), doc), true);
  assert.strictEqual(tb.isEditableTarget(fakeEl('div'), doc), false);

  // deepest active element inside a shadow root wins over the host
  const inner = fakeEl('textarea');
  const host = { shadowRoot: { activeElement: inner } };
  doc.activeElement = host;
  assert.strictEqual(tb.deepActiveElement(doc, host), inner);
  assert.strictEqual(tb.deepActiveElement(doc, null), host);
  assert.strictEqual(tb.isEditableTarget(host, doc), true);   // host is not editable, but its active descendant is
});

test('isEditableEvent follows the composed path before falling back to the active element', () => {
  const doc = { activeElement: fakeEl('input') };
  const inText = { composedPath: () => [fakeEl('span'), fakeEl('input')] };
  const onPlain = { composedPath: () => [fakeEl('div')] };
  const noPath = {};
  assert.strictEqual(tb.isEditableEvent(inText, doc), true);
  assert.strictEqual(tb.isEditableEvent(onPlain, doc), true); // fallback: page has focus in a text field
  doc.activeElement = fakeEl('div');
  assert.strictEqual(tb.isEditableEvent(onPlain, doc), false);
  assert.strictEqual(tb.isEditableEvent(noPath, doc), false);
  assert.strictEqual(tb.isEditableEvent(null, doc), false);
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
