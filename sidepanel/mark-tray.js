/**
 * DevTailor — side panel mark tray (DOM wiring)
 *
 * Shows the marks and screenshot attachments of the followed tab above the composer. The tray is a
 * read-only mirror of the page's store (marks-core.js `createTrayModel`); every action is written
 * back to the content script and the tray re-renders from the snapshot the page answers with.
 * Nothing is rendered when there is nothing to send, so an empty tray takes no space.
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
      return `
        <span class="tray-chip${mark.sent ? ' is-sent' : ''}" data-mark-id="${esc(mark.id)}" role="button" tabindex="0"
          title="${esc(mark.selector)}${mark.comment ? `\n${esc(mark.comment)}` : ''}" aria-label="定位标记 ${esc(mark.index)}：${label}">
          <span class="tray-chip__n" style="background:${esc(mark.color)}">${esc(mark.index)}</span>
          <span class="tray-chip__t">${label}</span>
          ${mark.sent ? '<span class="tray-chip__sent">已发送</span>' : ''}
          <button type="button" class="tray-chip__x" data-act="remove-mark" data-id="${esc(mark.id)}" aria-label="移除标记 ${esc(mark.index)}">×</button>
        </span>`;
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

        if (unavailable && empty) {
          els.body.innerHTML = '<p class="mark-tray__note">当前被接管的标签页没有 DevTailor（仅在 localhost / 已允许的站点上可用，或需要刷新页面），没有可随消息发送的标记。</p>';
        } else {
          fetchThumbs(s.screenshots);
          els.body.innerHTML = `
            ${s.marks.length ? `<div class="mark-tray__chips">${s.marks.map(chipHtml).join('')}</div>` : ''}
            ${s.screenshots.length ? `<div class="mark-tray__shots">${s.screenshots.map(shotHtml).join('')}</div>` : ''}
            ${s.truncated ? '<p class="mark-tray__note">标记很多，这里只显示前 200 个。</p>' : ''}`;
        }
      }
      onChange?.(s);
    }

    model.subscribe(render);

    els.toggle.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
    });
    els.clearSent.addEventListener('click', () => controller.clearSent());
    els.body.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-act]');
      if (remove) {
        event.stopPropagation();
        if (remove.dataset.act === 'remove-mark') controller.removeMark(remove.dataset.id);
        else if (remove.dataset.act === 'remove-shot') controller.removeScreenshot(remove.dataset.id);
        return;
      }
      const chip = event.target.closest('.tray-chip');
      if (chip) controller.locate(chip.dataset.markId);
    });
    els.body.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.tray-chip')) {
        event.preventDefault();
        controller.locate(event.target.dataset.markId);
      }
    });

    return {
      model,
      controller,
      render,
      /** Start following a tab (null = none) and pull its current marks. */
      async follow(tabId) {
        if (model.getState().tabId === tabId && model.getState().status !== 'idle') return;
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
