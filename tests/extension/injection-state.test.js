'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../../background/injection-state.js');

const root = path.resolve(__dirname, '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('completed navigation re-injects remembered tabs and only re-activates current owner', () => {
  const base = { status: 'complete', rememberedTabIds: [4, 8], activeTabId: 8, url: 'https://example.com/x' };
  assert.deepEqual(state.navigationAction({ ...base, tabId: 8 }), { inject: true, activate: true });
  assert.deepEqual(state.navigationAction({ ...base, tabId: 4 }), { inject: true, activate: false });
  assert.deepEqual(state.navigationAction({ ...base, tabId: 9 }), { inject: false, activate: false });
  assert.deepEqual(state.navigationAction({ ...base, tabId: 8, status: 'loading' }), { inject: false, activate: false });
  assert.deepEqual(state.navigationAction({ ...base, tabId: 8, url: 'chrome://settings' }), { inject: false, activate: false });
});

test('takeover changes ownership; closing a tab cleans remembered and active state', () => {
  assert.deepEqual(state.afterTakeover([1, 2], 3), { rememberedTabIds: [1, 2, 3], activeTabId: 3 });
  assert.deepEqual(state.afterTakeover([1, 3], 1), { rememberedTabIds: [1, 3], activeTabId: 1 });
  assert.deepEqual(state.afterTabClosed([1, 3], 3, 3), { rememberedTabIds: [1], activeTabId: null });
});

test('releasing the takeover drops only this tab\'s ownership and keeps the injected record', () => {
  assert.deepEqual(state.afterRelease([1, 3], 3, 3), { rememberedTabIds: [1, 3], activeTabId: null });
  // another tab owns the takeover: untouched
  assert.deepEqual(state.afterRelease([1, 3], 1, 3), { rememberedTabIds: [1, 3], activeTabId: 1 });
  // no owner / unknown tab: remembered list stays, nothing to clear
  assert.deepEqual(state.afterRelease([2], null, 9), { rememberedTabIds: [2], activeTabId: null });
  assert.deepEqual(state.afterRelease([], 4, 4), { rememberedTabIds: [], activeTabId: null });
});

test('manifest has no static content scripts and worker keeps the complete ordered on-demand lists', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.content_scripts, undefined);
  const sw = read('background/service-worker.js');
  for (const file of ['browser-console-bridge.js', 'framework-bridge.js', 'review-store.js', 'references-core.js', 'references.js', 'content/content-script.js', 'content/content-style.css']) {
    assert.match(sw, new RegExp(file.replaceAll('.', '\\.')));
  }
  // The element library browser UI is gone: no page-side saver and no export/import entry.
  assert.doesNotMatch(sw, /element-saver\.js|export-import\.js/);
  assert.match(sw, /filter\(id => id\.startsWith\('dr-custom-'\)\)/);
  assert.match(sw, /unregisterContentScripts\(\{ ids \}\)/);
  assert.match(sw, /chrome\.storage\.sync\.remove\(LEGACY_PATTERNS_KEY\)/);
  assert.doesNotMatch(sw, /chrome\.scripting\.registerContentScripts|ADD_CUSTOM_PATTERN|REMOVE_CUSTOM_PATTERN|DEFAULT_PATTERNS/);
});

test('popup, side panel and shortcut all route through explicit takeover', () => {
  assert.match(read('popup/popup.js'), /type: 'TAKEOVER_TAB'/);
  assert.match(read('sidepanel/sidepanel.js'), /type: 'TAKEOVER_TAB'/);
  const sw = read('background/service-worker.js');
  // Ctrl/Cmd+Shift+X: taken over -> toggle the page toolbar; nobody owns the takeover -> take it;
  // another tab owns it -> only inject + show/hide this page's toolbar (never steal the takeover).
  assert.match(sw, /const takenOver = Number\(session\.activeTabId\) === Number\(tabId\);/);
  assert.match(sw, /if \(session\.activeTabId != null && Number\(session\.activeTabId\) !== Number\(tabId\)\) \{/);
  assert.match(sw, /if \(session\.activeTabId != null && Number\(session\.activeTabId\) !== Number\(tabId\)\) \{\n    const injection = await injectDevTailorIntoTab\(tabId\);\n    return injection\.injected \|\| injection\.alreadyInjected\n      \? toggleToolbar\(tabId\)/);
  assert.match(sw, /const takeover = await takeoverTab\(tabId\);\n    return takeover\.ok \? \{ ok: true, action: 'takeover' \}/);
  assert.match(sw, /toolbar\.toggleVisibility\(\)/);
  assert.match(sw, /if \(message\.type === 'TAKEOVER_TAB'\)/);
  assert.match(sw, /function queueActivation\(tabId, claimOwnership\)/);
  assert.match(sw, /if \(current\.activeTabId !== Number\(tabId\)\) return \{ ok: false, stale: true \}/);
  // Releasing the takeover clears ownership in storage so a refresh does not re-take over.
  assert.match(sw, /if \(message\.type === 'RELEASE_TAKEOVER'\)/);
  assert.match(sw, /injectionState\.afterRelease\(current\.rememberedTabIds, current\.activeTabId, tabId\)/);
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(manifest.commands['toggle-sidebar'].description, /Take over this page/);
});

test('page toolbar sends RELEASE_TAKEOVER when the user releases the takeover', () => {
  const toolbar = read('content/modules/toolbar.js');
  assert.match(toolbar, /m\.action === 'release'/);
  assert.match(toolbar, /type: 'RELEASE_TAKEOVER'/);
  assert.match(toolbar, /ws\.disconnect\(true\)/);
});
