/**
 * DevTailor — side panel mark tray (DOM wiring)
 *
 * Shows the marks and screenshot attachments of the followed tab above the composer, and is the
 * one place where marks are reviewed: view (click to locate), edit a note, delete a single mark,
 * clear all of them. The tray is a read-only mirror of the page's store (marks-core.js
 * `createTrayModel`); every action is written back to the content script and the tray re-renders
 * from the snapshot the page answers with.
 *
 * This replaced the old page drawer (removed from toolbar.js): the page toolbar only picks,
 * screenshots and reports takeover state.
 */
(() => {
  'use strict';

  function create({ els, sendToTab, showNotice, onChange }) {
    const marksCore = window.__domReview.marksCore;
    const esc = marksCore.escapeHtml;
    const model = marksCore.createTrayModel();
    const controller = marksCore.createTrayController({ model, sendToTab });
    const thumbs = new Map(); // screenshot id -> small data URL (fetched on demand, never broadcast)
    const requested = new Set();
    let collapsed = false;
    let editingId = null;

    function fetchThumbs(shots) {
      const missing = shots.map((s) => s.id).filter((id) => !thumbs.has(id) && !requested.has(id));
      if (!missing.length) return;
      missing.forEach((id) => requested.add(id));
      controller.thumbs(missing).then((map) => {
        Object.entries(map).forEach(([id, url]) => thumbs.set(id, url));
        render();
      });
    }

    function chipHtml(mark) {
      const label = esc(mark.desc || mark.selector);
      const note = mark.comment ? `\n${esc(mark.comment)}` : '';
      const editing = editingId === mark.id;
      return `
        <span class="tray-chip${mark.sent ? ' is-sent' : ''}" data-mark-id="${esc(mark.id)}" role="button" tabindex="0"
          title="${esc(mark.selector)}${note}" aria-label="定位标记 ${esc(mark.index)}：${label}">
          <span class="tray-chip__n" style="background:${esc(mark.color)}">${esc(mark.index)}</span>
          <span class="tray-chip__t">${label}</span>
          ${mark.sent ? '<span class="tray-chip__sent">已发送</span>' : ''}
          <button type="button" class="tray-chip__act" data-act="edit-mark" data-id="${esc(mark.id)}" aria-label="编辑备注 ${esc(mark.index)}" title="编辑备注">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>
          </button>
          <button type="button" class="tray-chip__act tray-chip__act--danger" data-act="remove-mark" data-id="${esc(mark.id)}" aria-label="移除标记 ${esc(mark.index)}" title="移除标记">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>
          </button>
        </span>
        ${editing ? `<input class="tray-note" data-note="${esc(mark.id)}" type="text" value="${esc(mark.comment || '')}" aria-label="编辑标记 ${esc(mark.index)} 的备注" placeholder="备注，Enter 保存，Esc 取消">` : ''}`;
    }

    function shotHtml(shot, idx) {
      const src = thumbs.get(shot.id);
      const img = src ? `<img src="${esc(src)}" alt="页面截图 ${idx + 1}">` : '<span class="tray-shot__ph">…</span>';
      return `
        <span class="tray-shot" data-shot-id="${esc(shot.id)}" title="${shot.w}×${shot.h}">
          ${img}
          <button type="button" class="tray-chip__x tray-shot__x" data-act="remove-shot" data-id="${esc(shot.id)}" aria-label="移除截图 ${idx + 1}">×</button>
        </span>`;
    }

    function render() {
      const s = model.getState();
      const unavailable = s.status === 'unavailable' && showNotice();
      const empty = s.marks.length === 0 && s.screenshots.length === 0;
      els.root.hidden = empty && !unavailable;
      if (!els.root.hidden) {
        const parts = [];
        if (s.marks.length) parts.push(`页面标记 ${s.marks.length}`);
        if (s.screenshots.length) parts.push(`截图 ${s.screenshots.length}`);
        els.title.textContent = parts.join(' · ') || '页面标记';
        els.toggle.setAttribute('aria-expanded', String(!collapsed));
        els.root.classList.toggle('is-collapsed', collapsed);
        els.clearSent.hidden = !s.marks.some((m) => m.sent);
        els.clearAll.hidden = s.marks.length === 0;

        if (unavailable && empty) {
          els.body.innerHTML = '<p class="mark-tray__note">当前标签页尚未接管 DevTailor。请点击侧边栏顶部“接管当前页”，再添加要随消息发送的标记。</p>';
        } else {
          fetchThumbs(s.screenshots);
          els.body.innerHTML = `
            ${s.marks.length ? `<div class="mark-tray__chips">${s.marks.map(chipHtml).join('')}</div>` : ''}
            ${s.screenshots.length ? `<div class="mark-tray__shots">${s.screenshots.map(shotHtml).join('')}</div>` : ''}
            ${s.truncated ? '<p class="mark-tray__note">标记很多，这里只显示前 200 个。</p>' : ''}`;
          focusNoteInput();
        }
      }
      onChange?.(s);
    }

    function focusNoteInput() {
      if (!editingId) return;
      const input = els.body.querySelector('.tray-note');
      if (!input) { editingId = null; return; }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    model.subscribe(render);

    els.toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
    });
    els.clearSent.addEventListener('click', () => controller.clearSent());
    els.clearAll.addEventListener('click', () => controller.clearMarks());
    els.body.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]');
      if (act) {
        event.stopPropagation();
        if (act.dataset.act === 'remove-mark') { editingId = null; controller.removeMark(act.dataset.id); }
        else if (act.dataset.act === 'remove-shot') controller.removeScreenshot(act.dataset.id);
        else if (act.dataset.act === 'edit-mark') { editingId = act.dataset.id; render(); }
        return;
      }
      const chip = event.target.closest('.tray-chip');
      if (chip) controller.locate(chip.dataset.markId);
    });
    els.body.addEventListener('keydown', (event) => {
      const input = event.target.closest('.tray-note');
      if (input) {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); commitEdit(input); }
        else if (event.key === 'Escape') { event.preventDefault(); editingId = null; render(); }
        return;
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.tray-chip')) {
        event.preventDefault();
        controller.locate(event.target.dataset.markId);
      }
    });
    els.body.addEventListener('focusout', (event) => {
      if (event.target.matches?.('.tray-note') && editingId) commitEdit(event.target);
    });

    /** Commit the note currently open, if any (used before the tray switches tab). */
    async function commitActiveNote() {
      const input = els.body.querySelector('.tray-note');
      if (!input || !editingId) { editingId = null; return; }
      await commitEditAsync(input);
      editingId = null;
    }

    /** Save the open note to the page (Enter / blur). */
    function saveNote(id, value) {
      const mark = model.getState().marks.find((m) => m.id === id);
      if (mark && (mark.comment || '') !== value) return controller.updateMark(id, { comment: value });
      return Promise.resolve();
    }

    function commitEdit(input) {
      const id = editingId;
      if (!id) return Promise.resolve();
      editingId = null;
      const out = saveNote(id, input.value.trim());
      render();
      return out;
    }

    async function commitActiveNote() {
      const input = els.body.querySelector('.tray-note');
      if (!input || !editingId) { editingId = null; return; }
      const id = editingId;
      editingId = null;
      await saveNote(id, input.value.trim());
    }

    return {
      model,
      controller,
      render,
      /** Start following a tab (null = none) and pull its current marks. */
      async follow(tabId) {
        if (model.getState().tabId === tabId && model.getState().status !== 'idle') return;
        if (editingId) await commitActiveNote();
        model.follow(tabId);
        if (tabId != null) await controller.refresh();
      },
      hasContent() {
        const s = model.getState();
        return s.marks.some((m) => !m.sent) || s.screenshots.length > 0;
      },
    };
  }

  window.__sidepanelMarkTray = { create };
})();