/**
 * DevTailor — Reference elements (capture)
 *
 * Page-side half of "参考元素": pick an element, collect its whitelisted computed styles, a
 * sanitised outerHTML and (best effort) a cropped screenshot of the visible part, then hand the
 * record to references-core so the service worker stores it. Pure logic lives in references-core;
 * this file only touches the DOM.
 *
 * Rules that matter here:
 *   - mutually exclusive with the mark picker (V): entering one exits the other, and the reference
 *     overlay uses its own colour so the two modes are visually distinct;
 *   - the note popup's Enter/Esc respect IME composition; saving keeps picking the next element,
 *     Esc while picking leaves the list untouched;
 *   - screenshots hide DevTailor's own UI/overlays, cover the element's text inputs for the shot and
 *     restore everything on every path;
 *   - a reference is captured from the tab that asked for it, never from a taken-over page; a tab
 *     that is not in the foreground keeps its other fields and simply gets no screenshot.
 *
 * Depends on: referencesCore, selectorGen, hitTest, ui, toolbar (toast), selector (optional)
 * Registers: window.__domReview.references
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const REFERENCE_COLOR = '#7c3aed'; // violet: different from the mark palette
  const MAX_SCREENSHOT_EDGE = 800;

  let active = false;
  let pendingElement = null;
  let rafPending = false;
  let scrollRafPending = false;
  let lastPoint = null;
  let overlay = null;
  let label = null;
  let hint = null;
  let popup = null;
  let popupInput = null;
  let keyHandler = null;
  let changeListeners = [];
  let hideTargets = []; // elements covered while the screenshot is taken, restored afterwards
  let captureInFlight = null; // keeps one screenshot from covering a second element's restore

  const core = () => window.__domReview.referencesCore;
  const hitTest = () => window.__domReview.hitTest;

  // ------------------------------------------------------------ listeners

  /** A capture finished (nothing changed / saved / rejected): let the toolbar refresh its badge. */
  function emitChange() {
    changeListeners.forEach((fn) => {
      try { fn(); } catch (err) { console.warn('[DevTailor] reference listener error:', err); }
    });
  }

  function onChange(fn) {
    changeListeners.push(fn);
    return () => { changeListeners = changeListeners.filter((item) => item !== fn); };
  }

  // ----------------------------------------------------------------- ui

  function ensureOverlay() {
    if (overlay && overlay.parentNode) return;
    injectPopupStyles();
    overlay = document.createElement('div');
    overlay.id = 'dom-review-reference-overlay';
    overlay.style.cssText = [
      'position: fixed', 'inset: 0', 'z-index: 2147483646',
      'pointer-events: none', 'display: none',
      'font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    ].join(';');
    label = document.createElement('div');
    label.style.cssText = [
      'position: absolute', 'left: 0', 'top: -24px', 'max-width: 280px', 'padding: 3px 7px',
      'border-radius: 5px', 'background: #7c3aed', 'color: #fff',
      'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis',
      'box-shadow: 0 6px 16px rgba(15,23,42,0.22)', 'pointer-events: none',
    ].join(';');
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);

    hint = document.createElement('div');
    hint.id = 'dom-review-reference-hint';
    hint.style.cssText = [
      'position: fixed', 'left: 50%', 'bottom: 22px', 'z-index: 2147483646',
      'transform: translateX(-50%) translateY(8px)', 'pointer-events: none',
      'padding: 8px 11px', 'border-radius: 9px', 'background: rgba(15, 23, 42, 0.92)',
      'color: #e2e8f0', 'font: 12px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'box-shadow: 0 14px 36px rgba(15, 23, 42, 0.28)', 'border: 1px solid rgba(148, 163, 184, 0.22)',
      'opacity: 0', 'transition: opacity 140ms ease-out, transform 140ms ease-out',
    ].join(';');
    document.documentElement.appendChild(hint);
    setHint('');
  }

  function setHint(text) {
    if (!hint) return;
    hint.textContent = text;
    hint.style.opacity = text ? '1' : '0';
    hint.style.transform = text ? 'translateX(-50%) translateY(0)' : 'translateX(-50%) translateY(8px)';
  }

  function clearHighlight() {
    if (overlay) overlay.style.display = 'none';
  }

  function updateHover(element) {
    ensureOverlay();
    clearHighlight();
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    overlay.style.display = 'block';
    Object.assign(overlay.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      border: `2px solid ${REFERENCE_COLOR}`,
      borderRadius: '3px',
      background: 'rgba(124, 58, 237, 0.10)',
      boxShadow: '0 0 0 1px rgba(255,255,255,0.75)',
    });
    const tag = element.tagName ? element.tagName.toLowerCase() : 'element';
    const id = element.id ? `#${element.id}` : '';
    const cls = Array.from(element.classList || []).slice(0, 2).map((name) => `.${name}`).join('');
    label.textContent = `${tag}${id}${cls} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    label.style.background = REFERENCE_COLOR;
    label.style.top = rect.top < 28 ? 'auto' : '-24px';
    label.style.bottom = rect.top < 28 ? '-24px' : 'auto';
  }

  /**
   * A reference that cannot be stored is reported back instead of being dropped silently; the
   * toolbar owns the only page-level toast.
   */
  function reportFailure(res) {
    const detail = res && res.error ? res.error : '未知错误';
    window.__domReview.toolbar?.toast?.(detail === 'full'
      ? `参考元素最多 ${core().MAX_REFERENCES} 个，请先在侧边栏删除一些`
      : `参考元素未保存：${detail}`);
  }

  // ------------------------------------------------------------- picking

  function updateFromPoint(x, y) {
    const test = hitTest();
    if (!test) return;
    const result = test.pick(x, y);
    updateHover(result.element);
  }

  function onPointerMove(event) {
    if (!active || pendingElement) return;
    lastPoint = { x: event.clientX, y: event.clientY };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (active && !pendingElement && lastPoint) updateFromPoint(lastPoint.x, lastPoint.y);
    });
  }

  function onClick(event) {
    if (!active || pendingElement) return;
    const test = hitTest();
    if (test && test.isOwnElement && test.isOwnElement(event.target)) return;
    if (popup && popup.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = (lastPoint && test) ? test.pick(lastPoint.x, lastPoint.y).element : null;
    const element = target || event.target;
    if (!element || !element.getBoundingClientRect) return;
    openPopup(element);
  }

  /**
   * The popup's own input already stops propagation; this handler covers "Esc while picking"
   * without reaching the page or the toolbar's V/S/R handler.
   */
  function installKeyHandler() {
    if (keyHandler) return;
    keyHandler = (event) => {
      if (!active || event.isComposing) return;
      if (event.key !== 'Escape') return;
      // The note popup swallows its own Esc; only the picker mode ends here.
      if (pendingElement && popupInput === document.activeElement) return;
      closePopup();
      disable();
    };
    window.addEventListener('keydown', keyHandler, true);
  }

  // --------------------------------------------------------------- popup

  function popupHtml() {
    return `
      <div class="dt-ref-popup">
        <div class="dt-ref-popup__title">添加参考元素</div>
        <input class="dt-ref-popup__input" type="text" placeholder="备注（可选），Enter 保存，Esc 取消" aria-label="参考元素备注">
        <div class="dt-ref-popup__meta"></div>
      </div>`;
  }

  function openPopup(element) {
    ensureOverlay();
    pendingElement = element;
    clearHighlight();
    setHint('填写备注后 Enter 保存；Esc 不添加');
    document.documentElement.style.cursor = '';
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'dom-review-reference-popup';
      popup.innerHTML = popupHtml();
      popup.style.cssText = [
        'position: fixed', 'z-index: 2147483647', 'width: min(280px, calc(100vw - 24px))',
        'padding: 10px', 'border-radius: 10px', 'border: 1px solid rgba(148, 163, 184, 0.28)',
        'background: #172033', 'color: #e2e8f0', 'pointer-events: auto',
        'box-shadow: 0 16px 42px rgba(15, 23, 42, 0.34)', 'font: 12px/1.45 system-ui, sans-serif',
      ].join(';');
      document.documentElement.appendChild(popup);
      popup.querySelector('.dt-ref-popup__input').addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); saveAndContinue(); }
        else if (event.key === 'Escape') { event.preventDefault(); closePopup(); }
        event.stopPropagation();
      });
      injectPopupStyles();
    }
    popupInput = popup.querySelector('.dt-ref-popup__input');
    popupInput.value = '';
    popup.querySelector('.dt-ref-popup__meta').textContent = describePending(element);
    positionPopup(element);
    popup.style.display = '';
    setTimeout(() => popupInput && popupInput.focus(), 0);
  }

  function describePending(element) {
    const sel = window.__domReview.selectorGen?.generate?.(element);
    const short = sel && sel.css ? sel.css : '';
    return `${short.slice(0, 80)} · ${location.host}`;
  }

  function positionPopup(element) {
    if (!popup) return;
    const rect = element.getBoundingClientRect();
    popup.style.left = '0px';
    popup.style.top = '0px';
    const width = popup.offsetWidth || 280;
    const height = popup.offsetHeight || 110;
    const left = Math.max(6, Math.min(rect.right, window.innerWidth - width - 6));
    const top = rect.bottom + 8 + height <= window.innerHeight
      ? rect.bottom + 8
      : Math.max(6, rect.top - height - 8);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function closePopup() {
    if (!popup) return;
    popup.style.display = 'none';
    pendingElement = null;
    document.documentElement.style.cursor = active ? 'crosshair' : '';
    setHint(active ? '点击要作为参考的元素（Esc 退出）' : '');
    if (active) window.__domReview.ui?.restorePageFocus?.();
  }

  async function saveAndContinue() {
    const element = pendingElement;
    const note = popupInput ? popupInput.value.trim() : '';
    if (!element) { closePopup(); return; }
    closePopup();
    await collect(element, note);
    // Keep picking: the next click captures another reference.
  }

  // ----------------------------------------------------------- collection

  /** Pick -> popup -> capture; the service worker is the single writer of the list. */
  async function collect(element, note) {
    const coreApi = core();
    const record = buildRecord(element, note);
    // The popup is already closed and the user may pick the next element; the cover state is shared,
    // so only the first shot of a burst really shoots (and its restore still always runs).
    if (captureInFlight) {
      record.screenshot = '';
    } else {
      captureInFlight = captureElement(element);
      try {
        record.screenshot = await captureInFlight;
      } finally {
        captureInFlight = null;
      }
    }
    await send({ type: coreApi.MSG.ADD, reference: record });
    emitChange();
  }

  function referenceId() {
    return `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function buildRecord(element, note) {
    const coreApi = core();
    const sel = window.__domReview.selectorGen?.generate?.(element);
    const computed = window.getComputedStyle ? window.getComputedStyle(element) : {};
    return {
      id: referenceId(),
      url: location.href,
      title: document.title || '',
      selector: sel ? sel.css : '',
      note,
      styles: coreApi.pickStyles(computed),
      html: coreApi.sanitizeElementHtml(element.outerHTML || ''),
      screenshot: '',
    };
  }

  /** ADD to the service worker; storage quota / validation failures surface as a toast. */
  function send(message) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => { if (!done) { done = true; if (res && res.ok === false) reportFailure(res); resolve(res); } };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          finish(response || { ok: false, error: chrome.runtime.lastError?.message || '扩展后台不可用' });
        });
        setTimeout(() => finish({ ok: false, error: '后台响应超时' }), 8000);
      } catch (err) {
        finish({ ok: false, error: (err && err.message) || String(err) });
      }
    });
  }

  // ------------------------------------------------------------ screenshot

  /**
   * Crop the visible area around the element. Returns '' when the tab cannot be screenshotted
   * (not in the foreground / permission denied / decode failure): the other fields still travel.
   */
  async function captureElement(element) {
    if (!(await canCapture())) return '';
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.left, window.innerWidth));
    const y = Math.max(0, Math.min(rect.top, window.innerHeight));
    const width = Math.max(1, Math.min(rect.width, window.innerWidth - x));
    const height = Math.max(1, Math.min(rect.height, window.innerHeight - y));

    hideTargets = prepareCapture();
    let dataUrl = '';
    try {
      dataUrl = await requestCapture();
    } catch (err) {
      console.warn('[DevTailor] 参考截图失败:', (err && err.message) || err);
      return '';
    } finally {
      restoreCapture(hideTargets);
      hideTargets = [];
    }
    try {
      return cropToDataUrl(dataUrl, { x, y, width, height });
    } catch (err) {
      console.warn('[DevTailor] 参考截图裁剪失败:', (err && err.message) || err);
      return '';
    }
  }

  /**
   * `chrome.tabs.captureVisibleTab` shoots whatever tab is frontmost in this window, which may be
   * the taken-over page rather than the tab that asked for a reference. Only shoot when this tab is
   * both the sender and the visible one.
   */
  function canCapture() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      try {
        chrome.runtime.sendMessage({ type: 'DT_REFERENCE_TAB_CHECK' }, (response) => {
          // A closed port (extension reloading) must not leave the capture hanging forever.
          finish(Boolean(response && response.ok && response.match && response.foreground));
        });
        setTimeout(() => finish(false), 4000);
      } catch {
        finish(false);
      }
    });
  }

  /** Hide DevTailor UI/overlays plus the user text inside the captured element; always restored. */
  function prepareCapture() {
    const ids = [
      'dom-review-host', 'dom-review-badges', 'dom-review-highlights',
      'dom-review-selector-overlay', 'dom-review-selector-hint',
      'dom-review-reference-overlay', 'dom-review-reference-hint', 'dom-review-reference-popup',
    ];
    const targets = [];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      // Remember the exact inline display so restoring cannot resurrect something that was
      // already hidden (the note popup is closed before the capture starts).
      targets.push({ el, display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
      el.style.setProperty('display', 'none', 'important');
    });
    // Inputs' typed text is the user's content: cover it while the shot is taken.
    const root = pendingElement || document;
    root.querySelectorAll('input, textarea, select, [contenteditable], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]').forEach((el) => {
      targets.push({ el, cover: true });
      el.setAttribute('data-dt-ref-cover', '1');
      el.style.setProperty('color', 'transparent', 'important');
      el.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      el.style.setProperty('text-shadow', 'none', 'important');
      el.style.setProperty('caret-color', 'transparent', 'important');
    });
    return targets;
  }

  function restoreCapture(targets) {
    (targets || []).forEach((target) => {
      const el = target && target.el;
      if (!el) return;
      if (target.cover) {
        el.removeAttribute('data-dt-ref-cover');
        el.style.removeProperty('color');
        el.style.removeProperty('-webkit-text-fill-color');
        el.style.removeProperty('text-shadow');
        el.style.removeProperty('caret-color');
        return;
      }
      el.style.removeProperty('display');
      if (target.display) el.style.setProperty('display', target.display, target.priority);
    });
  }

  function requestCapture() {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, (response) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          if (!response || !response.success || !response.dataUrl) {
            reject(new Error((response && response.error) || '截图失败'));
            return;
          }
          resolve(response.dataUrl);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Draw the viewport shot into a canvas and cut out the element rectangle. */
  function cropToDataUrl(dataUrl, { x, y, width, height }) {
    return loadImage(dataUrl).then((img) => {
      // The screenshot is in physical pixels: map CSS coordinates through the actual ratio
      // (devicePixelRatio included) instead of assuming one.
      const scaleX = img.naturalWidth / window.innerWidth;
      const scaleY = img.naturalHeight / window.innerHeight;
      const sx = Math.round(x * scaleX);
      const sy = Math.round(y * scaleY);
      const sw = Math.max(1, Math.round(width * scaleX));
      const sh = Math.max(1, Math.round(height * scaleY));
      const maxEdge = MAX_SCREENSHOT_EDGE;
      const scale = Math.min(1, maxEdge / Math.max(sw, sh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = dataUrl;
    });
  }

  // -------------------------------------------------------------- lifecycle

  function enable() {
    if (active) return;
    // The two pickers share one overlay idea but never run at once.
    if (window.__domReview.selector && window.__domReview.selector.isActive?.()) {
      window.__domReview.selector.disable();
    }
    active = true;
    installKeyHandler();
    ensureOverlay();
    setHint('点击要作为参考的元素（Esc 退出）');
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);
    window.__domReview.toolbar?.setPickMode?.('idle');
  }

  function disable() {
    if (!active && !pendingElement) return;
    active = false;
    pendingElement = null;
    if (popup) {
      popup.style.display = 'none';
      popupInput = null;
    }
    document.documentElement.style.cursor = '';
    clearHighlight();
    setHint('');
    scrollRafPending = false;
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('click', onClick, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll, true);
    if (keyHandler) {
      window.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
    }
  }

  /** Scroll/resize only moves the viewport, not the pointer: keep the box under the last point. */
  function onScroll() {
    if (!active || pendingElement || !lastPoint || scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      if (active && !pendingElement && lastPoint) updateFromPoint(lastPoint.x, lastPoint.y);
    });
  }

  function toggle() {
    if (active) disable();
    else enable();
  }

  function isActive() {
    return active;
  }

  function injectPopupStyles() {
    if (document.getElementById('dom-review-reference-styles')) return;
    const style = document.createElement('style');
    style.id = 'dom-review-reference-styles';
    style.textContent = `
      .dt-ref-popup__title { color: #cbd5e1; font-size: 11px; margin-bottom: 6px; }
      .dt-ref-popup__input {
        /* The popup lives in the page DOM: do not rely on the host page for border-box. */
        box-sizing: border-box;
        width: 100%; padding: 6px 8px; border-radius: 7px; border: 1px solid rgba(148, 163, 184, 0.3);
        background: #0f172a; color: #f8fafc; outline: none; font: inherit;
      }
      .dt-ref-popup__input:focus { border-color: ${REFERENCE_COLOR}; }
      .dt-ref-popup__meta { margin-top: 6px; color: #94a3b8; font-family: ui-monospace, monospace; font-size: 10px; }
    `;
    document.head.appendChild(style);
  }

  window.__domReview.references = { enable, disable, toggle, isActive, onChange, captureElement };
})();
