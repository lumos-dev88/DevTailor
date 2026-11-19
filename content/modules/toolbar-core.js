/**
 * DevTailor — Toolbar core (pure logic, no DOM)
 *
 * Persisted toolbar state (drawer open/closed + vertical position, per origin) with tolerant
 * parsing, drag-position clamping, the pending-approval counter behind the red dot, and the
 * takeover status model of the status dot.
 *
 * Browser: window.__domReview.toolbarCore. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const STATE_VERSION = 1;
  const STORAGE_PREFIX = 'dt_toolbar:';
  const COLLAPSED_WIDTH = 44;
  const EXPANDED_WIDTH = 320;
  const APPROVAL_TTL_MS = 300000; // same as the bridge's approval timeout
  const BRIDGE_START_COMMAND = 'scripts/claude-devtailor.sh';

  // ---------------------------------------------------------------- state

  function stateKey(origin) {
    return `${STORAGE_PREFIX}${String(origin || 'unknown')}`;
  }

  function defaultState() {
    return { open: false, top: null };
  }

  /** Accepts the stored value (object or JSON string) and never throws; anything odd falls back. */
  function parseState(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return defaultState(); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultState();
    const top = typeof value.top === 'number' && Number.isFinite(value.top) ? Math.round(value.top) : null;
    return { open: value.open === true, top };
  }

  function serializeState(state) {
    const s = parseState(state);
    return { v: STATE_VERSION, open: s.open, top: s.top };
  }

  // ------------------------------------------------------------- position

  /** Keep a toolbar of `height` fully on screen. 0 is a legal value (it may touch the top edge). */
  function clampTop(top, viewportHeight, height) {
    const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
    const h = Number.isFinite(height) ? height : 0;
    const max = Math.max(0, vh - h);
    const t = Number.isFinite(top) ? top : 0;
    return Math.round(Math.min(Math.max(0, t), max));
  }

  /** Vertically centered, slightly above the middle. */
  function defaultTop(viewportHeight, height) {
    return clampTop(((viewportHeight - height) / 2) - viewportHeight * 0.06, viewportHeight, height);
  }

  function resolveTop(state, viewportHeight, height) {
    const top = state && typeof state.top === 'number' ? state.top : defaultTop(viewportHeight, height);
    return clampTop(top, viewportHeight, height);
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
      return { key: 'releasing', tone: 'warn', label: '正在取消接管…', tip: '正在取消接管，稍候会自动重新连接桥接服务', action: 'none' };
    }
    if (status !== 'connected') {
      return {
        key: 'offline',
        tone: 'error',
        label: '桥接未连接',
        tip: `桥接服务未连接：请在项目目录运行 ${startCommand}\n点击重试连接`,
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
    COLLAPSED_WIDTH,
    EXPANDED_WIDTH,
    APPROVAL_TTL_MS,
    BRIDGE_START_COMMAND,
    stateKey,
    defaultState,
    parseState,
    serializeState,
    clampTop,
    defaultTop,
    resolveTop,
    createApprovalTracker,
    takeoverModel,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.toolbarCore = api;
  }
})();
