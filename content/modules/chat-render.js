/**
 * DevTailor — shared HTML renderers (pure string builders, no DOM)
 *
 * Rendering for the side panel; the permission card, notices and tool
 * diff/console content exist exactly once. Every dynamic string goes through
 * escapeHtml; tool content is never inserted as HTML.
 *
 * Browser: window.__domReview.chatRender. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const core = (typeof module === 'object' && module.exports)
    ? require('./bridge-core.js')
    : window.__domReview.bridgeCore;
  const { escapeHtml } = core;

  /** Escape, then turn `code` spans into <code>. */
  function inlineText(text) {
    return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  /** Add the weakened "history" class to the root element of a rendered block. */
  function markHistory(html, msg) {
    if (!msg || !msg.history || typeof html !== 'string') return html;
    return html.replace(/^(\s*<[a-zA-Z0-9-]+\s+class=")/, '$1dt-is-history ');
  }

  // ------------------------------------------------------------ approvals

  function renderApprovalCard(msg) {
    const idAttr = escapeHtml(msg.id);
    const status = msg.status || 'pending';
    const detail = msg.detail || {};
    // `rawInput` is the tool-call shape; permission-relay approvals carry a plain
    // `preview` string instead (Claude Code's input_preview).
    const rawInput = detail.rawInput !== undefined ? detail.rawInput : detail.preview;
    const params = describeParams(rawInput);
    const locations = Array.isArray(detail.locations) ? detail.locations : [];
    const path = locations[0] && locations[0].path ? String(locations[0].path) : '';
    const interactive = core.isApprovalInteractive(msg);

    let footer = '';
    if (interactive) {
      footer = `<div class="dt-approval-actions">
        <button class="dt-approval-btn dt-approval-btn--primary" type="button" data-action="approval-decision" data-msg-id="${idAttr}" data-decision="approved">允许</button>
        <button class="dt-approval-btn" type="button" data-action="approval-decision" data-msg-id="${idAttr}" data-decision="rejected">拒绝</button>
      </div>`;
      if (msg.error) footer += `<div class="dt-approval-note dt-approval-note--error">${escapeHtml(msg.error)}</div>`;
    } else {
      const text = core.approvalStatusText(msg);
      const tone = status === 'approved' ? 'approved'
        : status === 'rejected' || status === 'timeout' ? 'rejected'
          : status === 'cancelled' || status === 'expired' ? 'muted' : 'wait';
      if (text) footer = `<div class="dt-approval-note dt-approval-note--${tone}">${escapeHtml(text)}</div>`;
    }

    const title = msg.action || msg.toolName || 'tool';
    return `<div class="dt-approval-card dt-approval-card--${escapeHtml(status)}${msg.observing ? ' is-observing' : ''}" data-msg-id="${idAttr}" data-approval-id="${escapeHtml(msg.approvalId)}">
      <div class="dt-approval-head">
        <span class="dt-approval-badge">需要审批</span>
        <span class="dt-approval-tool" title="${escapeHtml(msg.toolName)}">${escapeHtml(msg.toolName)}</span>
      </div>
      <div class="dt-approval-action">${escapeHtml(title)}</div>
      ${path ? `<div class="dt-approval-path"><code>${escapeHtml(path)}</code></div>` : ''}
      ${params ? `<pre class="dt-approval-params">${escapeHtml(params)}</pre>` : ''}
      ${msg.risk ? `<div class="dt-approval-risk">${escapeHtml(core.approvalRiskText(msg.risk))}</div>` : ''}
      ${footer}
    </div>`;
  }

  function describeParams(rawInput) {
    if (rawInput == null || rawInput === '') return '';
    if (typeof rawInput === 'string') return core.truncateText(rawInput, 600);
    if (typeof rawInput !== 'object') return String(rawInput);
    if (typeof rawInput.command === 'string') return core.truncateText(rawInput.command, 600);
    try { return core.truncateText(JSON.stringify(rawInput, null, 2), 600); } catch { return ''; }
  }

  // --------------------------------------------------------------- notices

  function renderNotice(msg) {
    const tone = msg.tone ? ` dt-notice--${escapeHtml(msg.tone)}` : '';
    return `<div class="dt-notice${tone}" data-msg-id="${escapeHtml(msg.id)}" role="status">${inlineText(msg.content || '')}</div>`;
  }

  const api = {
    inlineText,
    markHistory,
    renderApprovalCard,
    renderNotice,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.chatRender = api;
  }
})();
