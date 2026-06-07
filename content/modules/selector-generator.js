/**
 * DevTailor — Selector Generator Module
 *
 * Pure utility module. Generates unique CSS selectors and XPath
 * for DOM elements.
 *
 * Registers: window.__domReview.selectorGen
 * Public API: generate(element) -> { css, xpath }
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const MAX_DEPTH = 10;

  // Matches Tailwind / Bootstrap / common utility class prefixes
  const UTILITY_REGEX = /^(mt-|mb-|ml-|mr-|mx-|my-|pt-|pb-|pl-|pr-|px-|py-|p-\d|m-\d|w-|h-|min-w-|min-h-|max-w-|max-h-|flex|grid|text-|bg-|border-|rounded|shadow|opacity-|overflow-|z-|gap-|space-|col-|row-|hidden|block|inline|absolute|relative|fixed|sticky|sr-only|dark:|hover:|focus:|lg:|md:|sm:|xl:|2xl:|xs:)/;

  function isUtilityClass(className) {
    return UTILITY_REGEX.test(className);
  }

  /**
   * Generate a unique CSS selector for the given element.
   */
  function generateCSS(el) {
    if (!el || el === document.documentElement) return 'html';
    if (el === document.body) return 'body';

    // Fast path: element has a meaningful id
    if (el.id && !el.id.startsWith('dom-review')) {
      try {
        const sel = `#${CSS.escape(el.id)}`;
        if (document.querySelector(sel) === el) return sel;
      } catch { /* invalid id for CSS */ }
    }

    const parts = [];
    let current = el;
    let depth = 0;

    while (current && current !== document.body && depth < MAX_DEPTH) {
      let part = current.tagName.toLowerCase();

      // Stop at an element with id
      if (current.id && !current.id.startsWith('dom-review')) {
        try {
          parts.unshift(`#${CSS.escape(current.id)}`);
          break;
        } catch { /* fall through */ }
      }

      // Add meaningful (non-utility) classes, max 2
      const meaningful = Array.from(current.classList || [])
        .filter(c => c && !isUtilityClass(c))
        .slice(0, 2);

      if (meaningful.length) {
        part += '.' + meaningful.map(c => CSS.escape(c)).join('.');
      }

      // Add nth-of-type if there are same-tag siblings
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(s => s.tagName === current.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(current) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
      depth++;
    }

    const selector = parts.join(' > ');

    // Verify uniqueness
    try {
      if (document.querySelector(selector) === el) return selector;
    } catch { /* invalid selector */ }

    // Fallback: build full path with nth-of-type on every level
    return generateFallback(el);
  }

  /**
   * Fallback: full path selector with nth-of-type at every level.
   */
  function generateFallback(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(s => s.tagName === current.tagName);
        const idx = sameTag.indexOf(current) + 1;
        part += `:nth-of-type(${idx})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  }

  /**
   * Generate an XPath for the given element.
   */
  function generateXPath(el) {
    if (!el) return '';
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let idx = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) idx++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  /**
   * Public API: generate both CSS selector and XPath.
   */
  function generate(element) {
    return {
      css: generateCSS(element),
      xpath: generateXPath(element)
    };
  }

  window.__domReview.selectorGen = { generate };
})();
