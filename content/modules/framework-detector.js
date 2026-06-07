/**
 * DevTailor — Framework Detector Module (Isolated World)
 *
 * Communicates with framework-bridge.js (MAIN world) via
 * custom DOM events and attributes to detect framework components.
 *
 * dispatchEvent is synchronous — the MAIN world listener fires
 * before dispatchEvent returns, so we can read results immediately.
 *
 * Registers: window.__domReview.frameworkDetector
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let pageFrameworksCache = null;

  function getPageFrameworks() {
    if (pageFrameworksCache) return pageFrameworksCache;
    // Ask MAIN world bridge
    document.dispatchEvent(new CustomEvent('dr-detect-page'));
    const raw = document.documentElement.getAttribute('data-dr-frameworks');
    document.documentElement.removeAttribute('data-dr-frameworks');
    pageFrameworksCache = raw ? JSON.parse(raw) : [];
    return pageFrameworksCache;
  }

  function detect(element) {
    if (!element) return null;
    const active = getPageFrameworks();
    if (active.length === 0) return null;

    // Mark target element and ask MAIN world bridge
    element.setAttribute('data-dr-detect-target', '');
    document.dispatchEvent(new CustomEvent('dr-detect-element'));
    const raw = element.getAttribute('data-dr-result');
    element.removeAttribute('data-dr-detect-target');
    element.removeAttribute('data-dr-result');

    if (!raw || raw === 'null') return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function registerAdapter() {
    console.info('[DevTailor] Custom adapters: add detection logic to framework-bridge.js (MAIN world).');
  }

  window.__domReview.frameworkDetector = {
    detect,
    getPageFrameworks,
    registerAdapter,
  };
})();
