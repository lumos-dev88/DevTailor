'use strict';
// get_page_snapshot 输出预算：fitSnapshotBudget 超限时从尾部丢元素并标注截断。
// accessibleLabel / assertText / isInViewport 的行为测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDomEnvironment } = require('./helpers');

function loadModule(env) {
  const window = env ? env.makeWindow() : {};
  const source = fs.readFileSync(path.join(__dirname, '../../content/modules/browser-action-dom.js'), 'utf8');
  const sandbox = { window, console };
  if (env) {
    sandbox.Element = env.FakeElement;
    sandbox.HTMLInputElement = env.FakeInput;
    sandbox.HTMLTextAreaElement = env.FakeTextarea;
    sandbox.HTMLSelectElement = env.FakeSelect;
    sandbox.getComputedStyle = env.getComputedStyle;
    sandbox.document = env.mountDocument();
    sandbox.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
  }
  vm.runInNewContext(source, sandbox);
  return { dom: window.__domReview.browserActionDom, env, window, document: sandbox.document };
}

function fakeSnapshot(count, textLength) {
  return {
    url: 'http://localhost/',
    snapshot: { level: 'interactive-only', maxElements: 80, returnedInteractiveElements: count },
    interactiveElements: Array.from({ length: count }, (_, i) => ({ elementId: `e_${i}`, text: 'x'.repeat(textLength) })),
  };
}

test('fitSnapshotBudget returns small snapshots unchanged', () => {
  const { dom } = loadModule();
  const input = fakeSnapshot(3, 10);
  assert.equal(dom.fitSnapshotBudget(input, 40000), input);
});

test('fitSnapshotBudget drops tail elements and marks truncation', () => {
  const { dom } = loadModule();
  const out = dom.fitSnapshotBudget(fakeSnapshot(50, 1000), 10000);
  assert.ok(JSON.stringify(out).length <= 10000);
  assert.equal(out.snapshot.truncated, true);
  assert.equal(out.snapshot.totalCandidates, 50);
  assert.equal(out.snapshot.returnedInteractiveElements, out.interactiveElements.length);
  assert.ok(out.interactiveElements.length > 0 && out.interactiveElements.length < 50);
  assert.equal(out.interactiveElements[0].elementId, 'e_0');
  assert.match(out.snapshot.hint, /roles/);
});

/* ── accessibleLabel：优先级取第一个非空来源，绝不拼接，绝不使用 id ── */

test('accessibleLabel never includes the element id (Radix button id must not leak)', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const button = env.element('button');
  button.setAttribute('id', 'radix-_r_j_');
  button.textContent = '系统';
  env.rect(button, { top: 0, left: 0, width: 100, height: 40 });
  env.append(document.body, button);
  const res = dom.assertElement({ selector: 'button', exists: true });
  assert.equal(res.ok, true);
  assert.ok(!res.element.label.includes('radix-_r_j_'));
  assert.ok(!res.element.label.includes('radix'));
});

test('accessibleLabel never includes the id when no other source is available', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const el = env.element('button');
  el.setAttribute('id', 'radix-_r_j_');
  env.rect(el, { top: 0, left: 0, width: 100, height: 40 });
  env.append(document.body, el);
  const res = dom.assertElement({ selector: 'button', exists: true });
  assert.equal(res.element.label, '');
});

test('accessibleLabel dedupes identical aria-label and title (no "卡片视图 卡片视图")', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const btn = env.element('button');
  btn.setAttribute('aria-label', '卡片视图');
  btn.setAttribute('title', '卡片视图');
  btn.textContent = 'x';
  env.rect(btn, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, btn);
  const res = dom.assertElement({ selector: 'button', exists: true });
  assert.equal(res.ok, true);
  assert.equal(res.element.label, '卡片视图');
});

test('accessibleLabel prefers aria-labelledby over aria-label and joins multiple ids', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const refA = env.element('span');
  refA.textContent = '保存';
  const refB = env.element('span');
  refB.textContent = '草稿';
  document.registerId('lbl-a', refA);
  document.registerId('lbl-b', refB);
  const btn = env.element('button');
  btn.setAttribute('aria-labelledby', 'lbl-a lbl-b');
  btn.setAttribute('aria-label', 'IGNORED');
  btn.textContent = 'x';
  env.rect(btn, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, btn);
  const res = dom.assertElement({ selector: 'button', exists: true });
  assert.equal(res.ok, true);
  assert.equal(res.element.label, '保存 草稿');
});

test('accessibleLabel falls back to <label for> text before placeholder/title/name', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const input = env.element('input');
  input.setAttribute('placeholder', 'fallback-ph');
  input.setAttribute('title', 'fallback-title');
  input.setAttribute('name', 'email');
  const label = env.element('label');
  label.textContent = '邮箱地址';
  input.labels = [label];
  env.rect(input, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, input);
  const res = dom.assertElement({ selector: 'input', exists: true });
  assert.equal(res.ok, true);
  assert.equal(res.element.label, '邮箱地址');
});

test('accessibleLabel falls back to placeholder then title then name (first non-empty wins)', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const input = env.element('input');
  input.setAttribute('placeholder', '请输入关键词');
  input.setAttribute('title', '搜索');
  input.setAttribute('name', 'q');
  env.rect(input, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, input);
  const res = dom.assertElement({ selector: 'input', exists: true });
  assert.equal(res.element.label, '请输入关键词');
});

test('accessibleLabel uses title when placeholder is absent, name when both absent', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const input = env.element('input');
  input.setAttribute('title', '搜索');
  input.setAttribute('name', 'q');
  env.rect(input, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, input);
  const res = dom.assertElement({ selector: 'input', exists: true });
  assert.equal(res.element.label, '搜索');
});

test('accessibleLabel uses name as the last fallback when nothing else is available', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const input = env.element('input');
  input.setAttribute('name', 'q');
  env.rect(input, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, input);
  const res = dom.assertElement({ selector: 'input', exists: true });
  assert.equal(res.element.label, 'q');
});

test('accessibleLabel collapses whitespace and trims', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  const btn = env.element('button');
  btn.setAttribute('aria-label', '  卡片   视图 \n ');
  env.rect(btn, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, btn);
  const res = dom.assertElement({ selector: 'button', exists: true });
  assert.equal(res.element.label, '卡片 视图');
});

/* ── assertText：ok 时省略 actual，失败时保留且 ≤ 500 ── */

test('assertText omits actual when the assertion passes', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  document.body.textContent = 'Hello 世界 welcome';
  const res = dom.assertText({ text: '世界' });
  assert.equal(res.ok, true);
  assert.equal(res.expected, '世界');
  assert.equal('actual' in res, false);
  assert.equal(res.message, 'Text assertion passed');
});

test('assertText includes actual truncated to 500 chars when the assertion fails', () => {
  const env = createDomEnvironment();
  const { dom, document } = loadModule(env);
  document.body.textContent = 'x'.repeat(2000);
  const res = dom.assertText({ text: 'missing' });
  assert.equal(res.ok, false);
  assert.equal(typeof res.actual, 'string');
  assert.ok(res.actual.length <= 500);
  assert.match(res.message, /Expected page text/);
});

/* ── isInViewport：被滚动容器裁掉的元素返回 false ── */

test('isInViewport false when fully clipped by a horizontal scroll container', () => {
  const env = createDomEnvironment();
  const { dom, window, document } = loadModule(env);
  window.innerWidth = 200;
  window.innerHeight = 100;
  const scroller = env.element('div');
  env.rect(scroller, { top: 0, left: 0, width: 200, height: 50 });
  env.style(scroller, { overflowX: 'auto', overflowY: 'auto' });
  const tab = env.element('button');
  env.rect(tab, { top: 0, left: 300, width: 100, height: 40 }); // 超出 scroller 可视区
  env.append(scroller, tab);
  env.append(document.body, scroller);
  assert.equal(dom.isInViewport(tab), false);

  const tab2 = env.element('button');
  env.rect(tab2, { top: 0, left: 0, width: 50, height: 40 });
  env.append(scroller, tab2);
  assert.equal(dom.isInViewport(tab2), true);
});

test('isInViewport true when a clipped element still has partial intersection', () => {
  const env = createDomEnvironment();
  const { dom, window, document } = loadModule(env);
  window.innerWidth = 200;
  window.innerHeight = 100;
  const scroller = env.element('div');
  env.rect(scroller, { top: 0, left: 0, width: 100, height: 50 });
  env.style(scroller, { overflowX: 'scroll', overflowY: 'scroll' });
  const tab = env.element('button');
  env.rect(tab, { top: 0, left: 50, width: 100, height: 40 }); // 一半在 scroller 内
  env.append(scroller, tab);
  env.append(document.body, scroller);
  assert.equal(dom.isInViewport(tab), true);
});

test('isInViewport ignores ancestors with overflow visible and respects viewport only', () => {
  const env = createDomEnvironment();
  const { dom, window, document } = loadModule(env);
  window.innerWidth = 200;
  window.innerHeight = 100;
  const parent = env.element('div');
  env.rect(parent, { top: 0, left: 0, width: 500, height: 500 });
  env.style(parent, { overflow: 'visible' });
  const child = env.element('button');
  env.rect(child, { top: 10, left: 300, width: 50, height: 40 }); // 超出视口但 parent 不裁剪
  env.append(parent, child);
  env.append(document.body, parent);
  assert.equal(dom.isInViewport(child), false);
});

test('isInViewport walks up through a shadow host to find a clipping ancestor', () => {
  const env = createDomEnvironment();
  const { dom, window, document } = loadModule(env);
  window.innerWidth = 200;
  window.innerHeight = 100;
  const host = env.element('div');
  env.rect(host, { top: 0, left: 0, width: 100, height: 50 });
  env.style(host, { overflowX: 'hidden' });
  env.append(document.body, host);
  const inner = env.element('button');
  env.rect(inner, { top: 0, left: 300, width: 50, height: 40 }); // 在 host 裁剪区之外
  inner._host = host;
  assert.equal(dom.isInViewport(inner), false);
});
