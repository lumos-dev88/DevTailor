/**
 * DevTailor — bridge core (pure logic, no DOM)
 *
 * Everything the extension needs to talk to the DevTailor bridge that does not touch the DOM:
 * error-code -> copy, proxy response parsing, the permission-approval state machine
 * and status-bar copy.
 *
 * Used by the side panel and (for error copy / proxy parsing) the page content script.
 *
 * Browser: window.__domReview.bridgeCore. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const APPROVAL_TIMEOUT_MS = 300000;
  /**
   * Default buttons for approvals that carry no option list (Claude Code
   * permission relay). `label` is what the button shows; `name` stays empty so a
   * resolved card reads plain 已允许 / 已拒绝 instead of repeating the label.
   */
  const BRIDGE_START_COMMAND = 'claude-devtailor.sh';
  const FINAL_APPROVAL_STATUSES = ['approved', 'rejected', 'cancelled', 'timeout', 'expired'];

  // ---------------------------------------------------------------- helpers

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    ));
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function truncateText(value, max) {
    const text = String(value == null ? '' : value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // ----------------------------------------------------------------- errors

  /** Copy for a bridge error code. `ctx`: { message, status, max, maxDepth }. */
  function errorInfo(code, ctx = {}) {
    const message = str(ctx.message);
    let text;
    let kind = 'generic';
    switch (code) {
      case 'bridge_offline':
        kind = 'offline';
        text = 'Hub 未连接：请确认 devtailor-hub 正在运行（终端执行 `fh hub status` 查看）。';
        break;
      case 'no_claude_instance':
        text = '没有在线的 Claude Code 实例：请在项目目录运行 `claude-devtailor.sh`（devtailor-hub 仓库 scripts/ 下）启动 Claude Code 后重试。';
        break;
      case 'client_not_connected':
        text = '当前标签页没有连接到桥接服务：请刷新页面或点击“连接当前页”。';
        break;
      case 'auth_required':
        kind = 'auth';
        text = 'Claude 登录失效或需要认证：请在终端运行 `claude` 重新登录。';
        break;
      case 'gone':
        text = '该接口已移除，请更新扩展。';
        break;
      default:
        text = message || (ctx.status ? `请求失败（HTTP ${ctx.status}）` : '请求失败，请稍后重试');
    }
    return { code: code || '', text, kind };
  }

  /** Parse a service-worker proxy response: { ok, status, body(text), error }. */
  function parseProxyResponse(response) {
    const res = response || {};
    let data = null;
    if (typeof res.body === 'string' && res.body) {
      try { data = JSON.parse(res.body); } catch { data = null; }
    }
    const status = Number(res.status || 0);
    const reachable = status > 0;
    // Hub style errors: `{ ok:false, error:'no_claude_instance', message }` (error is the code).
    const errorIsCode = Boolean(data) && !str(data.code) && /^[a-z][a-z0-9_]*$/.test(str(data.error));
    return {
      ok: Boolean(res.ok) && (data == null || data.ok !== false),
      status,
      reachable,
      data,
      code: reachable ? (errorIsCode ? str(data.error) : str(data && data.code)) : 'bridge_offline',
      message: errorIsCode ? (str(data.message) || str(res.error)) : (str(data && data.error) || str(res.error)),
    };
  }

  /** Error copy for a failed (parsed) response. */
  function failureInfo(parsed) {
    return errorInfo(parsed.code, {
      message: parsed.message,
      status: parsed.status,
    });
  }

  /** Text for an `error` SSE event ({ code, message }). */
  function errorEventInfo(ev) {
    return errorInfo(str(ev && ev.code), { message: str(ev && ev.message) });
  }

  /**
   * What the last prompt carried besides the user's text: marked elements, screenshots/pasted images,
   * enabled design specs. Pure so it can be unit tested; the side panel renders it in the session bar.
   */
  function promptContextModel(input) {
    const marks = Math.max(0, Number(input && input.marks) || 0);
    const images = Math.max(0, Number(input && input.images) || 0);
    const designDocs = Math.max(0, Number(input && input.designDocs) || 0);
    const parts = [
      { key: 'marks', label: '标记', count: marks, unit: '个' },
      { key: 'images', label: '截图', count: images, unit: '张' },
      { key: 'designDocs', label: '规范', count: designDocs, unit: '份' },
    ].filter((part) => part.count > 0);
    if (!parts.length) return { empty: true, label: '', title: '' };
    return {
      empty: false,
      label: parts.map((part) => `${part.label} ${part.count}`).join(' · '),
      title: `上一条提示带入的上下文：${parts.map((part) => `${part.count} ${part.unit}${part.label}`).join('、')}`,
      parts,
    };
  }

  // -------------------------------------------------------------- approvals

  function approvalMessageId(approvalId) {
    return `appr_${approvalId}`;
  }

  /**
   * Approval detail for display: tool-call detail objects pass through; a plain
   * string (Claude Code's `input_preview`) is wrapped as `{ preview }` so the
   * renderer can show it in the params block.
   */
  function normalizeApprovalDetail(detail) {
    if (!detail) return null;
    if (typeof detail === 'object') return detail;
    return { preview: String(detail) };
  }

  function createApproval(ev, { observing = false, now = Date.now() } = {}) {
    return {
      id: approvalMessageId(ev.approvalId),
      role: 'assistant',
      type: 'approval',
      approvalId: ev.approvalId,
      sessionId: str(ev.sessionId) || null,
      toolCallId: str(ev.toolCallId) || null,
      toolName: str(ev.toolName) || 'tool',
      action: str(ev.action),
      risk: str(ev.risk),
      detail: normalizeApprovalDetail(ev.detail),
      status: 'pending',
      observing: Boolean(observing),
      requestedAt: now,
      expiresAt: now + APPROVAL_TIMEOUT_MS,
      decision: null,
      error: '',
      timestamp: now,
    };
  }

  function isApprovalFinal(card) {
    return FINAL_APPROVAL_STATUSES.includes(card && card.status);
  }

  function isApprovalInteractive(card) {
    return Boolean(card && card.status === 'pending' && !card.observing);
  }

  /**
   * Pure transition: returns a new card (or the same object when nothing changes).
   * actions: request | submit | submit_result | resolved | session_cancelled | tick
   */
  function reduceApproval(card, action, now = Date.now()) {
    if (!card || !action) return card;
    switch (action.type) {
      case 'request': {
        if (isApprovalFinal(card) || card.status === 'submitting') return card;
        const ev = action.ev || {};
        return {
          ...card,
          observing: false,
          action: str(ev.action) || card.action,
          risk: str(ev.risk) || card.risk,
          toolName: str(ev.toolName) || card.toolName,
          detail: normalizeApprovalDetail(ev.detail) || card.detail,
          sessionId: str(ev.sessionId) || card.sessionId,
          error: '',
        };
      }
      case 'submit': {
        if (!isApprovalInteractive(card)) return card;
        if (action.decision !== 'approved' && action.decision !== 'rejected') return card;
        return { ...card, status: 'submitting', decision: action.decision, error: '' };
      }
      case 'submit_result': {
        if (card.status !== 'submitting') return card;
        if (action.ok) return { ...card, status: card.decision };
        if (action.status === 409) return { ...card, status: 'expired', error: '' };
        return { ...card, status: 'pending', decision: null, error: action.error || '提交审批失败，请重试' };
      }
      case 'resolved': {
        // Already decided locally (our own click) or cancelled/timed out: keep the richer local state.
        if (isApprovalFinal(card) && card.status !== 'expired') return card;
        const ev = action.ev || {};
        let status;
        if (ev.decision === 'cancelled') status = 'cancelled';
        else if (ev.decision === 'approved') status = 'approved';
        else if (ev.reason === 'timeout') status = 'timeout';
        else status = 'rejected';
        return {
          ...card,
          status,
          observing: false,
          resolvedReason: str(ev.reason) || null,
          error: '',
        };
      }
      case 'session_cancelled': {
        if (card.status !== 'pending' && card.status !== 'submitting') return card;
        if (action.sessionId && card.sessionId && card.sessionId !== action.sessionId) return card;
        return { ...card, status: 'cancelled', observing: false };
      }
      case 'tick': {
        const at = typeof action.now === 'number' ? action.now : now;
        if (card.status === 'pending' && at >= card.expiresAt) {
          return { ...card, status: 'timeout', observing: false };
        }
        return card;
      }
      default:
        return card;
    }
  }

  function approvalStatusText(card) {
    switch (card.status) {
      case 'pending':
        if (card.observing) return '等待另一个界面（标签页）处理这个审批…';
        return card.error || '';
      case 'submitting': return '提交中…';
      case 'approved': return '已允许';
      case 'rejected': return '已拒绝';
      case 'cancelled': return '会话已取消，审批自动失效';
      case 'timeout': return '已超时，按拒绝处理';
      case 'expired': return '该审批已失效或已被其他界面处理';
      default: return '';
    }
  }

  /**
   * Human text for a card's `risk`. Permission relay sends a level
   * ('medium'); older callers send a sentence, which is passed through as-is.
   */
  function approvalRiskText(risk) {
    const text = str(risk);
    if (!text) return '';
    switch (text.toLowerCase()) {
      case 'low': return '风险：低';
      case 'medium': return '风险：中';
      case 'high': return '风险：高';
      default: return text;
    }
  }

  // ----------------------------------------------------------------- status

  /**
   * One status line for the side panel. Returns { tone: ok|warn|error|idle, text, key }.
   * ctx: { bridge: connected|connecting|disconnected, activeClient, authRequired, agentLabel }
   */
  function statusModel(ctx = {}) {
    const agent = ctx.agentLabel || 'Claude Code';
    if (ctx.bridge === 'disconnected') {
      return { key: 'offline', tone: 'error', text: errorInfo('bridge_offline').text };
    }
    if (ctx.bridge === 'connecting') {
      // Retrying after a failed attempt means the bridge is most likely not running.
      if (ctx.retrying) return { key: 'offline', tone: 'error', text: errorInfo('bridge_offline').text };
      return { key: 'connecting', tone: 'warn', text: '连接桥接服务中…' };
    }
    if (ctx.authRequired) return { key: 'auth', tone: 'error', text: errorInfo('auth_required').text };
    if (!ctx.activeClient) return { key: 'inactive', tone: 'warn', text: '未接管当前标签：点击“连接当前页”' };
    return { key: 'ready', tone: 'ok', text: `${agent} 已接管` };
  }

  const api = {
    APPROVAL_TIMEOUT_MS,
    BRIDGE_START_COMMAND,
    escapeHtml,
    truncateText,
    errorInfo,
    parseProxyResponse,
    failureInfo,
    errorEventInfo,
    promptContextModel,
    createApproval,
    approvalMessageId,
    reduceApproval,
    isApprovalFinal,
    isApprovalInteractive,
    approvalStatusText,
    approvalRiskText,
    statusModel,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.bridgeCore = api;
  }
})();
