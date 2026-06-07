/**
 * DevTailor — Page Mark Cards Module
 *
 * Renders one in-page card per marked DOM element. The card contains the
 * mark number, selector summary, annotation editor, and core actions.
 *
 * Depends on: store (review-store.js), hitTest (visbug-hit-test.js)
 * Registers: window.__domReview.badges
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const LAYER_Z = 2147483646;
  const MARK_COLORS = [
    '#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#a855f7',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16'
  ];

  let container = null;
  let cards = new Map();
  let selectedId = null;
  let rafPending = false;
  let listening = false;
  let documentCloseWired = false;

  function getColor(index) {
    return MARK_COLORS[(index - 1) % MARK_COLORS.length];
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function truncate(str, maxLen = 46) {
    if (!str || str.length <= maxLen) return str || '';
    return str.slice(0, maxLen - 1) + '…';
  }

  function ensureContainer() {
    if (container && container.parentNode) return;
    container = document.createElement('div');
    container.id = 'dom-review-badges';
    container.style.cssText = `
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: ${LAYER_Z};
      overflow: visible;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;
    document.body.appendChild(container);
    injectStyles();
    wireDocumentClose();
  }

  function injectStyles() {
    if (document.getElementById('dom-review-badge-styles')) return;
    const style = document.createElement('style');
    style.id = 'dom-review-badge-styles';
    style.textContent = `
      .dt-mark-card {
        position: absolute;
        width: min(286px, calc(100vw - 24px));
        border: 1px solid rgba(226, 232, 240, 0.16);
        border-radius: 10px;
        background: #172033;
        color: #e2e8f0;
        box-shadow: 0 16px 42px rgba(15, 23, 42, 0.34);
        pointer-events: auto;
        user-select: none;
        overflow: hidden;
      }
      .dt-mark-card.is-compact {
        width: 18px;
        height: 18px;
        min-width: 18px;
        border-radius: 999px;
        border-color: transparent;
        cursor: pointer;
        overflow: visible;
        box-shadow: 0 6px 16px rgba(15, 23, 42, 0.26);
      }
      .dt-mark-card.is-selected {
        border-color: var(--dt-mark-card-color, rgba(59, 130, 246, 0.74));
        box-shadow: 0 18px 48px rgba(15, 23, 42, 0.42), 0 0 0 2px var(--dt-mark-card-ring, rgba(59, 130, 246, 0.18));
      }
      .dt-mark-card.is-flashing {
        animation: dt-mark-card-flash 620ms ease;
      }
      @keyframes dt-mark-card-flash {
        0%, 100% { transform: scale(1); filter: brightness(1); }
        50% { transform: scale(1.04); filter: brightness(1.16); }
      }
      .dt-mark-card-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 9px;
      }
      .dt-mark-card-index {
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        border-radius: 11px;
        color: #f8fafc;
        font-size: 12px;
        font-weight: 750;
        line-height: 22px;
        text-align: center;
        flex-shrink: 0;
      }
      .dt-mark-card-dot {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        border-radius: inherit;
        color: #f8fafc;
        font-size: 10px;
        font-weight: 800;
        line-height: 1;
      }
      .dt-mark-card-title {
        min-width: 0;
        flex: 1;
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dt-mark-card-selector {
        color: #94a3b8;
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 10px;
      }
      .dt-mark-card-body {
        padding: 0 9px 9px;
      }
      .dt-mark-card-editor {
        width: 100%;
        min-height: 68px;
        max-height: 128px;
        padding: 8px 9px;
        resize: vertical;
        color: #f8fafc;
        background: #0f172a;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 8px;
        outline: none;
        font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        user-select: text;
      }
      .dt-mark-card-editor:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.18);
      }
      .dt-mark-card-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 8px;
      }
      .dt-mark-card-btn {
        height: 28px;
        padding: 0 9px;
        border: 0;
        border-radius: 7px;
        color: #cbd5e1;
        background: rgba(148, 163, 184, 0.12);
        cursor: pointer;
        font: 12px/28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .dt-mark-card-btn:hover {
        color: #f8fafc;
        background: rgba(148, 163, 184, 0.2);
      }
      .dt-mark-card-btn.is-danger:hover {
        color: #fecaca;
        background: rgba(239, 68, 68, 0.2);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getTarget(review) {
    const hitTest = window.__domReview.hitTest;
    return hitTest ? hitTest.resolveSelector(review.selector) : null;
  }

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    const int = parseInt(value, 16);
    return {
      r: (int >> 16) & 255,
      g: (int >> 8) & 255,
      b: int & 255,
    };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function createCard(review) {
    const card = document.createElement('div');
    card.className = 'dt-mark-card';
    card.dataset.reviewId = review.id;
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-action], textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      selectReview(review.id);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeFloating();
    });
    return card;
  }

  function renderCardContent(card, review, index) {
    const selected = selectedId === review.id;
    const color = getColor(index + 1);
    const comment = (review.comment || '').trim();
    const title = comment || '添加说明';
    card.classList.toggle('is-selected', selected);
    card.classList.toggle('is-compact', !selected);
    card.style.setProperty('--dt-mark-card-color', rgba(color, 0.74));
    card.style.setProperty('--dt-mark-card-ring', rgba(color, 0.18));
    card.style.background = selected ? '#172033' : color;
    card.innerHTML = selected ? `
      <div class="dt-mark-card-head">
        <span class="dt-mark-card-index" style="background:${color}">${index + 1}</span>
        <div class="dt-mark-card-title">
          <div>${escapeHtml(title)}</div>
          <div class="dt-mark-card-selector" title="${escapeHtml(review.selector)}">${escapeHtml(truncate(review.selector, 42))}</div>
        </div>
      </div>
      <div class="dt-mark-card-body">
        <textarea class="dt-mark-card-editor" placeholder="描述这里要改什么...">${escapeHtml(review.comment || '')}</textarea>
        <div class="dt-mark-card-actions">
          <button class="dt-mark-card-btn" type="button" data-action="copy">复制 selector</button>
          <button class="dt-mark-card-btn is-danger" type="button" data-action="delete">删除</button>
          <button class="dt-mark-card-btn" type="button" data-action="close">收起</button>
        </div>
      </div>
    ` : `
      <span class="dt-mark-card-dot" title="${escapeHtml(`${index + 1}. ${title}`)}">${index + 1}</span>
    `;

    if (selected) wireSelectedCard(card, review);
  }

  function wireSelectedCard(card, review) {
    const textarea = card.querySelector('.dt-mark-card-editor');
    const actions = card.querySelector('.dt-mark-card-actions');
    if (textarea) {
      textarea.addEventListener('click', event => event.stopPropagation());
      textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          saveComment(review.id, textarea.value);
          closeFloating();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeFloating();
        }
      });
    }
    if (actions) {
      actions.addEventListener('pointerdown', (event) => {
        const btn = event.target.closest('[data-action]');
        if (!btn || btn.dataset.action === 'copy') return;
        event.preventDefault();
        event.stopPropagation();
        handleAction(btn.dataset.action, review.id, btn, textarea);
      });
      actions.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action]');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        if (btn.dataset.action !== 'copy') return;
        handleAction(btn.dataset.action, review.id, btn, textarea);
      });
    }
  }

  function handleAction(action, id, btn, textarea) {
    const { store } = window.__domReview;
    const review = store.get(id);
    if (!review) return;

    if (action === 'copy') {
      copyText(review.selector, btn);
      return;
    }
    if (action === 'delete') {
      if (textarea) saveComment(id, textarea.value);
      deleteReview(id);
      return;
    }
    if (action === 'close') {
      if (textarea) saveComment(id, textarea.value);
      closeFloating();
    }
  }

  function positionCard(card, review) {
    const target = getTarget(review);
    if (!target) {
      card.style.display = 'none';
      return;
    }

    const hitTest = window.__domReview.hitTest;
    const rect = hitTest ? hitTest.getRect(target) : target.getBoundingClientRect();
    if (!rect || (rect.width <= 0 && rect.height <= 0)) {
      card.style.display = 'none';
      return;
    }

    const selected = selectedId === review.id;
    const width = card.offsetWidth || (selected ? 286 : 12);
    const height = card.offsetHeight || (selected ? 156 : 12);
    const gap = 8;
    let left = selected ? rect.right + gap : rect.right - width / 2;
    let top = selected ? rect.top : rect.top - height / 2;

    if (selected && left + width > window.innerWidth - 8) left = rect.left - width - gap;
    if (selected && left < 8) left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    if (selected && top + height > window.innerHeight - 8) top = rect.bottom - height;
    if (!selected && left + width > window.innerWidth - 8) left = rect.left + width / 2;
    if (!selected && top < 8) top = rect.bottom - height / 2;

    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - height - 8);

    card.style.display = '';
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function saveComment(id, value) {
    const { store } = window.__domReview;
    const review = store.get(id);
    const comment = value.trim();
    if (!review || (review.comment || '') === comment) return;
    store.update(id, { comment });
  }

  function copyText(text, btn) {
    const done = () => {
      const original = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = original; }, 1600);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  }

  function selectReview(id, options = {}) {
    const { store } = window.__domReview;
    const review = store.get(id);
    if (!review) return;
    if (selectedId && selectedId !== id) saveSelectedComment();
    selectedId = id;
    render();
    flashElement(review);

    if (options.focusEditor) {
      const card = cards.get(id);
      const editor = card && card.querySelector('.dt-mark-card-editor');
      if (editor) requestAnimationFrame(() => editor.focus());
    }
  }

  function saveSelectedComment() {
    if (!selectedId) return;
    const card = cards.get(selectedId);
    const editor = card && card.querySelector('.dt-mark-card-editor');
    if (editor) saveComment(selectedId, editor.value);
  }

  function closeFloating(options = {}) {
    if (!selectedId) return;
    if (options.save !== false) saveSelectedComment();
    selectedId = null;
    render();
    if (options.resume !== false) resumeSelector();
  }

  function deleteReview(id) {
    const { store } = window.__domReview;
    const wasSelected = selectedId === id;
    store.remove(id);
    if (wasSelected) {
      selectedId = null;
      resumeSelector();
    }
  }

  function resumeSelector() {
    const selector = window.__domReview.selector;
    if (selector && selector.isPaused && selector.isPaused()) {
      selector.resume();
    }
  }

  function flashElement(review) {
    const target = getTarget(review);
    if (!target) return;
    const index = getReviewIndex(review.id);
    target.style.setProperty('--dt-mark-color', getColor(index));
    target.setAttribute('data-dom-review-flash', '');
    setTimeout(() => target.removeAttribute('data-dom-review-flash'), 650);
  }

  function flashReview(id) {
    const card = cards.get(id);
    if (card) {
      card.classList.add('is-flashing');
      setTimeout(() => card.classList.remove('is-flashing'), 650);
    }
    const { store } = window.__domReview;
    const review = store.get(id);
    if (review) flashElement(review);
  }

  function getReviewIndex(id) {
    const { store } = window.__domReview;
    const idx = store.getAll().findIndex(review => review.id === id);
    return idx >= 0 ? idx + 1 : 1;
  }

  function wireDocumentClose() {
    if (documentCloseWired) return;
    documentCloseWired = true;
    document.addEventListener('pointerdown', (event) => {
      const path = event.composedPath ? event.composedPath() : [];
      if (path.includes(container)) return;
      closeFloating();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeFloating();
    });
  }

  function startListening() {
    if (listening) return;
    listening = true;
    window.addEventListener('scroll', throttledUpdateAll, true);
    window.addEventListener('resize', throttledUpdateAll);
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    window.removeEventListener('scroll', throttledUpdateAll, true);
    window.removeEventListener('resize', throttledUpdateAll);
  }

  function throttledUpdateAll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updatePositions();
    });
  }

  function updatePositions() {
    const { store } = window.__domReview;
    const reviews = store.getAll();
    const reviewMap = new Map(reviews.map(review => [review.id, review]));
    cards.forEach((card, id) => {
      const review = reviewMap.get(id);
      if (review) positionCard(card, review);
      else card.style.display = 'none';
    });
  }

  function render() {
    ensureContainer();
    const { store } = window.__domReview;
    const reviews = store.getAll();
    const activeIds = new Set(reviews.map(review => review.id));

    cards.forEach((card, id) => {
      if (!activeIds.has(id)) {
        card.remove();
        cards.delete(id);
      }
    });

    reviews.forEach((review, index) => {
      let card = cards.get(review.id);
      if (!card) {
        card = createCard(review);
        cards.set(review.id, card);
        container.appendChild(card);
      }
      renderCardContent(card, review, index);
      positionCard(card, review);
    });

    if (selectedId && !activeIds.has(selectedId)) selectedId = null;
    if (reviews.length > 0) startListening();
    else stopListening();
  }

  function cleanup() {
    cards.forEach(card => card.remove());
    cards.clear();
    selectedId = null;
    stopListening();
    if (container && container.parentNode) {
      container.remove();
      container = null;
    }
  }

  function reindex() {
    render();
  }

  window.__domReview.badges = {
    render,
    updateAll: updatePositions,
    cleanup,
    reindex,
    selectReview,
    flashReview,
    closeFloating,
    syncSelectedComment: saveSelectedComment,
    remove: deleteReview,
  };
})();
