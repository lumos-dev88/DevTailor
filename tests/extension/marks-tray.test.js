'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../../content/modules/review-store.js');
const marksCore = require('../../content/modules/marks-core.js');
const promptBuilder = require('../../content/modules/prompt-builder.js');

const URL_ = 'http://localhost:3000/app';
const review = (id, extra = {}) => ({
  id, selector: `div#${id} > span.t`, comment: '', context: { tagName: 'span', text: `text ${id}`, outerHTML: `<span class="t">${id}</span>`, boundingBox: { x: 0, y: 0, w: 10, h: 10 }, styles: {} },
  ...extra,
});

/** A fake page: real store + real command handler + in-memory screenshots, wired like marks-sync.js. */
function createPage({ tabId = 7 } = {}) {
  const store = createStore(() => URL_);
  let shots = [{ id: 's1', dataUrl: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,THUMBPIXELS', w: 100, h: 50 }];
  const located = [];
  const screenshots = {
    list: () => shots.slice(),
    images: () => shots.map((s) => s.dataUrl),
    remove: (id) => { shots = shots.filter((s) => s.id !== id); },
    clear: () => { shots = []; },
    thumbs: (ids) => Object.fromEntries(shots.filter((s) => ids.includes(s.id)).map((s) => [s.id, s.thumb])),
  };
  const ctx = {
    store, screenshots, url: () => URL_,
    buildParts: (marks, images) => promptBuilder.buildParts(marks, images, { pageUrl: URL_ }),
    locate: (id) => { located.push(id); return Boolean(store.get(id)); },
  };
  const tray = marksCore.createTrayModel();
  tray.follow(tabId);
  const controller = marksCore.createTrayController({
    model: tray,
    sendToTab: async (id, message) => {
      if (id !== tabId) throw new Error('Receiving end does not exist');
      return marksCore.handleCommand(message, ctx);
    },
  });
  // content script -> service worker -> side panel
  const relay = (changed) => { const { type: _t, ...snapshot } = changed; return { type: 'DT_MARKS_UPDATED', tabId, ...snapshot }; };
  const broadcast = () => tray.applyUpdate(relay(marksCore.buildChangedMessage({ url: URL_, marks: store.getAll(), screenshots: shots })));
  store.onChange(broadcast);
  return { store, tray, controller, located, screenshots, ctx, broadcast, shots: () => shots };
}

const trayMarks = (page) => page.tray.getState().marks.map((m) => [m.id, m.index, m.comment, m.sent]);
const storeMarks = (page) => page.store.getAll().map((m) => [m.id, m.index, m.comment || '', Boolean(m.sent)]);

test('tray follows the store: add, edit, remove and clear on the page show up as snapshots', () => {
  const page = createPage();
  page.store.add(review('a'));
  page.store.add(review('b'));
  assert.deepStrictEqual(trayMarks(page), storeMarks(page));
  page.store.update('a', { comment: 'tighten spacing' });
  assert.deepStrictEqual(trayMarks(page), storeMarks(page));
  assert.strictEqual(page.tray.getState().marks[0].comment, 'tighten spacing');
  page.store.remove('a');
  assert.deepStrictEqual(trayMarks(page), [['b', 1, '', false]]);
  page.store.clear();
  assert.deepStrictEqual(trayMarks(page), []);
  assert.strictEqual(page.tray.getState().status, 'ready');
});

test('removing a chip writes back to the page store and both sides agree', async () => {
  const page = createPage();
  page.store.add(review('a'));
  page.store.add(review('b'));
  page.store.add(review('c'));
  const res = await page.controller.removeMark('b');
  assert.strictEqual(res.removed, true);
  assert.deepStrictEqual(page.store.getAll().map((m) => m.id), ['a', 'c']);
  assert.deepStrictEqual(trayMarks(page), storeMarks(page));
  assert.deepStrictEqual(page.tray.getState().marks.map((m) => m.index), [1, 2]); // badge numbers re-packed on both sides
  // removing something that is already gone is harmless and still returns a fresh snapshot
  const again = await page.controller.removeMark('b');
  assert.strictEqual(again.removed, false);
  assert.deepStrictEqual(trayMarks(page), storeMarks(page));
});

test('clear all and screenshot removal also go through the page', async () => {
  const page = createPage();
  page.store.add(review('a'));
  await page.controller.refresh();
  assert.deepStrictEqual(page.tray.getState().screenshots, [{ id: 's1', w: 100, h: 50, bytes: 3 }]);
  await page.controller.removeScreenshot('s1');
  assert.deepStrictEqual(page.shots(), []);
  assert.deepStrictEqual(page.tray.getState().screenshots, []);
  await page.controller.clearMarks();
  assert.deepStrictEqual(page.store.getAll(), []);
  assert.deepStrictEqual(page.tray.getState().marks, []);
});

test('thumbnails are fetched on demand; the broadcast never carries pixels', async () => {
  const page = createPage();
  await page.controller.refresh();
  assert.ok(!JSON.stringify(page.tray.getState()).includes('THUMBPIXELS') && !JSON.stringify(page.tray.getState()).includes('AAAA'));
  assert.deepStrictEqual(await page.controller.thumbs(['s1', 'ghost']), { s1: 'data:image/jpeg;base64,THUMBPIXELS' });
});

test('locate is forwarded to the page', async () => {
  const page = createPage();
  page.store.add(review('a'));
  await page.controller.locate('a');
  await page.controller.locate('zzz');
  assert.deepStrictEqual(page.located, ['a', 'zzz']);
});

test('buildPayload returns {pageUrl, items, screenshots} using the page badge numbers, without already-sent marks', async () => {
  const page = createPage();
  page.store.add(review('a', { comment: '换成主色' }));
  page.store.add(review('b', { comment: 'bigger' }));
  page.store.setSent(['a'], true);
  const parts = await page.controller.buildPayload();
  assert.strictEqual(parts.pageUrl, URL_);
  assert.deepStrictEqual(parts.markIds, ['b']);
  assert.strictEqual(parts.items.length, 1);
  assert.strictEqual(parts.items[0].index, 2);              // the badge the user sees on the page
  assert.strictEqual(parts.items[0].selector, 'div#b > span.t');
  assert.strictEqual(parts.items[0].annotation, 'bigger');
  assert.deepStrictEqual(parts.screenshots, ['data:image/jpeg;base64,AAAA']);
});

test('send lifecycle: mark as sent (screenshots consumed), then done clears them, error makes them sendable again', async () => {
  const page = createPage();
  page.store.add(review('a'));
  page.store.add(review('b'));
  await page.controller.markSent(['a', 'b'], true);
  assert.deepStrictEqual(page.shots(), []);
  assert.deepStrictEqual(trayMarks(page), [['a', 1, '', true], ['b', 2, '', true]]);
  assert.strictEqual(page.tray.unsentCount(), 0);

  await page.controller.markUnsent(['a', 'b']); // the turn failed
  assert.strictEqual(page.tray.unsentCount(), 2);

  await page.controller.markSent(['a'], false);
  await page.controller.clearSent();            // the turn finished
  assert.deepStrictEqual(page.store.getAll().map((m) => m.id), ['b']);
  assert.deepStrictEqual(trayMarks(page), storeMarks(page));
});

test('a page without the content script makes the tray unavailable instead of throwing', async () => {
  const tray = marksCore.createTrayModel();
  tray.follow(99);
  const controller = marksCore.createTrayController({ model: tray, sendToTab: async () => { throw new Error('Receiving end does not exist'); } });
  const res = await controller.refresh();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(tray.getState().status, 'unavailable');
  assert.deepStrictEqual(tray.getState().marks, []);
  assert.strictEqual(await controller.buildPayload(), null);
});

test('broadcasts for another tab are ignored; switching tabs clears the previous tab\'s marks', () => {
  const page = createPage({ tabId: 7 });
  page.store.add(review('a'));
  assert.strictEqual(page.tray.applyUpdate({ type: 'DT_MARKS_UPDATED', tabId: 8, url: 'x', marks: [{ id: 'zzz' }], screenshots: [] }), false);
  assert.deepStrictEqual(page.tray.getState().marks.map((m) => m.id), ['a']);
  page.tray.follow(8);
  assert.deepStrictEqual(page.tray.getState().marks, []);
  assert.strictEqual(page.tray.getState().status, 'loading');
  page.tray.follow(null);
  assert.strictEqual(page.tray.getState().status, 'idle');
});

test('handleCommand ignores messages that are not ours', () => {
  const page = createPage();
  assert.strictEqual(marksCore.handleCommand({ type: 'DEVTAILOR_BRIDGE_PROXY_EVENT' }, page.ctx), undefined);
  assert.strictEqual(marksCore.handleCommand(null, page.ctx), undefined);
});

/** The side panel's send/settle flow (sidepanel.js executeSend / settleSentMarks / reconcileSentMarks). */
function createPanelFlow(page) {
  const tracker = marksCore.createSentTracker();
  const flow = {
    tracker,
    async send(postReview) {
      const parts = await page.controller.buildPayload();
      const markIds = parts ? parts.markIds : [];
      if (markIds.length) { tracker.begin(markIds); await page.controller.markSent(markIds, false); }
      const ok = await postReview(markIds);
      if (!ok) {
        if (markIds.length) { tracker.rollback(markIds); await page.controller.markUnsent(markIds); }
        return { ok: false, markIds };
      }
      return { ok: true, markIds };
    },
    settle(outcome) {
      const { clear, unsend } = tracker.settle(outcome);
      if (clear) return page.controller.clearSent();
      if (unsend.length) return page.controller.markUnsent(unsend);
      return undefined;
    },
    async reconcile() {
      const stale = tracker.staleIds(page.tray.getState().marks);
      if (stale.length) await page.controller.markSent(stale, false);
    },
  };
  return flow;
}

test('done arriving before the /review response still clears the sent marks', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  const r = await flow.send(async () => { await flow.settle('done'); return true; }); // SSE done beats the HTTP response
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(storeMarks(page), []);
  assert.deepStrictEqual(flow.tracker.ids(), []);
});

test('marks are sent-flagged before the request, so a concurrent BUILD never repeats them', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  let duringRequest;
  await flow.send(async () => { duringRequest = await page.controller.buildPayload(); return true; });
  assert.deepStrictEqual(duringRequest.markIds, []);
});

test('a failed /review rolls the marks back to sendable', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  const r = await flow.send(async () => false);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(storeMarks(page), [['a', 1, '', false]]);
  assert.deepStrictEqual(flow.tracker.ids(), []);
  assert.deepStrictEqual((await page.controller.buildPayload()).markIds, ['a']);
});

test('a turn error makes the carried marks sendable again', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  await flow.send(async () => true);
  assert.strictEqual(storeMarks(page)[0][3], true);
  await flow.settle('error');
  assert.strictEqual(storeMarks(page)[0][3], false);
});

test('sent ids accumulate across sends and one done clears them all', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  await flow.send(async () => true);
  page.store.add(review('b'));
  const r2 = await flow.send(async () => true);
  assert.deepStrictEqual(r2.markIds, ['b']);
  assert.deepStrictEqual(flow.tracker.ids().sort(), ['a', 'b']);
  await flow.settle('done');
  assert.deepStrictEqual(storeMarks(page), []);
});

test('a page reload mid-turn restores marks unsent; the panel re-marks them sent and done clears them', async () => {
  const page = createPage();
  page.store.add(review('a'));
  const flow = createPanelFlow(page);
  await flow.send(async () => true);
  // reload: persisted -> restored with sent=false, same ids
  const saved = marksCore.buildPersisted({ origin: 'http://localhost:3000', marks: page.store.getAll(), shots: [] });
  const restored = marksCore.restorePersisted(saved, 'http://localhost:3000');
  assert.strictEqual(restored.marks[0].sent, false);
  assert.strictEqual(restored.marks[0].id, 'a');
  page.store.clear();
  restored.marks.forEach((m) => page.store.add(m));
  page.broadcast();
  assert.deepStrictEqual(flow.tracker.staleIds(page.tray.getState().marks), ['a']);
  await flow.reconcile();
  assert.strictEqual(storeMarks(page)[0][3], true);
  assert.deepStrictEqual((await page.controller.buildPayload()).markIds, []);
  assert.deepStrictEqual(flow.tracker.staleIds(page.tray.getState().marks), []);
  await flow.settle('done');
  assert.deepStrictEqual(storeMarks(page), []);
});
