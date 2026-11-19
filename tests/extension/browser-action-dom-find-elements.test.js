'use strict';
// find_elements 的纯逻辑：参数归一化与候选过滤（加载真实模块，不复刻实现）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '../../content/modules/browser-action-dom.js'), 'utf8');
  vm.runInNewContext(source, { window, console });
  return window.__domReview.browserActionDom;
}

const candidates = [
  { id: 1, role: 'button', label: 'Submit order', text: '', placeholder: '' },
  { id: 2, role: 'textbox', label: 'Email address', text: '', placeholder: 'you@example.com' },
  { id: 3, role: 'link', label: '', text: 'Submit feedback', placeholder: '' },
];

test('normalizeFindParams rejects empty or blank query', () => {
  const dom = loadModule();
  assert.throws(() => dom.normalizeFindParams({}), /non-empty query/);
  assert.throws(() => dom.normalizeFindParams({ query: '   ' }), /non-empty query/);
});

test('normalizeFindParams clamps maxResults to 1..50 with default 10', () => {
  const dom = loadModule();
  assert.equal(dom.normalizeFindParams({ query: 'a' }).maxResults, 10);
  assert.equal(dom.normalizeFindParams({ query: 'a', maxResults: 0 }).maxResults, 1);
  assert.equal(dom.normalizeFindParams({ query: 'a', maxResults: 999 }).maxResults, 50);
  assert.equal(dom.normalizeFindParams({ query: 'a', maxResults: 'x' }).maxResults, 10);
});

test('filterFindCandidates matches label/text/placeholder case-insensitively', () => {
  const dom = loadModule();
  const ids = (q) => dom.filterFindCandidates(candidates, dom.normalizeFindParams(q)).map(c => c.id);
  assert.deepEqual(ids({ query: 'SUBMIT' }), [1, 3]);
  assert.deepEqual(ids({ query: 'example.com' }), [2]);
  assert.deepEqual(ids({ query: '不存在' }), []);
});

test('filterFindCandidates applies the role filter', () => {
  const dom = loadModule();
  const ids = (q) => dom.filterFindCandidates(candidates, dom.normalizeFindParams(q)).map(c => c.id);
  assert.deepEqual(ids({ query: 'submit', role: 'Link' }), [3]);
  assert.deepEqual(ids({ query: 'submit', role: 'checkbox' }), []);
});

/* ── label 定位（子串匹配）在新 accessibleLabel 语义下仍然命中 ── */

function loadDomModule() {
  const { createDomEnvironment } = require('./helpers');
  const env = createDomEnvironment();
  const window = env.makeWindow();
  const source = fs.readFileSync(path.join(__dirname, '../../content/modules/browser-action-dom.js'), 'utf8');
  const sandbox = {
    window, console,
    Element: env.FakeElement,
    HTMLInputElement: env.FakeInput,
    HTMLTextAreaElement: env.FakeTextarea,
    HTMLSelectElement: env.FakeSelect,
    getComputedStyle: env.getComputedStyle,
    document: env.mountDocument(),
    CSS: { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') },
  };
  vm.runInNewContext(source, sandbox);
  return { dom: window.__domReview.browserActionDom, env, document: sandbox.document };
}

test('findElement by label still matches aria-label, placeholder and <label> text', () => {
  const { dom, env, document } = loadDomModule();

  const byAria = env.element('button');
  byAria.setAttribute('aria-label', '卡片视图');
  env.rect(byAria, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, byAria);

  const byPlaceholder = env.element('input');
  byPlaceholder.setAttribute('placeholder', '搜索关键词');
  env.rect(byPlaceholder, { top: 20, left: 0, width: 10, height: 10 });
  env.append(document.body, byPlaceholder);

  const byLabelEl = env.element('input');
  const labelEl = env.element('label');
  labelEl.textContent = '邮箱地址';
  byLabelEl.labels = [labelEl];
  env.rect(byLabelEl, { top: 40, left: 0, width: 10, height: 10 });
  env.append(document.body, byLabelEl);

  const r1 = dom.assertElement({ label: '卡片视图' });
  assert.equal(r1.ok, true);
  assert.equal(r1.element.label, '卡片视图');
  assert.equal(r1.element.tag, 'button');

  const r2 = dom.assertElement({ label: '搜索关键词' });
  assert.equal(r2.ok, true);
  assert.equal(r2.element.label, '搜索关键词');
  assert.equal(r2.element.tag, 'input');

  const r3 = dom.assertElement({ label: '邮箱地址' });
  assert.equal(r3.ok, true);
  assert.equal(r3.element.label, '邮箱地址');
  assert.equal(r3.element.tag, 'input');
});

test('label locator matches any label source (aria-label, placeholder, legacy joined form)', () => {
  const { dom, env, document } = loadDomModule();

  const input = env.element('input');
  input.setAttribute('aria-label', '搜索节点');
  input.setAttribute('placeholder', '搜索节点名、IP、节点 ID');
  input.setAttribute('id', 'radix-x');
  env.rect(input, { top: 0, left: 0, width: 10, height: 10 });
  env.append(document.body, input);

  // 任一来源（aria-label / placeholder）单独命中
  assert.equal(dom.assertElement({ label: '搜索节点' }).ok, true);
  assert.equal(dom.assertElement({ label: '搜索节点名' }).ok, true);
  // 旧快照输出的拼接形式也能命中
  assert.equal(dom.assertElement({ label: '搜索节点 搜索节点名、IP、节点 ID' }).ok, true);
  // id 不是无障碍名称，不能命中
  assert.equal(dom.assertElement({ label: 'radix-x' }).ok, false);
});
