'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../../content/modules/marks-core.js');

function mark(over = {}) {
  return {
    id: over.id || 'r_1',
    index: over.index || 1,
    selector: 'main > div.card > button.btn.btn-primary',
    xpath: '/html/body/main/div/button',
    comment: '',
    context: {
      tagName: 'button',
      text: 'Save changes',
      outerHTML: '<button id="save" class="btn btn-primary big extra" data-x="a>b">Save changes</button>',
      boundingBox: { x: 1, y: 2, w: 120, h: 32 },
      styles: { color: 'red' },
      framework: null,
    },
    ...over,
  };
}

// ----------------------------------------------------------------- describe

test('describeMark: tag#id.class from the stored outerHTML (max 3 classes, quoted > survives)', () => {
  assert.strictEqual(core.describeMark(mark()).desc, 'button#save.btn.btn-primary.big');
});

test('describeMark: falls back to the selector tail, then to "element"', () => {
  const m = { id: 'x', selector: 'ul.menu > li.item#first:nth-child(2)', context: {} };
  assert.strictEqual(core.describeMark(m).desc, 'li#first.item');
  assert.strictEqual(core.describeMark({ id: 'y', selector: '', context: {} }).desc, 'element');
});

test('parseOpenTag handles single quotes, no attributes and garbage', () => {
  assert.deepStrictEqual(core.parseOpenTag("<A id='k' class='a  b'>x</A>"), { tag: 'a', id: 'k', classes: ['a', 'b'] });
  assert.deepStrictEqual(core.parseOpenTag('<br>'), { tag: 'br', id: '', classes: [] });
  assert.strictEqual(core.parseOpenTag('not html'), null);
  assert.strictEqual(core.parseOpenTag(undefined), null);
});

// ---------------------------------------------------------------- snapshot

test('toBroadcastMark: only the minimal fields, truncated, with the badge colour', () => {
  const big = mark({ index: 2, comment: 'c'.repeat(900), selector: 's'.repeat(900) });
  const out = core.toBroadcastMark(big, 1);
  assert.deepStrictEqual(Object.keys(out).sort(), ['color', 'comment', 'component', 'desc', 'file', 'id', 'index', 'selector', 'sent', 'text']);
  assert.strictEqual(out.color, core.MARK_COLORS[1]);
  assert.ok(out.comment.length <= core.LIMITS.COMMENT && out.selector.length <= core.LIMITS.SELECTOR);
  assert.ok(!('context' in out) && !('xpath' in out));
});

test('buildSnapshot: screenshots carry id/size only (never pixels) and the mark list is capped', () => {
  const marks = Array.from({ length: core.LIMITS.MAX_MARKS + 5 }, (_, i) => mark({ id: `m${i}`, index: i + 1 }));
  const shots = [{ id: 's1', w: 800, h: 600, dataUrl: `data:image/jpeg;base64,${'A'.repeat(4000)}`, thumb: 'data:image/jpeg;base64,BBBB' }];
  const snap = core.buildSnapshot({ url: 'http://localhost:3000/', marks, screenshots: shots });
  assert.strictEqual(snap.marks.length, core.LIMITS.MAX_MARKS);
  assert.strictEqual(snap.truncated, true);
  assert.deepStrictEqual(snap.screenshots, [{ id: 's1', w: 800, h: 600, bytes: 3000 }]);
  assert.ok(!JSON.stringify(snap).includes('AAAA'));
  const msg = core.buildChangedMessage({ url: 'u', marks: [], screenshots: [] });
  assert.strictEqual(msg.type, 'DT_MARKS_CHANGED');
});

test('a realistic snapshot stays far below the extension message limits', () => {
  const marks = Array.from({ length: 200 }, (_, i) => mark({ id: `m${i}`, index: i + 1, comment: 'c'.repeat(500), selector: 's'.repeat(300) }));
  const bytes = Buffer.byteLength(JSON.stringify(core.buildChangedMessage({ url: 'u', marks, screenshots: [] })));
  assert.ok(bytes < 400 * 1024, `snapshot is ${bytes} bytes`);
});

// ----------------------------------------------------------------- DevTailor prompt format

const bridgePrompt = [
  '## Current Page', 'URL: http://localhost:3000/app', '',
  '## User Intent', '把按钮改成绿色', '第二行', '',
  '## Marked Elements (2 total)', '',
  '### 1 `main > button.btn`',
  '- **User annotation**: 太小了',
  '- **Component file**: src/Button.tsx',
  '- **Component name**: Button',
  '- **DOM Structure**:', '```html', '<button class="btn">### 9 `fake`</button>', '```',
  '- **Bounding Box**: x=1, y=2, w=3, h=4', '',
  '### 2 `#nav > a.link`', '',
].join('\n');

test('parseDevTailorPrompt: reads page, intent and every marked element of the bridge format', () => {
  const p = core.parseDevTailorPrompt(bridgePrompt);
  assert.equal(p.pageUrl, 'http://localhost:3000/app');
  assert.equal(p.intent, '把按钮改成绿色\n第二行');
  assert.equal(p.marks.length, 2);
  assert.deepEqual(p.marks[0], { index: 1, selector: 'main > button.btn', comment: '太小了', file: 'src/Button.tsx', component: 'Button' });
  assert.deepEqual(p.marks[1], { index: 2, selector: '#nav > a.link', comment: '', file: '', component: '' });
});

test('parseDevTailorPrompt: no marks section, or the "no description" placeholder', () => {
  const p = core.parseDevTailorPrompt('## Current Page\nURL: http://x/\n\n## User Intent\n(No additional description provided)\n\n## Marked Elements\nNo elements were marked.\n\n');
  assert.deepEqual(p, { pageUrl: 'http://x/', intent: '', marks: [] });
});

test('parseDevTailorPrompt: missing sections are not a DevTailor prompt (null -> show the original)', () => {
  assert.equal(core.parseDevTailorPrompt('## User Intent\nhi'), null);
  assert.equal(core.parseDevTailorPrompt('## Current Page\nURL: x\n\nhello'), null);
  assert.equal(core.parseDevTailorPrompt(''), null);
  assert.equal(core.parseDevTailorPrompt(undefined), null);
});

test('parseDevTailorPrompt: plain user text and over-long text are left alone', () => {
  assert.equal(core.parseDevTailorPrompt('帮我看看这个页面'), null);
  assert.equal(core.parseDevTailorPrompt(`## Current Page\nURL: x\n\n## User Intent\n${'a'.repeat(500000)}`), null);
});

test('parseDevTailorPrompt: caps the number of marks and truncates huge selectors', () => {
  let t = '## Current Page\nURL: x\n\n## User Intent\ngo\n\n## Marked Elements (300 total)\n\n';
  for (let i = 1; i <= 300; i++) t += `### ${i} \`${i === 1 ? 's'.repeat(5000) : 'div'}\`\n\n`;
  const p = core.parseDevTailorPrompt(t);
  assert.equal(p.marks.length, core.LIMITS.MAX_MARKS);
  assert.ok(p.marks[0].selector.length <= core.LIMITS.SELECTOR + 1);
});

test('userBubbleModel: carried marks win; DevTailor text is compacted; anything else is untouched', () => {
  const carried = core.userBubbleModel({ content: 'hi', marks: [{ index: 1, desc: 'div', selector: 'div' }] });
  assert.equal(carried.parsed, false);
  assert.equal(carried.marks.length, 1);
  const compact = core.userBubbleModel({ content: bridgePrompt });
  assert.equal(compact.parsed, true);
  assert.equal(compact.text, '把按钮改成绿色\n第二行');
  assert.equal(compact.marks[0].desc, 'button.btn');
  assert.ok(compact.marks[0].color);
  const plain = core.userBubbleModel({ content: '## Current Page\nbroken' });
  assert.deepEqual([plain.parsed, plain.text, plain.marks], [false, '## Current Page\nbroken', []]);
});

// ------------------------------------------------------------- persistence
test('buildPersisted: nothing to keep -> null; otherwise marks + shots', () => {
  assert.strictEqual(core.buildPersisted({ origin: 'http://a', marks: [], shots: [] }), null);
  const shot = (id, n) => ({ id, dataUrl: 'data:image/png;base64,' + 'A'.repeat(n), thumb: '', w: 1, h: 1 });
  const state = core.buildPersisted({ origin: 'http://a', marks: [mark()], shots: [shot('s1', 10)] });
  assert.strictEqual(state.marks.length, 1);
  assert.strictEqual(state.shots[0].id, 's1');
});

test('buildPersisted: drops the OLDEST screenshots first when over budget', () => {
  const shot = (id) => ({ id, dataUrl: 'data:image/png;base64,' + 'A'.repeat(100), thumb: '', w: 1, h: 1 });
  const state = core.buildPersisted({ origin: 'o', marks: [mark()], shots: [shot('a'), shot('b'), shot('c')], maxChars: 250 });
  assert.deepStrictEqual(state.shots.map((s) => s.id), ['b', 'c']);
  assert.strictEqual(state.droppedShots, 1);
});

test('restorePersisted: same origin restores, clears sent flags; other origin / bad version ignored', () => {
  const shot = { id: 's1', dataUrl: 'data:image/png;base64,AAAA', thumb: '', w: 1, h: 1 };
  const saved = core.buildPersisted({ origin: 'http://a', marks: [mark({ sent: true })], shots: [shot] });
  const back = core.restorePersisted(saved, 'http://a');
  assert.strictEqual(back.marks[0].sent, false);
  assert.strictEqual(back.shots.length, 1);
  assert.strictEqual(core.restorePersisted(saved, 'http://other'), null);
  assert.strictEqual(core.restorePersisted({ ...saved, v: 999 }, 'http://a'), null);
  assert.strictEqual(core.restorePersisted(null, 'http://a'), null);
});

test('restorePersisted: discards screenshots that are not image data URLs', () => {
  const saved = { v: 1, origin: 'o', marks: [mark()], shots: [{ id: 'x', dataUrl: 'javascript:alert(1)' }] };
  assert.strictEqual(core.restorePersisted(saved, 'o').shots.length, 0);
});
