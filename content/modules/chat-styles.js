/**
 * DevTailor — shared styles for the chat components
 *
 * One stylesheet for the permission card, notices, tool diff/console content and
 * history styling. It only uses the design tokens
 * both surfaces define (--dt-text-primary / --dt-text-secondary / --dt-text-muted /
 * --dt-accent / --dt-font-mono) plus translucent greys. Only the side panel uses it now
 * (sidepanel.js injects it into <head>); chat is no longer rendered on the page.
 *
 * Browser: window.__domReview.chatStyles.css. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const css = `
/* ---- history (weakened, no new colour system) ---- */
.dt-is-history { opacity: 0.72; }
.dt-is-history:hover { opacity: 1; }

/* ---- notices ---- */
.dt-notice {
  align-self: flex-start;
  max-width: 96%;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(127,127,127,0.25);
  background: rgba(127,127,127,0.08);
  color: var(--dt-text-secondary, #475569);
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}
.dt-notice code { font-family: var(--dt-font-mono, monospace); font-size: 11px; padding: 0 4px; border-radius: 3px; background: rgba(127,127,127,0.18); }
.dt-notice--error { border-color: rgba(239,68,68,0.45); background: rgba(239,68,68,0.10); color: #dc2626; }
.dt-notice--warn { border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.10); color: #b45309; }
.dt-notice--info { border-color: rgba(59,130,246,0.35); background: rgba(59,130,246,0.08); }
.dt-notice--muted { background: transparent; border-style: dashed; }

/* ---- permission approval card ---- */
.dt-approval-card {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid rgba(245,158,11,0.55);
  background: rgba(245,158,11,0.08);
  color: var(--dt-text-primary, #1f2937);
  font-size: 12px;
  line-height: 1.5;
}
.dt-approval-card.is-observing,
.dt-approval-card--approved,
.dt-approval-card--rejected,
.dt-approval-card--cancelled,
.dt-approval-card--timeout,
.dt-approval-card--expired { border-color: rgba(127,127,127,0.3); background: rgba(127,127,127,0.07); }
.dt-approval-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dt-approval-badge { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; background: rgba(245,158,11,0.22); color: #b45309; font-size: 10.5px; font-weight: 600; }
.dt-approval-tool { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--dt-text-primary, #1f2937); }
.dt-approval-action { font-family: var(--dt-font-mono, monospace); font-size: 11.5px; word-break: break-all; }
.dt-approval-path code { font-family: var(--dt-font-mono, monospace); font-size: 10.5px; color: var(--dt-text-muted, #64748b); word-break: break-all; }
.dt-approval-params {
  margin: 0; padding: 6px 8px; max-height: 120px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  border-radius: 6px; background: rgba(127,127,127,0.12); font-family: var(--dt-font-mono, monospace); font-size: 10.5px; color: var(--dt-text-secondary, #475569);
}
.dt-approval-risk { color: #b45309; font-size: 11px; }
.dt-approval-actions { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-start; margin-top: 2px; }
.dt-approval-btn {
  max-width: 100%; padding: 5px 12px; border-radius: 6px; border: 1px solid rgba(127,127,127,0.4);
  background: transparent; color: var(--dt-text-primary, #1f2937); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; text-align: left;
}
.dt-approval-btn:hover { background: rgba(127,127,127,0.15); }
.dt-approval-btn--primary { background: var(--dt-accent, #3b82f6); border-color: var(--dt-accent, #3b82f6); color: #fff; }
.dt-approval-btn--primary:hover { background: var(--dt-accent-hover, #2563eb); }
.dt-approval-note { color: var(--dt-text-secondary, #475569); font-size: 11.5px; }
.dt-approval-note--approved { color: #16a34a; }
.dt-approval-note--rejected,
.dt-approval-note--error { color: #dc2626; }
.dt-approval-note--muted { color: var(--dt-text-muted, #64748b); }

`;

  const api = { css };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.chatStyles = api;
  }
})();
