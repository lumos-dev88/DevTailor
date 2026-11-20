/**
 * DevTailor — Marks toolbar (the only page-side UI)
 *
 * A narrow vertical bar docked to the right page edge that expands into a full-height drawer
 * listing the page marks (search, inline note edit, details, save to library, delete). It lives in
 * the closed Shadow DOM of shadow-ui.js, never changes the page layout, and never carries chat:
 * chat, approvals and prompts all live in the side panel.
 *
 * Pure logic lives in marks-core.js (search/describe/snapshot) and toolbar-core.js (state, clamp,
 * approvals, takeover model); this file is DOM wiring only.
 *
 * Depends on: ui (shadow-ui.js), store, marksCore, toolbarCore, marksSync, wsClient (optional)
 * Registers: window.__domReview.toolbar
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const dr = window.__domReview;
  const COLLAPSED_W = 44;
  const EXPANDED_W = 320;
  const RELEASE_RECONNECT_MS = 3300; // the bridge frees a dropped client after 3s

  const ICONS = {
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>',
    pick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2-2 6z"/><path d="M13 13l5 5"/></svg>',
    marks: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
    shot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8a2 2 0 012-2h2l1.5-2h5L16 6h2a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><circle cx="12" cy="12.5" r="3.2"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg>',
    panel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>',
    expandAll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg>',
    collapseAll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9l5-5 5 5M7 15l5 5 5-5"/></svg>',
    library: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4v16H5zM11 4h4v16h-4zM17.5 5l3 .8-3.5 14-3-.8z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  const CSS = `
    .dt-tb {
      position: fixed; right: 0; top: 0; width: ${COLLAPSED_W}px;
      display: flex; flex-direction: row; pointer-events: auto;
      font-family: var(--dt-font); font-size: var(--dt-font-size); color: var(--dt-text-primary);
      visibility: hidden;
    }
    .dt-tb.is-ready { visibility: visible; }
    .dt-tb[data-open="true"] { top: 0 !important; bottom: 0; height: 100vh; width: min(${EXPANDED_W}px, 100vw); }

    .dt-rail {
      position: relative; flex: 0 0 ${COLLAPSED_W}px; width: ${COLLAPSED_W}px;
      display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0;
      background: var(--dt-bg-tertiary);
      border: 1px solid rgba(255,255,255,0.08); border-right: 0; border-radius: 10px 0 0 10px;
      box-shadow: -2px 4px 16px rgba(0,0,0,0.35);
    }
    .dt-tb[data-open="true"] .dt-rail { border-radius: 0; border-top: 0; border-bottom: 0; box-shadow: none; }
    .dt-rail-sep { width: 22px; height: 1px; background: rgba(255,255,255,0.1); margin: 2px 0; flex: 0 0 auto; }
    .dt-rail-spacer { flex: 1 1 auto; }
    .dt-tb:not([data-open="true"]) .dt-rail-spacer { display: none; }

    .dt-b {
      position: relative; flex: 0 0 auto; width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: var(--dt-radius); background: transparent; color: var(--dt-text-secondary);
      cursor: pointer; font: inherit;
    }
    .dt-b svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .dt-b--grip { height: 18px; cursor: grab; touch-action: none; color: var(--dt-text-muted); }
    .dt-b--grip svg { width: 16px; height: 16px; fill: currentColor; stroke: none; }
    .dt-b--grip.is-dragging { cursor: grabbing; }
    .dt-tb[data-open="true"] .dt-b--grip { display: none; }
    .dt-b:hover { background: var(--dt-bg-secondary); color: var(--dt-text-primary); }
    .dt-b:focus-visible, .dt-ib:focus-visible, .dt-row-main:focus-visible, .dt-fbtn:focus-visible,
    .dt-search input:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: -2px; }
    .dt-b[aria-pressed="true"], .dt-b.is-on { background: var(--dt-accent); color: #fff; }
    .dt-b[aria-pressed="true"].is-describing { background: var(--dt-warning); color: #0f172a; }
    .dt-b[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
    .dt-b[aria-disabled="true"]:hover { background: transparent; color: var(--dt-text-secondary); }

    .dt-b[data-tip]:hover::after, .dt-b[data-tip]:focus-visible::after {
      content: attr(data-tip); position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%);
      z-index: 5; width: max-content; max-width: 250px; padding: 6px 9px; border-radius: var(--dt-radius-sm);
      background: #0b1220; color: var(--dt-text-primary); border: 1px solid rgba(255,255,255,0.1);
      font-size: 12px; font-weight: 400; line-height: 1.45; text-align: left; white-space: pre-line; pointer-events: none;
      box-shadow: var(--dt-shadow);
    }
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

    /* --- drawer --- */
    .dt-drawer {
      display: none; flex: 1 1 auto; min-width: 0; flex-direction: column;
      background: var(--dt-bg-primary); border-left: 1px solid rgba(255,255,255,0.08);
    }
    .dt-tb[data-open="true"] .dt-drawer { display: flex; }
    .dt-dr-head { flex: 0 0 auto; padding: 10px 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); background: var(--dt-bg-tertiary); }
    .dt-dr-title { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .dt-dr-title strong { font-size: 13px; font-weight: 600; }
    .dt-dr-title span { color: var(--dt-text-secondary); font-size: 12px; }
    .dt-spacer { flex: 1 1 auto; }
    .dt-ib {
      width: 26px; height: 26px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
      border: 0; border-radius: var(--dt-radius-sm); background: transparent; color: var(--dt-text-secondary); cursor: pointer;
    }
    .dt-ib svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .dt-ib:hover { background: var(--dt-bg-secondary); color: var(--dt-text-primary); }
    .dt-ib.is-danger:hover { background: rgba(239,68,68,0.18); color: #fecaca; }
    .dt-ib[hidden] { display: none; }
    .dt-search { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 6px 0 9px; background: var(--dt-bg-primary); border: 1px solid rgba(255,255,255,0.1); border-radius: var(--dt-radius); }
    .dt-search:focus-within { border-color: var(--dt-accent); }
    .dt-search > svg { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: var(--dt-text-muted); stroke-width: 1.8; stroke-linecap: round; }
    .dt-search input { flex: 1 1 auto; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--dt-text-primary); font: 12px var(--dt-font); }
    .dt-search input::placeholder { color: var(--dt-text-muted); }
    .dt-search-count { flex: 0 0 auto; color: var(--dt-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }

    .dt-dr-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .dt-list { list-style: none; }
    .dt-row { position: relative; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .dt-row:hover, .dt-row.is-hover { background: rgba(255,255,255,0.03); }
    .dt-row-main { display: flex; gap: 9px; padding: 9px 94px 9px 10px; cursor: pointer; min-width: 0; }
    .dt-badge { flex: 0 0 auto; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; color: #f8fafc; font-size: 12px; font-weight: 700; line-height: 22px; text-align: center; }
    .dt-row-text { min-width: 0; flex: 1 1 auto; }
    .dt-row-desc { font: 11.5px/1.35 var(--dt-font-mono); color: var(--dt-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt-row-note { margin-top: 2px; font-size: 12px; line-height: 1.4; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt-row-note.is-empty { color: var(--dt-text-muted); font-style: italic; }
    .dt-row-meta, .dt-row-match { margin-top: 2px; font-size: 11px; line-height: 1.35; color: var(--dt-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt-row-match { font-family: var(--dt-font-mono); color: #94a3b8; }
    .dt-row-match b { color: var(--dt-text-muted); font-family: var(--dt-font); font-weight: 500; margin-right: 4px; }
    .dt-sent { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px; background: rgba(34,197,94,0.18); color: #86efac; font: 600 10px/16px var(--dt-font); vertical-align: 1px; }
    .dt-row-actions { position: absolute; top: 6px; right: 6px; display: flex; gap: 0; }
    .dt-row-actions .dt-ib { width: 22px; height: 22px; }
    .dt-row[data-expanded="true"] [data-act="expand"] svg { transform: rotate(180deg); }
    .dt-detail { display: none; padding: 0 10px 10px 41px; }
    .dt-row[data-expanded="true"] .dt-detail { display: block; }
    .dt-detail dl { display: grid; grid-template-columns: 52px 1fr; gap: 4px 8px; font-size: 11.5px; }
    .dt-detail dt { color: var(--dt-text-muted); }
    .dt-detail dd { min-width: 0; color: #cbd5e1; word-break: break-all; }
    .dt-detail code, .dt-detail pre { font: 11px/1.45 var(--dt-font-mono); }
    .dt-detail pre { margin-top: 8px; max-height: 120px; overflow: auto; padding: 7px 8px; border-radius: var(--dt-radius-sm); background: var(--dt-bg-tertiary); color: #94a3b8; white-space: pre-wrap; word-break: break-all; }
    .dt-note-input { width: 100%; margin-top: 2px; padding: 4px 7px; border: 1px solid var(--dt-accent); border-radius: var(--dt-radius-sm); outline: 0; background: var(--dt-bg-tertiary); color: var(--dt-text-primary); font: 12px var(--dt-font); }
    .dt-hit { background: rgba(245,158,11,0.35); color: #fde68a; border-radius: 2px; }
    .dt-empty { padding: 36px 22px; text-align: center; color: var(--dt-text-secondary); font-size: 12.5px; line-height: 1.7; }
    .dt-empty strong { display: block; margin-bottom: 4px; color: var(--dt-text-primary); font-size: 13px; }
    .dt-empty .dt-fbtn { margin-top: 10px; }

    .dt-dr-foot { flex: 0 0 auto; display: flex; gap: 8px; padding: 9px 10px; border-top: 1px solid rgba(255,255,255,0.06); background: var(--dt-bg-tertiary); }
    .dt-fbtn { flex: 1 1 0; min-width: 0; height: 30px; padding: 0 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: var(--dt-radius-sm); background: var(--dt-bg-secondary); color: var(--dt-text-primary); font: 500 12px var(--dt-font); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dt-fbtn:hover:not(:disabled) { background: var(--dt-bg-hover); }
    .dt-fbtn:disabled { opacity: 0.45; cursor: not-allowed; }
    .dt-fbtn--primary { background: var(--dt-accent); border-color: transparent; }
    .dt-fbtn--primary:hover:not(:disabled) { background: var(--dt-accent-hover); }
    .dt-fbtn--danger.is-confirm { background: var(--dt-danger); border-color: transparent; }

    .dt-hl { position: fixed; left: 0; top: 0; width: 0; height: 0; display: none; pointer-events: none; z-index: 1; border: 2px solid var(--dt-accent); border-radius: 3px; background: rgba(59,130,246,0.12); box-shadow: 0 0 0 1px rgba(255,255,255,0.6); }
    .dt-hl.is-pulse { animation: dt-hl-pulse 0.55s ease-in-out 2; }
    @keyframes dt-hl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    .dt-toast { position: fixed; right: ${COLLAPSED_W + 12}px; bottom: 20px; max-width: min(320px, calc(100vw - 80px)); padding: 8px 12px; border-radius: var(--dt-radius); background: #0b1220; color: var(--dt-text-primary); border: 1px solid rgba(255,255,255,0.12); box-shadow: var(--dt-shadow); font-size: 12px; line-height: 1.5; white-space: pre-line; opacity: 0; transform: translateY(6px); transition: opacity .14s, transform .14s; pointer-events: none; }
    .dt-toast.is-show { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .dt-hl.is-pulse { animation: none; } .dt-toast { transition: none; } }
  `;

  const TEMPLATE = `
    <div class="dt-tb" id="dt-tb" data-open="false">
      <aside class="dt-drawer" id="dt-drawer" aria-label="标记列表">
        <header class="dt-dr-head">
          <div class="dt-dr-title">
            <strong>标记</strong><span id="dt-dr-sub">0 个</span>
            <span class="dt-spacer"></span>
            <button class="dt-ib" id="dt-expand-all" type="button" aria-label="全部展开" title="全部展开">${ICONS.expandAll}</button>
            <button class="dt-ib" id="dt-library" type="button" aria-label="打开元素库" title="打开元素库">${ICONS.library}</button>
          </div>
          <div class="dt-search">
            ${ICONS.search}
            <input id="dt-search" type="text" placeholder="搜索标记：文字 / 选择器 / 备注 / 组件" aria-label="搜索标记" autocomplete="off" spellcheck="false">
            <span class="dt-search-count" id="dt-search-count" aria-live="polite"></span>
            <button class="dt-ib" id="dt-search-clear" type="button" aria-label="清空搜索" title="清空搜索" hidden>${ICONS.close}</button>
          </div>
        </header>
        <div class="dt-dr-body" id="dt-dr-body">
          <ul class="dt-list" id="dt-list"></ul>
          <div class="dt-empty" id="dt-empty" hidden></div>
        </div>
        <footer class="dt-dr-foot">
          <button class="dt-fbtn dt-fbtn--danger" id="dt-clear-all" type="button">清空全部标记</button>
          <button class="dt-fbtn dt-fbtn--primary" id="dt-send" type="button" title="打开侧边栏，标记会随下一条消息一起发送">在侧边栏发送</button>
        </footer>
      </aside>
      <div class="dt-rail" id="dt-rail" role="toolbar" aria-orientation="vertical" aria-label="DevTailor 标记工具条">
        <button class="dt-b dt-b--grip" id="dt-grip" type="button" aria-label="拖动工具条（上下方向键微调位置）" data-tip="拖动调整位置">${ICONS.grip}</button>
        <button class="dt-b" id="dt-pick" type="button" aria-label="选取页面元素" aria-pressed="false" data-tip="选取页面元素（Esc 退出）">${ICONS.pick}</button>
        <button class="dt-b" id="dt-marks" type="button" aria-label="标记列表" aria-expanded="false" data-tip="标记列表">${ICONS.marks}<span class="dt-count" id="dt-marks-count" hidden>0</span></button>
        <button class="dt-b" id="dt-search-btn" type="button" aria-label="搜索标记" data-tip="搜索标记">${ICONS.search}</button>
        <button class="dt-b" id="dt-shot" type="button" aria-label="截取可见区域" data-tip="截取可见区域，加入待发送附件">${ICONS.shot}<span class="dt-count dt-count--muted" id="dt-shot-count" hidden>0</span></button>
        <button class="dt-b" id="dt-save" type="button" aria-label="存入元素库" aria-disabled="true" data-tip="存入元素库">${ICONS.save}</button>
        <span class="dt-rail-sep" role="presentation"></span>
        <button class="dt-b" id="dt-status" type="button" aria-label="接管状态" data-tone="warn" data-tip="接管状态"><span class="dt-status-pip"></span></button>
        <button class="dt-b" id="dt-sidepanel" type="button" aria-label="打开侧边栏" data-tip="打开侧边栏">${ICONS.panel}<span class="dt-reddot" id="dt-reddot" hidden></span></button>
        <span class="dt-rail-spacer"></span>
        <button class="dt-b" id="dt-toggle" type="button" aria-label="展开标记抽屉" aria-expanded="false" data-tip="展开标记抽屉">${ICONS.chevronLeft}</button>
      </div>
    </div>
    <div class="dt-hl" id="dt-hl"></div>
    <div class="dt-toast" id="dt-toast" role="status" aria-live="polite"></div>
  `;

  let built = false;
  let opts = {};
  const state = { open: false, top: null };
  let query = '';
  let selectedId = null;
  let editingId = null;
  let expanded = new Set();
  let confirmTimer = null;
  let confirming = false;
  let releasing = false;
  let pickMode = 'idle';
  let toastTimer = null;
  let hlTimers = [];
  let approvals = null;
  let el = {};

  const core = () => dr.marksCore;
  const tcore = () => dr.toolbarCore;
  const esc = (v) => core().escapeHtml(v);
  const $ = (id) => dr.ui.getShadowRoot().getElementById(id);

  // ------------------------------------------------------------ build

  function build() {
    if (built) return;
    built = true;
    dr.ui.addStyles(CSS, 'dt-toolbar-styles');
    dr.ui.getRoot().innerHTML = TEMPLATE;
    el = {
      tb: $('dt-tb'), rail: $('dt-rail'), grip: $('dt-grip'), pick: $('dt-pick'), marks: $('dt-marks'),
      marksCount: $('dt-marks-count'), searchBtn: $('dt-search-btn'), shot: $('dt-shot'), shotCount: $('dt-shot-count'),
      save: $('dt-save'), status: $('dt-status'), sidepanel: $('dt-sidepanel'), reddot: $('dt-reddot'),
      toggle: $('dt-toggle'), drawer: $('dt-drawer'), sub: $('dt-dr-sub'), expandAll: $('dt-expand-all'),
      library: $('dt-library'), search: $('dt-search'), searchCount: $('dt-search-count'), searchClear: $('dt-search-clear'),
      body: $('dt-dr-body'), list: $('dt-list'), empty: $('dt-empty'), clearAll: $('dt-clear-all'), send: $('dt-send'),
      hl: $('dt-hl'), toast: $('dt-toast'),
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

  function railHeight() {
    return el.rail.offsetHeight || 340;
  }

  function applyTop() {
    const top = tcore().resolveTop(state, window.innerHeight, railHeight());
    el.tb.style.top = `${top}px`;
    return top;
  }

  function applyOpen() {
    el.tb.dataset.open = String(state.open);
    el.toggle.innerHTML = state.open ? ICONS.chevronRight : ICONS.chevronLeft;
    const label = state.open ? '收起标记抽屉' : '展开标记抽屉';
    el.toggle.setAttribute('aria-label', label);
    el.toggle.dataset.tip = label;
    el.toggle.setAttribute('aria-expanded', String(state.open));
    el.marks.setAttribute('aria-expanded', String(state.open));
    el.marks.classList.toggle('is-on', state.open);
    if (!state.open) {
      hideHighlight();
      cancelEdit(false);
      resetConfirm();
      applyTop();
    }
  }

  function setOpen(open, { focusSearch = false, persist = true } = {}) {
    state.open = Boolean(open);
    applyOpen();
    if (state.open) renderList();
    if (persist) saveState();
    if (state.open && focusSearch) requestAnimationFrame(() => { el.search.focus(); el.search.select(); });
  }

  // ----------------------------------------------------------------- drag

  function wireDrag() {
    let drag = null;
    el.grip.addEventListener('pointerdown', (e) => {
      if (state.open || e.button !== 0) return;
      drag = { y: e.clientY, top: applyTop() };
      el.grip.classList.add('is-dragging');
      try { el.grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    el.grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.top = tcore().clampTop(drag.top + (e.clientY - drag.y), window.innerHeight, railHeight());
      applyTop();
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      el.grip.classList.remove('is-dragging');
      try { el.grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      saveState();
    };
    el.grip.addEventListener('pointerup', end);
    el.grip.addEventListener('pointercancel', end);
    el.grip.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      let top = null;
      if (e.key === 'ArrowUp') top = applyTop() - step;
      else if (e.key === 'ArrowDown') top = applyTop() + step;
      else if (e.key === 'Home') top = 0;
      else if (e.key === 'End') top = window.innerHeight;
      if (top == null) return;
      e.preventDefault();
      state.top = tcore().clampTop(top, window.innerHeight, railHeight());
      applyTop();
      saveState();
    });
    window.addEventListener('resize', () => { applyTop(); if (hoverId) showHighlight(hoverId); });
  }

  // --------------------------------------------------------------- toasts

  function toast(message, ms = 3200) {
    if (!built) return;
    el.toast.textContent = message;
    el.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-show'), ms);
  }

  // ------------------------------------------------------------ highlight

  let hoverId = null;
  let escHandledAt = -1;

  function resolveEl(mark) {
    const hit = dr.hitTest;
    return mark && hit ? hit.resolveSelector(mark.selector) : null;
  }

  function showHighlight(id, pulse = false) {
    const mark = dr.store.get(id);
    const target = resolveEl(mark);
    const rect = target && target.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) { el.hl.style.display = 'none'; return false; }
    const color = core().colorFor(mark.index);
    Object.assign(el.hl.style, {
      display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${Math.max(1, rect.width)}px`, height: `${Math.max(1, rect.height)}px`,
      borderColor: color, background: `${color}22`,
    });
    el.hl.classList.toggle('is-pulse', pulse);
    return true;
  }

  function hideHighlight() {
    hoverId = null;
    hlTimers.forEach(clearTimeout);
    hlTimers = [];
    el.hl.classList.remove('is-pulse');
    el.hl.style.display = 'none';
  }

  /** Flash the marked element in place (used after scrolling it into view). */
  function pulse(id) {
    if (!built) return;
    hideHighlight();
    // smooth scrolling is still moving: follow the element for a moment
    [0, 250, 500, 800].forEach((ms) => hlTimers.push(setTimeout(() => showHighlight(id, ms === 0), ms)));
    hlTimers.push(setTimeout(hideHighlight, 1300));
  }

  function locate(id) {
    const ok = dr.marksSync ? dr.marksSync.locate(id) : false;
    if (!ok) toast('页面上找不到这个元素（可能已被移除或还没渲染）');
    return ok;
  }

  // ----------------------------------------------------------------- list

  function pickSaveTarget() {
    const marks = dr.store.getAll();
    return marks.find((m) => m.id === selectedId) || marks[marks.length - 1] || null;
  }

  function markHtmlParts(mark, tokens) {
    const c = core();
    const f = c.markFields(mark);
    const ctx = mark.context || {};
    const hl = (text) => c.segmentsToHtml(c.highlightSegments(text, tokens));
    return { f, ctx, hl };
  }

  function rowHtml(mark, tokens) {
    const c = core();
    const { f, ctx, hl } = markHtmlParts(mark, tokens);
    const note = c.firstLine(f.comment);
    const meta = [f.component, f.file].filter(Boolean).join(' · ');
    const isOpen = expanded.has(mark.id);
    const color = c.colorFor(mark.index);
    const editing = editingId === mark.id;
    const matchLines = [];
    if (tokens.length) {
      // Show where a hit is when the row's own summary lines do not reveal it.
      for (const [label, value] of [['选择器', f.selector], ['文本', f.text]]) {
        if (value && c.findRanges(value, tokens).length) {
          matchLines.push(`<div class="dt-row-match"><b>${label}</b>${hl(c.excerpt(value, tokens, 70))}</div>`);
        }
      }
    }
    const noteHtml = editing
      ? `<input class="dt-note-input" data-note="${esc(mark.id)}" type="text" value="${esc(f.comment)}" aria-label="编辑备注" placeholder="备注，Enter 保存，Esc 取消">`
      : `<div class="dt-row-note${note ? '' : ' is-empty'}">${note ? hl(c.truncate(note, 140)) : '无备注'}</div>`;
    const size = ctx.boundingBox ? `${ctx.boundingBox.w}×${ctx.boundingBox.h}` : '';
    const details = [
      ['选择器', `<code>${hl(f.selector)}</code>`],
      mark.xpath ? ['XPath', `<code>${esc(mark.xpath)}</code>`] : null,
      f.text ? ['文本', hl(f.text)] : null,
      size ? ['尺寸', esc(size)] : null,
      f.component || f.file ? ['组件', hl([f.component, f.file].filter(Boolean).join(' — '))] : null,
    ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const html = ctx.outerHTML ? `<pre>${esc(c.truncate(ctx.outerHTML, 600))}</pre>` : '';
    return `
      <li class="dt-row" data-id="${esc(mark.id)}" data-expanded="${isOpen}">
        <div class="dt-row-main" role="button" tabindex="0" aria-label="定位标记 ${esc(mark.index)}：${esc(f.desc)}">
          <span class="dt-badge" style="background:${color}">${esc(mark.index)}</span>
          <div class="dt-row-text">
            <div class="dt-row-desc" title="${esc(f.selector)}">${hl(c.truncate(f.desc, 60))}${mark.sent ? '<span class="dt-sent">已发送</span>' : ''}</div>
            ${noteHtml}
            ${meta ? `<div class="dt-row-meta">${hl(c.truncate(meta, 90))}</div>` : ''}
            ${matchLines.join('')}
          </div>
        </div>
        <div class="dt-row-actions">
          <button class="dt-ib" type="button" data-act="expand" aria-label="${isOpen ? '收起详情' : '展开详情'}" aria-expanded="${isOpen}" title="${isOpen ? '收起详情' : '展开详情'}">${ICONS.expand}</button>
          <button class="dt-ib" type="button" data-act="edit" aria-label="编辑备注" title="编辑备注">${ICONS.edit}</button>
          <button class="dt-ib" type="button" data-act="save" aria-label="存入元素库" title="存入元素库">${ICONS.save}</button>
          <button class="dt-ib is-danger" type="button" data-act="delete" aria-label="删除标记" title="删除标记">${ICONS.trash}</button>
        </div>
        <div class="dt-detail"><dl>${details}</dl>${html}</div>
      </li>`;
  }

  function renderList() {
    if (!built) return;
    const c = core();
    const marks = dr.store.getAll();
    const { tokens, hits } = c.searchMarks(marks, query);
    const filtering = tokens.length > 0;

    el.sub.textContent = marks.length ? `${marks.length} 个` : '0 个';
    el.searchClear.hidden = !query;
    el.searchCount.textContent = filtering ? `${hits.length}/${marks.length}` : (marks.length ? `${marks.length}` : '');
    el.clearAll.disabled = marks.length === 0;
    const allOpen = hits.length > 0 && hits.every((h) => expanded.has(h.mark.id));
    el.expandAll.innerHTML = allOpen ? ICONS.collapseAll : ICONS.expandAll;
    el.expandAll.setAttribute('aria-label', allOpen ? '全部收起' : '全部展开');
    el.expandAll.title = allOpen ? '全部收起' : '全部展开';
    el.expandAll.hidden = marks.length === 0;

    if (!marks.length) {
      el.list.innerHTML = '';
      el.empty.hidden = false;
      el.empty.innerHTML = '<strong>还没有标记</strong>点击“选取”，在页面上点选元素；标记会显示在这里和侧边栏里。';
    } else if (!hits.length) {
      el.list.innerHTML = '';
      el.empty.hidden = false;
      el.empty.innerHTML = `<strong>没有匹配的标记</strong>没有找到包含“${esc(query.trim())}”的标记。<br><button class="dt-fbtn" type="button" data-act="clear-search">清除搜索</button>`;
    } else {
      el.empty.hidden = true;
      el.list.innerHTML = hits.map((h) => rowHtml(h.mark, tokens)).join('');
    }

    if (editingId) {
      const input = el.list.querySelector('.dt-note-input');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } else {
        editingId = null;
      }
    }
  }

  function refreshRail() {
    if (!built) return;
    const total = dr.store.getAll().length;
    el.marksCount.hidden = total === 0;
    el.marksCount.textContent = total > 99 ? '99+' : String(total);
    const label = total ? `标记列表（${total} 个）` : '标记列表';
    el.marks.dataset.tip = label;
    el.marks.setAttribute('aria-label', label);

    const shots = dr.marksSync ? dr.marksSync.screenshots.list().length : 0;
    el.shotCount.hidden = shots === 0;
    el.shotCount.textContent = String(shots);
    const shotTip = shots ? `截取可见区域（已附 ${shots} 张，发送时一起带上）` : '截取可见区域，加入待发送附件';
    el.shot.dataset.tip = shotTip;
    el.shot.setAttribute('aria-label', shots ? `截取可见区域，已附 ${shots} 张` : '截取可见区域');

    const target = pickSaveTarget();
    const can = Boolean(target);
    el.save.setAttribute('aria-disabled', String(!can));
    el.save.dataset.tip = can ? `把标记 ${target.index}（${core().describeMark(target).desc}）存入元素库` : '先点选一个元素，才能存入元素库';
    el.save.setAttribute('aria-label', can ? `存入元素库：标记 ${target.index}` : '存入元素库（需要先标记一个元素）');
  }

  function onStoreChange(_reviews, change) {
    if (change && change.type === 'add' && change.ids[0]) selectedId = change.ids[0];
    if (selectedId && !dr.store.get(selectedId)) selectedId = null;
    const ids = new Set(dr.store.getAll().map((m) => m.id));
    expanded = new Set([...expanded].filter((id) => ids.has(id)));
    if (editingId && !ids.has(editingId)) editingId = null;
    if (hoverId && !ids.has(hoverId)) hideHighlight();
    refreshRail();
    if (state.open) renderList();
  }

  // ------------------------------------------------------- row interactions

  function startEdit(id) {
    editingId = id;
    renderList();
  }

  function cancelEdit(render = true) {
    if (!editingId) return;
    editingId = null;
    if (render) renderList();
  }

  function commitEdit(input) {
    const id = editingId;
    if (!id) return;
    editingId = null;
    const mark = dr.store.get(id);
    const value = input.value.trim();
    if (mark && (mark.comment || '') !== value) dr.store.update(id, { comment: value });
    else renderList();
  }

  function rowId(target) {
    return target.closest('.dt-row')?.dataset.id || null;
  }

  function onListClick(e) {
    const act = e.target.closest('[data-act]');
    if (!act) {
      const main = e.target.closest('.dt-row-main');
      if (main && !e.target.closest('.dt-note-input')) {
        const id = rowId(main);
        if (id) { selectedId = id; refreshRail(); locate(id); }
      }
      return;
    }
    const id = rowId(act);
    const mark = id && dr.store.get(id);
    switch (act.dataset.act) {
      case 'expand':
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        renderList();
        break;
      case 'edit':
        if (mark) startEdit(id);
        break;
      case 'save':
        if (mark) saveToLibrary(mark);
        break;
      case 'delete':
        if (mark) { hideHighlight(); dr.store.remove(id); }
        break;
      default:
        break;
    }
  }

  function saveToLibrary(mark) {
    if (!mark) { toast('先点选一个元素，才能存入元素库'); return; }
    if (!dr.elementSaver) { toast('元素库模块未加载，请刷新页面'); return; }
    selectedId = mark.id;
    dr.elementSaver.openCardFromReview(mark, { name: core().describeMark(mark).desc });
  }

  function wireList() {
    el.list.addEventListener('click', onListClick);
    el.empty.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="clear-search"]')) clearSearch(true);
    });
    el.list.addEventListener('keydown', (e) => {
      if (e.target.matches('.dt-note-input')) {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); commitEdit(e.target); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
        return;
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.dt-row-main')) {
        e.preventDefault();
        const id = rowId(e.target);
        if (id) { selectedId = id; refreshRail(); locate(id); }
      }
    });
    el.list.addEventListener('focusout', (e) => {
      if (e.target.matches?.('.dt-note-input') && editingId) commitEdit(e.target);
    });
    el.list.addEventListener('mouseover', (e) => {
      const id = rowId(e.target);
      if (id && id !== hoverId) { hoverId = id; showHighlight(id); }
    });
    el.list.addEventListener('mouseleave', hideHighlight);
    el.list.addEventListener('focusin', (e) => {
      const id = rowId(e.target);
      if (id) { hoverId = id; showHighlight(id); }
    });
    el.list.addEventListener('focusout', (e) => {
      if (!e.relatedTarget || !el.list.contains(e.relatedTarget)) hideHighlight();
    });
  }

  // --------------------------------------------------------------- search

  function clearSearch(focus) {
    query = '';
    el.search.value = '';
    renderList();
    if (focus) el.search.focus();
  }

  function wireSearch() {
    el.search.addEventListener('input', () => {
      query = el.search.value;
      renderList();
    });
    el.searchClear.addEventListener('click', () => clearSearch(true));
    el.expandAll.addEventListener('click', () => {
      const { hits } = core().searchMarks(dr.store.getAll(), query);
      const allOpen = hits.length > 0 && hits.every((h) => expanded.has(h.mark.id));
      if (allOpen) hits.forEach((h) => expanded.delete(h.mark.id));
      else hits.forEach((h) => expanded.add(h.mark.id));
      renderList();
    });
    el.library.addEventListener('click', () => {
      if (dr.elementSaver?.showLibraryCard) dr.elementSaver.showLibraryCard();
      else toast('元素库模块未加载，请刷新页面');
    });
  }

  // ---------------------------------------------------------- footer actions

  function resetConfirm() {
    confirming = false;
    clearTimeout(confirmTimer);
    if (!built) return;
    el.clearAll.textContent = '清空全部标记';
    el.clearAll.classList.remove('is-confirm');
  }

  function onClearAll() {
    const total = dr.store.getAll().length;
    if (!total) return;
    if (!confirming) {
      confirming = true;
      el.clearAll.textContent = `再点一次，清空 ${total} 个`;
      el.clearAll.classList.add('is-confirm');
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(resetConfirm, 3500);
      return;
    }
    resetConfirm();
    hideHighlight();
    if (dr.sidebar?.discardBatch) dr.sidebar.discardBatch(); else dr.store.clear();
    toast(`已清空 ${total} 个标记`);
  }

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

  function refreshStatus() {
    if (!built) return;
    const m = takeoverState();
    el.status.dataset.tone = m.tone;
    el.status.dataset.tip = `${m.label}\n${m.tip}`;
    el.status.setAttribute('aria-label', `接管状态：${m.label}`);
    el.status.dataset.state = m.key;
  }

  function refreshApprovals() {
    if (!built) return;
    const n = approvals ? approvals.count() : 0;
    el.reddot.hidden = n === 0;
    el.sidepanel.dataset.tip = n ? '有待审批的操作，点击打开侧边栏处理' : '打开侧边栏';
    el.sidepanel.setAttribute('aria-label', n ? `打开侧边栏（${n} 个待审批操作）` : '打开侧边栏');
    el.sidepanel.dataset.pending = String(n);
  }

  async function onStatusClick() {
    const ws = dr.wsClient;
    const m = takeoverState();
    if (!ws) { toast('Hub 客户端未加载，请刷新页面'); return; }
    if (m.action === 'reconnect') {
      ws.reconnectNow();
      toast(m.tip.split('\n')[0]);
    } else if (m.action === 'activate') {
      const res = await ws.activate();
      if (!res || res.ok === false) toast(res?.error || '连接当前页失败，请确认 Hub 正在运行');
      refreshStatus();
    } else if (m.action === 'release') {
      // The bridge has no explicit release call: dropping this tab's event stream makes it
      // release the tab after its grace period, then we reconnect (as "未接管").
      releasing = true;
      refreshStatus();
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
    const tip = pickMode === 'selecting' ? '正在选取：点击页面元素，Esc 或再点一次退出'
      : pickMode === 'describing' ? '正在填写标记说明，点击保存并退出选取'
        : '选取页面元素（Esc 退出）';
    el.pick.dataset.tip = tip;
    el.pick.setAttribute('aria-label', pickMode === 'idle' ? '选取页面元素' : '退出选取');
  }

  // ------------------------------------------------------------- keyboard

  function isEditable(node) {
    if (!(node instanceof Element)) return false;
    return node.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  function closeOnEscape() {
    if (editingId) { cancelEdit(); return true; }
    if (query) { clearSearch(false); return true; }
    if (state.open) { setOpen(false); dr.ui.restorePageFocus?.(); return true; }
    return false;
  }

  function onDocKeydown(e) {
    const path = e.composedPath ? e.composedPath() : [];
    const inside = path.includes(dr.ui.getHost());

    if (e.key === 'Escape') {
      const sel = dr.selector;
      if (sel && sel.isActive() && !sel.isPaused()) {
        escHandledAt = e.timeStamp;
        sel.disable();
        setPickMode('idle');
        return;
      }
      if (inside) return; // handled by the shadow-root listener below
      const active = document.activeElement;
      const pageBusy = active && active !== document.body && active !== document.documentElement;
      if (state.open && !pageBusy) closeOnEscape();
      return;
    }

    if (e.key === '/' && state.open && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const origin = path[0];
      if (isEditable(origin)) return;
      e.preventDefault();
      e.stopPropagation();
      el.search.focus();
      el.search.select();
    }
  }

  function wireKeyboard() {
    document.addEventListener('keydown', onDocKeydown, true);
    dr.ui.getShadowRoot().addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.timeStamp === escHandledAt) return; // pick mode already took this Esc
      if (closeOnEscape()) e.stopPropagation();
    });
  }

  // ------------------------------------------------------------------ init

  function wireRail() {
    el.pick.addEventListener('click', () => opts.onPick?.());
    el.marks.addEventListener('click', () => setOpen(!state.open));
    el.toggle.addEventListener('click', () => setOpen(!state.open));
    el.searchBtn.addEventListener('click', () => {
      if (state.open) { el.search.focus(); el.search.select(); } else setOpen(true, { focusSearch: true });
    });
    el.shot.addEventListener('click', () => {
      if (dr.screenshot) dr.screenshot.capture();
      else toast('截图模块未加载，请刷新页面');
    });
    el.save.addEventListener('click', () => {
      if (el.save.getAttribute('aria-disabled') === 'true') {
        toast('先点选一个元素，才能存入元素库');
        return;
      }
      saveToLibrary(pickSaveTarget());
    });
    el.status.addEventListener('click', onStatusClick);
    el.sidepanel.addEventListener('click', () => openSidePanel());
    el.clearAll.addEventListener('click', onClearAll);
    el.send.addEventListener('click', () => openSidePanel({ focusInput: true }));
  }

  function init(options = {}) {
    if (built) return;
    opts = options;
    build();
    wireRail();
    wireDrag();
    wireList();
    wireSearch();
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

    dr.store.onChange(onStoreChange);
    dr.marksSync?.onChange(refreshRail);
    setPickMode(pickMode);
    refreshStatus();
    refreshApprovals();
    refreshRail();
    renderList();

    const reveal = () => {
      applyOpen();
      if (state.open) renderList();
      applyTop();
      el.tb.classList.add('is-ready');
    };
    let revealed = false;
    const once = (loaded) => {
      if (revealed) return;
      revealed = true;
      state.open = loaded.open;
      state.top = loaded.top;
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
    open: (focusSearch) => setOpen(true, { focusSearch: Boolean(focusSearch) }),
    close: () => setOpen(false),
    isOpen: () => state.open,
    refresh() { refreshRail(); refreshStatus(); refreshApprovals(); if (state.open) renderList(); },
  };
})();
