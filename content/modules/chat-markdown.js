/**
 * DevTailor — Chat Markdown Renderer
 *
 * Renders assistant markdown through vendored marked plus a small allowlist
 * sanitizer. Falls back to basic markdown when marked is unavailable.
 *
 * Registers: window.__domReview.chatMarkdown
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function render(markdown) {
    if (window.marked && typeof window.marked.parse === 'function') {
      try {
        const html = window.marked.parse(String(markdown || ''), {
          gfm: true,
          breaks: true,
        });
        return sanitize(html);
      } catch (e) {
        console.warn('[DevTailor] marked render failed:', e);
      }
    }
    return renderBasic(markdown);
  }

  function sanitize(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const allowedTags = new Set([
      'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'HR', 'IMG', 'LI', 'OL',
      'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
      'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
    ]);

    function isSafeUrl(value) {
      if (!value) return false;
      try {
        const url = new URL(value, location.href);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol);
      } catch {
        return false;
      }
    }

    function isSafeImageSrc(value) {
      if (!value) return false;
      if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(value)) return true;
      return isSafeUrl(value);
    }

    function clean(node) {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child.remove();
          continue;
        }

        const tag = child.tagName;
        if (!allowedTags.has(tag)) {
          child.replaceWith(document.createTextNode(child.textContent || ''));
          continue;
        }

        if (tag === 'A') {
          const href = child.getAttribute('href');
          for (const attr of Array.from(child.attributes)) {
            child.removeAttribute(attr.name);
          }
          if (isSafeUrl(href)) {
            child.setAttribute('href', href);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noreferrer');
          }
        } else if (tag === 'IMG') {
          const src = child.getAttribute('src');
          const alt = child.getAttribute('alt') || '';
          for (const attr of Array.from(child.attributes)) {
            child.removeAttribute(attr.name);
          }
          if (isSafeImageSrc(src)) {
            child.setAttribute('src', src);
            child.setAttribute('alt', alt);
          } else {
            child.remove();
            continue;
          }
        } else if (tag === 'CODE') {
          const className = child.getAttribute('class') || '';
          for (const attr of Array.from(child.attributes)) {
            child.removeAttribute(attr.name);
          }
          const language = className.match(/\blanguage-[a-z0-9_-]+\b/i);
          if (language) child.setAttribute('class', language[0]);
        } else {
          for (const attr of Array.from(child.attributes)) {
            child.removeAttribute(attr.name);
          }
        }

        clean(child);
      }
    }

    clean(template.content);
    return template.innerHTML;
  }

  function renderBasic(markdown) {
    const source = String(markdown || '');
    const codeBlocks = [];
    let text = source.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
      const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
      codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
      return token;
    });

    const lines = text.split(/\n/);
    const parts = [];
    let list = [];

    function flushList() {
      if (!list.length) return;
      parts.push(`<ul>${list.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      list = [];
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushList();
        continue;
      }

      const codeToken = line.match(/^@@CODE_BLOCK_(\d+)@@$/);
      if (codeToken) {
        flushList();
        parts.push(codeBlocks[Number(codeToken[1])] || '');
        continue;
      }

      const listItem = line.match(/^[-*]\s+(.+)$/);
      if (listItem) {
        list.push(listItem[1]);
        continue;
      }

      flushList();
      parts.push(`<p>${renderInline(line)}</p>`);
    }

    flushList();
    return parts.join('');
  }

  function renderInline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  window.__domReview.chatMarkdown = {
    render,
    sanitize,
    renderBasic,
  };
})();
