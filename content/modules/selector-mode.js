/**
 * DevTailor — Selector Mode Module
 *
 * Fine-grained click-to-select mode. Uses a VisBug-style deep hit test:
 * start at elementFromPoint(), cross Shadow DOM boundaries, then inspect
 * geometry-matching descendants so small inner nodes beat coarse containers.
 *
 * Registers: window.__domReview.selector
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let active = false;
  let paused = false;
  let hoveredElement = null;
  let selectCallbacks = [];
  let stateCallbacks = [];
  let rafPending = false;
  let lastPoint = null;
  let candidateCount = 0;
  let overlay = null;
  let label = null;
  let hint = null;
  let suppressClickUntil = 0;
  let passThrough = false;
  let quickMark = false;
  let quickMarkKeyDown = false;

  const MARK_COLORS = [
    '#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#a855f7',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16'
  ];

  function hitTest() {
    return window.__domReview.hitTest;
  }

  function getColor(index) {
    return MARK_COLORS[(index - 1) % MARK_COLORS.length];
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

  function getNextMarkColor() {
    const store = window.__domReview.store;
    const nextIndex = store ? store.getAll().length + 1 : 1;
    return getColor(nextIndex);
  }

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'dom-review-selector-overlay';
    overlay.style.cssText = [
      'position: fixed',
      'z-index: 2147483646',
      'pointer-events: none',
      'border: 2px solid #3b82f6',
      'background: rgba(59, 130, 246, 0.08)',
      'box-shadow: 0 0 0 1px rgba(255,255,255,0.75), 0 8px 24px rgba(15,23,42,0.18)',
      'border-radius: 3px',
      'display: none',
      'box-sizing: border-box'
    ].join(';');

    label = document.createElement('div');
    label.style.cssText = [
      'position: absolute',
      'left: -2px',
      'top: -24px',
      'max-width: 260px',
      'padding: 3px 7px',
      'border-radius: 5px',
      'background: #2563eb',
      'color: #fff',
      'font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'box-shadow: 0 6px 16px rgba(15,23,42,0.22)'
    ].join(';');
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);
  }

  function createHint() {
    if (hint) return;
    hint = document.createElement('div');
    hint.id = 'dom-review-selector-hint';
    hint.style.cssText = [
      'position: fixed',
      'left: 50%',
      'bottom: 22px',
      'z-index: 2147483646',
      'transform: translateX(-50%) translateY(8px)',
      'pointer-events: none',
      'padding: 8px 11px',
      'border-radius: 9px',
      'background: rgba(15, 23, 42, 0.92)',
      'color: #e2e8f0',
      'font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'box-shadow: 0 14px 36px rgba(15, 23, 42, 0.28)',
      'border: 1px solid rgba(148, 163, 184, 0.22)',
      'opacity: 0',
      'transition: opacity 140ms ease-out, transform 140ms ease-out'
    ].join(';');
    document.documentElement.appendChild(hint);
  }

  function showHint(message) {
    createHint();
    hint.textContent = message;
    hint.style.opacity = '1';
    hint.style.transform = 'translateX(-50%) translateY(0)';
  }

  function hideHint() {
    if (!hint) return;
    hint.style.opacity = '0';
    hint.style.transform = 'translateX(-50%) translateY(8px)';
  }

  function clearHighlight() {
    hoveredElement = null;
    candidateCount = 0;
    if (overlay) overlay.style.display = 'none';
  }

  function describeElement(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = Array.from(el.classList || [])
      .filter(Boolean)
      .slice(0, 2)
      .map(name => `.${name}`)
      .join('');
    return candidateCount > 1 ? `${tag}${id}${cls} · ${candidateCount} hits` : `${tag}${id}${cls}`;
  }

  function updateOverlay() {
    if (!hoveredElement) {
      clearHighlight();
      return;
    }

    createOverlay();
    const rect = hoveredElement.getBoundingClientRect();
    const color = getNextMarkColor();
    overlay.style.display = 'block';
    overlay.style.borderColor = color;
    overlay.style.background = rgba(color, 0.08);
    label.style.background = color;
    overlay.style.left = `${Math.max(0, rect.left)}px`;
    overlay.style.top = `${Math.max(0, rect.top)}px`;
    overlay.style.width = `${Math.max(1, rect.width)}px`;
    overlay.style.height = `${Math.max(1, rect.height)}px`;
    label.textContent = quickMark
      ? `${describeElement(hoveredElement)} · 快速标记`
      : describeElement(hoveredElement);

    if (rect.top < 28) {
      label.style.top = 'auto';
      label.style.bottom = '-24px';
    } else {
      label.style.top = '-24px';
      label.style.bottom = 'auto';
    }
  }

  function setCandidate(el, count = 0) {
    if (!el) {
      clearHighlight();
      return;
    }
    candidateCount = count;
    hoveredElement = el;
    updateOverlay();
  }

  function updateCandidatesFromPoint(x, y, keepIndex = false) {
    const previous = hoveredElement;
    const result = hitTest().pick(x, y);
    const candidates = result.candidates;

    if (!candidates.length) {
      clearHighlight();
      return;
    }

    if (keepIndex && previous && candidates.includes(previous)) {
      setCandidate(previous, candidates.length);
      return;
    }

    setCandidate(result.element, candidates.length);
  }

  function handlePointerMove(e) {
    if (!active || paused) return;
    quickMark = isQuickMarkEvent(e);
    if (quickMark) {
      if (passThrough) {
        passThrough = false;
        hideHint();
        document.documentElement.style.cursor = 'crosshair';
        emitStateChange();
      }
    } else if (e.altKey) {
      enterPassThrough();
      return;
    }
    if (passThrough) return;
    lastPoint = { x: e.clientX, y: e.clientY };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!active || passThrough || !lastPoint) return;
      updateCandidatesFromPoint(lastPoint.x, lastPoint.y);
    });
  }

  function handleScrollOrResize() {
    if (!active || paused || passThrough || !lastPoint) return;
    updateCandidatesFromPoint(lastPoint.x, lastPoint.y, true);
  }

  function getMode() {
    if (!active) return 'idle';
    return paused ? 'describing' : 'selecting';
  }

  function isQuickMarkEvent(event) {
    return quickMarkKeyDown || Boolean(event && event.shiftKey);
  }

  function emitStateChange() {
    const state = { active, paused, passThrough, mode: getMode() };
    stateCallbacks.forEach(fn => {
      try { fn(state); } catch (err) { console.warn('[DevTailor] selector state callback error:', err); }
    });
  }

  function enterPassThrough() {
    if (!active || paused || passThrough) return;
    quickMark = false;
    quickMarkKeyDown = false;
    passThrough = true;
    document.documentElement.style.cursor = '';
    clearHighlight();
    showHint('穿透模式：可以直接操作页面元素，松开 Alt 继续标记');
    emitStateChange();
  }

  function exitPassThrough() {
    if (!passThrough) return;
    passThrough = false;
    suppressClickUntil = performance.now() + 250;
    hideHint();
    if (active && !paused) {
      document.documentElement.style.cursor = 'crosshair';
      if (lastPoint) updateCandidatesFromPoint(lastPoint.x, lastPoint.y);
    }
    emitStateChange();
  }

  function handleKeyDown(e) {
    if (!active || paused) return;
    if (e.key === 'Shift') {
      quickMark = true;
      quickMarkKeyDown = true;
      if (passThrough) {
        passThrough = false;
        hideHint();
        suppressClickUntil = 0;
        document.documentElement.style.cursor = 'crosshair';
        emitStateChange();
      }
      return;
    }
    if (isQuickMarkEvent(e)) {
      quickMark = true;
      if (passThrough) {
        passThrough = false;
        hideHint();
        suppressClickUntil = 0;
        document.documentElement.style.cursor = 'crosshair';
        emitStateChange();
      }
      return;
    }
    if (e.key === 'Alt' || e.altKey) enterPassThrough();
  }

  function handleKeyUp(e) {
    if (e.key === 'Shift') {
      quickMark = false;
      quickMarkKeyDown = false;
      return;
    }
    if (e.key === 'Alt') {
      quickMark = false;
      exitPassThrough();
    }
  }

  function handleClick(e) {
    if (!active || paused) return;
    const quick = isQuickMarkEvent(e);
    if (passThrough && !quick) return;
    if (e.altKey && !quick) return;
    if (hitTest().isOwnElement(e.target)) return;
    if (performance.now() < suppressClickUntil) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let target = hoveredElement || e.target;
    if (quick) {
      const result = hitTest().pick(e.clientX, e.clientY);
      target = result.element || target;
      passThrough = false;
      quickMark = false;
      quickMarkKeyDown = false;
      hideHint();
    }
    if (!hitTest().isSelectable(target, { allowPointerEventsNone: target === hoveredElement })) return;

    clearHighlight();
    selectCallbacks.forEach(fn => {
      try { fn(target, { quick }); } catch (err) { console.warn('[DevTailor] selector callback error:', err); }
    });
  }

  function enable() {
    if (active) return;
    active = true;
    paused = false;
    passThrough = false;
    quickMark = false;
    quickMarkKeyDown = false;
    createOverlay();
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('click', handleClick, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', exitPassThrough, true);
    window.addEventListener('scroll', handleScrollOrResize, true);
    window.addEventListener('resize', handleScrollOrResize, true);
    emitStateChange();
  }

  function disable() {
    if (!active) return;
    active = false;
    paused = false;
    passThrough = false;
    quickMark = false;
    quickMarkKeyDown = false;
    document.documentElement.style.cursor = '';
    clearHighlight();
    hideHint();
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('click', handleClick, true);
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('keyup', handleKeyUp, true);
    window.removeEventListener('blur', exitPassThrough, true);
    window.removeEventListener('scroll', handleScrollOrResize, true);
    window.removeEventListener('resize', handleScrollOrResize, true);
    emitStateChange();
  }

  function isActive() {
    return active;
  }

  function isPaused() {
    return paused;
  }

  function isPassThrough() {
    return passThrough;
  }

  function pause() {
    if (!active || paused) return;
    passThrough = false;
    quickMark = false;
    quickMarkKeyDown = false;
    paused = true;
    document.documentElement.style.cursor = '';
    clearHighlight();
    hideHint();
    emitStateChange();
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    passThrough = false;
    quickMark = false;
    quickMarkKeyDown = false;
    suppressClickUntil = performance.now() + 250;
    document.documentElement.style.cursor = 'crosshair';
    if (lastPoint) updateCandidatesFromPoint(lastPoint.x, lastPoint.y);
    emitStateChange();
  }

  function toggle() {
    if (active) disable(); else enable();
  }

  function onSelect(callback) {
    selectCallbacks.push(callback);
    return () => { selectCallbacks = selectCallbacks.filter(fn => fn !== callback); };
  }

  function onStateChange(callback) {
    stateCallbacks.push(callback);
    try { callback({ active, paused, passThrough, mode: getMode() }); } catch {}
    return () => { stateCallbacks = stateCallbacks.filter(fn => fn !== callback); };
  }

  window.__domReview.selector = { enable, disable, pause, resume, isActive, isPaused, isPassThrough, toggle, onSelect, onStateChange };
})();
