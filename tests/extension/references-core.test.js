'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../../content/modules/references-core.js');

const baseRef = (over = {}) => ({
  id: over.id || 'ref_1',
  url: 'https://example.com/app/dashboard?tab=style',
  title: 'Dashboard',
  selector: 'main > section.card > button.primary',
  note: '',
  styles: { color: 'rgb(1, 2, 3)', fontSize: '14px' },
  html: '<button class="primary">保存</button>',
  screenshot: '',
  ...over,
});

// ------------------------------------------------------------------ list

test('addReference appends up to MAX_REFERENCES and refuses a full list', () => {
  let list = [];
  for (let i = 0; i < core.MAX_REFERENCES; i++) {
    const res = core.addReference(list, baseRef({ id: `r${i}` }));
    assert.strictEqual(res.ok, true);
    list = res.list;
  }
  assert.strictEqual(list.length, core.MAX_REFERENCES);
  const extra = core.addReference(list, baseRef({ id: 'r_extra' }));
  assert.strictEqual(extra.ok, false);
  assert.strictEqual(extra.full, true);
  assert.strictEqual(extra.error, 'full'); // the service worker forwards this verbatim to the toast
  assert.strictEqual(extra.list.length, core.MAX_REFERENCES); // nothing silently dropped
  assert.strictEqual(core.MAX_REFERENCES, 8);

  // a duplicate id never replaces an entry
  const dup = core.addReference(list, baseRef({ id: 'r0' }));
  assert.deepStrictEqual([dup.ok, dup.error], [false, 'duplicate']);

  // an entry without a usable selector is rejected (the Hub could not locate it)
  const noSelector = core.addReference([], baseRef({ selector: '' }));
  assert.deepStrictEqual([noSelector.ok, noSelector.error], [false, 'invalid_reference']);
  const empty = core.addReference([], {});
  assert.deepStrictEqual([empty.ok, empty.error], [false, 'invalid_reference']);

  // the input list is never mutated
  const original = [baseRef({ id: 'a' })];
  const frozen = JSON.stringify(original);
  core.addReference(original, baseRef({ id: 'b' }));
  assert.strictEqual(JSON.stringify(original), frozen);
});

test('updateNote / removeReference / clearReferences only touch what they name', () => {
  const list = [baseRef({ id: 'a', note: '' }), baseRef({ id: 'b', note: 'keep' })];
  const edited = core.updateNote(list, 'a', '换个间距');
  assert.strictEqual(edited.ok, true);
  assert.strictEqual(edited.list[0].note, '换个间距');
  assert.strictEqual(edited.list[1].note, 'keep');
  assert.strictEqual(list[0].note, '', 'input untouched');

  const missing = core.updateNote(list, 'ghost', 'x');
  assert.deepStrictEqual([missing.ok, missing.list.length], [false, 2]); // unknown id: nothing changed
  // an empty id is rejected outright (nothing to name)
  assert.strictEqual(core.updateNote(list, '', 'x').ok, false);
  assert.strictEqual(core.updateNote(list, '', 'x').error, 'invalid_id');

  const removed = core.removeReference(list, 'a');
  assert.strictEqual(removed.ok, true);
  assert.deepStrictEqual(removed.list.map((r) => r.id), ['b']);
  assert.deepStrictEqual(core.removeReference(list, 'ghost').ok, false);

  assert.deepStrictEqual(core.clearReferences(), []);
});

test('acceptSent drops exactly the ids a send carried; newer ids survive', () => {
  const list = [baseRef({ id: 'a' }), baseRef({ id: 'b' }), baseRef({ id: 'c' })];
  const next = core.acceptSent(list, ['a', 'c']);
  assert.deepStrictEqual(next.map((r) => r.id), ['b']);
  assert.deepStrictEqual(core.acceptSent(list, []).length, 3);
  assert.deepStrictEqual(core.acceptSent(list, ['ghost']).length, 3);
});

// -------------------------------------------------------------- sanitize

test('sanitizeReference keeps known fields, clamps sizes and never throws on garbage', () => {
  const out = core.sanitizeReference(baseRef({
    id: 'x'.repeat(200),
    url: 'u'.repeat(5000),
    note: 'n'.repeat(5000),
    html: 'h'.repeat(9000),
    styles: { color: 'red', position: 'absolute', bogus: 'x', nested: { a: 1 } },
    unknown: 'drop me',
  }));
  assert.strictEqual(out.id.length, core.LIMITS.ID);
  assert.strictEqual(out.url.length, core.LIMITS.URL);
  assert.strictEqual(out.note.length, core.LIMITS.NOTE);
  assert.strictEqual(out.html.length, core.LIMITS.HTML);
  // sanitizeStyles is a size guard, not an allowlist: unknown keys stay (pickStyles does the filtering)
  assert.deepStrictEqual(out.styles, { color: 'red', position: 'absolute', bogus: 'x' });
  assert.strictEqual('unknown' in out, false);
  assert.ok(Number.isFinite(out.createdAt));
  for (const bad of [undefined, null, 42, [], 'str']) {
    assert.deepStrictEqual(core.sanitizeReference(bad), {});
  }
  // without any signal at all there is nothing worth sending
  assert.deepStrictEqual(core.sanitizeReference({ selector: '#a', styles: {}, html: '', url: '' }), {});
});

test('sanitizeStyles ignores non-string keys/values and clamps long values', () => {
  assert.deepStrictEqual(core.sanitizeStyles(undefined), {});
  assert.deepStrictEqual(core.sanitizeStyles({ color: '', background: ' ', width: 12 }), {});
  // the key is capped at 80 chars, the value at STYLE_VALUE
  const out = core.sanitizeStyles({ width: `${'9'.repeat(500)}px`, [`${'x'.repeat(200)}`]: 'y' });
  assert.deepStrictEqual(Object.keys(out), ['width', 'x'.repeat(80)]);
  assert.strictEqual(out.width.length, core.LIMITS.STYLE_VALUE);
});

test('sanitizeScreenshot accepts only image data URLs and measures the decoded bytes', () => {
  assert.strictEqual(core.sanitizeScreenshot('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.strictEqual(core.sanitizeScreenshot('data:image/jpeg;base64,AAAA'), 'data:image/jpeg;base64,AAAA');
  assert.strictEqual(core.sanitizeScreenshot('data:image/webp;base64,AAAA'), 'data:image/webp;base64,AAAA');
  for (const bad of ['http://x/y.png', 'data:text/html;base64,AAAA', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', 42, '']) {
    assert.strictEqual(core.sanitizeScreenshot(bad), '', String(bad));
  }
});

test('toSendReferences emits the send field list (createdAt and oversize screenshots dropped)', () => {
  const ref = core.toSendReference(baseRef({ createdAt: 1234 }));
  assert.deepStrictEqual(Object.keys(ref).sort(), [...core.SEND_FIELDS].filter((f) => f !== 'screenshot').sort());
  assert.strictEqual('createdAt' in ref, false);
  // `{selector:'div'}` alone is dropped (no url/html/styles to send); the full record goes through
  assert.deepStrictEqual(core.toSendReferences([{}, { id: 'x', selector: 'div', html: '<div></div>' }, baseRef()]).map((r) => r.id), ['x', 'ref_1']);
  // an over-the-cap screenshot is dropped rather than failing the whole reference
  const big = `data:image/png;base64,${'A'.repeat(Math.ceil((core.LIMITS.SCREENSHOT_BYTES * 4) / 3) + 1024)}`;
  const withoutShot = core.toSendReference(baseRef({ screenshot: big }));
  assert.strictEqual('screenshot' in withoutShot, false);
  const kept = core.toSendReference(baseRef({ screenshot: 'data:image/jpeg;base64,AAAA' }));
  assert.strictEqual(kept.screenshot, 'data:image/jpeg;base64,AAAA');
});

// ------------------------------------------------------------- URL privacy

test('sanitizeUrl drops credentials/hash and redacts sensitive query values', () => {
  const out = core.sanitizeUrl('https://user:pass@example.com/a/b?token=abc&page=2&key=K&sig=s&session=z&code=c&password=p&auth=a#frag');
  assert.strictEqual(out, 'https://example.com/a/b?token=REDACTED&page=2&key=REDACTED&sig=REDACTED&session=REDACTED&code=REDACTED&password=REDACTED&auth=REDACTED');
  assert.strictEqual(core.sanitizeUrl('javascript:alert(1)'), '');
  assert.strictEqual(core.sanitizeUrl('chrome-extension://abc/x'), '');
  // relative/garbage values fall back to the current page (never an empty source)
  const fallback = core.sanitizeUrl('not a url');
  assert.ok(fallback === '' || /^https?:\/\//.test(fallback), fallback);
  // a data: URI as a query value is redacted too
  assert.match(core.sanitizeUrl('https://e.com/p?next=data:text/html,hi'), /next=REDACTED/);
  // prefixed/suffixed credential-looking names are caught as well
  const names = core.sanitizeUrl('https://e.com/?access_token=a&api_key=b&session_id=c&user_id=42&keyword=js');
  assert.ok(/access_token=REDACTED/.test(names) && /api_key=REDACTED/.test(names) && /session_id=REDACTED/.test(names));
  assert.ok(/user_id=42/.test(names) && /keyword=js/.test(names), 'ordinary id/name parameters stay');
});

test('shortUrl shows host+path (+ sanitized query) for the tray label', () => {
  assert.strictEqual(core.shortUrl('https://example.com/a/b?token=x&page=2#z'), 'example.com/a/b?token=x&page=2');
  assert.strictEqual(core.shortUrl('https://example.com'), 'example.com');
  assert.strictEqual(core.shortUrl('https://example.com/'), 'example.com');
  assert.strictEqual(core.shortUrl(''), '');
  assert.strictEqual(core.shortUrl('garbage'), 'garbage');
});

// ---------------------------------------------------------- capture guards

test('pickStyles keeps only the whitelisted computed style fields', () => {
  const computed = {
    color: 'rgb(1, 2, 3)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'url(x)',
    fontFamily: 'Inter', fontSize: '14px', fontWeight: '600', lineHeight: '1.4',
    letterSpacing: '0.2px', padding: '4px', margin: '0', gap: '8px', display: 'flex',
    border: '1px solid #ccc', borderRadius: '4px', boxShadow: 'none',
    width: '100px', height: '20px',
    position: 'absolute', opacity: '0.5', overflow: 'hidden', textAlign: 'left',
  };
  const picked = core.pickStyles(computed);
  assert.deepStrictEqual(picked, core.STYLE_KEYS.reduce((acc, key) => { acc[key] = computed[key]; return acc; }, {}));
  assert.deepStrictEqual(core.pickStyles(null), {});
  assert.deepStrictEqual(core.pickStyles({ color: '   ' }), {});
});

test('sanitizeElementHtml strips code, handlers, srcdoc and user-entered text but keeps structure', () => {
  const html = [
    '<div class="card" onclick="steal()" onmouseover="x()">',
    '<script>alert(document.cookie)</script>',
    '<style>.x{color:red}</style>',
    '<input type="text" value="secret" name="q">',
    '<input type="password" value="pw">',
    '<input type="hidden" value="h">',
    '<textarea>typed comment</textarea>',
    '<select><option selected>chosen</option></select>',
    '<button>提交订单</button>',
    '<div contenteditable="true">我的草稿</div>',
    '<iframe srcdoc="<script>x</script>"></iframe>',
    `<img src="data:image/png;base64,${'A'.repeat(600)}">`,
    '</div>',
  ].join('');
  const out = core.sanitizeElementHtml(html);
  assert.ok(out.startsWith('<div class="card"') && out.endsWith('</div>'));
  assert.ok(!out.includes('onclick') && !out.includes('onmouseover'));
  assert.ok(!out.toLowerCase().includes('script') || !out.includes('alert'));
  assert.ok(!out.includes('document.cookie'));
  assert.ok(!out.includes('secret') && !out.includes('value='));
  assert.ok(!out.includes('type="password"') && !out.includes('type="hidden"'));
  assert.ok(!out.includes('typed comment') && !out.includes('我的草稿'));
  // Visible labels are the point of a reference (and already in its screenshot): they stay.
  assert.ok(out.includes('提交订单') && out.includes('chosen'));
  // checkbox/radio state never travels; the input's real type is replaced by a placeholder
  const controls = core.sanitizeElementHtml('<input type="checkbox" checked value="on"><select><option selected>a</option></select>');
  assert.ok(!controls.includes('checked') && !controls.includes('selected'));
  assert.ok(controls.includes('[REDACTED]'));
  assert.ok(!out.includes('srcdoc'));
  assert.ok(!out.includes('A'.repeat(100)), 'long data: URI redacted');
  assert.ok(!out.includes('selected'));
  assert.ok(out.includes('class="card"'), 'meaningful attributes stay');

  assert.strictEqual(core.sanitizeElementHtml(undefined), '');
  assert.strictEqual(core.sanitizeElementHtml(`<div>${'x'.repeat(20000)}</div>`).length, core.LIMITS.HTML);
});

test('sanitizeElementHtml tolerates unclosed/messy markup without throwing', () => {
  assert.doesNotThrow(() => {
    core.sanitizeElementHtml('<div><span>unclosed');
    core.sanitizeElementHtml('<SCRIPT>a</SCRIPT><p onclick=x>');
    core.sanitizeElementHtml('');
  });
});

test('isSafeImageDataUrl rejects everything that is not a small raster data URL', () => {
  assert.strictEqual(core.isSafeImageDataUrl('data:image/png;base64,AAAA'), true);
  assert.strictEqual(core.isSafeImageDataUrl('data:image/jpeg;base64,AAAA'), true);
  assert.strictEqual(core.isSafeImageDataUrl('data:image/webp;base64,AAAA'), true);
  for (const bad of [
    'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA', 'javascript:alert(1)',
    'http://x/y.png', '//evil', 'data:image/png;base64,AAA A', '', 'data:image/png;base64,',
  ]) {
    assert.strictEqual(core.isSafeImageDataUrl(bad), false, bad);
  }
});

// --------------------------------------------------------------- messages

test('isValidAddMessage rejects malformed or oversized payloads', () => {
  assert.strictEqual(core.isValidAddMessage({ type: core.MSG.ADD, reference: baseRef() }), true);
  for (const bad of [
    null, undefined, 42, {},
    { type: core.MSG.ADD },
    { type: core.MSG.ADD, reference: null },
    { type: core.MSG.ADD, reference: [] },
    { type: 'OTHER', reference: {} },
    { type: core.MSG.ADD, reference: { html: 'x'.repeat(300 * 1024) } },
  ]) {
    assert.strictEqual(core.isValidAddMessage(bad), false, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('isValidUpdateMessage carries only an id and a string note', () => {
  assert.strictEqual(core.isValidUpdateMessage({ type: core.MSG.UPDATE_NOTE, id: 'a', note: 'x' }), true);
  assert.strictEqual(core.isValidUpdateMessage({ type: core.MSG.UPDATE_NOTE, id: 'a' }), true);
  for (const bad of [
    null, { type: core.MSG.UPDATE_NOTE }, { type: core.MSG.UPDATE_NOTE, id: '' },
    { type: core.MSG.UPDATE_NOTE, id: 42 }, { type: core.MSG.UPDATE_NOTE, id: 'a', note: 42 },
  ]) {
    // extra fields (e.g. a smuggled `reference`) are ignored by the writer; the message itself is valid
    assert.strictEqual(core.isValidUpdateMessage(bad), false, JSON.stringify(bad));
  }
  assert.strictEqual(core.isValidUpdateMessage({ type: core.MSG.UPDATE_NOTE, id: 'a', reference: { selector: 'div' } }), true);
});

test('validateIncomingReference enforces the size caps and returns a sanitized copy', () => {
  const ok = core.validateIncomingReference(baseRef());
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.reference.selector, baseRef().selector);
  assert.deepStrictEqual([core.validateIncomingReference({ selector: '' }).ok,
    core.validateIncomingReference({ selector: '' }).error], [false, 'invalid_reference']);
  const bigHtml = core.validateIncomingReference(baseRef({ html: 'x'.repeat(core.LIMITS.HTML + 1) }));
  assert.deepStrictEqual([bigHtml.ok, bigHtml.error], [false, 'reference_too_large']);
  const bigNote = core.validateIncomingReference(baseRef({ note: 'x'.repeat(core.LIMITS.NOTE + 1) }));
  assert.deepStrictEqual([bigNote.ok, bigNote.error], [false, 'reference_too_large']);
  const bigUrl = core.validateIncomingReference(baseRef({ url: 'https://e.com/?q=' + 'x'.repeat(core.LIMITS.URL) }));
  assert.deepStrictEqual([bigUrl.ok, bigUrl.error], [false, 'reference_too_large']);
  // the cap counts decoded bytes (base64 inflates by 4/3)
  const shot = (n) => `data:image/png;base64,${'A'.repeat(n)}`;
  // a screenshot that is clearly an image but decodes above the byte cap is refused as too large
  const over = core.validateIncomingReference(baseRef({ screenshot: shot(Math.ceil((core.LIMITS.SCREENSHOT_BYTES * 4) / 3) + 1024) }));
  assert.deepStrictEqual([over.ok, over.error], [false, 'reference_too_large'], 'screenshot byte cap');
  const under = core.validateIncomingReference(baseRef({ screenshot: shot(1024) }));
  assert.strictEqual(under.ok, true);
});

// ------------------------------------------- resolveSentReferences contract

test('resolveSentReferences: accepted only when referencesAccepted equals the sent count', () => {
  const ids = ['a', 'b'];
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: { referencesAccepted: 2 } }, ids),
    { keep: false, accepted: true, count: 2 });
  // older Hub: no field -> keep + "unsupported" (the side panel tells the user)
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: { turnId: 't' } }, ids),
    { keep: true, accepted: false, reason: 'unsupported', count: 0 });
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: {} }, ids).reason, 'unsupported');
  // partial accept / wrong number -> keep + count_mismatch
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: { referencesAccepted: 1 } }, ids),
    { keep: true, accepted: false, reason: 'count_mismatch', count: 1 });
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: { referencesAccepted: 3 } }, ids),
    { keep: true, accepted: false, reason: 'count_mismatch', count: 3 });
  // non-numeric / non-object responses are errors
  for (const res of [
    null, undefined, 'x', 42, { ok: false, data: { referencesAccepted: 2 } },
    { ok: true, data: { referencesAccepted: '2' } }, { ok: true, data: { referencesAccepted: NaN } },
    { ok: true }, {},
  ]) {
    const out = core.resolveSentReferences(res, ids);
    assert.strictEqual(out.keep, true, JSON.stringify(res));
    assert.strictEqual(out.accepted, false, JSON.stringify(res));
  }
  // nothing was sent: nothing to accept, never an "unsupported" complaint
  assert.deepStrictEqual(core.resolveSentReferences({ ok: true, data: {} }, []),
    { keep: true, accepted: false, reason: 'unsupported', count: 0 });
});
