/**
 * DevTailor — Comment Panel Module
 *
 * Renders the comment form inside the Shadow DOM comment-panel container.
 * Supports both new-comment and edit modes. Pill groups for category/priority.
 *
 * Depends on: ui (Track 4) — getShadowRoot() for #dr-comment-panel
 * Registers: window.__domReview.commentPanel
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let saveCallbacks = [];
  let cancelCallbacks = [];
  let currentElement = null;
  let editMode = false;
  let editId = null;

  const CATEGORIES = ['style', 'logic', 'a11y', 'text', 'layout', 'remove', 'add'];
  const PRIORITIES = ['high', 'medium', 'low'];

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getPanel() {
    const { ui } = window.__domReview;
    return ui.getShadowRoot().getElementById('dr-comment-panel');
  }

  function renderForm(selectorData, context, existingReview) {
    const panel = getPanel();
    if (!panel) return;

    const isEdit = !!existingReview;
    editMode = isEdit;
    editId = isEdit ? existingReview.id : null;

    const tagDisplay = context ? `<${escapeHtml(context.tagName)}>` : '';
    const selectorDisplay = selectorData ? escapeHtml(selectorData.css) : (existingReview ? escapeHtml(existingReview.selector) : '');
    const commentText = isEdit ? escapeHtml(existingReview.comment) : '';
    const activeCategory = isEdit ? existingReview.category : '';
    const activePriority = isEdit ? existingReview.priority : 'medium';

    const categoryPills = CATEGORIES.map(c =>
      `<span class="dr-pill dr-pill--cat${c === activeCategory ? ' dr-active' : ''}" data-category="${c}">${c}</span>`
    ).join('');

    const priorityPills = PRIORITIES.map(p =>
      `<span class="dr-pill dr-pill--${p}${p === activePriority ? ' dr-active' : ''}" data-priority="${p}">${p}</span>`
    ).join('');

    const contextItems = context ? [
      context.framework && context.framework.framework && `\u2699 ${escapeHtml(context.framework.framework)}`,
      context.framework && context.framework.componentName && `component: ${escapeHtml(context.framework.componentName)}`,
      context.framework && context.framework.filePath && `file: ${escapeHtml(context.framework.filePath)}`,
      context.framework && context.framework.parentComponentName && `parent: ${escapeHtml(context.framework.parentComponentName)}`,
      context.tagName && `tag: ${escapeHtml(context.tagName)}`,
      context.styles && context.styles.fontSize && `font: ${escapeHtml(context.styles.fontSize)}`,
      context.styles && context.styles.color && `color: ${escapeHtml(context.styles.color)}`,
      context.styles && context.styles.display && `display: ${escapeHtml(context.styles.display)}`,
      context.a11y && context.a11y.role && `role: ${escapeHtml(context.a11y.role)}`,
    ].filter(Boolean).map(item => `<span class="dr-context-item">${item}</span>`).join('') : '';

    panel.innerHTML = `
      <div class="dr-panel-header">
        <span class="dr-panel-title">${isEdit ? 'Edit Review' : 'New Review'}</span>
        <button class="dr-btn dr-btn--icon" id="dr-panel-close">\u00D7</button>
      </div>
      ${tagDisplay || selectorDisplay ? `
      <div class="dr-panel-info">
        ${tagDisplay ? `<div class="dr-panel-tag">${tagDisplay}</div>` : ''}
        ${selectorDisplay ? `<div class="dr-panel-selector">${selectorDisplay}</div>` : ''}
      </div>` : ''}
      <div class="dr-panel-form">
        <label class="dr-label">Comment</label>
        <textarea class="dr-textarea" id="dr-comment-text" placeholder="Describe the issue or suggestion...">${commentText}</textarea>

        <label class="dr-label">Category</label>
        <div class="dr-pill-group" id="dr-category-group">
          ${categoryPills}
        </div>

        <label class="dr-label">Priority</label>
        <div class="dr-pill-group" id="dr-priority-group">
          ${priorityPills}
        </div>

        ${contextItems ? `
        <label class="dr-label">Captured Context</label>
        <div class="dr-panel-context">${contextItems}</div>
        ` : ''}
      </div>
      <div class="dr-panel-actions">
        <button class="dr-btn" id="dr-panel-cancel">Cancel</button>
        <button class="dr-btn dr-btn--primary" id="dr-panel-save">${isEdit ? 'Update' : 'Save'}</button>
      </div>
    `;

    // --- Wire events ---

    // Pill group toggles
    panel.querySelector('#dr-category-group').addEventListener('click', (e) => {
      const pill = e.target.closest('.dr-pill');
      if (!pill) return;
      panel.querySelectorAll('#dr-category-group .dr-pill').forEach(p => p.classList.remove('dr-active'));
      pill.classList.add('dr-active');
    });

    panel.querySelector('#dr-priority-group').addEventListener('click', (e) => {
      const pill = e.target.closest('.dr-pill');
      if (!pill) return;
      panel.querySelectorAll('#dr-priority-group .dr-pill').forEach(p => p.classList.remove('dr-active'));
      pill.classList.add('dr-active');
    });

    // Close button
    panel.querySelector('#dr-panel-close').addEventListener('click', () => hide());

    // Cancel
    panel.querySelector('#dr-panel-cancel').addEventListener('click', () => {
      hide();
      cancelCallbacks.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    });

    // Save
    panel.querySelector('#dr-panel-save').addEventListener('click', () => {
      const comment = panel.querySelector('#dr-comment-text').value.trim();
      if (!comment) {
        panel.querySelector('#dr-comment-text').focus();
        return;
      }

      const activeCat = panel.querySelector('#dr-category-group .dr-pill.dr-active');
      const activePri = panel.querySelector('#dr-priority-group .dr-pill.dr-active');

      const formData = {
        comment,
        category: activeCat ? activeCat.dataset.category : 'style',
        priority: activePri ? activePri.dataset.priority : 'medium',
        selector: selectorData ? selectorData.css : (existingReview ? existingReview.selector : ''),
        xpath: selectorData ? selectorData.xpath : (existingReview ? existingReview.xpath : ''),
        context: context || (existingReview ? existingReview.context : null),
        isEdit: editMode,
        editId: editId,
      };

      saveCallbacks.forEach(fn => {
        try { fn(formData); } catch (e) { console.warn('[DevTailor] save callback error:', e); }
      });
      hide();
    });

    // Show panel
    panel.classList.remove('dr-hidden');
    window.__domReview.ui.showPanel();

    // Focus textarea
    setTimeout(() => {
      const ta = panel.querySelector('#dr-comment-text');
      if (ta) ta.focus();
    }, 50);
  }

  // --- Public API ---

  function show(element, selectorData, context) {
    currentElement = element;
    renderForm(selectorData, context, null);
  }

  function showEdit(review) {
    currentElement = null;
    try {
      currentElement = document.querySelector(review.selector);
    } catch { /* ignore */ }
    renderForm(
      { css: review.selector, xpath: review.xpath },
      review.context,
      review
    );
  }

  function hide() {
    const panel = getPanel();
    if (panel) {
      panel.innerHTML = '';
      panel.classList.add('dr-hidden');
    }
    window.__domReview.ui.hidePanel();
    currentElement = null;
    editMode = false;
    editId = null;
  }

  function onSave(callback) {
    saveCallbacks.push(callback);
    return () => { saveCallbacks = saveCallbacks.filter(fn => fn !== callback); };
  }

  function onCancel(callback) {
    cancelCallbacks.push(callback);
    return () => { cancelCallbacks = cancelCallbacks.filter(fn => fn !== callback); };
  }

  window.__domReview.commentPanel = { show, showEdit, hide, onSave, onCancel };
})();
