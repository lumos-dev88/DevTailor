/**
 * DevTailor — Page highlights for marks
 *
 * Draws the persistent dashed outline around every marked element. Mark viewing/editing/deletion
 * lives in badges.js (in-place note card) and the side panel's mark tray; the name `sidebar` is
 * historical.
 *
 * Depends on: store (review-store.js), hitTest
 * Registers: window.__domReview.sidebar
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const MARK_COLORS = [
    '#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#a855f7',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16'
  ];

  let highlightContainer = null;
  let highlightMap = new Map();
  let rafPending = false;

  function getColor(index) {
    return MARK_COLORS[(index - 1) % MARK_COLORS.length];
  }

  function getMarks() {
    return window.__domReview.store.getAll();
  }

  function ensureHighlightContainer() {
    if (highlightContainer && highlightContainer.parentNode) return;
    highlightContainer = document.createElement('div');
    highlightContainer.id = 'dom-review-highlights';
    highlightContainer.style.cssText = `
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483645;
      overflow: visible;
    `;
    document.body.appendChild(highlightContainer);
  }

  function createHighlightOverlay(rect, color, index) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      left: ${Math.max(0, rect.left)}px;
      top: ${Math.max(0, rect.top)}px;
      width: ${Math.max(1, rect.width)}px;
      height: ${Math.max(1, rect.height)}px;
      border: 2px dashed ${color};
      background: ${hexToRgba(color, 0.06)};
      border-radius: 3px;
      box-sizing: border-box;
      pointer-events: none;
      z-index: 2147483645;
    `;

    return overlay;
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace('#', '');
    const int = parseInt(value, 16);
    const r = (int >> 16) & 255;
    const g = (int >> 8) & 255;
    const b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function updateHighlightPositions() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const hitTest = window.__domReview.hitTest;
      highlightMap.forEach((overlay, markId) => {
        const mark = getMarks().find(m => m.id === markId);
        if (!mark) return;
        const el = hitTest ? hitTest.resolveSelector(mark.selector) : null;
        if (!el) {
          overlay.style.display = 'none';
          return;
        }
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          overlay.style.display = 'none';
          return;
        }
        overlay.style.display = '';
        overlay.style.left = `${Math.max(0, rect.left)}px`;
        overlay.style.top = `${Math.max(0, rect.top)}px`;
        overlay.style.width = `${Math.max(1, rect.width)}px`;
        overlay.style.height = `${Math.max(1, rect.height)}px`;
      });
    });
  }

  function render() {
    // Kept for historical call sites; highlights are refreshed from content-script on store changes.
    updatePersistentHighlights();
  }

  function updatePersistentHighlights() {
    ensureHighlightContainer();
    const hitTest = window.__domReview.hitTest;
    const marks = getMarks();
    const activeIds = new Set(marks.map(m => m.id));

    // Remove overlays for deleted marks
    highlightMap.forEach((overlay, markId) => {
      if (!activeIds.has(markId)) {
        overlay.remove();
        highlightMap.delete(markId);
      }
    });

    // Create or update overlays
    marks.forEach((mark, idx) => {
      const el = hitTest ? hitTest.resolveSelector(mark.selector) : null;
      const color = getColor(idx + 1);
      let overlay = highlightMap.get(mark.id);

      if (!overlay) {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        overlay = createHighlightOverlay(rect, color, idx + 1);
        highlightContainer.appendChild(overlay);
        highlightMap.set(mark.id, overlay);
      } else {
        // Update color
        overlay.style.borderColor = color;
        overlay.style.background = hexToRgba(color, 0.06);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect && rect.width > 0 && rect.height > 0) {
            overlay.style.display = '';
            overlay.style.left = `${Math.max(0, rect.left)}px`;
            overlay.style.top = `${Math.max(0, rect.top)}px`;
            overlay.style.width = `${Math.max(1, rect.width)}px`;
            overlay.style.height = `${Math.max(1, rect.height)}px`;
          } else {
            overlay.style.display = 'none';
          }
        } else {
          overlay.style.display = 'none';
        }
      }
    });
  }

  // Wire scroll/resize to update highlight positions
  function startListening() {
    window.addEventListener('scroll', updateHighlightPositions, true);
    window.addEventListener('resize', updateHighlightPositions);
  }

  startListening();

  window.__domReview.sidebar = {
    render,
    updatePersistentHighlights,
    getMarkCount() {
      return getMarks().length;
    }
  };
})();
