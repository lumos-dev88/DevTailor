'use strict';
// 极简工具状态（工具名 + 状态）：加载真实模块，不复刻实现。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../sidepanel/tool-status.js');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const NOW = 1_700_000_000_000;
/** 事件契约（Hub 侧同款）。 */
const ev = (toolStatus, extra = {}) => ({
  type: 'tool_status',
  tabId: 'tab_1',
  sessionId: 's1',
  toolName: 'Bash',
  requestId: 'req_1',
  toolStatus,
  ...extra,
});

/* ── normalize ───────────────────────────────────── */

test('normalize keeps the four displayable states', () => {
  for (const state of ['running', 'success', 'error', 'timeout']) {
    const n = ts.normalize(ev(state));
    assert.deepStrictEqual(n, { toolName: 'Bash', state, errorCode: '', durationMs: null });
  }
  assert.deepStrictEqual(ts.STATES, ['running', 'success', 'error', 'timeout']);
});

test('normalize tolerates junk input and never throws', () => {
  for (const junk of [undefined, null, 0, '', 'tool_status', [], () => {}, true]) {
    assert.strictEqual(ts.normalize(junk), null);
  }
});

test('normalize ignores the old canceled shape and anything without a toolName', () => {
  // 旧形态：{type:'tool_status', tabId, sessionId, toolStatus:'canceled'} —— 无 toolName
  assert.strictEqual(ts.normalize({ type: 'tool_status', tabId: 'tab_1', sessionId: 's1', toolStatus: 'canceled' }), null);
  assert.strictEqual(ts.normalize(ev('canceled')), null, 'canceled is not a displayable state');
  assert.strictEqual(ts.normalize(ev('running', { toolName: '' })), null);
  assert.strictEqual(ts.normalize(ev('running', { toolName: '   ' })), null);
  assert.strictEqual(ts.normalize(ev('running', { toolName: { nested: true } })), null);
  assert.strictEqual(ts.normalize({ toolName: 'Bash', toolStatus: 'in_progress' }), null);
  assert.strictEqual(ts.normalize({ toolName: 'Bash', toolStatus: 'done' }), null);
  assert.strictEqual(ts.normalize({ toolName: 'Bash' }), null);
});

test('normalize sanitises the tool name: single line, no control chars, 40 chars max', () => {
  const messy = ts.normalize(ev('running', { toolName: ' Bash:\n\t npm   test \u0000\u001b[31m ' }));
  assert.strictEqual(messy.toolName, 'Bash: npm test [31m');

  const long = 'x'.repeat(200);
  const n = ts.normalize(ev('running', { toolName: long }));
  assert.strictEqual(n.toolName.length, ts.MAX_TOOL_NAME);
  assert.strictEqual(ts.MAX_TOOL_NAME, 40);
  assert.ok(n.toolName.endsWith('…'));
  assert.doesNotMatch(n.toolName, /….*…/);
  assert.doesNotMatch(n.toolName, /[\u0000-\u001f]/);
});

test('normalize keeps errorCode and durationMs when usable', () => {
  const n = ts.normalize(ev('error', { errorCode: 'permission_denied', durationMs: 1234.6 }));
  assert.strictEqual(n.errorCode, 'permission_denied');
  assert.strictEqual(n.durationMs, 1235);
  assert.strictEqual(ts.normalize(ev('running', { durationMs: -1 })).durationMs, null);
  assert.strictEqual(ts.normalize(ev('running', { durationMs: 'soon' })).durationMs, null);
  assert.strictEqual(ts.normalize(ev('running', { errorCode: { a: 1 } })).errorCode, '');
});

/* ── model / hide delays ─────────────────────────── */

test('model renders 「工具名 · 状态」', () => {
  const running = ts.model(ts.normalize(ev('running')));
  assert.strictEqual(running.visible, true);
  assert.strictEqual(running.state, 'running');
  assert.strictEqual(running.text, 'Bash · 进行中');
  assert.strictEqual(running.title, 'Bash · 进行中');
  assert.strictEqual(running.hideInMs, 0, 'running stays until the next event / clear');

  assert.strictEqual(ts.model(ts.normalize(ev('success'))).text, 'Bash · 成功');
  assert.strictEqual(ts.model(ts.normalize(ev('error'))).text, 'Bash · 失败');
  assert.strictEqual(ts.model(ts.normalize(ev('timeout'))).text, 'Bash · 超时');
});

test('model auto-hide delays: success ~2.5s, error/timeout ~5s, running never', () => {
  assert.strictEqual(ts.model(ts.normalize(ev('success'))).hideInMs, 2500);
  assert.strictEqual(ts.model(ts.normalize(ev('error'))).hideInMs, 5000);
  assert.strictEqual(ts.model(ts.normalize(ev('timeout'))).hideInMs, 5000);
  assert.strictEqual(ts.model(ts.normalize(ev('running'))).hideInMs, 0);
  assert.strictEqual(ts.SUCCESS_HIDE_MS, 2500);
  assert.strictEqual(ts.FAILURE_HIDE_MS, 5000);
});

test('model puts duration / errorCode in the title only', () => {
  const m = ts.model(ts.normalize(ev('error', { errorCode: 'tool_failed', durationMs: 1400 })));
  assert.strictEqual(m.text, 'Bash · 失败');
  assert.match(m.title, /tool_failed/);
  assert.match(m.title, /耗时 1\.4s/);
  const fast = ts.model(ts.normalize(ev('success', { durationMs: 820 })));
  assert.match(fast.title, /耗时 820ms/);
});

test('model hides on anything unusable', () => {
  for (const value of [null, undefined, {}, { state: 'running' }, { state: 'canceled', toolName: 'Bash' }]) {
    const m = ts.model(value);
    assert.strictEqual(m.visible, false);
    assert.strictEqual(m.text, '');
    assert.strictEqual(m.state, '');
  }
});

test('formatDuration boundaries', () => {
  assert.strictEqual(ts.formatDuration(0), '0ms');
  assert.strictEqual(ts.formatDuration(999), '999ms');
  assert.strictEqual(ts.formatDuration(1000), '1.0s');
  assert.strictEqual(ts.formatDuration(9999), '10.0s');
  assert.strictEqual(ts.formatDuration(12_000), '12s');
  assert.strictEqual(ts.formatDuration(65_000), '1m05s');
  assert.strictEqual(ts.formatDuration(-1), '');
  assert.strictEqual(ts.formatDuration(NaN), '');
  assert.strictEqual(ts.formatDuration('nope'), '');
});

/* ── create(): minimal fake DOM + fake timers ────── */

/** Hand-rolled element stub (no jsdom in this repo). */
function el() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: '',
    title: '',
    attrs: {},
    classes,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return this.attrs[name]; },
  };
}

function harness() {
  const elements = { root: el(), text: el() };
  const timers = new Map();
  let seq = 0;
  let clock = NOW;
  const api = ts.create({
    elements,
    now: () => clock,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms, at: clock }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    api,
    elements,
    timers,
    advance(ms) {
      clock += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (clock >= t.at + t.ms) { timers.delete(id); t.fn(); }
      }
    },
  };
}

test('create starts hidden', () => {
  const h = harness();
  assert.strictEqual(h.elements.root.hidden, true);
  assert.strictEqual(h.elements.text.textContent, '');
  assert.strictEqual(h.timers.size, 0);
});

test('create shows 「工具名 · 进行中」 for running and keeps it', () => {
  const h = harness();
  h.api.update(ev('running'));
  assert.strictEqual(h.elements.root.hidden, false);
  assert.strictEqual(h.elements.text.textContent, 'Bash · 进行中');
  assert.ok(h.elements.root.classes.has('tool-status--running'));
  assert.strictEqual(h.elements.root.getAttribute('data-state'), 'running');
  assert.strictEqual(h.timers.size, 0, 'running has no auto-hide timer');
  h.advance(60_000);
  assert.strictEqual(h.elements.root.hidden, false);
});

test('create hides a success after ~2.5s and a failure after ~5s', () => {
  const h = harness();
  h.api.update(ev('success', { toolName: 'Read' }));
  assert.strictEqual(h.elements.text.textContent, 'Read · 成功');
  const [timer] = [...h.timers.values()];
  assert.strictEqual(timer.ms, ts.SUCCESS_HIDE_MS);
  h.advance(2000);
  assert.strictEqual(h.elements.root.hidden, false, 'still visible after 2s');
  h.advance(600);
  assert.strictEqual(h.elements.root.hidden, true, 'hidden after ~2.5s');
  assert.strictEqual(h.elements.text.textContent, '');
  assert.strictEqual(h.timers.size, 0);

  h.api.update(ev('error', { toolName: 'Bash', errorCode: 'tool_failed' }));
  assert.strictEqual(h.elements.text.textContent, 'Bash · 失败');
  assert.strictEqual([...h.timers.values()][0].ms, ts.FAILURE_HIDE_MS);
  h.advance(4000);
  assert.strictEqual(h.elements.root.hidden, false, 'failures stay longer than successes');
  h.advance(1200);
  assert.strictEqual(h.elements.root.hidden, true);

  h.api.update(ev('timeout', { toolName: 'Grep' }));
  assert.strictEqual(h.elements.text.textContent, 'Grep · 超时');
  assert.strictEqual([...h.timers.values()][0].ms, ts.FAILURE_HIDE_MS);
});

test('create: a new running event overrides a pending auto-hide', () => {
  const h = harness();
  h.api.update(ev('success', { toolName: 'Read' }));
  assert.strictEqual(h.timers.size, 1);
  h.api.update(ev('running', { toolName: 'Bash' }));
  assert.strictEqual(h.elements.text.textContent, 'Bash · 进行中');
  assert.strictEqual(h.timers.size, 0, 'the old hide timer is cancelled');
  assert.ok(h.elements.root.classes.has('tool-status--running'));
  assert.ok(!h.elements.root.classes.has('tool-status--success'));
  h.advance(10_000);
  assert.strictEqual(h.elements.root.hidden, false);
});

test('create: concurrent tools only show the latest one', () => {
  const h = harness();
  h.api.update(ev('running', { toolName: 'Bash', requestId: 'r1' }));
  h.api.update(ev('running', { toolName: 'Read', requestId: 'r2' }));
  assert.strictEqual(h.elements.text.textContent, 'Read · 进行中');
  h.api.update(ev('success', { toolName: 'Read', requestId: 'r2' }));
  assert.strictEqual(h.elements.text.textContent, 'Read · 成功');
});

test('create ignores the old canceled shape (no toolName) without touching the display', () => {
  const h = harness();
  h.api.update(ev('running', { toolName: 'Bash' }));
  h.api.update({ type: 'tool_status', tabId: 'tab_1', sessionId: 's1', toolStatus: 'canceled' });
  assert.strictEqual(h.elements.root.hidden, false, 'canceled must not clear the line here');
  assert.strictEqual(h.elements.text.textContent, 'Bash · 进行中');
  assert.strictEqual(h.timers.size, 0);
});

test('create.clear() hides immediately and cancels the pending auto-hide (done / reset / SSE down)', () => {
  const h = harness();
  h.api.update(ev('error', { toolName: 'Bash' }));
  assert.strictEqual(h.timers.size, 1);
  h.api.clear();
  assert.strictEqual(h.elements.root.hidden, true);
  assert.strictEqual(h.elements.text.textContent, '');
  assert.strictEqual(h.elements.root.title, '');
  assert.strictEqual(h.timers.size, 0);
  assert.strictEqual(h.elements.root.classes.size, 0);
  assert.strictEqual(h.elements.root.getAttribute('data-state'), undefined);
});

test('create writes the tool name with textContent (never markup)', () => {
  const h = harness();
  const name = '<img src=x onerror=alert(1)>';
  h.api.update(ev('running', { toolName: name }));
  assert.strictEqual(h.elements.text.textContent, `${name} · 进行中`);
  assert.strictEqual(h.elements.text.innerHTML, undefined, 'the module only uses textContent');
  const truncated = ts.normalize(ev('running', { toolName: name }));
  assert.ok(truncated.toolName.length <= ts.MAX_TOOL_NAME);
});

test('create re-renders after a hide when the same state comes back', () => {
  const h = harness();
  h.api.update(ev('running', { toolName: 'Bash' }));
  h.api.clear();
  h.api.update(ev('running', { toolName: 'Bash' }));
  assert.strictEqual(h.elements.text.textContent, 'Bash · 进行中');
  assert.ok(h.elements.root.classes.has('tool-status--running'));
  // el() stubs default hidden=false above; assert what the module set
  assert.strictEqual(h.elements.root.hidden, false);
});

/* ── wiring smoke tests against the real side panel files ── */

test('sidepanel.html renders the tool status in the session bar with the ids sidepanel.js queries', () => {
  const html = read('sidepanel/sidepanel.html');
  const bar = /<div class="session-bar"[\s\S]*?<\/div>/.exec(html);
  assert.ok(bar, 'session bar not found');
  for (const id of ['tool-status', 'tool-status-text']) {
    assert.match(bar[0], new RegExp(`id="${id}"`), `#${id} must live in the session bar`);
    assert.match(read('sidepanel/sidepanel.js'), new RegExp(`\\$\\('#${id}'\\)`), `sidepanel.js must query #${id}`);
  }
  assert.match(bar[0], /role="status"/);
  assert.match(bar[0], /aria-live="polite"/);
  assert.match(bar[0], /id="tool-status"[^>]*hidden/);
  // the status line is not part of the message stream
  assert.ok(html.indexOf('id="tool-status"') < html.indexOf('<main class="stream"'));
  // the old pill and the dead #thinking dots are gone
  assert.doesNotMatch(html, /agent-status/);
  assert.doesNotMatch(html, /id="thinking"/);
  assert.doesNotMatch(html, /thinking__dot/);
});

test('sidepanel.html loads tool-status.js before sidepanel.js', () => {
  const html = read('sidepanel/sidepanel.html');
  const mod = html.indexOf('src="tool-status.js"');
  const panel = html.indexOf('src="sidepanel.js"');
  assert.ok(mod > -1, 'tool-status.js must be loaded');
  assert.ok(panel > mod, 'tool-status.js must load before sidepanel.js');
  assert.strictEqual(html.indexOf('src="agent-status.js"'), -1, 'agent-status.js must be gone');
});

test('sidepanel.js no longer mentions the old AI status pill', () => {
  const js = read('sidepanel/sidepanel.js');
  assert.doesNotMatch(js, /agent_status/);
  assert.doesNotMatch(js, /agentStatus/);
  assert.doesNotMatch(js, /agent-status/);
  assert.doesNotMatch(js, /__sidepanelAgentStatus/);
});

test('sidepanel.js wires the new tool_status shape and clears on done / disconnect', () => {
  const js = read('sidepanel/sidepanel.js');
  assert.match(js, /window\.__domReview\.toolStatus\.create/);
  assert.match(js, /case 'tool_status':/);
  assert.match(js, /toolStatus\.update\(msg\)/);
  assert.match(js, /onToolStatus: \(ev\) => toolStatus\.update\(ev\)/);
  // tool_status is no longer a global event: the normal tabId filter applies
  assert.doesNotMatch(js, /globalEvent/);
  // bridge offline -> clear
  const offline = /bridgeReachable = false;[\s\S]{0,200}toolStatus\.clear\(\)/.exec(js);
  assert.ok(offline, 'refreshStatus failure branch must clear the line');
  // SSE error branch also clears it
  const sseError = /sseConnected = false;[\s\S]{0,200}toolStatus\.clear\(\)/.exec(js);
  assert.ok(sseError, 'SSE error branch must clear the line');
  // done / session_reset clear it too
  assert.match(js, /msg\.type === 'session_reset'[\s\S]{0,120}toolStatus\.clear\(\)/);
  assert.match(js, /kind === 'reset'\) toolStatus\.clear\(\)/);
});

test('every id queried by sidepanel.js with $() exists in sidepanel.html', () => {
  const html = read('sidepanel/sidepanel.html');
  const js = read('sidepanel/sidepanel.js');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...js.matchAll(/\$\('#([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(refs.size > 20, 'expected the panel to query a good number of ids');
  const missing = [...refs].filter((id) => !ids.has(id));
  assert.deepStrictEqual(missing, [], `ids missing from sidepanel.html: ${missing.join(', ')}`);
});

test('sidepanel.css styles the tool status and dropped the old pill / thinking dots', () => {
  const css = read('sidepanel/sidepanel.css');
  assert.match(css, /\.tool-status \{/);
  assert.match(css, /\.tool-status\[hidden\] \{\s*display: none;/);
  assert.match(css, /\.tool-status--running \.tool-status__dot/);
  assert.match(css, /\.tool-status--error/);
  assert.match(css, /\.tool-status--timeout/);
  assert.match(css, /\.tool-status--success/);
  // dark mode + reduced motion are handled for the new element
  const dark = /@media \(prefers-color-scheme: dark\) \{[\s\S]*?\.tool-status--success[\s\S]*?\n\}/.exec(css);
  assert.ok(dark, 'dark mode must restyle the tool status');
  const reduce = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.tool-status--running \.tool-status__dot \{[\s\S]*?animation: none;[\s\S]*?\n\}/.exec(css);
  assert.ok(reduce, 'prefers-reduced-motion must drop the pulse animation');
  // old rules are gone, the shared loading dots survive
  assert.doesNotMatch(css, /agent-status/);
  assert.doesNotMatch(css, /\.thinking\b/);
  assert.doesNotMatch(css, /thinking__dot/);
  assert.match(css, /^\.dt-loading-dots \{/m);
  assert.match(css, /\.dt-loading-dots span \{/);
  assert.match(css, /\.dt-loading-dots span:nth-child\(1\) \{/);
  // the rule right after the block must survive
  assert.match(css, /\.prompt-ctx\[hidden\] \{\s*display: none;/);
});

test('loading tool-status.js in a browser-like global exposes the same API on window', () => {
  const file = path.join(root, 'sidepanel/tool-status.js');
  const sandbox = { window: {}, Date, console, setTimeout: () => 0, clearTimeout: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const api = sandbox.window.__domReview?.toolStatus;
  assert.ok(api, 'window.__domReview.toolStatus must be defined');
  assert.deepStrictEqual(Object.keys(api).sort(), [
    'FAILURE_HIDE_MS', 'MAX_ERROR_CODE', 'MAX_TOOL_NAME', 'STATES', 'STATE_TEXT', 'SUCCESS_HIDE_MS',
    'asText', 'create', 'formatDuration', 'hideDelay', 'model', 'normalize',
  ]);
  void ts;
});
