/**
 * DevTailor — Context Capture Module
 *
 * Pure utility module. Captures computed styles, bounding box,
 * and accessibility attributes from a DOM element.
 *
 * Registers: window.__domReview.contextCapture
 * Public API: capture(element) -> ContextObject
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function fallback() {
    return {
      tagName: 'unknown',
      text: '',
      boundingBox: { x: 0, y: 0, w: 0, h: 0 },
      styles: {},
      a11y: { role: 'unknown', label: '' },
      framework: null
    };
  }

  function capture(element) {
    if (!element) return fallback();

    try {
      const computed = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      const outerHTML = element.outerHTML || '';

      return {
        tagName: element.tagName.toLowerCase(),
        text: (element.textContent || '').trim().substring(0, 100),
        outerHTML: outerHTML.length > 2000 ? outerHTML.substring(0, 2000) + '…' : outerHTML,
        boundingBox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        styles: {
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          padding: computed.padding,
          margin: computed.margin,
          display: computed.display,
          position: computed.position,
          border: computed.border,
          borderRadius: computed.borderRadius,
          opacity: computed.opacity
        },
        a11y: {
          role: element.getAttribute('role') || element.tagName.toLowerCase(),
          label: element.getAttribute('aria-label')
                 || element.getAttribute('alt')
                 || (element.textContent || '').trim().substring(0, 50),
          ariaDescribedby: element.getAttribute('aria-describedby'),
          ariaExpanded: element.getAttribute('aria-expanded'),
          tabIndex: element.getAttribute('tabindex')
        },
        framework: window.__domReview.frameworkDetector
          ? window.__domReview.frameworkDetector.detect(element)
          : null
      };
    } catch (_err) {
      return fallback();
    }
  }

  window.__domReview.contextCapture = { capture };
})();
