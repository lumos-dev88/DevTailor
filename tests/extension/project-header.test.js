'use strict';
// 项目头 X-DevTailor-Project 的纯逻辑（加载真实模块，不复刻实现）。
// 扩展向 Bridge/Hub 发的每个请求都带这个头，值只允许 [A-Za-z0-9_-]，否则不发头。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const headerModule = require('../../background/project-header.js');

/* ── buildProjectHeaders ─────────────────────────────────────── */

test('buildProjectHeaders adds the header for a valid project id', () => {
  assert.deepEqual(headerModule.buildProjectHeaders('a1b2c3d4e5f6'), { 'X-DevTailor-Project': 'a1b2c3d4e5f6' });
  assert.deepEqual(headerModule.buildProjectHeaders('my_proj-01'), { 'X-DevTailor-Project': 'my_proj-01' });
  assert.deepEqual(headerModule.buildProjectHeaders('ABC'), { 'X-DevTailor-Project': 'ABC' });
  assert.equal(headerModule.PROJECT_HEADER, 'X-DevTailor-Project');
});

test('buildProjectHeaders returns no header without a usable project id', () => {
  for (const value of ['', '   ', null, undefined, 0, 42, {}, [], true]) {
    assert.deepEqual(headerModule.buildProjectHeaders(value), {}, `expected no header for ${JSON.stringify(value)}`);
  }
});

test('buildProjectHeaders drops values that are not header-safe', () => {
  const illegal = [
    'pro ject',      // space
    'pro/ject',      // path separator
    'pro\\ject',
    'pro:ject',      // colon
    'pro;ject',
    'pro,ject',
    'pro"ject',
    "pro'ject",
    'pro\nject',
    'pro\rject',
    'pro\tject',
    'pro\u0000ject',
    '..',            // traversal-ish
    '../../etc/passwd',
    'héllo',         // non-ascii
    'pro+ject',
    'pro%20ject',
    'pro\nX-Injected: 1',
  ];
  for (const value of illegal) {
    assert.deepEqual(headerModule.buildProjectHeaders(value), {}, `must not send ${JSON.stringify(value)}`);
    assert.equal(headerModule.normalizeProjectId(value), '', `must normalize ${JSON.stringify(value)} to ''`);
  }
});

test('normalizeProjectId keeps valid ids and trims surrounding blanks', () => {
  assert.equal(headerModule.normalizeProjectId('abc-123_XYZ'), 'abc-123_XYZ');
  assert.equal(headerModule.normalizeProjectId('  abc123  '), 'abc123');
  assert.equal(headerModule.normalizeProjectId(null), '');
  assert.equal(headerModule.normalizeProjectId(undefined), '');
});

test('loading project-header.js in a browser-like global exposes the same API', () => {
  const sandbox = { self: {}, console };
  vm.createContext(sandbox);
  const file = path.join(root, 'background/project-header.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const api = sandbox.self.__domReview?.projectHeader;
  assert.ok(api, 'self.__domReview.projectHeader must be defined');
  assert.deepEqual(Object.keys(api).sort(), ['PROJECT_HEADER', 'PROJECT_ID_PATTERN', 'buildProjectHeaders', 'normalizeProjectId']);
  // headers built inside the vm realm: compare content, not object identity
  assert.equal(JSON.stringify(api.buildProjectHeaders('proj_1')), JSON.stringify({ 'X-DevTailor-Project': 'proj_1' }));
  assert.equal(JSON.stringify(api.buildProjectHeaders('proj 1')), '{}');
});

test('a window global works too (same module usable from a page context)', () => {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  const file = path.join(root, 'background/project-header.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  assert.equal(JSON.stringify(sandbox.window.__domReview.projectHeader.buildProjectHeaders('abc')), JSON.stringify({ 'X-DevTailor-Project': 'abc' }));
});

/* ── service worker wiring ───────────────────────────────────── */

test('service-worker imports project-header.js and keeps a module-level currentProjectId', () => {
  const sw = read('background/service-worker.js');
  assert.match(sw, /^importScripts\('project-header\.js'\);$/m, 'service worker must importScripts project-header.js');
  assert.match(sw, /let currentProjectId = '';/, 'currentProjectId must default to an empty string');
  assert.match(sw, /const projectHeader = self\.__domReview\.projectHeader;/);
});

test('fetchBridgeUrl attaches the project header next to the client header', () => {
  const sw = read('background/service-worker.js');
  const fn = /async function fetchBridgeUrl\([\s\S]*?\n}/.exec(sw);
  assert.ok(fn, 'fetchBridgeUrl not found');
  const body = fn[0];
  assert.match(body, /projectHeader\.buildProjectHeaders\(currentProjectId\)/);
  // still one single fetch call, still carrying the extension client header
  assert.equal(body.match(/await fetch\(/g)?.length, 1, 'fetchBridgeUrl must keep a single fetch call');
  assert.match(body, /'X-DevTailor-Client': chrome\.runtime\.id/);
  // the SSE /events stream and the proxy both use this helper
  assert.match(sw, /fetchBridgeUrl\(bridgeUrl, `\/events\?clientId=/);
  assert.match(sw, /const response = await fetchBridgeUrl\(bridgeUrl, path, \{/);
});

test('the worker re-learns the project from proxied /health bodies (MV3 worker restarts)', () => {
  const sw = read('background/service-worker.js');
  const fn = /function rememberProjectFromHealth\(path, bodyText\) \{[\s\S]*?\n\}/.exec(sw);
  assert.ok(fn, 'rememberProjectFromHealth not found');
  // run the real function against a stub state
  const sandbox = { projectHeader: headerModule, console };
  vm.createContext(sandbox);
  vm.runInContext(`var currentProjectId = '';\n${fn[0]}`, sandbox);
  const remember = (p, b) => vm.runInContext(`(function () {
    rememberProjectFromHealth(${JSON.stringify(p)}, ${JSON.stringify(b)});
    return currentProjectId;
  })()`, sandbox);

  assert.equal(remember('/health', JSON.stringify({ projectId: 'abc123' })), 'abc123');
  assert.equal(remember('/health?clientId=tab_1', JSON.stringify({ projectId: 'def456' })), 'def456');
  // an untrusted /health (no details) keeps what we know
  assert.equal(remember('/health', JSON.stringify({ ok: true })), 'def456');
  assert.equal(remember('/health', '<html>'), 'def456');
  // another route never touches the project
  assert.equal(remember('/sessions/active?projectId=zzz', JSON.stringify({ projectId: 'zzz' })), 'def456');
  // /healths that would be a traversal / other path do not match
  assert.equal(remember('/healthcheck', JSON.stringify({ projectId: 'zzz' })), 'def456');
  // and only a header-safe id is adopted
  assert.equal(remember('/health', JSON.stringify({ projectId: 'bad id' })), 'def456');
  assert.match(sw, /rememberProjectFromHealth\(path, text\);/);
});

test('service worker handles SET_PROJECT_ID with a header-safe id', () => {
  const sw = read('background/service-worker.js');
  const handler = /if \(message\.type === 'SET_PROJECT_ID'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(handler, 'SET_PROJECT_ID handler not found');
  assert.match(handler[0], /projectHeader\.normalizeProjectId\(message\.projectId \|\| ''\)/);
  assert.match(handler[0], /currentProjectId = /);
  assert.match(handler[0], /sendResponse\(\{ ok: true, projectId: currentProjectId \}\)/);
});

/* ── reporting side ──────────────────────────────────────────── */

test('ws-client reports /health projectId to the background only when it changes', () => {
  const js = read('content/modules/ws-client.js');
  assert.match(js, /chrome\.runtime\.sendMessage\(\{ type: 'SET_PROJECT_ID', projectId \}/);
  assert.match(js, /if \(projectId === lastSentProjectId\) return;/);
  assert.match(js, /let lastSentProjectId = null;/);
  // several projects without a top-level projectId: stay header-less
  assert.match(js, /info\.projects\.length > 1\) return;/);
  // the /health snapshot feeds it through setProjectInfo
  assert.match(js, /setProjectInfo\(info\);/);
  assert.match(js, /function setProjectInfo\(info\) \{\n    if \(!info\) return;\n    syncProjectIdToBackground\(info\);/);
});

test('sidepanel reports /health projectId to the background only when it changes', () => {
  const js = read('sidepanel/sidepanel.js');
  assert.match(js, /chrome\.runtime\.sendMessage\(\{ type: 'SET_PROJECT_ID', projectId \}/);
  assert.match(js, /if \(projectId === lastSentProjectId\) return;/);
  assert.match(js, /let lastSentProjectId = null;/);
  assert.match(js, /body\.projects\.length > 1\) return;/);
  const branch = /bridgeReachable = true;[\s\S]{0,120}syncProjectIdToBackground\(body\)/.exec(js);
  assert.ok(branch, 'refreshStatus success branch must report the project');
});

test('no project-selection UI was added: both callers send one id, never a list', () => {
  for (const rel of ['content/modules/ws-client.js', 'sidepanel/sidepanel.js']) {
    const js = read(rel);
    const sends = js.match(/type: 'SET_PROJECT_ID'[^}]*}/g) || [];
    assert.equal(sends.length, 1, `${rel} must send SET_PROJECT_ID from exactly one place`);
    assert.doesNotMatch(sends[0], /projects/);
  }
});
