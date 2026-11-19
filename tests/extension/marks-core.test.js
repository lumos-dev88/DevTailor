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

// ------------------------------------------------------------------ search

test('tokenize: whitespace split, lower-cased, de-duplicated, blank -> []', () => {
  assert.deepStrictEqual(core.tokenize('  Foo   bar FOO '), ['foo', 'bar']);
  assert.deepStrictEqual(core.tokenize('   '), []);
  assert.deepStrictEqual(core.tokenize(null), []);
});

test('searchMarks: matches number, tag/id/class, selector, text, comment, component and file (case-insensitive)', () => {
  const marks = [
    mark({ id: 'a', index: 1, comment: '按钮颜色太浅' }),
    mark({
      id: 'b', index: 2, selector: 'section#hero > h1', comment: 'Heading too big',
      context: { tagName: 'h1', text: 'Welcome back', outerHTML: '<h1 class="title">Welcome back</h1>', framework: { framework: 'vue3', componentName: 'HeroBanner', filePath: 'src/components/HeroBanner.vue' } },
    }),
    mark({ id: 'c', index: 3, selector: 'footer > a', context: { tagName: 'a', text: 'Contact', outerHTML: '<a href="/c">Contact</a>' } }),
  ];
  const ids = (q) => core.searchMarks(marks, q).hits.map((h) => h.mark.id);
  assert.deepStrictEqual(ids('2'), ['b']);               // badge number
  assert.deepStrictEqual(ids('#save'), ['a']);            // id (via selector/desc)
  assert.deepStrictEqual(ids('BTN-PRIMARY'), ['a']);      // class, case-insensitive
  assert.deepStrictEqual(ids('section#hero'), ['b']);     // selector
  assert.deepStrictEqual(ids('welcome'), ['b']);          // element text
  assert.deepStrictEqual(ids('颜色'), ['a']);              // comment (CJK)
  assert.deepStrictEqual(ids('herobanner'), ['b']);       // component
  assert.deepStrictEqual(ids('components/hero'), ['b']);  // file path
  assert.deepStrictEqual(ids('footer'), ['c']);
  assert.deepStrictEqual(ids('nothing-like-this'), []);
});

test('searchMarks: every token must hit (AND), tokens may hit different fields, order and positions are kept', () => {
  const marks = [
    mark({ id: 'a', index: 1, comment: 'padding is off' }),
    mark({ id: 'b', index: 2, selector: 'nav > a', comment: 'padding is off', context: { tagName: 'a', text: 'Home', outerHTML: '<a>Home</a>' } }),
  ];
  const r = core.searchMarks(marks, 'padding nav');
  assert.deepStrictEqual(r.hits.map((h) => h.mark.id), ['b']);
  assert.strictEqual(r.hits[0].position, 1);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(core.searchMarks(marks, 'padding home').hits.map((h) => h.mark.id), ['b']);
  assert.deepStrictEqual(core.searchMarks(marks, 'padding').hits.map((h) => h.mark.id), ['a', 'b']);
});

test('searchMarks: empty query returns everything and never mutates the input', () => {
  const marks = [mark({ id: 'a' }), mark({ id: 'b', index: 2 })];
  const snapshot = JSON.stringify(marks);
  assert.strictEqual(core.searchMarks(marks, '').hits.length, 2);
  core.searchMarks(marks, 'zzz');
  assert.strictEqual(JSON.stringify(marks), snapshot);
  assert.deepStrictEqual(core.searchMarks(undefined, 'x').hits, []);
});

// ------------------------------------------------------------- highlighting

test('highlightSegments: keeps original case, merges overlaps, escapes regex characters', () => {
  assert.deepStrictEqual(core.highlightSegments('Save SAVE', ['save']), [
    { text: 'Save', hit: true }, { text: ' ', hit: false }, { text: 'SAVE', hit: true },
  ]);
  assert.deepStrictEqual(core.highlightSegments('abcd', ['ab', 'bc']), [{ text: 'abc', hit: true }, { text: 'd', hit: false }]);
  assert.deepStrictEqual(core.highlightSegments('a.b(c)', ['.b(']), [
    { text: 'a', hit: false }, { text: '.b(', hit: true }, { text: 'c)', hit: false },
  ]);
  assert.deepStrictEqual(core.highlightSegments('plain', []), [{ text: 'plain', hit: false }]);
  assert.deepStrictEqual(core.highlightSegments('', ['x']), []);
});

test('segmentsToHtml escapes everything, including text that looks like markup', () => {
  const html = core.segmentsToHtml(core.highlightSegments('<img src=x onerror=1> & "q"', ['img']));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;<mark class="dt-hit">img</mark> src=x'));
  assert.ok(html.includes('&amp;') && html.includes('&quot;q&quot;'));
});

test('excerpt keeps a late hit visible inside the window', () => {
  const text = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`;
  const out = core.excerpt(text, ['needle'], 60);
  assert.ok(out.includes('needle'));
  assert.ok(out.length <= 62);
  assert.ok(out.startsWith('…') && out.endsWith('…'));
  assert.strictEqual(core.excerpt('short', ['s'], 60), 'short');
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
