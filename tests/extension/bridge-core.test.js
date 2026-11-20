'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../../content/modules/bridge-core.js');
const render = require('../../content/modules/chat-render.js');

// ---------------------------------------------------------------- error copy
test('errorInfo maps bridge codes to actionable copy', () => {
  assert.match(core.errorInfo('no_claude_instance').text, /Claude Code/);
  assert.match(core.errorInfo('no_claude_instance').text, /`claude-devtailor\.sh`.*devtailor-hub/);
  // 429 / review_queue_full is gone: an unknown code falls back to the server message
  assert.match(core.errorInfo('review_queue_full', { message: '服务端文案' }).text, /服务端文案/);
  assert.match(core.errorInfo('client_not_connected').text, /连接当前页/);
  assert.match(core.errorInfo('auth_required').text, /`claude`/);
  assert.strictEqual(core.errorInfo('auth_required').kind, 'auth');
  assert.match(core.errorInfo('bridge_offline').text, /Hub 未连接.*fh hub status/);
  assert.strictEqual(core.errorInfo('bridge_offline').kind, 'offline');
  assert.match(core.errorInfo('gone').text, /更新扩展/);
  assert.match(core.errorInfo('something_new', { message: '自定义', status: 500 }).text, /自定义/);
  assert.match(core.errorInfo('', { status: 500 }).text, /500/);
  assert.strictEqual(core.errorInfo('something_new', { status: 500 }).kind, 'generic');
});

test('parseProxyResponse: unreachable bridge, JSON error bodies, success', () => {
  const offline = core.parseProxyResponse({ ok: false, status: 0, error: 'fetch failed' });
  assert.strictEqual(offline.ok, false);
  assert.strictEqual(offline.code, 'bridge_offline');
  assert.strictEqual(offline.reachable, false);
  const auth = core.parseProxyResponse({ ok: false, status: 401, body: JSON.stringify({ ok: false, code: 'auth_required', error: '登录失效' }) });
  assert.strictEqual(auth.code, 'auth_required');
  assert.strictEqual(core.failureInfo(auth).kind, 'auth');
  // Hub style: the error code lives in `error`, the human text in `message`
  const noClaude = core.parseProxyResponse({ ok: false, status: 503, body: JSON.stringify({ ok: false, error: 'no_claude_instance', message: 'no live claude' }) });
  assert.strictEqual(noClaude.ok, false);
  assert.strictEqual(noClaude.code, 'no_claude_instance');
  assert.strictEqual(noClaude.message, 'no live claude');
  assert.match(core.failureInfo(noClaude).text, /Claude Code/);
  // free-form `error` text (not a code) keeps working as the message
  const freeform = core.parseProxyResponse({ ok: false, status: 500, body: JSON.stringify({ ok: false, error: '登录失效 了' }) });
  assert.strictEqual(freeform.code, '');
  assert.match(core.failureInfo(freeform).text, /登录失效/);
  // 202 accepted
  const accepted = core.parseProxyResponse({ ok: true, status: 202, body: JSON.stringify({ ok: true, turnId: 't1', sessionId: 's1' }) });
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.data.turnId, 't1');
  // cancel with nothing to cancel is a success, not an error
  const nothing = core.parseProxyResponse({ ok: true, status: 200, body: JSON.stringify({ ok: true, canceled: false, reason: 'nothing_to_cancel' }) });
  assert.strictEqual(nothing.ok, true);
  assert.strictEqual(nothing.data.canceled, false);
  const good = core.parseProxyResponse({ ok: true, status: 200, body: JSON.stringify({ ok: true, sessions: [] }) });
  assert.strictEqual(good.ok, true);
  const garbage = core.parseProxyResponse({ ok: false, status: 502, body: '<html>' });
  assert.strictEqual(garbage.data, null);
  assert.match(core.failureInfo(garbage).text, /502/);
  assert.strictEqual(core.errorEventInfo({ code: 'auth_required', message: 'x' }).kind, 'auth');
  assert.match(core.errorEventInfo({ message: 'boom' }).text, /boom/);
});

test('promptContextModel summarizes what the last prompt carried', () => {
  const m = core.promptContextModel({ marks: 2, images: 1, designDocs: 1 });
  assert.strictEqual(m.empty, false);
  assert.strictEqual(m.label, '标记 2 · 截图 1 · 规范 1');
  assert.match(m.title, /2 个标记/);
  assert.match(m.title, /1 张截图/);
  assert.match(m.title, /1 份规范/);
  // zero parts are skipped; nothing at all is "empty" (the pill stays hidden)
  assert.strictEqual(core.promptContextModel({ marks: 0, images: 3, designDocs: 0 }).label, '截图 3');
  assert.strictEqual(core.promptContextModel({}).empty, true);
  assert.strictEqual(core.promptContextModel({ marks: -1, images: 'x' }).empty, true);
});

// ---------------------------------------------------------------- approvals
const request = (extra = {}) => ({
  type: 'approval_request', approvalId: 'a1', sessionId: 's', toolName: 'Bash', action: 'rm -rf build', risk: 'high',
  ...extra,
});

test('approval state machine: request -> submit -> result', () => {
  let card = core.createApproval(request(), { now: 1000 });
  assert.strictEqual(card.status, 'pending');
  assert.strictEqual(core.isApprovalInteractive(card), true);
  assert.strictEqual(card.expiresAt, 1000 + core.APPROVAL_TIMEOUT_MS);
  // unknown decision is refused
  assert.strictEqual(core.reduceApproval(card, { type: 'submit', decision: 'nope' }), card);
  card = core.reduceApproval(card, { type: 'submit', decision: 'approved' });
  assert.strictEqual(card.status, 'submitting');
  assert.strictEqual(core.isApprovalInteractive(card), false);
  const ok = core.reduceApproval(card, { type: 'submit_result', ok: true });
  assert.strictEqual(ok.status, 'approved');
  assert.match(core.approvalStatusText(ok), /^已允许$/);
  const rejected = core.reduceApproval(core.reduceApproval(core.createApproval(request(), { now: 1 }), { type: 'submit', decision: 'rejected' }), { type: 'submit_result', ok: true });
  assert.strictEqual(rejected.status, 'rejected');
  // 409 = decided elsewhere / gone; other failures are retryable
  assert.strictEqual(core.reduceApproval(card, { type: 'submit_result', ok: false, status: 409 }).status, 'expired');
  const retry = core.reduceApproval(card, { type: 'submit_result', ok: false, status: 0, error: '桥接未连接' });
  assert.strictEqual(retry.status, 'pending');
  assert.strictEqual(retry.error, '桥接未连接');
});

test('approval state machine: observer, resolved, cancel, timeout', () => {
  const observer = core.createApproval({ approvalId: 'a2', toolName: 'Bash' }, { observing: true, now: 0 });
  assert.strictEqual(core.isApprovalInteractive(observer), false);
  assert.match(core.approvalStatusText(observer), /等待/);
  assert.strictEqual(core.reduceApproval(observer, { type: 'submit', decision: 'approved' }), observer);
  const upgraded = core.reduceApproval(observer, { type: 'request', ev: request({ approvalId: 'a2' }) });
  assert.strictEqual(upgraded.observing, false);
  assert.strictEqual(upgraded.toolName, 'Bash');

  const resolvedOther = core.reduceApproval(upgraded, { type: 'resolved', ev: { decision: 'approved' } });
  assert.strictEqual(resolvedOther.status, 'approved');

  const timedOut = core.reduceApproval(upgraded, { type: 'resolved', ev: { decision: 'rejected', reason: 'timeout' } });
  assert.strictEqual(timedOut.status, 'timeout');
  assert.strictEqual(core.approvalStatusText(timedOut), '已超时，按拒绝处理');

  const cancelledEv = core.reduceApproval(upgraded, { type: 'resolved', ev: { decision: 'cancelled', reason: 'cancelled' } });
  assert.strictEqual(cancelledEv.status, 'cancelled');
  assert.match(core.approvalStatusText(cancelledEv), /自动失效/);

  const bySession = core.reduceApproval(upgraded, { type: 'session_cancelled', sessionId: 's' });
  assert.strictEqual(bySession.status, 'cancelled');
  assert.strictEqual(core.reduceApproval(upgraded, { type: 'session_cancelled', sessionId: 'other' }), upgraded);

  // final states are sticky; the late broadcast after our own click changes nothing
  assert.strictEqual(core.reduceApproval(resolvedOther, { type: 'resolved', ev: { decision: 'rejected', reason: 'timeout' } }), resolvedOther);
  assert.strictEqual(core.reduceApproval(resolvedOther, { type: 'session_cancelled', sessionId: 's' }), resolvedOther);

  // client-side fallback timer
  const fresh = core.createApproval(request(), { now: 0 });
  assert.strictEqual(core.reduceApproval(fresh, { type: 'tick', now: core.APPROVAL_TIMEOUT_MS - 1 }), fresh);
  assert.strictEqual(core.reduceApproval(fresh, { type: 'tick', now: core.APPROVAL_TIMEOUT_MS }).status, 'timeout');
  // an "expired" card is upgraded by the authoritative resolved event
  const expired = core.reduceApproval(core.reduceApproval(fresh, { type: 'submit', decision: 'rejected' }), { type: 'submit_result', ok: false, status: 409 });
  assert.strictEqual(core.reduceApproval(expired, { type: 'resolved', ev: { decision: 'approved' } }).status, 'approved');
});

// ---------------------------------------------------------------- status bar
test('statusModel priority: offline > connecting > auth > inactive > ready', () => {
  const s = (ctx) => core.statusModel({ bridge: 'connected', activeClient: true, ...ctx });
  assert.strictEqual(s({ bridge: 'disconnected' }).key, 'offline');
  assert.match(s({ bridge: 'disconnected' }).text, /Hub 未连接.*fh hub status/);
  assert.strictEqual(s({ bridge: 'connecting' }).key, 'connecting');
  assert.strictEqual(s({ bridge: 'connecting', retrying: true }).key, 'offline', 'reconnect attempts after a failure mean the bridge is down');
  assert.match(s({ authRequired: true }).text, /`claude`/);
  assert.match(s({ activeClient: false }).text, /连接当前页/);
  assert.strictEqual(s({}).tone, 'ok');
  assert.strictEqual(s({ agentLabel: 'Claude Code' }).text, 'Claude Code 已接管');
});
