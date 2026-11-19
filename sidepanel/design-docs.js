/**
 * DevTailor side panel — design spec (DESIGN.md) manager
 *
 * Upload / toggle / delete DESIGN.md files through the bridge's /design-docs routes. The bridge
 * owns storage and limits and passes only the enabled files' paths to the AI; this file shows the
 * list and maps errors. Pure helpers are exported for Node tests (tests/extension/design-docs.test.js).
 *
 * Browser: window.__sidepanelDesignDocs. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const MAX_BYTES = 256 * 1024;
  const MAX_DOCS = 10;
  const ACCEPT = '.md,.markdown,.txt';

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  }

  /** Client-side pre-check (the bridge re-validates). Returns an error string or ''. */
  function validateUpload(file, count) {
    const name = String((file && file.name) || '');
    if (!/\.(md|markdown|txt)$/i.test(name)) return `${name || '文件'}：仅支持 .md / .markdown / .txt`;
    if ((file.size || 0) > MAX_BYTES) return `${name}：超过 ${MAX_BYTES / 1024}KB 上限`;
    if (count >= MAX_DOCS) return `最多 ${MAX_DOCS} 个规范文件`;
    return '';
  }

  function errorText(parsed) {
    const map = {
      design_doc_too_large: '文件超过 256KB 上限',
      design_doc_limit: `最多 ${MAX_DOCS} 个规范文件`,
      invalid_design_doc: parsed.message || '文件内容无效（需要非空的 UTF-8 文本）',
      design_doc_not_found: '文件已不存在，请刷新列表',
      store_unavailable: 'Bridge 未配置数据目录，无法保存规范',
      bridge_offline: 'Bridge 未连接',
    };
    if (parsed.status === 404 && !parsed.code) return '当前 Bridge 版本不支持设计规范，请升级 Bridge';
    return map[parsed.code] || parsed.message || '操作失败';
  }

  /** Summary shown on the collapsed header. */
  function summaryText(docs) {
    const list = Array.isArray(docs) ? docs : [];
    const on = list.filter((d) => d.enabled).length;
    return list.length ? `${on}/${list.length} 已启用` : '未添加';
  }

  const api = { MAX_BYTES, MAX_DOCS, ACCEPT, formatSize, validateUpload, errorText, summaryText };

  function create(deps) {
    const { els, call } = deps;
    const state = { open: false, connected: false, docs: [], error: '', busy: false };

    function el(tag, cls, text) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    }

    function render() {
      els.summary.textContent = state.connected ? summaryText(state.docs) : 'Bridge 未连接';
      els.toggle.setAttribute('aria-expanded', String(state.open));
      els.body.hidden = !state.open;
      els.uploadBtn.disabled = !state.connected || state.busy || state.docs.length >= MAX_DOCS;
      els.error.hidden = !state.error;
      els.error.textContent = state.error;
      els.list.textContent = '';
      if (!state.connected) {
        els.list.appendChild(el('li', 'dd-empty', 'Bridge 未连接，无法管理设计规范。'));
        return;
      }
      if (!state.docs.length) {
        els.list.appendChild(el('li', 'dd-empty', '还没有规范文件。上传后，AI 每次调整前会先读取已启用的文件；多个文件冲突时靠后启用者优先。'));
        return;
      }
      for (const doc of state.docs) {
        const row = el('li', `dd-row${doc.enabled ? ' is-enabled' : ''}`);
        const label = el('label', 'dd-row__main');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = Boolean(doc.enabled);
        box.disabled = state.busy;
        box.setAttribute('aria-label', `启用 ${doc.name}`);
        box.addEventListener('change', () => toggle(doc.id, box.checked));
        const name = el('span', 'dd-row__name', doc.name);
        name.title = doc.name;
        label.append(box, name);
        const size = el('span', 'dd-row__size', formatSize(doc.size));
        const del = el('button', 'topbar-btn dd-row__del', '删除');
        del.type = 'button';
        del.disabled = state.busy;
        del.addEventListener('click', () => remove(doc.id));
        row.append(label, size, del);
        els.list.appendChild(row);
      }
    }

    async function run(fn) {
      state.busy = true;
      state.error = '';
      render();
      try { await fn(); } finally { state.busy = false; render(); }
    }

    function applyResult(parsed) {
      if (parsed.ok && parsed.data && Array.isArray(parsed.data.docs)) {
        state.docs = parsed.data.docs;
        return true;
      }
      state.error = errorText(parsed);
      return false;
    }

    async function refresh() {
      if (!state.connected) return render();
      await run(async () => { applyResult(await call('/design-docs')); });
    }

    async function toggle(id, enabled) {
      await run(async () => {
        applyResult(await call('/design-docs/toggle', { method: 'POST', body: { id, enabled } }));
      });
    }

    async function remove(id) {
      await run(async () => {
        applyResult(await call('/design-docs/delete', { method: 'POST', body: { id } }));
      });
    }

    async function upload(files) {
      const errors = [];
      await run(async () => {
        for (const file of files) {
          const bad = validateUpload(file, state.docs.length);
          if (bad) { errors.push(bad); continue; }
          let content;
          try { content = await file.text(); } catch { errors.push(`${file.name}：读取失败`); continue; }
          const parsed = await call('/design-docs', { method: 'POST', body: { name: file.name, content } });
          if (!applyResult(parsed)) errors.push(`${file.name}：${state.error}`);
        }
      });
      state.error = errors.join('；');
      render();
    }

    els.toggle.addEventListener('click', () => {
      state.open = !state.open;
      render();
      if (state.open) refresh();
    });
    els.uploadBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', () => {
      const files = Array.from(els.fileInput.files || []);
      els.fileInput.value = '';
      if (files.length) upload(files);
    });

    render();
    return {
      setConnected(value) {
        const next = Boolean(value);
        if (next === state.connected) return;
        state.connected = next;
        if (!next) { state.docs = []; state.error = ''; }
        render();
        // 发送时要数「已启用规范」，所以连上就拉一次，不再只在面板展开时拉
        if (next) refresh();
      },
      refresh,
      getState: () => state,
    };
  }

  api.create = create;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.__sidepanelDesignDocs = api;
})();
