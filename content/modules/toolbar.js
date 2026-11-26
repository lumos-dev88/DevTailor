/**
 * DevTailor — Marks toolbar (the only page-side UI)
 *
 * A compact rounded bar that floats over the left edge of the viewport, VisBug-style. Dragging it
 * (from anywhere, past a small threshold) moves it freely (clamped to the viewport); the position is remembered per origin
 * (chrome.storage.local). It never changes the page layout and never carries chat: chat,
 * approvals and prompts all live in the side panel.
 *
 * Five controls: pick (V), reference elements (R), screenshot (S), takeover dot, open side panel.
 * Mark viewing, editing, deletion and clearing moved to the side panel's mark tray
 * (sidepanel/mark-tray.js); the reference list lives in sidepanel/references-tray.js.
 *
 * Pure logic lives in toolbar-core.js (position clamp, shortcut matching, approvals, takeover
 * model); this file is DOM wiring only.
 *
 * Depends on: ui (shadow-ui.js), store, marksCore, toolbarCore, marksSync, wsClient (optional)
 * Registers: window.__domReview.toolbar
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const dr = window.__domReview;
  const BAR_W = 48;
  const RELEASE_RECONNECT_MS = 3300; // the bridge frees a dropped client after 3s

  const ICONS = {
    pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6z"/><path d="M13 13l5 5"/></svg>',
    shot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
    reference: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v14l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h4"/></svg>',
    panel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>',
  };

  /** Buttons get a hover/focus card: name, one-line description and shortcut. */
  const TIPS = {
    pick: '选取元素\n点击页面元素加标记并就地写备注（Esc 退出）\n快捷键 V',
    reference: '参考元素\n点选元素存为参考（样式、结构、截图），随消息发给 Claude（Esc 退出）\n快捷键 R',
    shot: '截图\n截取可见区域，加入待发送附件\n快捷键 S',
    statusIdle: '接管状态：未接管\n点击“连接当前页”，Claude 才能操作这个页面',
    statusTaken: '接管状态：已接管\n点击取消接管',
    statusOffline: '接管状态：Hub 未连接\n点击重试连接',
    statusReleasing: '正在取消接管…',
    panel: '打开侧边栏\n查看和编辑标记、聊天、处理审批',
    panelPending: '打开侧边栏\n有待审批的操作，点击处理',
  };

  const CSS = `
    .dt-tb {
      position: fixed; left: 0; top: 0; width: ${BAR_W}px; height: auto; max-height: 100vh;
      display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0;
      pointer-events: auto; font-family: var(--dt-font); font-size: var(--dt-font-size);
      color: var(--dt-text-primary); visibility: hidden; touch-action: none;
      background: var(--dt-bg-tertiary);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    }
    .dt-tb.is-ready { visibility: visible; }
    .dt-tb.is-dragging { cursor: grabbing; opacity: 0.92; }

    .dt-b {
      position: relative; flex: 0 0 auto; width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: var(--dt-radius); background: transparent; color: var(--dt-text-secondary);
      cursor: pointer; font: inherit;
    }
    .dt-b svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .dt-b:hover { background: var(--dt-bg-secondary); color: var(--dt-text-primary); }
    .dt-b:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: -2px; }
    .dt-b[aria-pressed="true"] { background: var(--dt-accent); color: #fff; }
    .dt-b[aria-pressed="true"].is-describing { background: var(--dt-warning); color: #0f172a; }
    .dt-b.is-reference { color: #c4b5fd; }
    .dt-b[aria-pressed="true"].is-reference { background: #7c3aed; color: #fff; }
    .dt-b[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
    .dt-b[aria-disabled="true"]:hover { background: transparent; color: var(--dt-text-secondary); }

    .dt-tip {
      display: none; position: absolute; top: 50%; transform: translateY(-50%);
      z-index: 5; width: max-content; max-width: 250px; padding: 7px 9px; border-radius: var(--dt-radius-sm);
      background: #0b1220; color: var(--dt-text-primary); border: 1px solid rgba(255,255,255,0.1);
      font-size: 12px; line-height: 1.5; text-align: left; white-space: pre-line; pointer-events: none;
      box-shadow: var(--dt-shadow);
    }
    /* tooltip pops out on the side with more room: right when docked left, left when docked right */
    .dt-tb:not(.is-tip-left) .dt-tip { left: calc(100% + 8px); }
    .dt-tb.is-tip-left .dt-tip { right: calc(100% + 8px); }
    .dt-b:hover .dt-tip, .dt-b:focus-visible .dt-tip { display: block; }

    .dt-count {
      position: absolute; top: 1px; right: 0; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
      background: var(--dt-accent); color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center;
    }
    .dt-count--muted { background: var(--dt-bg-hover); }
    .dt-count[hidden], .dt-reddot[hidden] { display: none; }
    .dt-reddot { position: absolute; top: 4px; right: 4px; width: 9px; height: 9px; border-radius: 50%; background: var(--dt-danger); border: 2px solid var(--dt-bg-tertiary); box-sizing: content-box; }
    .dt-status-pip { width: 11px; height: 11px; border-radius: 50%; background: var(--dt-text-muted); box-shadow: 0 0 0 3px rgba(255,255,255,0.06); }
    .dt-b[data-tone="ok"] .dt-status-pip { background: var(--dt-success); }
    .dt-b[data-tone="warn"] .dt-status-pip { background: var(--dt-warning); }
    .dt-b[data-tone="error"] .dt-status-pip { background: var(--dt-danger); }

    .dt-hl { position: fixed; left: 0; top: 0; width: 0; height: 0; display: none; pointer-events: none; z-index: 1; border: 2px solid var(--dt-accent); border-radius: 3px; background: rgba(59,130,246,0.12); box-shadow: 0 0 0 1px rgba(255,255,255,0.6); }
    .dt-hl.is-pulse { animation: dt-hl-pulse 0.55s ease-in-out 2; }
    @keyframes dt-hl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    .dt-toast { position: fixed; left: 0; top: 0; max-width: min(320px, calc(100vw - 80px)); padding: 8px 12px; border-radius: var(--dt-radius); background: #0b1220; color: var(--dt-text-primary); border: 1px solid rgba(255,255,255,0.12); box-shadow: var(--dt-shadow); font-size: 12px; line-height: 1.5; white-space: pre-line; opacity: 0; transform: translateY(6px); transition: opacity .14s, transform .14s; pointer-events: none; }
    .dt-toast.is-show { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .dt-hl.is-pulse { animation: none; } .dt-toast { transition: none; } }
  `;

  const TEMPLATE = `
    <div class="dt-tb" id="dt-tb">
      <button class="dt-b" id="dt-pick" type="button" aria-label="选取页面元素" aria-pressed="false">${ICONS.pick}<span class="dt-tip">${TIPS.pick}</span></button>
      <button class="dt-b is-reference" id="dt-reference" type="button" aria-label="参考元素" aria-pressed="false">${ICONS.reference}<span class="dt-count dt-count--muted" id="dt-reference-count" hidden>0</span><span class="dt-tip">${TIPS.reference}</span></button>
      <button class="dt-b" id="dt-shot" type="button" aria-label="截取可见区域">${ICONS.shot}<span class="dt-count dt-count--muted" id="dt-shot-count" hidden>0</span><span class="dt-tip">${TIPS.shot}</span></button>
      <button class="dt-b" id="dt-status" type="button" aria-label="接管状态" data-tone="warn"><span class="dt-status-pip"></span><span class="dt-tip" id="dt-status-tip">${TIPS.statusIdle}</span></button>
      <button class="dt-b" id="dt-sidepanel" type="button" aria-label="打开侧边栏">${ICONS.panel}<span class="dt-reddot" id="dt-reddot" hidden></span><span class="dt-tip">${TIPS.panel}</span></button>
    </div>
    <div class="dt-hl" id="dt-hl"></div>
    <div class="dt-toast" id="dt-toast" role="status" aria-live="polite"></div>
  `;

  let built = false;
  let opts = {};
  // `open` is a legacy field from the removed drawer; it is ignored on load but kept in the shape.
  const state = { top: null, left: null };
  let releasing = false;
  let pickMode = 'idle';
  let toastTimer = null;
  let hlTimers = [];
  let approvals = null;
  let el = {};

  const core = () => dr.marksCore;
  const tcore = () => dr.toolbarCore;
  const $ = (id) => dr.ui.getShadowRoot().getElementById(id);

  // ------------------------------------------------------------ build

  function build() {
    if (built) return;
    built = true;
    dr.ui.addStyles(CSS, 'dt-toolbar-styles');
    dr.ui.getRoot().innerHTML = TEMPLATE;
    el = {
      tb: $('dt-tb'), pick: $('dt-pick'), reference: $('dt-reference'), referenceCount: $('dt-reference-count'),
      shot: $('dt-shot'), shotCount: $('dt-shot-count'),
      status: $('dt-status'), statusTip: $('dt-status-tip'), sidepanel: $('dt-sidepanel'),
      reddot: $('dt-reddot'), hl: $('dt-hl'), toast: $('dt-toast'),
    };
  }

  // ---------------------------------------------------------- persistence

  function storageKey() {
    return tcore().stateKey(location.origin);
  }

  function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(storageKey(), (res) => {
          if (chrome.runtime.lastError) { resolve(tcore().defaultState()); return; }
          resolve(tcore().parseState(res && res[storageKey()]));
        });
      } catch { resolve(tcore().defaultState()); }
    });
  }

  function saveState() {
    try {
      chrome.storage.local.set({ [storageKey()]: tcore().serializeState(state) }, () => { void chrome.runtime.lastError; });
    } catch { /* storage is best effort */ }
  }

  // --------------------------------------------------------------- layout

  function barBox() {
    return { width: el.tb.offsetWidth || BAR_W, height: el.tb.offsetHeight || 180 };
  }

  function applyPosition() {
    const { width, height } = barBox();
    const pos = tcore().resolvePosition(state, window.innerWidth, window.innerHeight, width, height);
    el.tb.style.left = `${pos.left}px`;
    el.tb.style.top = `${pos.top}px`;
    // Tooltip flips to the side with more room: only pop left when the right side would clip.
    const rightRoom = window.innerWidth - (pos.left + width);
    el.tb.classList.toggle('is-tip-left', rightRoom < width + 16);
    placeToast();
    return pos;
  }

  /** Toast follows the bar instead of a fixed corner; clamped to stay on screen. */
  function placeToast() {
    if (!built || !el.toast) return;
    const { width } = barBox();
    const left = Number.isFinite(state.left) ? state.left : 0;
    const top = Number.isFinite(state.top) ? state.top : 0;
    // Prefer the bar's right side when there is room, otherwise its left; never overlap the bar.
    const onRight = left + width + 12 + Math.min(320, window.innerWidth - 80) <= window.innerWidth;
    const x = onRight ? left + width + 12 : Math.max(0, left - 12 - Math.min(320, window.innerWidth - 80));
    const y = Math.min(window.innerHeight - 60, top);
    el.toast.style.left = `${x}px`;
    el.toast.style.top = `${y}px`;
  }

  function hideHighlight() {
    hlTimers.forEach(clearTimeout);
    hlTimers = [];
    el.hl.classList.remove('is-pulse');
    el.hl.style.display = 'none';
  }

  /** Flash the marked element in place (used after scrolling it into view). */
  function pulse(id) {
    if (!built) return;
    hideHighlight();
    const mark = dr.store.get(id);
    const target = mark && dr.hitTest ? dr.hitTest.resolveSelector(mark.selector) : null;
    const rect = target && target.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const color = core().colorFor(mark.index);
    const show = (pulseOn) => {
      Object.assign(el.hl.style, {
        display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${Math.max(1, rect.width)}px`, height: `${Math.max(1, rect.height)}px`,
        borderColor: color, background: `${color}22`,
      });
      el.hl.classList.toggle('is-pulse', pulseOn);
    };
    // smooth scrolling is still moving: follow the element for a moment
    [0, 250, 500, 800].forEach((ms) => hlTimers.push(setTimeout(() => show(ms === 0), ms)));
    hlTimers.push(setTimeout(hideHighlight, 1300));
  }

  function locate(id) {
    const ok = dr.marksSync ? dr.marksSync.locate(id) : false;
    if (!ok) toast('页面上找不到这个元素（可能已被移除或还没渲染）');
    return ok;
  }

  // ----------------------------------------------------------------- drag

  const DRAG_THRESHOLD = 4;

  function wireDrag() {
    let drag = null;
    let swallowClick = false;
    // The bar is almost all buttons, so a move may start anywhere on it: it becomes a drag only after
    // the pointer travels past the threshold, otherwise the button click goes through untouched.
    el.tb.addEventListener('pointerdown', (e) => {
      swallowClick = false;
      if (e.button !== 0) return;
      const pos = applyPosition();
      drag = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, moved: false };
    });
    el.tb.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!(e.buttons & 1)) { end(e); return; }
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
        drag.moved = true;
        el.tb.classList.add('is-dragging');
        try { el.tb.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      const { width, height } = barBox();
      const pos = tcore().clampPosition(
        { left: drag.left + (e.clientX - drag.x), top: drag.top + (e.clientY - drag.y) },
        window.innerWidth, window.innerHeight, width, height
      );
      state.left = pos.left;
      state.top = pos.top;
      applyPosition();
    });
    function end(e) {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      if (!moved) return;
      swallowClick = true;
      el.tb.classList.remove('is-dragging');
      try { el.tb.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      saveState();
    }
    el.tb.addEventListener('pointerup', end);
    el.tb.addEventListener('pointercancel', end);
    // A drag that ends over a button must not trigger it.
    el.tb.addEventListener('click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('resize', applyPosition);
  }

  // --------------------------------------------------------------- toasts

  function toast(message, ms = 3200) {
    if (!built) return;
    el.toast.textContent = message;
    placeToast();
    el.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-show'), ms);
  }

  function refreshRail() {
    if (!built) return;
    const shots = dr.marksSync ? dr.marksSync.screenshots.list().length : 0;
    el.shotCount.hidden = shots === 0;
    el.shotCount.textContent = String(shots);
  }

  // --------------------------------------------------------- status + approvals

  function takeoverState() {
    const ws = dr.wsClient;
    return tcore().takeoverModel({
      status: ws ? ws.getStatus() : 'disconnected',
      active: Boolean(ws && ws.isActive && ws.isActive()),
      releasing,
      startCommand: dr.bridgeCore?.BRIDGE_START_COMMAND,
    });
  }

  /** True only when this page owns the Hub takeover (marks are part of the message then). */
  function isTakenOverPage() {
    const ws = dr.wsClient;
    return Boolean(ws && ws.isActive && ws.isActive());
  }

  function selectorDisable() {
    try { dr.selector?.disable?.(); } catch { /* optional module */ }
  }

  function refreshStatus() {
    if (!built) return;
    const m = takeoverState();
    el.status.dataset.tone = m.tone;
    el.status.dataset.state = m.key;
    el.status.setAttribute('aria-label', `接管状态：${m.label}`);
    el.statusTip.textContent = m.key === 'taken' ? TIPS.statusTaken
      : m.key === 'offline' ? `${m.label}\n${m.tip}`
        : m.key === 'releasing' ? TIPS.statusReleasing
          : TIPS.statusIdle;
  }

  function refreshApprovals() {
    if (!built) return;
    const n = approvals ? approvals.count() : 0;
    el.reddot.hidden = n === 0;
    el.sidepanel.querySelector('.dt-tip').textContent = n ? TIPS.panelPending : TIPS.panel;
    el.sidepanel.setAttribute('aria-label', n ? `打开侧边栏（${n} 个待审批操作）` : '打开侧边栏');
  }

  async function onStatusClick() {
    const ws = dr.wsClient;
    const m = takeoverState();
    if (!ws) { toast('Hub 客户端未加载，请刷新页面'); return; }
    if (m.action === 'reconnect') {
      ws.reconnectNow();
      toast(m.tip.split('\n')[0]);
    } else if (m.action === 'activate') {
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'TAKEOVER_TAB' }, response => resolve(
          response || { ok: false, error: chrome.runtime.lastError?.message }
        ));
      });
      if (!res || res.ok === false) toast(res?.error || '接管当前页失败，请确认 Hub 正在运行');
      refreshStatus();
    } else if (m.action === 'release') {
      // Drop the takeover ownership in the background (only when it belongs to this tab), then let
      // the bridge free the dropped event stream before reconnecting as "未接管".
      releasing = true;
      refreshStatus();
      chrome.runtime.sendMessage({ type: 'RELEASE_TAKEOVER' }, (response) => {
        void chrome.runtime.lastError;
        if (response?.ok === false) toast(response.error || '取消接管失败，请刷新后重试');
      });
      ws.disconnect(true);
      setTimeout(() => {
        releasing = false;
        ws.connect();
        refreshStatus();
        // The bridge only frees a tab whose event stream is gone. An open side panel keeps its own
        // stream for the same tab, so the release may not happen: say so instead of failing silently.
        setTimeout(() => {
          if (ws.isActive && ws.isActive()) toast('侧边栏仍连接着此页，关闭侧边栏后可取消接管');
        }, 1500);
      }, RELEASE_RECONNECT_MS);
    }
  }

  // ------------------------------------------------------------- pick mode

  function setPickMode(mode) {
    pickMode = mode === 'selecting' || mode === 'describing' ? mode : 'idle';
    if (!built) return;
    el.pick.setAttribute('aria-pressed', String(pickMode !== 'idle'));
    el.pick.classList.toggle('is-describing', pickMode === 'describing');
    el.pick.setAttribute('aria-label', pickMode === 'idle' ? '选取页面元素' : '退出选取');
  }

  /** Reference picker is a separate mode with its own colour; pressing R again leaves it. */
  function syncReferenceMode() {
    if (!built) return;
    const on = Boolean(dr.references?.isActive?.());
    el.reference.setAttribute('aria-pressed', String(on));
    el.reference.setAttribute('aria-label', on ? '退出参考元素模式' : '参考元素');
  }

  /** Mirror the global pending reference count (the service worker broadcasts changes). */
  function refreshReferenceCount() {
    if (!built) return;
    const list = Array.isArray(dr.referencesState) ? dr.referencesState : [];
    const n = list.length;
    el.referenceCount.hidden = n === 0;
    el.referenceCount.textContent = String(n);
  }

  // ------------------------------------------------------------- keyboard

  /**
   * The toolbar's own "选取" button also starts mark mode; a non-taken-over page gets the same
   * heads-up there (the shortcut path shows it above).
   */
  function onPickRequested() {
    if (!isTakenOverPage()) toast('此页未接管，标记不会随消息发送；用 R 添加为参考', 4200);
    opts.onPick?.();
  }

  /** Reference picker toggle (button click and the R shortcut share it). */
  function toggleReferenceMode() {
    const refs = dr.references;
    if (!refs) { toast('参考元素模块未加载，请刷新页面'); return; }
    if (refs.isActive?.()) {
      refs.disable();
    } else {
      // The mark workflow owns the same hover/click surface: leave it first.
      if (dr.selector?.isActive?.()) {
        dr.badges?.closeFloating?.({ save: true, resume: false });
        selectorDisable();
      }
      setPickMode('idle');
      refs.enable();
    }
    syncReferenceMode();
  }

  /**
   * V / S / R shortcuts for the toolbar. They fire only for a plain key press while focus is
   * outside any text-editing context; otherwise the page keeps the key untouched.
   */
  function onDocKeydown(e) {
    if (!e || e.isComposing) return;
    if (e.key === 'Escape') {
      const refs = dr.references;
      if (refs && refs.isActive?.()) { refs.disable(); syncReferenceMode(); return; }
      const sel = dr.selector;
      if (sel && sel.isActive() && !sel.isPaused()) {
        sel.disable();
        setPickMode('idle');
      }
      return;
    }
    const action = tcore().matchShortcut(e.key, {
      modifierKeys: [e.ctrlKey, e.metaKey, e.altKey],
      composing: Boolean(e.isComposing),
    });
    if (!action) return;
    if (tcore().isEditableEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'pick') {
      // Mark picking and the reference picker are mutually exclusive.
      if (dr.references?.isActive?.()) { dr.references.disable(); syncReferenceMode(); }
      // Marks only travel with a message from the taken-over page; references work anywhere.
      if (!isTakenOverPage()) toast('此页未接管，标记不会随消息发送；用 R 添加为参考', 4200);
      opts.onPick?.();
    } else if (action === 'reference') {
      toggleReferenceMode();
    } else if (action === 'screenshot') {
      if (dr.screenshot) dr.screenshot.capture();
      else toast('截图模块未加载，请刷新页面');
    }
  }

  function wireKeyboard() {
    document.addEventListener('keydown', onDocKeydown, true);
  }

  // -------------------------------------------------- reference list count

  /**
   * The service worker broadcasts MSG.UPDATED after every change; the badge mirrors it.
   * `message.references` is the whole pending list (max 8 entries), so the page keeps no copy itself.
   */
  function onReferencesUpdated(message) {
    dr.referencesState = Array.isArray(message?.references) ? message.references : [];
    refreshReferenceCount();
  }

  async function loadReferences() {
    const coreApi = dr.referencesCore;
    if (!coreApi) return;
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: coreApi.MSG.GET }, (response) => resolve(
          response || { ok: false, error: chrome.runtime.lastError?.message }
        ));
      });
      if (res && res.ok) onReferencesUpdated({ references: res.references });
    } catch { /* extension context not ready yet */ }
  }

  // ------------------------------------------------------------------ init

  function openSidePanel({ focusInput = false } = {}) {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL', focusInput }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          toast('无法自动打开侧边栏：请点击浏览器工具栏里的 DevTailor 图标，再选择“打开侧边栏”');
        }
      });
    } catch {
      toast('无法自动打开侧边栏：请点击浏览器工具栏里的 DevTailor 图标');
    }
  }

  function wireRail() {
    el.pick.addEventListener('click', onPickRequested);
    el.reference.addEventListener('click', () => toggleReferenceMode());
    el.shot.addEventListener('click', () => {
      if (dr.screenshot) dr.screenshot.capture();
      else toast('截图模块未加载，请刷新页面');
    });
    el.status.addEventListener('click', onStatusClick);
    el.sidepanel.addEventListener('click', () => openSidePanel());
  }

  /** Show/hide the bar without destroying it; the shortcut and takeover wiring stays live. */
  function toggleVisibility() {
    if (!built) return false;
    const nextHidden = el.tb.style.visibility !== 'hidden';
    el.tb.style.visibility = nextHidden ? 'hidden' : '';
    return !nextHidden;
  }

  function init(options = {}) {
    if (built) return;
    opts = options;
    build();
    wireRail();
    wireDrag();
    wireKeyboard();

    approvals = tcore().createApprovalTracker();
    const ws = dr.wsClient;
    if (ws) {
      ws.onStatusChange((status) => {
        if (status !== 'connected' && approvals.reset()) refreshApprovals();
        refreshStatus();
      });
      ws.onMessage((msg) => {
        if (approvals.handle(msg)) refreshApprovals();
        if (msg && (msg.type === 'active_client' || msg.type === 'connected')) refreshStatus();
      });
    }
    setInterval(refreshApprovals, 30000);

    dr.store.onChange(() => { hideHighlight(); });
    dr.marksSync?.onChange(refreshRail);
    chrome.runtime.onMessage.addListener((message) => {
      const coreApi = dr.referencesCore;
      if (coreApi && message && message.type === coreApi.MSG.UPDATED) onReferencesUpdated(message);
      return false;
    });
    dr.references?.onChange?.(syncReferenceMode);
    void loadReferences();
    setPickMode(pickMode);
    syncReferenceMode();
    refreshStatus();
    refreshApprovals();
    refreshRail();
    refreshReferenceCount();

    const reveal = () => {
      applyPosition();
      el.tb.classList.add('is-ready');
    };
    let revealed = false;
    const once = (loaded) => {
      if (revealed) return;
      revealed = true;
      state.top = loaded.top;
      state.left = loaded.left;
      reveal();
    };
    loadState().then(once);
    setTimeout(() => once(tcore().defaultState()), 600);
  }

  dr.toolbar = {
    init,
    toast,
    pulse,
    locate,
    setPickMode,
    syncReferenceMode,
    onReferencesUpdated,
    refresh() { refreshRail(); refreshStatus(); refreshApprovals(); refreshReferenceCount(); },
    /** Show/hide the bar (Ctrl/Cmd+Shift+X when already taken over). */
    toggleVisibility,
    show: () => { if (built) el.tb.style.visibility = ''; },
    hide: () => { if (built) el.tb.style.visibility = 'hidden'; },
    isHidden: () => Boolean(built && el.tb.style.visibility === 'hidden'),
  };
})();