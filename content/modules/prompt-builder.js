/**
 * DevTailor — Prompt Builder Module
 *
 * Pure function module. Assembles mark data + screenshot + user text
 * into a structured payload for the bridge.
 *
 * System prompt (browser tools, workflow guidelines) is injected once
 * at ACP session creation in devtailor-bridge. This module only
 * handles user-level dynamic data.
 *
 * Registers: window.__domReview.promptBuilder
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

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

  /**
   * Build a plain-text prompt from marks + user text + images.
   * Used as a fallback / export format. System instructions are
   * handled by the bridge at session creation — this only
   * assembles the user-level dynamic content.
   */
  function build(marks, userText, imagesInput) {
    const images = normalizeImages(imagesInput);
    const count = marks.length;
    const intent = (userText || '').trim() || '(No additional description provided)';

    let prompt = `## Current Page\nURL: ${location.href}\n\n`;
    prompt += `## User Intent\n${intent}\n\n`;
    prompt += `## Marked Elements (${count} total)\n\n`;

    marks.forEach((mark, idx) => {
      prompt += formatMark(mark, idx + 1) + '\n';
    });

    if (images.length) {
      prompt += `## Screenshots (${images.length})\n`;
      prompt += `The screenshots/images are attached as data URLs below:\n\n`;
      images.forEach((image, idx) => {
        prompt += `### Image ${idx + 1}\n`;
        prompt += `\`\`\`text\n${image}\n\`\`\`\n\n`;
      });
    }

    return prompt;
  }

  function buildPayload(marks, userText, imagesInput) {
    const intent = (userText || '').trim() || '';
    const images = normalizeImages(imagesInput);

    const items = marks.map((mark, idx) => {
      const ctx = mark.context || {};
      return {
        index: idx + 1,
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

    return {
      type: 'review',
      payload: {
        pageUrl: location.href,
        userIntent: intent,
        items,
        screenshots: images,
        screenshot: images[0] || null,
      }
    };
  }

  window.__domReview.promptBuilder = { build, buildPayload };
})();
