/**
 * DevTailor — side panel references tray (DOM wiring)
 *
 * A separate section of the mark tray area for "参考元素": it shows whenever there is something to
 * show (even without a taken-over page and with no marks). The list lives in the service worker's
 * chrome.storage.session (`dt_references`); every change broadcasts DT_REFERENCES_UPDATED, so the
 * tray just mirrors that broadcast. Note edits / removals are written back through the background
 * (references-core.js keeps the single-writer rule).
 *
 * All page-derived strings are rendered with textContent (never innerHTML); the only attribute we
 * set on an <img> is a data:image/(png|jpeg|webp);base64 URL that references-core has already
 * validated.
 */
(() => {
  'use strict';

  function create({ els, send, onCountChange }) {
    const core = window.__domReview.referencesCore;
    let references = [];
    let collapsed = false;
    let editingId = null;

    function applyList(list) {
      const next = Array.isArray(list) ? list : [];
      references = next;
      render();
    }

    function count() {
      return references.length;
    }

    // ------------------------------------------------------------- render

    function thumbEl(ref) {
      const box = document.createElement('span');
      box.className = 'ref-card__thumb';
      if (core.isSafeImageDataUrl(ref.screenshot)) {
        const img = document.createElement('img');
        img.src = ref.screenshot;
        img.alt = '';
        box.appendChild(img);
      } else {
        box.textContent = '无截图';
      }
      return box;
    }

    function sourceEl(ref) {
      const span = document.createElement('span');
      span.className = 'ref-card__source';
      span.textContent = core.shortUrl(ref.url) || '(无来源)';
      if (ref.url) span.title = ref.url; // full (sanitized) URL on hover
      return span;
    }

    function cardEl(ref) {
      const card = document.createElement('div');
      card.className = 'ref-card';
      card.dataset.refId = ref.id;

      card.appendChild(thumbEl(ref));

      const body = document.createElement('div');
      body.className = 'ref-card__body';

      const top = document.createElement('div');
      top.className = 'ref-card__top';
      top.appendChild(sourceEl(ref));

      if (editingId === ref.id) {
        const input = document.createElement('input');
        input.className = 'tray-note';
        input.type = 'text';
        input.value = ref.note || '';
        input.setAttribute('aria-label', `编辑参考备注：${core.shortUrl(ref.url)}`);
        input.placeholder = '备注，Enter 保存，Esc 取消';
        top.appendChild(input);
        setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
      } else {
        const note = document.createElement('span');
        note.className = 'ref-card__note';
        note.textContent = ref.note || '（无备注）';
        note.title = ref.selector || '';
        top.appendChild(note);
      }
      body.appendChild(top);

      const selector = document.createElement('div');
      selector.className = 'ref-card__selector';
      selector.textContent = ref.selector || '';
      selector.title = ref.selector || '';
      body.appendChild(selector);

      const actions = document.createElement('div');
      actions.className = 'ref-card__actions';
      if (editingId === ref.id) {
        actions.appendChild(button('保存', 'save', () => void commitNote(ref.id)));
        actions.appendChild(button('取消', 'cancel', () => { editingId = null; render(); }));
      } else {
        actions.appendChild(button('备注', 'edit', () => { editingId = ref.id; render(); }));
        actions.appendChild(button('删除', 'remove', () => void removeOne(ref.id), true));
      }
      body.appendChild(actions);

      card.appendChild(body);
      return card;
    }

    function button(label, act, onClick, danger = false) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `ref-card__btn${danger ? ' ref-card__btn--danger' : ''}`;
      el.dataset.act = act;
      el.textContent = label;
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      return el;
    }

    function render() {
      const empty = references.length === 0;
      els.root.hidden = empty;
      els.clear.hidden = empty;
      onCountChange?.(references.length);
      if (empty) return;
      const capped = references.length >= core.MAX_REFERENCES;
      els.title.textContent = `参考 ${references.length}${capped ? '（已达上限）' : ''}`;
      els.toggle.setAttribute('aria-expanded', String(!collapsed));
      els.root.classList.toggle('is-collapsed', collapsed);
      els.body.replaceChildren(...references.map(cardEl));
    }

    // ------------------------------------------------------------- actions

    function commitNote(id) {
      const input = els.body.querySelector('.tray-note');
      updateNote(id, input ? input.value.trim() : '');
    }

    async function updateNote(id, note) {
      try {
        const res = await send({ type: core.MSG.UPDATE_NOTE, id, note });
        if (res && res.ok === false) throw new Error(res.error || '保存失败');
      } finally {
        editingId = null; // an optimistic edit is fine; the UPDATED broadcast brings back the truth
      }
    }

    async function removeOne(id) {
      await send({ type: core.MSG.REMOVE, id });
    }

    function clearAll() {
      return send({ type: core.MSG.CLEAR });
    }

    function initEvents() {
      els.toggle.addEventListener('click', () => {
        collapsed = !collapsed;
        render();
      });
      els.clear.addEventListener('click', () => { if (references.length) void clearAll(); });
      els.body.addEventListener('keydown', (event) => {
        const input = event.target.closest('.tray-note');
        if (!input) return;
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); void commitNote(editingId); }
        else if (event.key === 'Escape') { event.preventDefault(); editingId = null; render(); }
      });
      els.body.addEventListener('focusout', (event) => {
        if (event.target.matches?.('.tray-note') && editingId) void commitNote(editingId);
      });
    }

    initEvents();
    render();

    return {
      applyList,
      render,
      /** Ask the service worker for the current list (panel was opened after captures). */
      async refresh() {
        const res = await send({ type: core.MSG.GET });
        applyList(res && res.ok ? res.references : []);
        return res;
      },
      count,
    };
  }

  window.__sidepanelReferencesTray = { create };
})();
