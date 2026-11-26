'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../../background/instance-header.js');
const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('instance header is present only for a concrete safe selection', () => {
  assert.deepEqual(api.buildInstanceHeaders('claude_1-abc'), { 'X-DevTailor-Instance': 'claude_1-abc' });
  for (const value of ['', null, 'bad id', 'x\nInjected: yes', '../x']) {
    assert.deepEqual(api.buildInstanceHeaders(value), {});
  }
});

test('instance options include automatic default, online instances and retained offline selection', () => {
  const health = {
    instances: [{ instanceId: 'a', name: 'Claude A' }, { instanceId: 'b', name: 'Claude B' }],
    defaultInstanceId: 'b',
  };
  assert.deepEqual(api.instanceOptions(health, 'a').options.map(x => [x.value, x.label]), [
    ['', '自动（Claude B）'], ['a', 'Claude A'], ['b', 'Claude B'],
  ]);
  const offline = api.instanceOptions(health, 'gone');
  assert.equal(offline.selected, 'gone');
  assert.deepEqual(offline.options.at(-1), { value: 'gone', label: '所选实例已离线', offline: true });
  assert.equal(api.instanceOptions({ instances: [] }, '').options[0].label, '自动（无在线实例）');
});

test('service worker waits for restored selection and attaches one unified instance header', () => {
  const sw = read('background/service-worker.js');
  assert.match(sw, /const instanceReady = chrome\.storage\.local\.get\(INSTANCE_KEY\)/);
  const fetchFn = /async function fetchBridgeUrl\([\s\S]*?\n}/.exec(sw)?.[0] || '';
  assert.match(fetchFn, /await instanceReady;/);
  assert.match(fetchFn, /instanceHeader\.buildInstanceHeaders\(selectedInstanceId\)/);
  assert.match(fetchFn, /'X-DevTailor-Client': chrome\.runtime\.id/);
  assert.match(sw, /await restartBridgeSseProxies\(\)/);
  assert.doesNotMatch(sw, /X-DevTailor-Project|SET_PROJECT_ID|currentProjectId/);
});

test('side panel persists a concrete selection through the worker and renders health instances', () => {
  const js = read('sidepanel/sidepanel.js');
  assert.match(js, /type: 'SET_INSTANCE_SELECTION'/);
  assert.match(js, /instanceHeader\.instanceOptions\(health, selectedInstanceId\)/);
  assert.match(read('sidepanel/sidepanel.html'), /id="instance-select"/);
});
