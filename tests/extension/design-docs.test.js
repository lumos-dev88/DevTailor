'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dd = require('../../sidepanel/design-docs.js');

test('formatSize', () => {
  assert.strictEqual(dd.formatSize(0), '0 B');
  assert.strictEqual(dd.formatSize(512), '512 B');
  assert.strictEqual(dd.formatSize(2048), '2.0 KB');
  assert.strictEqual(dd.formatSize(200 * 1024), '200 KB');
});

test('validateUpload checks extension, size and count', () => {
  assert.strictEqual(dd.validateUpload({ name: 'DESIGN.md', size: 100 }, 0), '');
  assert.strictEqual(dd.validateUpload({ name: 'a.TXT', size: 100 }, 9), '');
  assert.match(dd.validateUpload({ name: 'a.png', size: 1 }, 0), /仅支持/);
  assert.match(dd.validateUpload({ name: 'a.md', size: dd.MAX_BYTES + 1 }, 0), /256KB/);
  assert.match(dd.validateUpload({ name: 'a.md', size: 1 }, dd.MAX_DOCS), /最多/);
});

test('errorText maps bridge codes', () => {
  assert.match(dd.errorText({ code: 'design_doc_too_large' }), /256KB/);
  assert.match(dd.errorText({ code: 'design_doc_limit' }), /最多/);
  assert.match(dd.errorText({ status: 404, code: '' }), /升级/);
  assert.strictEqual(dd.errorText({ code: 'weird', message: 'boom' }), 'boom');
});

test('summaryText', () => {
  assert.strictEqual(dd.summaryText([]), '未添加');
  assert.strictEqual(dd.summaryText([{ enabled: true }, { enabled: false }]), '1/2 已启用');
});
