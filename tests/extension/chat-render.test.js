'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../../content/modules/bridge-core.js');
const render = require('../../content/modules/chat-render.js');

const card = (extra = {}) => ({
  ...core.createApproval({
    approvalId: 'a1', sessionId: 's', toolName: 'Bash', action: 'rm -rf build',
    detail: { kind: 'execute', rawInput: { command: 'rm -rf build' }, locations: [{ path: '/p/build' }], content: [] },
  }, { now: 0 }),
  ...extra,
});

test('approval card: observer is read-only, final states show the outcome and no buttons', () => {
  const observer = render.renderApprovalCard(card({ observing: true }));
  assert.doesNotMatch(observer, /data-action="approval-decision"/);
  assert.match(observer, /等待/);
  assert.match(observer, /rm -rf build/);
  assert.match(observer, /\/p\/build/);
  const timeout = render.renderApprovalCard(card({ status: 'timeout' }));
  assert.match(timeout, /已超时，按拒绝处理/);
  assert.doesNotMatch(timeout, /<button/);
  assert.match(render.renderApprovalCard(card({ status: 'cancelled' })), /自动失效/);
  assert.match(render.renderApprovalCard(card({ status: 'approved' })), /已允许/);
  assert.match(render.renderApprovalCard(card({ status: 'submitting' })), /提交中/);
});

test('approval card: 允许 / 拒绝 buttons; string detail is shown truncated', () => {
  const relay = core.createApproval({
    approvalId: 'p1', toolName: 'Bash', action: '执行 shell 命令', risk: 'medium',
    detail: 'x'.repeat(2000),
  }, { now: 0 });
  assert.deepStrictEqual(relay.detail, { preview: 'x'.repeat(2000) });
  const html = render.renderApprovalCard(relay);
  assert.strictEqual((html.match(/data-action="approval-decision"/g) || []).length, 2);
  assert.match(html, /data-decision="approved"/);
  assert.match(html, /data-decision="rejected"/);
  assert.match(html, />允许</);
  assert.match(html, />拒绝</);
  assert.match(html, /dt-approval-btn--primary/);
  assert.match(html, /执行 shell 命令/);
  // input_preview is capped so a huge command cannot blow up the card
  const preview = html.match(/<pre class="dt-approval-params">([\s\S]*?)<\/pre>/)[1];
  assert.ok(preview.length <= 601, `preview should be truncated, got ${preview.length}`);
  // observer / final states still show no buttons
  assert.doesNotMatch(render.renderApprovalCard({ ...relay, observing: true }), /<button/);
  assert.doesNotMatch(render.renderApprovalCard({ ...relay, status: 'approved' }), /<button/);
});

test('rendered text is escaped: tool names and params', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = render.renderApprovalCard(card({
    toolName: evil, action: evil, risk: evil,
    detail: { rawInput: { command: evil }, content: [{ type: 'diff', path: evil, oldText: evil, newText: evil + '2' }] },
  }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(render.renderNotice({ id: 'n', content: evil }), /&lt;img/);
  assert.strictEqual(render.inlineText('跑 `claude` <b>'), '跑 <code>claude</code> &lt;b&gt;');
});

test('history marking', () => {
  assert.match(render.markHistory('<div class="dt-chat-md">x</div>', { history: true }), /^<div class="dt-is-history dt-chat-md">/);
  assert.match(render.markHistory('\n   <div class="dt-notice ">', { history: true }), /dt-is-history/);
  assert.strictEqual(render.markHistory('<div class="a">', { history: false }), '<div class="a">');
  assert.strictEqual(render.markHistory(null, { history: true }), null);
});
