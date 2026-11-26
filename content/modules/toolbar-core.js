/**
 * DevTailor — Toolbar core (pure logic, no DOM)
 *
 * Persisted floating-bar position (per origin) with tolerant parsing, viewport clamping, the
 * pending-approval counter behind the red dot, shortcut matching, and the takeover status model of
 * the status dot.
 *
 * Browser: window.__domReview.toolbarCore. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const STATE_VERSION = 1;
  const STORAGE_PREFIX = 'dt_toolbar:';
  const BAR_WIDTH = 48;
  const APPROVAL_TTL_MS = 300000; // same as the bridge's approval timeout
  const BRIDGE_START_COMMAND = 'claude-devtailor.sh';

  // Page shortcuts live on the toolbar (V = pick, S = screenshot, R = reference elements). A hit
  // only fires when it is a plain key press on a non-editable target; anything else is left to the page.
  // `x` is deliberately not bound here: Ctrl/Cmd+Shift+X lives in the manifest command.
  const SHORTCUTS = { v: 'pick', s: 'screenshot', r: 'reference' };

  // ---------------------------------------------------------------- state

  function stateKey(origin) {
    return `${STORAGE_PREFIX}${String(origin || 'unknown')}`;
  }

  /**
   * Old states stored only a vertical `top`; the floating bar now also remembers `left`.
   * `{ open }` is not used anymore but stays tolerated so old values still load.
   */
  function defaultState() {
    return { open: false, top: null, left: null };
  }

  /** Accepts the stored value (object or JSON string) and never throws; anything odd falls back. */
  function parseState(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return defaultState(); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultState();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    return { open: value.open === true, top: num(value.top), left: num(value.left) };
  }

  function serializeState(state) {
    const s = parseState(state);
    // `open` is legacy (the drawer is gone); it is kept in the parsed shape for old reads only.
    return { v: STATE_VERSION, open: false, top: s.top, left: s.left };
  }

  // ------------------------------------------------------------- position

  /** Keep a box of `width x height` fully inside the viewport. 0 is a legal edge value. */
  function clampPosition({ left, top }, viewportWidth, viewportHeight, width, height) {
    const vw = Number.isFinite(viewportWidth) ? viewportWidth : 0;
    const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
    const w = Number.isFinite(width) ? width : 0;
    const h = Number.isFinite(height) ? height : 0;
    const clamp = (value, viewport, size) => {
      const max = Math.max(0, viewport - size);
      const n = Number.isFinite(value) ? value : 0;
      return Math.round(Math.min(Math.max(0, n), max));
    };
    return { left: clamp(left, vw, w), top: clamp(top, vh, h) };
  }

  /** Docked to the left edge, vertically centred a little above the middle. */
  function defaultPosition(viewportWidth, viewportHeight, width, height) {
    return clampPosition(
      { left: 0, top: ((viewportHeight - height) / 2) - viewportHeight * 0.06 },
      viewportWidth, viewportHeight, width, height
    );
  }

  function resolvePosition(state, viewportWidth, viewportHeight, width, height) {
    const s = state && typeof state === 'object' ? state : {};
    const def = defaultPosition(viewportWidth, viewportHeight, width, height);
    return clampPosition(
      { left: typeof s.left === 'number' ? s.left : def.left, top: typeof s.top === 'number' ? s.top : def.top },
      viewportWidth, viewportHeight, width, height
    );
  }

  // ----------------------------------------------------------- shortcuts

  const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  /**
   * Walk from `node` through shadow roots (the page's and nested ones) to the deepest active
   * element; a closed root reports its host, which is still the element to check for editability.
   */
  function deepActiveElement(documentRef, node) {
    let current = node;
    let guard = 0;
    while (current && current.shadowRoot && current.shadowRoot.activeElement && guard++ < 16) {
      current = current.shadowRoot.activeElement;
    }
    return current || (documentRef && documentRef.activeElement) || null;
  }

  /**
   * True when `event` came from a text-editing context. The caller passes the composed path so a
   * page inside (or outside) any shadow boundary is handled: the first element of the path wins,
   * then the deepest `activeElement` is checked as a fallback.
   */
  function isEditableEvent(event, documentRef = typeof document !== 'undefined' ? document : null) {
    if (!event) return false;
    const path = Array.isArray(event.composedPath) ? event.composedPath() : [];
    for (const node of path) {
      if (typeof node?.matches === 'function' && node.matches(EDITABLE_SELECTOR)) return true;
    }
    return isEditableTarget(documentRef && documentRef.activeElement, documentRef);
  }

  /** True when the element (or the deepest active descendant) accepts text input. */
  function isEditableTarget(node, documentRef = typeof document !== 'undefined' ? document : null) {
    if (!node || typeof node !== 'object') return false;
    const target = deepActiveElement(documentRef, node);
    if (!target || typeof target.matches !== 'function') return false;
    return Boolean(target.matches(EDITABLE_SELECTOR));
  }

  /**
   * Plain-key shortcut hit? `modifierKeys` are ctrl/meta/alt. A composing IME must not swallow
   * the key. Returns the action name ('pick' | 'screenshot' | 'reference') or null (page keeps it).
   */
  function matchShortcut(key, { modifierKeys = [], composing = false } = {}) {
    if (composing) return null;
    if (Array.isArray(modifierKeys) && modifierKeys.some(Boolean)) return null;
    if (typeof key !== 'string') return null;
    const normalized = key.length === 1 ? key.toLowerCase() : key;
    return SHORTCUTS[normalized] || null;
  }

  // ------------------------------------------------------------ approvals

  /** Counts distinct pending approvals from the bridge event stream. */
  function createApprovalTracker({ now = () => Date.now() } = {}) {
    const pending = new Map(); // approvalId -> firstSeenAt
    const prune = () => {
      const t = now();
      for (const [id, at] of pending) if (t - at > APPROVAL_TTL_MS) pending.delete(id);
    };
    return {
      /** Feed every SSE message; returns true when the count changed. */
      handle(msg) {
        if (!msg || typeof msg !== 'object') return false;
        const before = pending.size;
        const id = msg.approvalId;
        if ((msg.type === 'approval_request' || msg.type === 'approval_pending') && id) {
          if (!pending.has(id)) pending.set(id, now());
        } else if (msg.type === 'approval_resolved' && id) {
          pending.delete(id);
        } else if (msg.type === 'session_reset') {
          pending.clear();
        }
        prune();
        return pending.size !== before;
      },
      /** Bridge went away: it re-sends the pending ones when we reconnect. */
      reset() { const had = pending.size > 0; pending.clear(); return had; },
      count() { prune(); return pending.size; },
    };
  }

  // --------------------------------------------------------- takeover dot

  /**
   * @param {{ status: string, active: boolean, releasing?: boolean, startCommand?: string }} input
   *   status: wsClient status ('connected' | 'connecting' | 'disconnected')
   */
  function takeoverModel({ status, active, releasing = false, startCommand = BRIDGE_START_COMMAND }) {
    if (releasing) {
      return { key: 'releasing', tone: 'warn', label: '正在取消接管…', tip: '正在取消接管，稍候会自动重新连接 Hub', action: 'none' };
    }
    if (status !== 'connected') {
      return {
        key: 'offline',
        tone: 'error',
        label: 'Hub 未连接',
        tip: `Hub 未连接：请确认 devtailor-hub 正在运行（\`fh hub status\`），并在项目目录运行 ${startCommand} 启动 Claude Code\n点击重试连接`,
        action: 'reconnect',
      };
    }
    if (active) {
      return { key: 'taken', tone: 'ok', label: '已接管', tip: 'Claude Code 已接管当前页，点击取消接管', action: 'release' };
    }
    return { key: 'idle', tone: 'warn', label: '未接管', tip: '未接管当前页，点击“连接当前页”让 Claude 可以操作它', action: 'activate' };
  }

  const api = {
    STATE_VERSION,
    BAR_WIDTH,
    APPROVAL_TTL_MS,
    BRIDGE_START_COMMAND,
    SHORTCUTS,
    EDITABLE_SELECTOR,
    stateKey,
    defaultState,
    parseState,
    serializeState,
    clampPosition,
    defaultPosition,
    resolvePosition,
    deepActiveElement,
    isEditableEvent,
    isEditableTarget,
    matchShortcut,
    createApprovalTracker,
    takeoverModel,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.toolbarCore = api;
  }
})();
