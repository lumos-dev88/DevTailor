/**
 * DevTailor — Element Saver Module
 *
 * Independent one-shot element saving workflow.
 * Click button → hover/select element → save to element library.
 *
 * Registers: window.__domReview.elementSaver
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let isActive = false;
  let hoveredElement = null;
  let highlightBox = null;
  let saveCard = null;
  let pendingReview = null;
  let dragState = {
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  };

  function init() {
    createHighlightBox();
  }

  function createHighlightBox() {
    if (highlightBox) return;
    highlightBox = document.createElement('div');
    highlightBox.id = 'element-saver-highlight';
    highlightBox.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px solid #10b981;
      background: rgba(16, 185, 129, 0.1);
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.3);
      display: none;
    `;
    document.body.appendChild(highlightBox);
  }

  function ensureCardStyles() {
    if (document.getElementById('element-saver-card-styles')) return;
    const style = document.createElement('style');
    style.id = 'element-saver-card-styles';
    style.textContent = `
      .dt-element-save-card {
        position: fixed;
        right: 24px;
        top: 84px;
        z-index: 2147483647;
        width: min(420px, calc(100vw - 32px));
        max-height: min(720px, calc(100vh - 112px));
        display: flex;
        flex-direction: column;
        color: #e2e8f0;
        background: #111827;
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 12px;
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.46);
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .dt-element-save-card * { box-sizing: border-box; }
      .dt-element-save-card__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 14px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        cursor: grab;
        flex-shrink: 0;
      }
      .dt-element-save-card__head.is-dragging {
        cursor: grabbing;
      }
      .dt-element-save-card__title {
        margin: 0;
        font-size: 14px;
        font-weight: 750;
        color: #f8fafc;
        user-select: none;
      }
      .dt-element-save-card__body {
        padding: 14px;
        display: grid;
        gap: 11px;
        overflow-y: auto;
        overflow-x: hidden;
        flex: 1;
        min-height: 0;
      }
      .dt-element-save-card label {
        display: grid;
        gap: 5px;
        color: #94a3b8;
        font-size: 12px;
      }
      .dt-element-save-card input,
      .dt-element-save-card textarea {
        width: 100%;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 8px;
        color: #f8fafc;
        background: #0f172a;
        outline: none;
        padding: 8px 9px;
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .dt-element-save-card textarea {
        min-height: 70px;
        resize: vertical;
      }
      .dt-element-save-card input:focus,
      .dt-element-save-card textarea:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
      }
      .dt-element-save-card__meta {
        display: grid;
        gap: 5px;
        padding: 9px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.74);
        border: 1px solid rgba(148, 163, 184, 0.16);
        color: #94a3b8;
        font-family: "SF Mono", ui-monospace, monospace;
        font-size: 11px;
        word-break: break-all;
      }
      .dt-element-save-card__list {
        display: grid;
        gap: 9px;
        min-width: 0;
      }
      .dt-element-save-card__empty {
        padding: 18px 14px;
        border: 1px dashed rgba(148, 163, 184, 0.24);
        border-radius: 10px;
        color: #94a3b8;
        text-align: center;
      }
      .dt-element-target-card {
        display: grid;
        gap: 7px;
        padding: 10px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.66);
        border: 1px solid rgba(148, 163, 184, 0.18);
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
      }
      .dt-element-target-card__top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: flex-start;
        gap: 10px;
        min-width: 0;
      }
      .dt-element-target-card__name {
        color: #f8fafc;
        font-weight: 720;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dt-element-target-card__desc {
        color: #94a3b8;
        font-size: 12px;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .dt-element-target-card__meta {
        color: #64748b;
        font: 11px/1.4 "SF Mono", ui-monospace, monospace;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dt-element-target-card button[data-action="delete-target"] {
        flex-shrink: 0;
        height: 28px;
        padding: 0 9px;
        color: #fecaca;
        background: rgba(239, 68, 68, 0.16);
        font-size: 12px;
        line-height: 28px;
      }
      .dt-element-target-card button[data-action="delete-target"]:hover {
        color: #fff;
        background: rgba(239, 68, 68, 0.34);
      }
      .dt-element-save-card details {
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.5);
      }
      .dt-element-save-card summary {
        cursor: pointer;
        padding: 8px 9px;
        color: #cbd5e1;
      }
      .dt-element-save-card pre {
        margin: 0;
        max-height: 220px;
        overflow: auto;
        padding: 0 9px 9px;
        color: #94a3b8;
        white-space: pre-wrap;
        word-break: break-word;
        font: 11px/1.45 "SF Mono", ui-monospace, monospace;
      }
      .dt-element-save-card__actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 14px 14px;
        border-top: 1px solid rgba(148, 163, 184, 0.16);
        flex-shrink: 0;
      }
      .dt-element-save-card button {
        height: 34px;
        padding: 0 13px;
        border: 0;
        border-radius: 8px;
        color: #cbd5e1;
        background: rgba(148, 163, 184, 0.14);
        cursor: pointer;
        font: 13px/34px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .dt-element-save-card button:hover { color: #f8fafc; background: rgba(148, 163, 184, 0.22); }
      .dt-element-save-card button[data-action="save"] { color: #dbeafe; background: #2563eb; }
      .dt-element-save-card button[data-action="save"]:hover { background: #3b82f6; }
      .dt-element-save-card button:disabled { opacity: 0.58; cursor: not-allowed; }
    `;
    document.documentElement.appendChild(style);
  }

  function enable() {
    if (isActive) return;
    isActive = true;
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.body.style.cursor = 'crosshair';

    // Update UI button state
    window.__domReview.ui?.setSaveElementActive?.(true);
  }

  function disable() {
    if (!isActive) return;
    isActive = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.body.style.cursor = '';
    hideHighlight();
    hoveredElement = null;

    // Update UI button state
    window.__domReview.ui?.setSaveElementActive?.(false);
  }

  function closeSaveCard() {
    if (saveCard) {
      saveCard.remove();
      saveCard = null;
    }
    pendingReview = null;
  }

  function handleMouseMove(event) {
    event.stopPropagation();
    const picked = window.__domReview.hitTest?.pick?.(event.clientX, event.clientY);
    const element = picked?.element || document.elementFromPoint(event.clientX, event.clientY);

    // Skip DevTailor UI elements
    if (isDevTailorElement(element)) {
      hideHighlight();
      hoveredElement = null;
      return;
    }

    if (element && element !== hoveredElement) {
      hoveredElement = element;
      showHighlight(element);
    }
  }

  function handleClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!hoveredElement || isDevTailorElement(hoveredElement)) {
      return;
    }

    const element = hoveredElement;
    disable();
    saveElement(element);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      disable();
    }
  }

  function isDevTailorElement(element) {
    if (!element) return false;
    return Boolean(
      element.closest('#dom-review-host') ||
      element.closest('#dom-review-highlights') ||
      element.closest('#dom-review-badges') ||
      element.closest('#devtailor-host') ||
      element.closest('#devtailor-highlights') ||
      element.closest('#devtailor-badges') ||
      element.closest('.dt-element-save-card') ||
      element.id === 'element-saver-highlight'
    );
  }

  function showHighlight(element) {
    if (!highlightBox) return;
    const rect = element.getBoundingClientRect();
    highlightBox.style.display = 'block';
    highlightBox.style.left = rect.left + 'px';
    highlightBox.style.top = rect.top + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';
  }

  function hideHighlight() {
    if (highlightBox) {
      highlightBox.style.display = 'none';
    }
  }

  async function saveElement(element) {
    try {
      // Generate selector
      const selectorData = window.__domReview.selectorGen?.generate(element);
      if (!selectorData) {
        window.__domReview.chatPanel?.showHint?.('无法生成选择器');
        return;
      }

      // Capture context
      const context = window.__domReview.contextCapture?.capture(element);

      const defaultName = defaultNameForReview({ selector: selectorData.css, context }, element);

      const elementTargets = window.__domReview.elementTargets;
      if (!elementTargets?.saveFromReview || !elementTargets?.buildTargetPayload) {
        window.__domReview.chatPanel?.showHint?.('元素库不可用，请确认 Bridge 已启动');
        return;
      }

      pendingReview = {
        selector: selectorData.css,
        xpath: selectorData.xpath,
        comment: '',
        context,
      };
      showSaveCard(pendingReview, defaultName);

    } catch (err) {
      console.error('[ElementSaver] Save failed:', err);
      window.__domReview.chatPanel?.showHint?.(`保存失败: ${err.message || '未知错误'}`);
    }
  }

  function defaultNameForReview(review, element) {
    const context = review?.context || {};
    return (
      context?.a11y?.label ||
      context?.text?.slice(0, 30) ||
      element?.getAttribute?.('aria-label') ||
      element?.getAttribute?.('title') ||
      element?.textContent?.trim().slice(0, 30) ||
      review?.selector?.slice(0, 30) ||
      '页面元素'
    );
  }

  function openCardFromReview(review, options = {}) {
    if (!review) return;
    const elementTargets = window.__domReview.elementTargets;
    if (!elementTargets?.saveFromReview || !elementTargets?.buildTargetPayload) {
      window.__domReview.chatPanel?.showHint?.('元素库不可用，请确认 Bridge 已启动');
      return;
    }
    pendingReview = review;
    const defaultName = String(options.name || review.comment || defaultNameForReview(review)).trim();
    showSaveCard(review, defaultName);
  }

  function bestLocatorSummary(target) {
    const recipes = Array.isArray(target?.locatorRecipes) ? target.locatorRecipes : [];
    const recommended = recipes.find(item => item.recommended) || recipes[0];
    if (recommended?.type === 'testId') return `${recommended.attr || 'testId'}=${recommended.value}`;
    if (recommended?.type === 'role+label') return `${recommended.role} / ${recommended.label}`;
    if (recommended?.type === 'role+text') return `${recommended.role} / ${recommended.text}`;
    if (recommended?.type === 'label') return `label=${recommended.value}`;
    if (recommended?.type === 'css') return recommended.value;
    if (target?.selector) return target.selector;
    if (target?.xpath) return target.xpath;
    return 'locatorRecipes';
  }

  function showLibraryCard() {
    const elementTargets = window.__domReview.elementTargets;
    if (!elementTargets?.listCurrentPage) {
      window.__domReview.chatPanel?.showHint?.('元素库不可用，请确认 Bridge 已启动');
      return;
    }
    closeSaveCard();
    ensureCardStyles();

    saveCard = document.createElement('div');
    saveCard.className = 'dt-element-save-card';
    saveCard.innerHTML = `
      <div class="dt-element-save-card__head" data-drag-handle>
        <h3 class="dt-element-save-card__title">元素库</h3>
        <button type="button" data-action="cancel" title="关闭">×</button>
      </div>
      <div class="dt-element-save-card__body">
        <div class="dt-element-save-card__meta">
          当前页面：${escapeHtml(location.origin + location.pathname)}
        </div>
        <div class="dt-element-save-card__list" data-role="target-list">
          <div class="dt-element-save-card__empty">正在加载元素库…</div>
        </div>
      </div>
      <div class="dt-element-save-card__actions">
        <button type="button" data-action="refresh-list">刷新</button>
        <button type="button" data-action="start-select">选择元素</button>
        <button type="button" data-action="cancel">关闭</button>
      </div>
    `;

    saveCard.addEventListener('pointerdown', event => event.stopPropagation());
    saveCard.addEventListener('click', handleSaveCardClick);
    saveCard.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') closeSaveCard();
    });

    initCardDrag();
    document.body.appendChild(saveCard);
    loadElementLibrary();
  }

  async function loadElementLibrary() {
    if (!saveCard) return;
    const list = saveCard.querySelector('[data-role="target-list"]');
    if (!list) return;
    list.innerHTML = '<div class="dt-element-save-card__empty">正在加载元素库…</div>';
    try {
      const targets = await window.__domReview.elementTargets.listCurrentPage();
      renderElementLibrary(targets);
    } catch (err) {
      list.innerHTML = `<div class="dt-element-save-card__empty">加载失败：${escapeHtml(err.message || err)}</div>`;
    }
  }

  function renderElementLibrary(targets) {
    if (!saveCard) return;
    const list = saveCard.querySelector('[data-role="target-list"]');
    if (!list) return;
    if (!Array.isArray(targets) || targets.length === 0) {
      list.innerHTML = '<div class="dt-element-save-card__empty">当前页面还没有保存元素。点击“选择元素”添加一个。</div>';
      return;
    }
    list.innerHTML = targets.map(target => `
      <div class="dt-element-target-card" data-target-id="${escapeHtml(target.id || target.targetId || '')}">
        <div class="dt-element-target-card__top">
          <div class="dt-element-target-card__name" title="${escapeHtml(target.name || '')}">${escapeHtml(target.name || '未命名元素')}</div>
          <button type="button" data-action="delete-target" data-target-id="${escapeHtml(target.id || target.targetId || '')}">删除</button>
        </div>
        ${target.description ? `<div class="dt-element-target-card__desc">${escapeHtml(target.description)}</div>` : ''}
        <div class="dt-element-target-card__meta">${escapeHtml(bestLocatorSummary(target))}</div>
        <div class="dt-element-target-card__meta">targetId: ${escapeHtml(target.id || target.targetId || '')}</div>
      </div>
    `).join('');
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function compactJson(value) {
    return JSON.stringify(value || {}, null, 2);
  }

  function showSaveCard(review, defaultName) {
    const elementTargets = window.__domReview.elementTargets;
    const payload = elementTargets.buildTargetPayload(review, { name: defaultName });
    closeSaveCard();
    pendingReview = review; // Restore after closeSaveCard clears it
    ensureCardStyles();

    saveCard = document.createElement('div');
    saveCard.className = 'dt-element-save-card';
    saveCard.innerHTML = `
      <div class="dt-element-save-card__head" data-drag-handle>
        <h3 class="dt-element-save-card__title">保存到元素库</h3>
        <button type="button" data-action="cancel" title="关闭">×</button>
      </div>
      <div class="dt-element-save-card__body">
        <label>
          元素名称
          <input data-field="name" value="${escapeHtml(defaultName || '')}" placeholder="例如：登录按钮、优先级选择器" />
        </label>
        <label>
          描述
          <textarea data-field="description" placeholder="这个元素用于什么场景，AI 后续如何使用">${escapeHtml(payload.description || '')}</textarea>
        </label>
        <label>
          页面匹配
          <input data-field="pagePattern" value="${escapeHtml(payload.pagePattern || '')}" />
        </label>
        <div class="dt-element-save-card__meta">
          <div><strong>selector</strong>: ${escapeHtml(payload.selector || '')}</div>
          <div><strong>xpath</strong>: ${escapeHtml(payload.xpath || '')}</div>
        </div>
        <details>
          <summary>定位参数预览</summary>
          <pre>${escapeHtml(compactJson({
            semantic: payload.semantic,
            context: payload.context,
            structure: payload.structure,
            visual: payload.visual,
            locatorRecipes: payload.locatorRecipes,
          }))}</pre>
        </details>
      </div>
      <div class="dt-element-save-card__actions">
        <button type="button" data-action="cancel">取消</button>
        <button type="button" data-action="save">保存</button>
      </div>
    `;

    saveCard.addEventListener('pointerdown', event => event.stopPropagation());
    saveCard.addEventListener('click', handleSaveCardClick);
    saveCard.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') closeSaveCard();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submitSaveCard();
      }
    });

    // Initialize drag
    initCardDrag();

    document.body.appendChild(saveCard);
    const nameInput = saveCard.querySelector('[data-field="name"]');
    if (nameInput) requestAnimationFrame(() => nameInput.focus());
  }

  function handleSaveCardClick(event) {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.dataset.action === 'cancel') {
      closeSaveCard();
      return;
    }
    if (btn.dataset.action === 'refresh-list') {
      loadElementLibrary();
      return;
    }
    if (btn.dataset.action === 'start-select') {
      closeSaveCard();
      enable();
      return;
    }
    if (btn.dataset.action === 'delete-target') {
      deleteElementTarget(btn.dataset.targetId, btn);
      return;
    }
    if (btn.dataset.action === 'save') submitSaveCard();
  }

  async function deleteElementTarget(targetId, btn) {
    const id = String(targetId || '').trim();
    if (!id) return;
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '删除中…';
      }
      await window.__domReview.elementTargets.deleteTarget(id);
      window.__domReview.chatPanel?.showHint?.('已删除元素');
      await loadElementLibrary();
    } catch (err) {
      console.error('[ElementSaver] Delete failed:', err);
      window.__domReview.chatPanel?.showHint?.(`删除失败: ${err.message || '未知错误'}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '删除';
      }
    }
  }

  async function submitSaveCard() {
    if (!saveCard || !pendingReview) return;
    const saveBtn = saveCard.querySelector('[data-action="save"]');
    const name = saveCard.querySelector('[data-field="name"]')?.value?.trim();
    const description = saveCard.querySelector('[data-field="description"]')?.value?.trim() || '';
    const pagePattern = saveCard.querySelector('[data-field="pagePattern"]')?.value?.trim() || undefined;
    if (!name) {
      window.__domReview.chatPanel?.showHint?.('请填写元素名称');
      saveCard.querySelector('[data-field="name"]')?.focus();
      return;
    }
    try {
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
      }
      await window.__domReview.elementTargets.saveFromReview(pendingReview, {
        name,
        description,
        pagePattern,
      });
      closeSaveCard();
      window.__domReview.chatPanel?.showHint?.(`已保存元素：${name}`);
    } catch (err) {
      console.error('[ElementSaver] Save failed:', err);
      window.__domReview.chatPanel?.showHint?.(`保存失败: ${err.message || '未知错误'}`);
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    }
  }

  function initCardDrag() {
    if (!saveCard) return;
    const head = saveCard.querySelector('[data-drag-handle]');
    if (!head) return;

    head.addEventListener('pointerdown', (e) => {
      // Ignore if clicking on button
      if (e.target.closest('button')) return;
      if (e.button !== 0) return;

      dragState.dragging = true;
      dragState.moved = false;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;

      const rect = saveCard.getBoundingClientRect();
      dragState.originX = rect.left;
      dragState.originY = rect.top;

      head.classList.add('is-dragging');
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    head.addEventListener('pointermove', (e) => {
      if (!dragState.dragging) return;

      const dx = Math.abs(e.clientX - dragState.startX);
      const dy = Math.abs(e.clientY - dragState.startY);
      if (dx > 3 || dy > 3) dragState.moved = true;

      const newX = dragState.originX + (e.clientX - dragState.startX);
      const newY = dragState.originY + (e.clientY - dragState.startY);

      saveCard.style.left = `${newX}px`;
      saveCard.style.top = `${newY}px`;
      saveCard.style.right = 'auto';
    });

    const finishDrag = (e) => {
      if (!dragState.dragging) return;
      dragState.dragging = false;
      head.classList.remove('is-dragging');
      head.releasePointerCapture?.(e.pointerId);

      if (dragState.moved) {
        // Clamp to viewport
        const rect = saveCard.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width;
        const maxY = window.innerHeight - rect.height;
        const clampedX = Math.max(0, Math.min(rect.left, maxX));
        const clampedY = Math.max(0, Math.min(rect.top, maxY));

        saveCard.style.left = `${clampedX}px`;
        saveCard.style.top = `${clampedY}px`;
      }
    };

    head.addEventListener('pointerup', finishDrag);
    head.addEventListener('pointercancel', finishDrag);
  }

  // Public API
  window.__domReview.elementSaver = {
    init,
    enable,
    disable,
    closeSaveCard,
    openCardFromReview,
    showLibraryCard,
    isActive: () => isActive,
  };
})();
