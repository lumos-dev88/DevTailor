/**
 * DevTailor — VisBug-style Hit Test Module
 *
 * Shared fine-grained DOM picking for hover selection, mark badges, and
 * persistent highlights. Inspired by VisBug's deep elementFromPoint approach.
 *
 * Registers: window.__domReview.hitTest
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'HTML', 'BODY', 'NOSCRIPT', 'TEMPLATE']);
  const COARSE_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FORM', 'UL', 'OL', 'LI']);
  const TEXT_TAGS = new Set(['A', 'BUTTON', 'LABEL', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH']);
  const MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'VIDEO', 'CANVAS', 'SVG']);
  const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
  const MIN_AREA = 4;
  const MAX_DESCENDANT_SCAN = 900;
  const MAX_DESCENDANT_ROOTS = 6;

  function isOwnElement(el) {
    let node = el;
    while (node) {
      if (
        node.id === 'dom-review-host' ||
        node.id === 'dom-review-badges' ||
        node.id === 'dom-review-selector-overlay' ||
        node.id === 'dom-review-selector-hint' ||
        node.id === 'dom-review-highlights' ||
        node.id === 'devtailor-host' ||
        node.id === 'devtailor-badges' ||
        node.id === 'devtailor-highlights'
      ) {
        return true;
      }
      node = node.parentElement || (node.getRootNode && node.getRootNode() !== document ? node.getRootNode().host : null);
    }
    return false;
  }

  function isSelectable(el, options = {}) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (IGNORE_TAGS.has(el.tagName)) return false;
    if (isOwnElement(el)) return false;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width * rect.height < MIN_AREA) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (!options.allowPointerEventsNone && style.pointerEvents === 'none') return false;
    return true;
  }

  function rectContainsPoint(rect, x, y) {
    return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y;
  }

  function getDepth(el) {
    let depth = 0;
    let node = el;
    while (node) {
      depth += 1;
      node = node.parentElement || (node.getRootNode && node.getRootNode() !== document ? node.getRootNode().host : null);
    }
    return depth;
  }

  function hasMeaningfulText(el) {
    return Boolean((el.innerText || el.textContent || '').trim());
  }

  function hasElementChildren(el) {
    return Array.prototype.some.call(el.children || [], child => isSelectable(child));
  }

  function isInteractive(el) {
    const role = el.getAttribute('role');
    return FORM_TAGS.has(el.tagName)
      || el.tagName === 'BUTTON'
      || el.tagName === 'A'
      || el.hasAttribute('onclick')
      || el.hasAttribute('contenteditable')
      || ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch'].includes(role);
  }

  function addCandidate(list, seen, el, options) {
    if (!isSelectable(el, options) || seen.has(el)) return;
    seen.add(el);
    list.push(el);
  }

  function addAncestors(list, seen, el) {
    let node = el;
    while (node && node !== document.documentElement) {
      addCandidate(list, seen, node);
      node = node.parentElement || (node.getRootNode && node.getRootNode() !== document ? node.getRootNode().host : null);
    }
  }

  function deepElementFromPoint(root, x, y) {
    let el = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y);

    while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }

    return el;
  }

  function addDescendantsAtPoint(list, seen, root, x, y) {
    if (!root || !root.querySelectorAll) return;
    const rootRect = root.getBoundingClientRect();
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    if (rootRect.width * rootRect.height > viewportArea * 0.92) return;

    let scanned = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode() && scanned < MAX_DESCENDANT_SCAN) {
      scanned += 1;
      const el = walker.currentNode;
      if (seen.has(el) || !isSelectable(el, { allowPointerEventsNone: true })) continue;
      if (rectContainsPoint(el.getBoundingClientRect(), x, y)) {
        addCandidate(list, seen, el, { allowPointerEventsNone: true });
      }
    }
  }

  function collectCandidatesFromPoint(x, y) {
    const list = [];
    const seen = new Set();
    const roots = [];
    const direct = deepElementFromPoint(document, x, y);

    addAncestors(list, seen, direct);
    if (direct) roots.push(direct);

    document.elementsFromPoint(x, y).forEach(el => {
      addAncestors(list, seen, el);
      if (roots.length < MAX_DESCENDANT_ROOTS) roots.push(el);
    });

    roots
      .filter((el, index, arr) => el && arr.indexOf(el) === index)
      .forEach(el => addDescendantsAtPoint(list, seen, el, x, y));

    return list;
  }

  function scoreCandidate(el, x, y, index) {
    const rect = el.getBoundingClientRect();
    const area = Math.max(1, rect.width * rect.height);
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const centerDistance = Math.hypot(centerX - x, centerY - y);
    const depth = getDepth(el);
    const children = Array.from(el.children || []).filter(child => {
      if (!isSelectable(child)) return false;
      return rectContainsPoint(child.getBoundingClientRect(), x, y);
    });

    let score = 0;
    score += Math.max(0, 80 - index * 5);
    score += depth * 4;
    score += Math.max(0, 90 - Math.log(area) * 10);
    score += Math.max(0, 28 - centerDistance / 8);

    if (area > viewportArea * 0.55) score -= 130;
    if (area > viewportArea * 0.25) score -= 50;
    if (children.length === 0) score += 36;
    if (children.length > 2 && COARSE_TAGS.has(el.tagName)) score -= 36;
    if (COARSE_TAGS.has(el.tagName) && hasElementChildren(el)) score -= 16;
    if (TEXT_TAGS.has(el.tagName) && hasMeaningfulText(el)) score += 22;
    if (MEDIA_TAGS.has(el.tagName) || FORM_TAGS.has(el.tagName)) score += 24;
    if (isInteractive(el)) score += 12;
    if (el.id || (el.classList && el.classList.length)) score += 6;

    return score;
  }

  function chooseCandidate(candidates, x, y) {
    if (!candidates.length) return null;
    return candidates
      .map((el, index) => ({ el, score: scoreCandidate(el, x, y, index) }))
      .sort((a, b) => b.score - a.score)[0].el;
  }

  function pick(x, y) {
    const candidates = collectCandidatesFromPoint(x, y);
    return {
      element: chooseCandidate(candidates, x, y),
      candidates,
    };
  }

  function resolveSelector(selector) {
    if (!selector) return null;
    try {
      const el = document.querySelector(selector);
      return isSelectable(el, { allowPointerEventsNone: true }) ? el : null;
    } catch {
      return null;
    }
  }

  function getRect(el) {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  window.__domReview.hitTest = {
    pick,
    getRect,
    isOwnElement,
    isSelectable,
    resolveSelector,
  };
})();
