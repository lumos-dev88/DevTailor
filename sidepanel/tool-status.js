/**
 * DevTailor side panel — 极简工具状态（工具名 + 状态）
 *
 * Bridge/Hub 在已有 SSE 流里推 `{ type:'tool_status', tabId, sessionId, toolName, requestId,
 * toolStatus:'running'|'success'|'error'|'timeout', errorCode?, durationMs? }`。这里只把它渲染成
 * session bar 里的一小段「工具名 · 进行中/成功/失败/超时」，不进消息流、不碰滚动和 composer。
 *
 * 旧形态 `{ type:'tool_status', toolStatus:'canceled' }`（无 toolName）不归这里管：
 * normalize() 对它返回 null，事件仍由 content/modules/chat-conversation.js 的 endStream() 处理。
 *
 * 纯逻辑导出给 Node 测试（tests/extension/tool-status.test.js）。
 *
 * Browser: window.__domReview.toolStatus. Node (tests): module.exports.
 */
(() => {
  'use strict';

  /** 只有这四种状态会被显示；其它（含旧的 canceled）一律忽略。 */
  const STATES = ['running', 'success', 'error', 'timeout'];

  const STATE_TEXT = {
    running: '进行中',
    success: '成功',
    error: '失败',
    timeout: '超时',
  };

  /** 工具名显示上限：完整值只放在 title 里。 */
  const MAX_TOOL_NAME = 40;
  const MAX_ERROR_CODE = 40;
  /** 成功只是「一闪而过」，失败要留得久一点让人看见。 */
  const SUCCESS_HIDE_MS = 2500;
  const FAILURE_HIDE_MS = 5000;

  /** 去控制字符 + 单行化 + 限长（超长用省略号，结果长度永远 <= max）。 */
  function asText(value, max) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const s = String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!max || s.length <= max) return s;
    return `${s.slice(0, max - 1).trimEnd()}…`;
  }

  /**
   * SSE 事件 -> `{ toolName, state, errorCode, durationMs }`，或不接管时返回 null。
   * - 没有 toolName（旧的 canceled 形态）-> null
   * - 未知 toolStatus（含 canceled / in_progress…）-> null
   */
  function normalize(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const toolName = asText(msg.toolName, MAX_TOOL_NAME);
    if (!toolName) return null;
    const state = String(msg.toolStatus == null ? '' : msg.toolStatus).trim().toLowerCase();
    if (!STATES.includes(state)) return null;
    const rawDuration = Number(msg.durationMs);
    return {
      toolName,
      state,
      errorCode: asText(msg.errorCode, MAX_ERROR_CODE),
      durationMs: Number.isFinite(rawDuration) && rawDuration >= 0 ? Math.round(rawDuration) : null,
    };
  }

  /** `820ms` / `1.4s` / `12s` / `1m05s`；缺失、负数、NaN 一律返回空串。 */
  function formatDuration(ms) {
    if (ms === null || ms === undefined || ms === '') return '';
    const total = Number(ms);
    if (!Number.isFinite(total) || total < 0) return '';
    if (total < 1000) return `${Math.round(total)}ms`;
    const seconds = total / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
  }

  /** 这个状态要停留多久（0 = 一直留到下一个事件 / 被清空）。 */
  function hideDelay(state) {
    if (state === 'success') return SUCCESS_HIDE_MS;
    if (state === 'error' || state === 'timeout') return FAILURE_HIDE_MS;
    return 0;
  }

  /**
   * 归一化结果 -> `{ visible, state, toolName, text, title, hideInMs }`。
   * `text` 就是屏幕上那一行「工具名 · 状态」；`title` 额外带上 errorCode / 耗时。
   */
  function model(entry) {
    const src = entry && typeof entry === 'object' ? entry : null;
    if (!src || !STATES.includes(src.state) || !src.toolName) {
      return { visible: false, state: '', toolName: '', text: '', title: '', hideInMs: 0 };
    }
    const text = `${src.toolName} · ${STATE_TEXT[src.state]}`;
    const parts = [text];
    if (src.errorCode) parts.push(src.errorCode);
    const duration = formatDuration(src.durationMs);
    if (duration) parts.push(`耗时 ${duration}`);
    return {
      visible: true,
      state: src.state,
      toolName: src.toolName,
      text,
      title: parts.join(' · '),
      hideInMs: hideDelay(src.state),
    };
  }

  /* ── DOM binding ──────────────────────────────── */
  /**
   * create({ elements: { root, text }, now?, setTimeout?, clearTimeout? })
   * - update(msg)：新的 running 直接覆盖旧显示；success/error/timeout 定时自动隐藏。
   * - clear()：立即隐藏（done / session_reset / SSE 断开）。
   * - 不认识的输入（含旧的 canceled）不改变当前显示。
   */
  function create(deps) {
    const opts = deps || {};
    const elements = opts.elements || opts.els || {};
    const root = elements.root || null;
    const textEl = elements.text || null;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const startTimer = typeof opts.setTimeout === 'function'
      ? (fn, ms) => opts.setTimeout(fn, ms)
      : (fn, ms) => setTimeout(fn, ms);
    const stopTimerFn = typeof opts.clearTimeout === 'function'
      ? (id) => opts.clearTimeout(id)
      : (id) => clearTimeout(id);

    let entry = null;
    let current = model(null);
    let timer = null;
    let since = 0;

    function stopTimer() {
      if (timer !== null) {
        stopTimerFn(timer);
        timer = null;
      }
    }

    function paint(next) {
      current = next;
      if (root) {
        root.classList.remove(...STATES.map((state) => `tool-status--${state}`));
        if (next.visible) {
          root.hidden = false;
          root.classList.add(`tool-status--${next.state}`);
          root.setAttribute('data-state', next.state);
          root.title = next.title;
        } else {
          root.hidden = true;
          root.removeAttribute('data-state');
          root.title = '';
        }
      }
      // textContent（不是 innerHTML）：工具名/错误码都是外部数据，绝不当标记解析。
      if (textEl) textEl.textContent = next.visible ? next.text : '';
    }

    function clear() {
      stopTimer();
      entry = null;
      since = 0;
      paint(model(null));
      return current;
    }

    function update(msg) {
      const next = normalize(msg);
      // 不接管的输入（旧 canceled 形态、未知状态、非对象）保持现状。
      if (!next) return current;
      stopTimer();
      entry = next;
      since = now();
      paint(model(entry));
      if (next.state !== 'running') {
        timer = startTimer(() => {
          timer = null;
          clear();
        }, hideDelay(next.state));
      }
      return current;
    }

    clear();
    return {
      update,
      clear,
      destroy: () => clear(),
      getState: () => ({ ...current, since, pending: timer !== null }),
    };
  }

  const api = {
    STATES,
    STATE_TEXT,
    MAX_TOOL_NAME,
    MAX_ERROR_CODE,
    SUCCESS_HIDE_MS,
    FAILURE_HIDE_MS,
    asText,
    normalize,
    formatDuration,
    hideDelay,
    model,
    create,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.toolStatus = api;
  }
})();
