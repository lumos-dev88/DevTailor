/**
 * DevTailor — Prompt Builder Module
 *
 * Pure function module. Assembles mark data + screenshot + user text
 * into a structured payload for the bridge.
 *
 * System prompt (browser tools, workflow guidelines) is injected once
 * in the local bridge runtime. This module only
 * handles user-level dynamic data.
 *
 * The side panel asks the content script for `buildParts` (the page-owned part of a /review
 * payload: { pageUrl, items, screenshots }) and adds the user's text itself.
 *
 * Browser: window.__domReview.promptBuilder. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const MAX_OUTER_HTML = 2000;
  const MAX_TEXT = 200;

  const RELEVANT_STYLES = new Set([
    'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
    'padding', 'margin', 'display', 'position', 'border', 'borderRadius',
    'opacity', 'width', 'height', 'lineHeight', 'textAlign', 'boxShadow'
  ]);

  function truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str || '';
    return str.slice(0, maxLen) + '…';
  }

  function formatStyles(styles) {
    if (!styles) return '';
    const lines = [];
    for (const [key, value] of Object.entries(styles)) {
      if (!RELEVANT_STYLES.has(key)) continue;
      if (!value || value === 'none' || value === 'normal' || value === '0px') continue;
      if (key === 'color' && value === 'rgb(0, 0, 0)') continue;
      if (key === 'backgroundColor' && value === 'rgba(0, 0, 0, 0)') continue;
      lines.push(`  - ${key}: ${value}`);
    }
    return lines.join('\n');
  }

  function formatMark(mark, index) {
    const ctx = mark.context || {};
    const styles = formatStyles(ctx.styles);
    const outerHTML = truncate(ctx.outerHTML, MAX_OUTER_HTML);
    const text = truncate(ctx.text, MAX_TEXT);

    let body = `### Element ${index}\n`;
    body += `- **Selector**: \`${mark.selector}\`\n`;
    if (mark.xpath) body += `- **XPath**: \`${mark.xpath}\`\n`;
    body += `- **Comment**: ${mark.comment || '(no comment)'}\n`;
    if (text) body += `- **Text**: "${text}"\n`;
    if (outerHTML) body += `- **Outer HTML**: \`\`\`html\n${outerHTML}\n\`\`\`\n`;
    if (styles) body += `- **Computed Styles**:\n${styles}\n`;
    if (ctx.boundingBox) {
      const b = ctx.boundingBox;
      body += `- **Bounding Box**: x=${b.x}, y=${b.y}, w=${b.w}, h=${b.h}\n`;
    }
    if (ctx.framework) {
      const fw = ctx.framework;
      if (fw.framework) body += `- **Framework**: ${fw.framework}`;
      if (fw.componentName) body += ` / ${fw.componentName}`;
      body += '\n';
    }
    return body;
  }

  function normalizeImages(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
  }

  function currentHref() {
    return typeof location !== 'undefined' ? location.href : '';
  }

  /** Page-owned part of a review payload. `index` is the mark's badge number on the page. */
  function buildParts(marks, imagesInput, options = {}) {
    const images = normalizeImages(imagesInput);
    const items = (Array.isArray(marks) ? marks : []).map((mark, idx) => {
      const ctx = mark.context || {};
      return {
        index: mark.index || idx + 1,
        selector: mark.selector,
        xpath: mark.xpath || '',
        outerHTML: truncate(ctx.outerHTML || '', MAX_OUTER_HTML),
        computedStyle: ctx.styles || {},
        annotation: mark.comment || '',
        text: truncate(ctx.text || '', MAX_TEXT),
        boundingBox: ctx.boundingBox || null,
        framework: ctx.framework || null,
      };
    });
    return { pageUrl: options.pageUrl || currentHref(), items, screenshots: images };
  }

  function buildPayload(marks, userText, imagesInput) {
    const intent = (userText || '').trim() || '';
    const parts = buildParts(marks, imagesInput);
    return {
      type: 'review',
      payload: {
        pageUrl: parts.pageUrl,
        userIntent: intent,
        items: parts.items,
        screenshots: parts.screenshots,
        screenshot: parts.screenshots[0] || null,
      }
    };
  }

  const api = { buildParts, buildPayload, formatMark };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.promptBuilder = api;
  }
})();
