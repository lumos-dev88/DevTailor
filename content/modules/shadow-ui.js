/**
 * DevTailor — Shadow UI 模块
 *
 * 创建 Shadow DOM 宿主，可拖拽悬浮卡片。
 * 布局：工具栏 + 状态栏 + 标记列表 + 聊天面板。
 *
 * 注册：window.__domReview.ui
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const DEFAULT_PANEL_WIDTH = 480;
  const DEFAULT_PANEL_HEIGHT = 640;
  const POSITION_KEY = 'dom-review-panel-position';
  const SIZE_KEY = 'dr_panel_size';
  const DEFAULT_POSITION = { x: 24, y: 88 };

  // --- Shadow DOM 宿主（悬浮覆盖层，不影响页面布局）---
  const host = document.createElement('div');
  host.id = 'dom-review-host';
  host.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    top: ${DEFAULT_POSITION.y}px;
    left: ${DEFAULT_POSITION.x}px;
    width: min(${DEFAULT_PANEL_WIDTH}px, calc(100vw - 24px));
    height: min(${DEFAULT_PANEL_HEIGHT}px, calc(100vh - 32px));
    pointer-events: none;
    display: block;
  `;
  const shadow = host.attachShadow({ mode: 'closed' });

  const UI_BOUNDARY_EVENTS = [
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'touchstart',
    'touchend',
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'compositionstart',
    'compositionend',
  ];
  const UI_TEXT_FOCUS_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[data-dt-allow-focus="true"]',
  ].join(',');
  const UI_NON_TEXT_FOCUS_SELECTOR = [
    'button',
    'a[href]',
    'summary',
    '[role="button"]',
    '[tabindex]',
  ].join(',');
  let lastPageFocusEl = null;

  function isPageFocusableElement(el) {
    return Boolean(
      el &&
      el instanceof Element &&
      el !== host &&
      el !== document.body &&
      el !== document.documentElement &&
      document.contains(el)
    );
  }

  function rememberPageFocus() {
    const active = document.activeElement;
    if (isPageFocusableElement(active)) {
      lastPageFocusEl = active;
    }
  }

  function shouldAllowUiFocus(target) {
    return Boolean(target?.closest?.(UI_TEXT_FOCUS_SELECTOR));
  }

  function shouldSuppressUiFocus(target) {
    return Boolean(target?.closest?.(UI_NON_TEXT_FOCUS_SELECTOR)) && !shouldAllowUiFocus(target);
  }

  function installEventBoundary() {
    UI_BOUNDARY_EVENTS.forEach((type) => {
      host.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    });

    document.addEventListener('focusin', (event) => {
      if (isPageFocusableElement(event.target)) {
        lastPageFocusEl = event.target;
      }
    }, true);

    const suppressNonTextFocus = (event) => {
      rememberPageFocus();
      if (shouldSuppressUiFocus(event.target)) {
        event.preventDefault();
      }
    };
    shadow.addEventListener('pointerdown', suppressNonTextFocus, { capture: true });
    shadow.addEventListener('mousedown', suppressNonTextFocus, { capture: true });
  }

  installEventBoundary();

  // --- 内联样式 ---
  const style = document.createElement('style');
  style.textContent = `
    /* === Design Tokens === */
    :host {
      --dt-bg-primary: #1e293b;
      --dt-bg-secondary: #334155;
      --dt-bg-hover: #475569;
      --dt-bg-tertiary: #0f172a;
      --dt-text-primary: #f8fafc;
      --dt-text-secondary: #94a3b8;
      --dt-text-muted: #64748b;
      --dt-accent: #3b82f6;
      --dt-accent-hover: #2563eb;
      --dt-danger: #ef4444;
      --dt-warning: #f59e0b;
      --dt-success: #22c55e;
      --dt-radius: 8px;
      --dt-radius-sm: 6px;
      --dt-shadow: 0 4px 16px rgba(0,0,0,0.4);
      --dt-font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --dt-font-mono: 'SF Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
      --dt-font-size: 13px;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    /* === Sidebar Root === */
    .dt-sidebar {
      width: 100%;
      height: 100%;
      background: var(--dt-bg-primary);
      color: var(--dt-text-primary);
      font-family: var(--dt-font);
      font-size: var(--dt-font-size);
      box-shadow: var(--dt-shadow);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      overflow: hidden;
    }

    /* === Toolbar === */
    .dt-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      background: var(--dt-bg-tertiary);
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .dt-toolbar.is-dragging { cursor: grabbing; }

    .dt-toolbar-title {
      font-weight: 600;
      font-size: 12px;
      color: var(--dt-text-secondary);
      margin-right: auto;
      letter-spacing: 0.3px;
    }

    /* === Buttons === */
    .dt-btn {
      background: var(--dt-bg-secondary);
      color: var(--dt-text-primary);
      border: 1px solid rgba(255,255,255,0.06);
      padding: 5px 10px;
      border-radius: var(--dt-radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--dt-font);
      font-weight: 500;
      transition: background 0.15s, border-color 0.15s, opacity 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      line-height: 1.4;
    }
    .dt-btn:hover { background: var(--dt-bg-hover); border-color: rgba(255,255,255,0.12); }
    .dt-btn:active { transform: scale(0.97); }
    .dt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .dt-btn--primary { background: var(--dt-accent); border-color: var(--dt-accent); }
    .dt-btn--primary:hover { background: var(--dt-accent-hover); }
    .dt-btn--danger { background: var(--dt-danger); border-color: var(--dt-danger); color: white; }
    .dt-btn--danger:hover { background: #dc2626; }
    .dt-btn--small { padding: 3px 8px; font-size: 11px; }
    .dt-btn--icon { padding: 3px 6px; font-size: 14px; line-height: 1; background: transparent; border: none; }
    .dt-btn--icon:hover { background: var(--dt-bg-hover); }

    .dt-active {
      background: var(--dt-accent) !important;
      color: white !important;
      border-color: var(--dt-accent) !important;
      font-weight: 600;
    }
    .dt-describing {
      background: var(--dt-warning) !important;
      color: #111827 !important;
      border-color: var(--dt-warning) !important;
      font-weight: 700;
    }

    /* === Status Bar === */
    .dt-status-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      flex-shrink: 0;
      font-size: 11px;
      color: var(--dt-text-secondary);
      cursor: pointer;
      user-select: none;
    }
    .dt-status-bar:hover { background: rgba(255,255,255,0.025); }

    .dt-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dt-status-dot--export { background: var(--dt-warning); }
    .dt-status-dot--disconnected { background: var(--dt-danger); }
    .dt-status-dot--connecting { background: var(--dt-warning); }
    .dt-status-dot--connected { background: var(--dt-success); }

    .dt-status-text { flex: 1; }

    .dt-session-wrap {
      position: relative;
      margin-left: auto;
      flex-shrink: 0;
    }

    .dt-session-btn {
      width: 28px;
      height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .dt-session-btn svg {
      width: 15px;
      height: 15px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.9;
    }

    .dt-session-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      width: 260px;
      max-height: 320px;
      overflow: auto;
      padding: 6px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.98);
      box-shadow: 0 18px 48px rgba(0,0,0,0.35);
      z-index: 2147483647;
    }

    .dt-session-item {
      width: 100%;
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 3px 5px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--dt-text-primary);
      text-align: left;
      cursor: pointer;
      font-family: var(--dt-font);
      overflow: hidden;
    }
    .dt-session-item:hover { background: rgba(255,255,255,0.06); }
    .dt-session-item.is-active { background: rgba(59,130,246,0.18); }
    .dt-session-item__title {
      font-size: 12px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1 1 auto;
      min-width: 0;
    }
    .dt-session-item__meta {
      font-size: 10px;
      color: var(--dt-text-muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .dt-session-item__delete {
      color: var(--dt-text-muted);
      font-size: 10px;
      padding: 2px 4px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .dt-session-item__delete:hover {
      color: #fecaca;
      background: rgba(239, 68, 68, 0.18);
    }
    .dt-session-empty {
      padding: 10px;
      color: var(--dt-text-muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .dt-status-toggle {
      background: none;
      border: none;
      color: var(--dt-text-muted);
      font-size: 11px;
      cursor: pointer;
      font-family: var(--dt-font);
      padding: 2px 4px;
      border-radius: 4px;
    }
    .dt-status-toggle:hover { color: var(--dt-text-primary); background: rgba(255,255,255,0.04); }

    /* === Context Queue === */
    .dt-context-panel {
      flex: 0 0 auto;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: linear-gradient(180deg, rgba(255,255,255,0.025), transparent);
    }

    .dt-context-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      flex-shrink: 0;
    }

    .dt-context-summary {
      color: var(--dt-text-muted);
      font-size: 11px;
      margin-left: 0;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* === Batch Bar === */
    .dt-batch-bar {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      background: rgba(15, 23, 42, 0.94);
      flex-shrink: 0;
    }
    .dt-batch-bar.is-visible { display: flex; }
    .dt-batch-count {
      min-width: 28px;
      height: 28px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--dt-accent);
      color: white;
      font-size: 13px;
      font-weight: 700;
    }
    .dt-batch-label {
      color: var(--dt-text-secondary);
      font-size: 11px;
      margin-right: auto;
      white-space: nowrap;
    }
    .dt-batch-action {
      height: 28px;
      padding: 0 9px;
    }

    /* === Chat Panel === */
    .dt-chat-panel {
      flex: 1 1 58%;
      min-height: 220px;
      display: flex;
      flex-direction: column;
      background: var(--dt-bg-tertiary);
      min-height: 0;
      position: relative;
    }

    .dt-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .dt-chat-jump {
      position: absolute;
      right: 14px;
      bottom: 58px;
      z-index: 4;
      height: 28px;
      padding: 0 11px;
      border: 1px solid rgba(96, 165, 250, 0.35);
      border-radius: 999px;
      background: rgba(30, 64, 175, 0.9);
      color: #dbeafe;
      font-size: 11px;
      font-weight: 600;
      box-shadow: 0 8px 22px rgba(0,0,0,0.28);
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px);
      transition: opacity 140ms ease, transform 140ms ease;
    }
    .dt-chat-jump.is-visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .dt-activation-banner {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 58px;
      z-index: 5;
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 10px;
      border: 1px solid rgba(96,165,250,0.35);
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.94);
      color: var(--dt-text-primary);
      box-shadow: 0 10px 28px rgba(0,0,0,0.32);
    }
    .dt-activation-banner.is-visible { display: flex; }
    .dt-activation-text {
      min-width: 0;
      color: var(--dt-text-secondary);
      font-size: 11px;
      line-height: 1.35;
    }
    .dt-activation-text strong {
      display: block;
      color: var(--dt-text-primary);
      font-size: 12px;
      margin-bottom: 1px;
    }
    .dt-activation-btn {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .dt-chat-empty {
      margin: auto;
      max-width: 280px;
      color: #64748b;
      font-size: 12.5px;
      line-height: 1.6;
      text-align: center;
      padding: 20px;
    }

    /* === Chat Message === */
    .dt-chat-msg {
      max-width: 94%;
      font-size: 13px;
      line-height: 1.65;
      word-break: break-word;
      color: var(--dt-text-primary);
    }
    .dt-chat-md p {
      margin: 0 0 10px;
    }
    .dt-chat-md p:last-child {
      margin-bottom: 0;
    }
    .dt-chat-md strong {
      font-weight: 600;
      color: #e2e8f0;
    }
    .dt-chat-md h1,
    .dt-chat-md h2,
    .dt-chat-md h3,
    .dt-chat-md h4,
    .dt-chat-md h5,
    .dt-chat-md h6 {
      margin: 14px 0 8px;
      font-size: 14px;
      line-height: 1.4;
      font-weight: 600;
      color: #f1f5f9;
    }
    .dt-chat-md h1:first-child,
    .dt-chat-md h2:first-child,
    .dt-chat-md h3:first-child,
    .dt-chat-md h4:first-child,
    .dt-chat-md h5:first-child,
    .dt-chat-md h6:first-child {
      margin-top: 0;
    }
    .dt-chat-md ul {
      margin: 6px 0 10px;
      padding-left: 20px;
    }
    .dt-chat-md ol {
      margin: 6px 0 10px;
      padding-left: 20px;
    }
    .dt-chat-md li {
      margin: 3px 0;
      line-height: 1.6;
    }
    .dt-chat-md blockquote {
      margin: 10px 0;
      padding: 8px 0 8px 12px;
      border-left: 3px solid rgba(59,130,246,0.5);
      color: var(--dt-text-secondary);
      font-style: italic;
    }
    .dt-chat-md code {
      font-family: var(--dt-font-mono);
      font-size: 11.5px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(100, 116, 139, 0.25);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.15);
    }
    .dt-chat-md pre {
      margin: 10px 0;
      padding: 10px 12px;
      overflow-x: auto;
      border-radius: var(--dt-radius-sm);
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
    .dt-chat-md pre code {
      padding: 0;
      background: transparent;
      border: none;
      white-space: pre;
      color: #e2e8f0;
    }
    .dt-chat-md a {
      color: #60a5fa;
      text-decoration: none;
      border-bottom: 1px solid rgba(96, 165, 250, 0.3);
      transition: border-color 0.15s, color 0.15s;
    }
    .dt-chat-md a:hover {
      color: #93c5fd;
      border-bottom-color: rgba(147, 197, 253, 0.6);
    }
    .dt-chat-md table {
      width: 100%;
      margin: 10px 0;
      border-collapse: collapse;
      font-size: 12px;
    }
    .dt-chat-md th,
    .dt-chat-md td {
      padding: 6px 8px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      text-align: left;
    }
    .dt-chat-md th {
      background: rgba(51, 65, 85, 0.4);
      font-weight: 600;
      color: var(--dt-text-primary);
    }
    .dt-chat-md img {
      max-width: 100%;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148, 163, 184, 0.25);
    }
    .dt-chat-msg--user {
      align-self: flex-end;
      width: fit-content;
      max-width: min(75%, 320px);
      padding: 9px 12px;
      border-radius: 12px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
      border-bottom-right-radius: 3px;
      box-shadow: 0 2px 8px rgba(59, 130, 246, 0.25);
    }
    .dt-chat-msg--user > div {
      max-width: 280px;
      line-height: 1.5;
    }
    .dt-chat-attachment {
      display: block;
      width: 180px;
      max-width: 100%;
      max-height: 120px;
      object-fit: contain;
      margin-top: 8px;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.95);
      cursor: zoom-in;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .dt-chat-attachment:hover {
      transform: scale(1.02);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .dt-chat-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .dt-chat-attachments .dt-chat-attachment {
      margin-top: 0;
      width: 140px;
      max-height: 100px;
    }

    /* === Legacy tool msg (kept for backward compat) === */
    .dt-tool-msg {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      max-width: 88%;
      gap: 7px;
      padding: 6px 9px;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148,163,184,0.18);
      background: rgba(30,41,59,0.62);
      color: var(--dt-text-secondary);
      font-size: 11px;
      line-height: 1.3;
    }
    .dt-tool-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      background: rgba(59,130,246,0.18);
      color: #93c5fd;
      font-size: 12px;
      flex: 0 0 auto;
    }
    .dt-tool-icon svg {
      width: 11px;
      height: 11px;
      display: block;
    }
    .dt-tool-title {
      color: var(--dt-text-primary);
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dt-tool-status {
      color: var(--dt-text-muted);
      white-space: nowrap;
    }
    .dt-tool-msg--completed .dt-tool-icon {
      background: rgba(34,197,94,0.16);
      color: #86efac;
    }
    .dt-tool-msg--failed .dt-tool-icon,
    .dt-tool-msg--canceled .dt-tool-icon {
      background: rgba(239,68,68,0.16);
      color: #fca5a5;
    }

    /* === Thinking Block === */
    .dt-thinking-block {
      align-self: flex-start;
      max-width: 94%;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148,163,184,0.18);
      background: linear-gradient(135deg, rgba(15,23,42,0.5), rgba(30,41,59,0.4));
      backdrop-filter: blur(8px);
      transition: background 0.2s, border-color 0.2s;
    }
    .dt-thinking-block.open {
      background: linear-gradient(135deg, rgba(15,23,42,0.75), rgba(30,41,59,0.6));
      border-color: rgba(148,163,184,0.25);
    }
    .dt-thinking-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      background: transparent;
      border: none;
      color: var(--dt-text-secondary);
      font-size: 11px;
      cursor: pointer;
      text-align: left;
      transition: color 0.15s;
    }
    .dt-thinking-toggle:hover {
      color: var(--dt-text-primary);
    }
    .dt-thinking-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .dt-thinking-icon svg {
      display: block;
    }
    .dt-thinking-label {
      font-weight: 600;
      color: var(--dt-text-primary);
      flex: 0 0 auto;
      font-size: 11.5px;
    }
    .dt-thinking-preview {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--dt-text-muted);
      margin-left: 2px;
      font-size: 11px;
    }
    .dt-thinking-chev {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--dt-text-muted);
      line-height: 1;
    }
    .dt-thinking-chev svg {
      display: block;
      margin: 0;
    }
    .dt-thinking-body {
      padding: 9px 11px 11px;
      margin: 0;
      font-family: var(--dt-font-mono);
      font-size: 11px;
      line-height: 1.55;
      color: #94a3b8;
      white-space: pre-wrap;
      overflow-x: auto;
      border-top: 1px solid rgba(148,163,184,0.12);
      background: rgba(0,0,0,0.15);
    }

    /* === Tool Card === */
    .dt-tool-card {
      align-self: flex-start;
      max-width: 96%;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148,163,184,0.18);
      background: linear-gradient(135deg, rgba(15,23,42,0.45), rgba(30,41,59,0.35));
      font-size: 11px;
      line-height: 1.4;
      transition: border-color 0.2s, background 0.2s;
    }
    .dt-tool-card:hover {
      border-color: rgba(148,163,184,0.28);
    }
    .dt-tool-card-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 9px;
    }
    .dt-tool-card-icon {
      width: 17px;
      height: 17px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      background: rgba(59,130,246,0.18);
      color: #93c5fd;
      font-size: 11px;
      flex: 0 0 auto;
    }
    .dt-tool-card-icon svg {
      width: 12px;
      height: 12px;
      display: block;
    }
    .dt-tool-card-title {
      font-weight: 600;
      color: var(--dt-text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 11.5px;
    }
    .dt-tool-card-path {
      font-family: var(--dt-font-mono);
      font-size: 10px;
      color: #64748b;
      background: rgba(100, 116, 139, 0.2);
      padding: 2px 5px;
      border-radius: 3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 150px;
      border: 1px solid rgba(148, 163, 184, 0.15);
    }
    .dt-tool-card-meta {
      color: var(--dt-text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 130px;
      font-size: 10.5px;
    }
    .dt-tool-card-status {
      margin-left: auto;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .dt-tool-card-status.dt-tool-status-ok {
      background: rgba(34,197,94,0.18);
      color: #86efac;
    }
    .dt-tool-card-status.dt-tool-status-error {
      background: rgba(239,68,68,0.18);
      color: #fca5a5;
    }
    .dt-tool-card-status.dt-tool-status-running {
      background: rgba(59,130,246,0.18);
      color: #93c5fd;
    }
    .dt-tool-card-status.dt-tool-status-pending {
      background: rgba(148,163,184,0.12);
      color: var(--dt-text-muted);
    }
    .dt-tool-card-toggle {
      margin-left: 5px;
      width: 22px;
      height: 22px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      font-size: 11px;
      line-height: 1;
      color: var(--dt-text-secondary);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .dt-tool-card-toggle:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.15);
    }
    .dt-tool-card--browser {
      border-color: rgba(45,212,191,0.22);
      background: linear-gradient(135deg, rgba(8,47,73,0.35), rgba(15,58,80,0.25));
    }
    .dt-tool-card--browser .dt-tool-card-icon {
      background: rgba(45,212,191,0.2);
      color: #5eead4;
    }
    .dt-tool-card--browser .dt-tool-card-icon svg {
      stroke: #5eead4;
    }
    .dt-tool-card--browser .dt-tool-card-title {
      color: #ccfbf1;
    }
    .dt-tool-output {
      padding: 7px 9px 9px;
      margin: 0;
      font-family: var(--dt-font-mono);
      font-size: 10.5px;
      line-height: 1.5;
      color: #94a3b8;
      white-space: pre-wrap;
      overflow-x: auto;
      border-top: 1px solid rgba(148,163,184,0.12);
      max-height: 240px;
      overflow-y: auto;
      background: rgba(0,0,0,0.15);
    }

    /* === Tool Group === */
    .dt-tool-group {
      align-self: flex-start;
      max-width: 96%;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148,163,184,0.18);
      background: linear-gradient(135deg, rgba(15,23,42,0.45), rgba(30,41,59,0.35));
      font-size: 11px;
      transition: border-color 0.2s;
    }
    .dt-tool-group:hover {
      border-color: rgba(148,163,184,0.28);
    }
    .dt-tool-group-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 9px;
      background: transparent;
      border: none;
      color: var(--dt-text-secondary);
      font-size: 11px;
      cursor: pointer;
      text-align: left;
      transition: color 0.15s;
    }
    .dt-tool-group-toggle:hover {
      color: var(--dt-text-primary);
    }
    .dt-tool-group-toggle.running .dt-tool-group-summary strong {
      color: #93c5fd;
    }
    .dt-tool-group-icon {
      width: 17px;
      height: 17px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      background: rgba(59,130,246,0.18);
      color: #93c5fd;
      font-size: 11px;
      flex: 0 0 auto;
    }
    .dt-tool-group-icon svg {
      width: 12px;
      height: 12px;
      display: block;
    }
    .dt-tool-group-summary {
      flex: 1;
      color: var(--dt-text-secondary);
      font-size: 11.5px;
    }
    .dt-tool-group-summary strong {
      color: var(--dt-text-primary);
      font-weight: 600;
    }
    .dt-tool-group-chev {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--dt-text-muted);
      line-height: 1;
    }
    .dt-tool-group-chev svg {
      display: block;
      margin: 0;
    }
    .dt-tool-group-body {
      padding: 0 9px 9px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .dt-tool-group:has(.dt-tool-card--browser),
    .dt-tool-group[data-tool-family="browser"] {
      border-color: rgba(45,212,191,0.22);
      background: linear-gradient(135deg, rgba(8,47,73,0.3), rgba(15,58,80,0.2));
    }

    /* === Waiting Pill === */
    .dt-waiting-pill {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 7px 11px;
      border-radius: var(--dt-radius-sm);
      border: 1px solid rgba(148,163,184,0.18);
      background: linear-gradient(135deg, rgba(15,23,42,0.5), rgba(30,41,59,0.4));
      color: var(--dt-text-secondary);
      font-size: 12px;
      backdrop-filter: blur(4px);
    }
    .dt-waiting-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: linear-gradient(135deg, #60a5fa, #3b82f6);
      animation: dt-pulse 1.4s ease-in-out infinite;
      flex-shrink: 0;
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
    }
    @keyframes dt-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }

    /* === Assistant Footer === */
    .dt-assistant-footer {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(148,163,184,0.12);
      font-size: 10.5px;
      color: var(--dt-text-muted);
    }
    .dt-assistant-footer-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--dt-success);
      flex-shrink: 0;
      box-shadow: 0 0 6px rgba(34, 197, 94, 0.4);
    }
    .dt-assistant-footer-dot[data-active="true"] {
      background: var(--dt-accent);
      animation: dt-pulse 1.4s ease-in-out infinite;
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.5);
    }
    .dt-assistant-footer-label {
      font-weight: 500;
    }

    /* === Legacy loading spinner (kept for fallback) === */
    .dt-chat-loading {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      color: var(--dt-text-secondary);
      font-size: 12px;
    }
    .dt-loading-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.1);
      border-top-color: var(--dt-accent);
      border-radius: 50%;
      animation: dt-spin 0.8s linear infinite;
    }
    @keyframes dt-spin {
      to { transform: rotate(360deg); }
    }

    /* === Prompt Card === */
    .dt-prompt-card {
      background: linear-gradient(135deg, rgba(51, 65, 85, 0.5), rgba(30, 41, 59, 0.4));
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: var(--dt-radius);
      overflow: hidden;
      backdrop-filter: blur(4px);
    }
    .dt-prompt-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 11px;
      background: rgba(15, 23, 42, 0.4);
      border-bottom: 1px solid rgba(148, 163, 184, 0.15);
    }
    .dt-prompt-label {
      font-size: 10px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .dt-prompt-body {
      padding: 11px;
      font-family: var(--dt-font-mono);
      font-size: 11.5px;
      line-height: 1.55;
      color: #cbd5e1;
      white-space: pre-wrap;
      max-height: min(360px, 48vh);
      overflow-y: auto;
    }
    .dt-prompt-footer {
      padding: 7px 11px;
      border-top: 1px solid rgba(148, 163, 184, 0.15);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      background: rgba(15, 23, 42, 0.3);
    }
    .dt-prompt-hint {
      font-size: 10px;
      color: var(--dt-text-muted);
      flex: 1;
    }

    /* === Screenshot Preview === */
    .dt-screenshot-preview {
      padding: 8px 12px 0;
      display: none;
    }
    .dt-screenshot-preview.has-image { display: block; }

    .dt-screenshot-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .dt-screenshot-wrap {
      position: relative;
      display: inline-block;
      border-radius: var(--dt-radius-sm);
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .dt-screenshot-wrap img {
      display: block;
      max-height: 80px;
      width: auto;
      cursor: zoom-in;
    }
    .dt-screenshot-remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0,0,0,0.6);
      color: white;
      border: none;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .dt-screenshot-remove:hover { background: var(--dt-danger); }

    /* === Image Preview === */
    .dt-image-preview {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 28px 28px;
      background: rgba(2,6,23,0.78);
      backdrop-filter: blur(4px);
      pointer-events: auto;
    }
    .dt-image-preview.is-open { display: flex; }

    .dt-image-editor-toolbar {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(15,23,42,0.92);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: var(--dt-radius);
      z-index: 2147483648;
    }
    .dt-image-editor-toolbar .dt-btn {
      padding: 5px 10px;
      font-size: 12px;
    }
    .dt-image-editor-toolbar .dt-btn.dt-active {
      background: var(--dt-accent) !important;
      color: white !important;
    }
    .dt-image-editor-toolbar .dt-color-picker {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      cursor: pointer;
      background: none;
      padding: 0;
    }
    .dt-image-editor-toolbar .dt-stroke-size {
      width: 40px;
      background: var(--dt-bg-secondary);
      color: var(--dt-text-primary);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
      padding: 3px 5px;
      font-size: 11px;
      text-align: center;
    }

    .dt-image-preview__wrap {
      position: relative;
      display: inline-block;
      max-width: min(1100px, calc(100vw - 56px));
      max-height: calc(100vh - 100px);
    }
    .dt-image-preview__img {
      max-width: min(1100px, calc(100vw - 56px));
      max-height: calc(100vh - 100px);
      object-fit: contain;
      border-radius: var(--dt-radius-sm);
      background: white;
      box-shadow: 0 20px 80px rgba(0,0,0,0.55);
      display: block;
    }
    .dt-image-preview__canvas {
      position: absolute;
      top: 0;
      left: 0;
      cursor: crosshair;
      border-radius: var(--dt-radius-sm);
    }
    .dt-image-preview__close {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 32px;
      height: 32px;
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 50%;
      background: rgba(15,23,42,0.78);
      color: white;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      z-index: 2147483648;
    }
    .dt-image-preview__close:hover { background: var(--dt-danger); }

    .dt-image-text-input {
      position: absolute;
      background: transparent;
      border: 1px dashed var(--dt-accent);
      color: #ef4444;
      font-size: 16px;
      font-weight: 600;
      padding: 2px 6px;
      outline: none;
      min-width: 60px;
      z-index: 10;
    }

    /* === Chat Input === */
    .dt-chat-input-wrap {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .dt-chat-input {
      flex: 1;
      min-width: 0;
      min-height: 36px;
      max-height: 112px;
      background: var(--dt-bg-secondary);
      color: var(--dt-text-primary);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: var(--dt-radius-sm);
      padding: 7px 10px;
      font-family: var(--dt-font);
      font-size: 12px;
      line-height: 1.45;
      outline: none;
      resize: none;
      overflow-y: auto;
      transition: border-color 0.15s;
    }
    .dt-chat-input:focus { border-color: var(--dt-accent); }
    .dt-chat-input::placeholder { color: var(--dt-text-muted); opacity: 0.6; }

    .dt-send-btn {
      flex: 0 0 auto;
      min-width: 64px;
      min-height: 36px;
      padding: 0 14px;
      align-self: flex-end;
      justify-content: center;
    }
    .dt-send-btn--stop {
      background: var(--dt-danger);
      border-color: rgba(248,113,113,0.55);
    }
    .dt-send-btn--stop:hover:not(:disabled) {
      background: #dc2626;
    }

    .dt-chat-hint {
      padding: 0 12px 6px;
      font-size: 10px;
      color: var(--dt-danger);
      display: none;
    }
    .dt-chat-hint.show { display: block; }

    /* === Floating Action Ball === */
    .dt-fab {
      display: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--dt-accent);
      color: #fff;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      border: 2px solid rgba(255,255,255,0.15);
      pointer-events: auto;
      user-select: none;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .dt-fab:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 16px rgba(0,0,0,0.45);
    }
    .dt-fab:active {
      transform: scale(0.95);
    }
    .dt-fab.is-dragging {
      cursor: grabbing;
    }
    .dt-fab svg {
      display: block;
      width: 18px;
      height: 18px;
    }

    /* === Hidden === */
    .dt-hidden { display: none !important; }

    /* === Scrollbar === */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--dt-bg-hover); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--dt-text-secondary); }
  `;
  shadow.appendChild(style);

  // --- HTML 结构 ---
  const root = document.createElement('div');
  root.id = 'dt-root';
  root.style.height = '100%';
  root.innerHTML = `
    <div class="dt-sidebar" id="dt-sidebar">
      <!-- Toolbar -->
      <div class="dt-toolbar" id="dt-toolbar">
        <span class="dt-toolbar-title">DevTailor</span>
        <button class="dt-btn dt-btn--small" id="dt-btn-mark" title="标记元素">标记</button>
        <button class="dt-btn dt-btn--small" id="dt-btn-save-element" title="保存元素到元素库">存元素</button>
        <button class="dt-btn dt-btn--small" id="dt-btn-screenshot" title="截取屏幕">截图</button>
        <button class="dt-btn dt-btn--small" id="dt-btn-new-session" title="新建会话">新会话</button>
        <button class="dt-btn dt-btn--small dt-btn--danger" id="dt-btn-close" title="收起侧边栏">×</button>
      </div>

      <!-- Status Bar -->
      <div class="dt-status-bar">
        <span class="dt-status-dot dt-status-dot--export" id="dt-status-dot"></span>
        <span class="dt-status-text" id="dt-status-text">导出模式</span>
        <div class="dt-session-wrap">
          <button class="dt-btn dt-btn--small dt-session-btn" id="dt-btn-session" title="切换会话" aria-label="切换会话">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 7h10"></path>
              <path d="M7 12h10"></path>
              <path d="M7 17h6"></path>
              <path d="M4 5.5v13"></path>
            </svg>
          </button>
          <div class="dt-session-menu dt-hidden" id="dt-session-menu"></div>
        </div>
      </div>

      <!-- Context Queue -->
      <div class="dt-context-panel" id="dt-context-panel">
        <div class="dt-context-header">
          <span class="dt-context-summary" id="dt-context-summary">0 个标记</span>
        </div>
      </div>

      <!-- Batch Actions -->
      <div class="dt-batch-bar" id="dt-batch-bar">
        <span class="dt-batch-count" id="dt-batch-count">0</span>
        <span class="dt-batch-label">当前批次</span>
        <button class="dt-btn dt-btn--small dt-batch-action" id="dt-btn-undo-mark" title="撤销最近一次标记">撤销</button>
        <button class="dt-btn dt-btn--small dt-batch-action" id="dt-btn-discard-batch" title="放弃当前批次">放弃</button>
      </div>

      <!-- Chat Panel -->
      <div class="dt-chat-panel" id="dt-chat-panel">
        <div class="dt-chat-messages" id="dt-chat-messages"></div>
        <button class="dt-chat-jump" id="dt-chat-jump" type="button">回到底部</button>
        <div class="dt-activation-banner" id="dt-activation-banner">
          <div class="dt-activation-text">
            <strong>当前页面未接管</strong>
            新 tab 需要连接后才会接收浏览器操作。
          </div>
          <button class="dt-btn dt-btn--primary dt-btn--small dt-activation-btn" id="dt-btn-activate-tab" type="button">连接当前页</button>
        </div>
        <div class="dt-screenshot-preview" id="dt-screenshot-preview"></div>
        <div class="dt-chat-hint" id="dt-chat-hint">请先标记至少一个元素</div>
        <div class="dt-chat-input-wrap">
          <textarea class="dt-chat-input" id="dt-chat-input" rows="1" spellcheck="false" placeholder="描述你想修改的内容..."></textarea>
          <button class="dt-btn dt-btn--primary dt-send-btn" id="dt-btn-send">发送</button>
        </div>
      </div>
    </div>
    <div class="dt-image-preview" id="dt-image-preview" aria-hidden="true">
      <button class="dt-image-preview__close" id="dt-image-preview-close" title="关闭预览">×</button>
      <div class="dt-image-editor-toolbar" id="dt-image-editor-toolbar">
        <button class="dt-btn dt-btn--small" data-tool="rect" title="矩形标注">矩形</button>
        <button class="dt-btn dt-btn--small" data-tool="arrow" title="箭头标注">箭头</button>
        <button class="dt-btn dt-btn--small" data-tool="text" title="文字标注">文字</button>
        <input type="color" class="dt-color-picker" id="dt-image-color" value="#ef4444" title="颜色">
        <input type="number" class="dt-stroke-size" id="dt-image-stroke" value="3" min="1" max="20" title="粗细">
        <button class="dt-btn dt-btn--small" id="dt-image-undo" title="撤销">撤销</button>
        <button class="dt-btn dt-btn--small dt-btn--primary" id="dt-image-save" title="保存">保存</button>
      </div>
      <div class="dt-image-preview__wrap" id="dt-image-preview-wrap">
        <img class="dt-image-preview__img" id="dt-image-preview-img" alt="图片预览">
        <canvas class="dt-image-preview__canvas" id="dt-image-preview-canvas"></canvas>
      </div>
    </div>
    <div class="dt-fab" id="dt-fab" title="展开侧边栏">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="7" height="7" x="3" y="3" rx="1"/>
        <rect width="7" height="7" x="14" y="3" rx="1"/>
        <rect width="7" height="7" x="14" y="14" rx="1"/>
        <rect width="7" height="7" x="3" y="14" rx="1"/>
      </svg>
    </div>
  `;
  shadow.appendChild(root);

  let sidebarVisible = true;
  let dragInitialized = false;
  let panelSize = { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
  let savedFabPos = null;

  function ensureHostInBody() {
    if (host.parentNode) return;
    const target = document.body || document.documentElement;
    if (target) {
      restorePanelPosition();
      target.appendChild(host);
      loadPanelSize();
      initDrag();
      window.addEventListener('resize', clampToViewport);
      if (chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && changes[SIZE_KEY]) {
            applyPanelSize(changes[SIZE_KEY].newValue);
          }
        });
      }
      console.log('[DevTailor] 宿主已挂载到', target.nodeName);
    } else {
      console.warn('[DevTailor] 找不到 body 或 documentElement 来挂载宿主');
    }
  }

  function getPanelRect() {
    return {
      width: host.offsetWidth || DEFAULT_PANEL_WIDTH,
      height: host.offsetHeight || Math.min(DEFAULT_PANEL_HEIGHT, window.innerHeight - 32)
    };
  }

  function clampPosition(x, y) {
    const rect = getPanelRect();
    const margin = 12;
    const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      x: Math.min(Math.max(margin, x), maxX),
      y: Math.min(Math.max(margin, y), maxY)
    };
  }

  function setPanelPosition(x, y, persist = true) {
    const pos = clampPosition(x, y);
    host.style.left = pos.x + 'px';
    host.style.top = pos.y + 'px';
    host.style.right = 'auto';
    if (persist) {
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
      } catch {
        // localStorage may be unavailable on some pages.
      }
    }
  }

  function restorePanelPosition() {
    try {
      const raw = localStorage.getItem(POSITION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          setPanelPosition(parsed.x, parsed.y, false);
          return;
        }
      }
    } catch {
      // Ignore corrupted or unavailable saved position.
    }
    setPanelPosition(DEFAULT_POSITION.x, DEFAULT_POSITION.y, false);
  }

  function clampToViewport() {
    const x = parseFloat(host.style.left) || DEFAULT_POSITION.x;
    const y = parseFloat(host.style.top) || DEFAULT_POSITION.y;
    setPanelPosition(x, y, true);
  }

  function normalizePanelSize(size) {
    const width = Number(size && size.width);
    const height = Number(size && size.height);
    return {
      width: Math.min(Math.max(Number.isFinite(width) ? width : DEFAULT_PANEL_WIDTH, 320), 960),
      height: Math.min(Math.max(Number.isFinite(height) ? height : DEFAULT_PANEL_HEIGHT, 420), 900)
    };
  }

  function applyPanelSize(size) {
    panelSize = normalizePanelSize(size);
    host.style.width = `min(${panelSize.width}px, calc(100vw - 24px))`;
    host.style.height = `min(${panelSize.height}px, calc(100vh - 32px))`;
    requestAnimationFrame(clampToViewport);
  }

  function loadPanelSize() {
    if (!chrome.storage || !chrome.storage.sync) {
      applyPanelSize(panelSize);
      return;
    }
    chrome.storage.sync.get(SIZE_KEY, (result) => {
      applyPanelSize(result[SIZE_KEY] || panelSize);
    });
  }

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'APPLY_PANEL_SIZE') {
        applyPanelSize(message.size);
        sendResponse({ success: true });
      }
    });
  }

  function initDrag() {
    if (dragInitialized) return;
    dragInitialized = true;

    const toolbar = shadow.getElementById('dt-toolbar');
    if (toolbar) bindDrag(toolbar);

    const fab = shadow.getElementById('dt-fab');
    if (fab) bindDrag(fab);
  }

  function bindDrag(el) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // For toolbar, ignore buttons inside it; FAB itself is the handle
      if (el.id === 'dt-toolbar' && e.target.closest('button, input, textarea, select, a')) return;

      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      originX = parseFloat(host.style.left) || DEFAULT_POSITION.x;
      originY = parseFloat(host.style.top) || DEFAULT_POSITION.y;
      el.classList.add('is-dragging');
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 3 || dy > 3) moved = true;
      setPanelPosition(originX + e.clientX - startX, originY + e.clientY - startY, false);
    });

    const finishDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('is-dragging');
      el.releasePointerCapture?.(e.pointerId);
      if (moved) {
        el.dataset.dragged = '1';
        requestAnimationFrame(() => delete el.dataset.dragged);
        const pos = {
          left: parseFloat(host.style.left) || DEFAULT_POSITION.x,
          top: parseFloat(host.style.top) || DEFAULT_POSITION.y,
        };
        if (el.id === 'dt-fab') {
          const clamped = clampPosition(pos.left, pos.top);
          savedFabPos = { left: clamped.x, top: clamped.y };
          setPanelPosition(clamped.x, clamped.y, false);
        }
        if (el.id === 'dt-toolbar') {
          clampToViewport();
        }
      }
    };

    el.addEventListener('pointerup', finishDrag);
    el.addEventListener('pointercancel', finishDrag);
  }

  // --- 公开 API ---
  window.__domReview.ui = {
    init() {
      ensureHostInBody();
    },

    getShadowRoot() {
      return shadow;
    },

    getSidebar() {
      return shadow.getElementById('dt-sidebar');
    },

    showSidebar() {
      ensureHostInBody();
      host.style.display = 'block';
      host.style.pointerEvents = 'none';
      const sidebar = shadow.getElementById('dt-sidebar');
      const fab = shadow.getElementById('dt-fab');
      if (sidebar) sidebar.style.display = 'flex';
      if (fab) fab.style.display = 'none';

      // Sidebar opens from where the FAB is (FAB is the anchor)
      const anchor = savedFabPos || {
        left: parseFloat(host.style.left) || DEFAULT_POSITION.x,
        top: parseFloat(host.style.top) || DEFAULT_POSITION.y,
      };

      applyPanelSize(panelSize);
      setPanelPosition(anchor.left, anchor.top, false);
      clampToViewport();
      sidebarVisible = true;
      console.log('[DevTailor] 边栏已显示');
    },

    hideSidebar() {
      ensureHostInBody();
      const sidebar = shadow.getElementById('dt-sidebar');
      const fab = shadow.getElementById('dt-fab');

      // Capture sidebar rect before hiding it
      const rect = getPanelRect();

      // Save current sidebar position so FAB can snap to its edge next time if needed
      const sidebarPos = {
        left: parseFloat(host.style.left) || DEFAULT_POSITION.x,
        top: parseFloat(host.style.top) || DEFAULT_POSITION.y,
      };

      if (sidebar) sidebar.style.display = 'none';
      if (fab) fab.style.display = 'flex';

      // Shrink host to FAB size explicitly
      host.style.width = '48px';
      host.style.height = '48px';
      host.style.pointerEvents = 'none';

      // Position FAB: use saved position if user dragged it, otherwise snap to sidebar right edge
      if (savedFabPos) {
        const clamped = clampPosition(savedFabPos.left, savedFabPos.top);
        setPanelPosition(clamped.x, clamped.y, false);
      } else {
        const fabSize = 48;
        const x = sidebarPos.left + rect.width;
        const y = sidebarPos.top + (rect.height / 2) - (fabSize / 2);
        const clamped = clampPosition(x, y);
        setPanelPosition(clamped.x, clamped.y, false);
      }

      sidebarVisible = false;
      console.log('[DevTailor] 边栏已收起为悬浮球');
    },

    isSidebarVisible() {
      return sidebarVisible;
    },

    toggleSidebar() {
      if (sidebarVisible) this.hideSidebar();
      else this.showSidebar();
    },

    applyPanelSize,

    // 标记按钮状态
    setMarkMode(mode) {
      const btn = shadow.getElementById('dt-btn-mark');
      if (!btn) return;
      const next = mode === 'describing' ? 'describing' : (mode === 'selecting' ? 'selecting' : 'idle');
      btn.classList.toggle('dt-active', next === 'selecting');
      btn.classList.toggle('dt-describing', next === 'describing');
      if (next === 'selecting') {
        btn.textContent = '标记中';
        btn.title = '正在选择页面元素，点击退出标记';
      } else if (next === 'describing') {
        btn.textContent = '描述中';
        btn.title = '正在填写标记说明，点击保存并继续选择';
      } else {
        btn.textContent = '标记';
        btn.title = '标记元素';
      }
    },

    setSaveElementActive(active) {
      const btn = shadow.getElementById('dt-btn-save-element');
      if (!btn) return;
      btn.classList.toggle('dt-active', active);
      if (active) {
        btn.textContent = '选择中';
        btn.title = '正在选择元素，点击退出或按ESC';
      } else {
        btn.textContent = '存元素';
        btn.title = '保存元素到元素库';
      }
    },

    setMarkActive(active) {
      this.setMarkMode(active ? 'selecting' : 'idle');
    },

    getContextSummary() {
      return shadow.getElementById('dt-context-summary');
    },

    updateBatchBar(count) {
      const bar = shadow.getElementById('dt-batch-bar');
      const countEl = shadow.getElementById('dt-batch-count');
      if (bar) bar.classList.toggle('is-visible', count > 0);
      if (countEl) countEl.textContent = String(count);
    },

    // 聊天
    getChatMessages() {
      return shadow.getElementById('dt-chat-messages');
    },

    getChatJumpButton() {
      return shadow.getElementById('dt-chat-jump');
    },

    getActivationBanner() {
      return shadow.getElementById('dt-activation-banner');
    },

    setActivationBannerVisible(visible) {
      shadow.getElementById('dt-activation-banner')?.classList.toggle('is-visible', Boolean(visible));
    },

    getChatInput() {
      return shadow.getElementById('dt-chat-input');
    },

    focusChatInput() {
      const input = shadow.getElementById('dt-chat-input');
      if (input) input.focus();
    },

    restorePageFocus() {
      const el = lastPageFocusEl;
      if (!isPageFocusableElement(el)) return false;
      try {
        el.focus({ preventScroll: true });
        return true;
      } catch {
        return false;
      }
    },

    getSendButton() {
      return shadow.getElementById('dt-btn-send');
    },

    getScreenshotPreview() {
      return shadow.getElementById('dt-screenshot-preview');
    },

    getImagePreview() {
      return shadow.getElementById('dt-image-preview');
    },

    getImagePreviewImage() {
      return shadow.getElementById('dt-image-preview-img');
    },

    getImagePreviewClose() {
      return shadow.getElementById('dt-image-preview-close');
    },

    getImagePreviewCanvas() {
      return shadow.getElementById('dt-image-preview-canvas');
    },

    getImagePreviewWrap() {
      return shadow.getElementById('dt-image-preview-wrap');
    },

    getImageEditorToolbar() {
      return shadow.getElementById('dt-image-editor-toolbar');
    },

    getImageColorPicker() {
      return shadow.getElementById('dt-image-color');
    },

    getImageStrokeInput() {
      return shadow.getElementById('dt-image-stroke');
    },

    getImageUndoBtn() {
      return shadow.getElementById('dt-image-undo');
    },

    getImageSaveBtn() {
      return shadow.getElementById('dt-image-save');
    },

    getChatHint() {
      return shadow.getElementById('dt-chat-hint');
    },

    getSessionButton() {
      return shadow.getElementById('dt-btn-session');
    },

    getSessionMenu() {
      return shadow.getElementById('dt-session-menu');
    },

    setSessionButtonLabel(label) {
      const btn = shadow.getElementById('dt-btn-session');
      if (!btn) return;
      const title = label ? `切换会话：${label}` : '切换会话';
      btn.title = title;
      btn.setAttribute('aria-label', title);
    },

    setConnectionStatus(status, sessionLabel, isActive) {
      const dot = shadow.getElementById('dt-status-dot');
      const text = shadow.getElementById('dt-status-text');
      if (!dot || !text) return;
      const map = {
        disconnected: { cls: 'dt-status-dot--disconnected', label: '未连接' },
        connecting: { cls: 'dt-status-dot--connecting', label: '连接中' },
        connected: { cls: 'dt-status-dot--connected', label: isActive ? '已接管' : '已连接 · 点击接管' },
      };
      const cfg = map[status] || map.disconnected;
      dot.className = 'dt-status-dot ' + cfg.cls;
      let label = cfg.label;
      if (sessionLabel && status === 'connected') {
        label += ` · ${sessionLabel}`;
      }
      text.textContent = label;
    },

    // 事件绑定辅助方法
    onStatusClick(callback) {
      shadow.getElementById('dt-status-dot')?.parentElement?.addEventListener('click', callback);
    },

    onActivateTabClick(callback) {
      shadow.getElementById('dt-btn-activate-tab')?.addEventListener('click', callback);
    },

    onMarkClick(callback) {
      shadow.getElementById('dt-btn-mark').addEventListener('click', callback);
    },

    onSaveElementClick(callback) {
      shadow.getElementById('dt-btn-save-element').addEventListener('click', callback);
    },

    onScreenshotClick(callback) {
      shadow.getElementById('dt-btn-screenshot').addEventListener('click', callback);
    },

    onNewSessionClick(callback) {
      shadow.getElementById('dt-btn-new-session').addEventListener('click', callback);
    },

    onUndoMarkClick(callback) {
      shadow.getElementById('dt-btn-undo-mark').addEventListener('click', callback);
    },

    onDiscardBatchClick(callback) {
      shadow.getElementById('dt-btn-discard-batch').addEventListener('click', callback);
    },

    onSendClick(callback) {
      shadow.getElementById('dt-btn-send').addEventListener('click', callback);
    },

    onCloseClick(callback) {
      shadow.getElementById('dt-btn-close').addEventListener('click', callback);
    },

    onFabClick(callback) {
      const fab = shadow.getElementById('dt-fab');
      fab.addEventListener('click', (e) => {
        if (fab.dataset.dragged) {
          delete fab.dataset.dragged;
          return;
        }
        callback(e);
      });
    },

    onChatInput(callback) {
      let composing = false;
      const input = shadow.getElementById('dt-chat-input');
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; });
      input.addEventListener('keydown', (e) => {
        if (composing || e.isComposing || e.keyCode === 229 || e.key === 'Process') return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          callback(e);
        }
      });
    },
  };
})();
