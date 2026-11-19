'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createStore } = require('../../content/modules/review-store.js');
const marksCore = require('../../content/modules/marks-core.js');

function makeStore() {
  const store = createStore(() => 'http://localhost:3000/page');
  const events = [];
  store.onChange((reviews, change) => events.push({ n: reviews.length, ...change }));
  return { store, events };
}
const review = (id, extra = {}) => ({ id, selector: `#${id}`, comment: '', context: {}, ...extra });

test('store emits one typed event per mutation and keeps badge numbers contiguous', () => {
  const { store, events } = makeStore();
  store.add(review('a'));
  store.add(review('b'));
  store.add(review('c'));
  store.update('b', { comment: 'note' });
  store.remove('a');
  assert.deepStrictEqual(events.map((e) => [e.type, e.ids]), [
    ['add', ['a']], ['add', ['b']], ['add', ['c']], ['update', ['b']], ['remove', ['a']],
  ]);
  assert.deepStrictEqual(store.getAll().map((r) => [r.id, r.index]), [['b', 1], ['c', 2]]);
  assert.strictEqual(store.get('b').comment, 'note');
});

test('no-op mutations are silent (unknown id, empty clear, nothing to flag)', () => {
  const { store, events } = makeStore();
  assert.strictEqual(store.remove('ghost'), false);
  assert.strictEqual(store.update('ghost', { comment: 'x' }), false);
  store.clear();
  assert.strictEqual(store.setSent(['ghost'], true), 0);
  assert.strictEqual(store.removeSent(), 0);
  assert.strictEqual(events.length, 0);
});

test('setSent / removeSent: sent marks stay until cleared, and are not rebuilt into the next payload', () => {
  const { store, events } = makeStore();
  store.add(review('a'));
  store.add(review('b'));
  assert.strictEqual(store.setSent(['a'], true), 1);
  assert.strictEqual(store.setSent(['a'], true), 0); // already flagged
  assert.deepStrictEqual(events.at(-1), { n: 2, type: 'sent', ids: ['a'] });
  assert.strictEqual(store.get('a').sent, true);
  assert.strictEqual(store.removeSent(), 1);
  assert.deepStrictEqual(store.getAll().map((r) => [r.id, r.index]), [['b', 1]]);
  assert.deepStrictEqual(events.at(-1), { n: 1, type: 'remove', ids: ['a'] });
});

test('listeners that throw do not break the store', () => {
  const store = createStore(() => 'u');
  store.onChange(() => { throw new Error('boom'); });
  const seen = [];
  store.onChange((r) => seen.push(r.length));
  const warn = console.warn;
  console.warn = () => {};
  try { store.add(review('a')); } finally { console.warn = warn; }
  assert.deepStrictEqual(seen, [1]);
});

test('every store mutation maps to the broadcast the side panel receives', () => {
  const { store } = makeStore();
  const broadcast = () => marksCore.buildChangedMessage({ url: 'http://localhost:3000/page', marks: store.getAll(), screenshots: [] });
  store.add(review('a', { comment: 'first' }));
  store.add(review('b'));
  let msg = broadcast();
  assert.deepStrictEqual(msg.marks.map((m) => [m.id, m.index, m.comment, m.sent]), [['a', 1, 'first', false], ['b', 2, '', false]]);
  store.update('b', { comment: 'edited' });
  assert.strictEqual(broadcast().marks[1].comment, 'edited');
  store.remove('a');
  msg = broadcast();
  assert.deepStrictEqual(msg.marks.map((m) => [m.id, m.index]), [['b', 1]]);
  store.clear();
  assert.deepStrictEqual(broadcast().marks, []);
});
