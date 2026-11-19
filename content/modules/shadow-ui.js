/**
 * DevTailor — Shadow UI host
 *
 * Creates the isolated Shadow DOM host (`#dom-review-host`) that carries the page-side marks
 * toolbar (toolbar.js). The host is a zero-size fixed box with `pointer-events: none`; only the
 * toolbar's own controls take pointer events, so the page stays fully clickable.
 *
 * Isolation rules (docs/ARCHITECTURE_DECISION.md):
 *   - closed shadow root, so page scripts/styles cannot reach in;
 *   - UI events are stopped at the host so the page never sees clicks/keys that belong to the UI;
 *   - clicking a button does not steal focus from the page (text inputs may take it);
 *   - the host id is what Browser MCP (`withDevTailorUiHidden`), screenshots and the selector
 *     hit-test use to hide / ignore DevTailor UI, so it must stay `dom-review-host`.
 *
 * Registers: window.__domReview.ui
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const HOST_ID = 'dom-review-host';

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    overflow: visible;
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
    // 页面模态层的焦点陷阱监听 document 的 focusin，不拦的话工具栏输入框一聚焦就被抢回
    'focusin',
    'focusout',
  ];
  const UI_TEXT_FOCUS_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[data-dt-allow-focus="true"]',
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
    if (isPageFocusableElement(active)) lastPageFocusEl = active;
  }

  function installEventBoundary() {
    UI_BOUNDARY_EVENTS.forEach((type) => {
      host.addEventListener(type, (event) => event.stopPropagation());
    });

    document.addEventListener('focusin', (event) => {
      if (isPageFocusableElement(event.target)) lastPageFocusEl = event.target;
    }, true);

    // Mouse presses on non-text controls must not move focus out of the page.
    const keepPageFocus = (event) => {
      rememberPageFocus();
      const target = event.target;
      const textual = target?.closest?.(UI_TEXT_FOCUS_SELECTOR);
      if (!textual && target?.closest?.('button, [role="button"], a[href], summary, [tabindex]')) {
        event.preventDefault();
      }
    };
    shadow.addEventListener('pointerdown', keepPageFocus, { capture: true });
    shadow.addEventListener('mousedown', keepPageFocus, { capture: true });
  }

  installEventBoundary();

  const styleEl = document.createElement('style');
  styleEl.textContent = `
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
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .dt-hidden { display: none !important; }
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--dt-bg-hover); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--dt-text-secondary); }
  `;
  shadow.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = 'dt-root';
  shadow.appendChild(root);

  function ensureHostInBody() {
    if (host.parentNode) return;
    const target = document.body || document.documentElement;
    if (!target) {
      console.warn('[DevTailor] 找不到 body 或 documentElement 来挂载宿主');
      return;
    }
    target.appendChild(host);
  }

  window.__domReview.ui = {
    HOST_ID,

    init() {
      ensureHostInBody();
    },

    getHost() {
      return host;
    },

    getShadowRoot() {
      return shadow;
    },

    /** Container inside the shadow root that UI modules render into. */
    getRoot() {
      return root;
    },

    /** Append a stylesheet (once per id) to the shadow root. */
    addStyles(css, id = 'dt-extra-styles') {
      if (!css || shadow.getElementById(id)) return;
      const extra = document.createElement('style');
      extra.id = id;
      extra.textContent = css;
      shadow.appendChild(extra);
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
  };
})();
