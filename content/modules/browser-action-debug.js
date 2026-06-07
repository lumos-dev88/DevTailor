/**
 * DevTailor — Enhanced Debugging for Browser Actions
 *
 * Provides detailed diagnostics when element finding fails:
 * - Why the element wasn't found
 * - Similar selectors that do exist
 * - Visibility/interactability issues
 * - Helpful suggestions
 *
 * Registers: window.__domReview.browserDebug
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const MAX_SUGGESTIONS = 5;

  /**
   * Calculate string similarity (Levenshtein distance)
   */
  function stringSimilarity(a, b) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1.0;
    const editDistance = levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Find similar selectors that exist in the page
   */
  function findSimilarSelectors(targetSelector) {
    const suggestions = [];
    const dom = window.__domReview.browserActionDom;

    // Try variations of the selector
    const variations = generateSelectorVariations(targetSelector);

    for (const variant of variations) {
      try {
        const elements = document.querySelectorAll(variant);
        if (elements.length > 0) {
          const similarity = stringSimilarity(targetSelector, variant);
          suggestions.push({
            selector: variant,
            count: elements.length,
            similarity,
            visible: Array.from(elements).filter(el => dom?.isVisible?.(el)).length
          });
        }
      } catch {
        // Invalid selector, skip
      }
    }

    // Sort by similarity
    suggestions.sort((a, b) => b.similarity - a.similarity);
    return suggestions.slice(0, MAX_SUGGESTIONS);
  }

  /**
   * Generate selector variations (case, quotes, etc.)
   */
  function generateSelectorVariations(selector) {
    const variations = new Set();

    // Original
    variations.add(selector);

    // Try without quotes
    variations.add(selector.replace(/['"]/g, ''));

    // Try with different quotes
    variations.add(selector.replace(/"/g, "'"));
    variations.add(selector.replace(/'/g, '"'));

    // Try case-insensitive attribute selectors
    const attrMatch = /\[([^=]+)=["']([^"']+)["']\]/g;
    let match;
    while ((match = attrMatch.exec(selector)) !== null) {
      const attr = match[1];
      const value = match[2];
      variations.add(selector.replace(match[0], `[${attr}="${value.toLowerCase()}"]`));
      variations.add(selector.replace(match[0], `[${attr}="${value.toUpperCase()}"]`));
    }

    // Try with wildcard
    if (selector.includes('=')) {
      variations.add(selector.replace(/=["']([^"']+)["']/, '*="$1"'));
    }

    // Try removing :nth-child
    if (selector.includes(':nth-child')) {
      variations.add(selector.replace(/:nth-child\(\d+\)/g, ''));
    }

    // Try simpler class selector
    const classMatch = /\.([a-zA-Z0-9_-]+)/g;
    const classes = [];
    let classMatchResult;
    while ((classMatchResult = classMatch.exec(selector)) !== null) {
      classes.push(classMatchResult[1]);
    }
    if (classes.length > 1) {
      classes.forEach(cls => variations.add(`.${cls}`));
    }

    return Array.from(variations);
  }

  /**
   * Diagnose why a selector failed
   */
  function diagnoseSelectorFailure(selector) {
    const diagnosis = {
      selector,
      found: false,
      reason: null,
      details: null,
      suggestions: []
    };

    // 1. Check if selector syntax is valid
    try {
      document.querySelector(selector);
    } catch (e) {
      diagnosis.reason = 'invalid_selector';
      diagnosis.details = {
        error: e.message,
        explanation: 'CSS 选择器语法错误'
      };
      return diagnosis;
    }

    // 2. Check if elements exist (even if not visible)
    const elements = document.querySelectorAll(selector);

    if (elements.length === 0) {
      diagnosis.reason = 'not_found';
      diagnosis.details = {
        explanation: '页面中不存在匹配该选择器的元素'
      };

      // Find similar selectors
      const similar = findSimilarSelectors(selector);
      if (similar.length > 0) {
        diagnosis.suggestions = similar.map(s => ({
          type: 'similar_selector',
          message: `类似的选择器 "${s.selector}" 找到 ${s.count} 个元素（${s.visible} 个可见）`,
          selector: s.selector,
          count: s.count,
          visible: s.visible
        }));
      }

      // Check if it's a timing issue
      diagnosis.suggestions.push({
        type: 'timing',
        message: '如果元素是动态加载的，尝试添加 wait_for_selector 步骤'
      });

      return diagnosis;
    }

    // 3. Elements exist but might not be visible
    diagnosis.found = true;
    diagnosis.elementCount = elements.length;

    const dom = window.__domReview.browserActionDom;
    const visibleElements = Array.from(elements).filter(el => {
      return dom?.isVisible?.(el) ?? (
        el.offsetWidth > 0 &&
        el.offsetHeight > 0 &&
        getComputedStyle(el).visibility !== 'hidden' &&
        getComputedStyle(el).display !== 'none'
      );
    });

    if (visibleElements.length === 0) {
      diagnosis.reason = 'not_visible';
      diagnosis.details = {
        total: elements.length,
        visible: 0,
        explanation: `找到 ${elements.length} 个元素，但都不可见`
      };

      // Diagnose why not visible
      const firstEl = elements[0];
      const style = getComputedStyle(firstEl);
      const hiddenReasons = [];

      if (style.display === 'none') hiddenReasons.push('display: none');
      if (style.visibility === 'hidden') hiddenReasons.push('visibility: hidden');
      if (parseFloat(style.opacity) === 0) hiddenReasons.push('opacity: 0');
      if (firstEl.offsetWidth === 0 || firstEl.offsetHeight === 0) {
        hiddenReasons.push('宽度或高度为 0');
      }

      const rect = firstEl.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        hiddenReasons.push('元素在视口上方或下方');
      }
      if (rect.right < 0 || rect.left > window.innerWidth) {
        hiddenReasons.push('元素在视口左侧或右侧');
      }

      if (hiddenReasons.length > 0) {
        diagnosis.details.hiddenReasons = hiddenReasons;
        diagnosis.suggestions.push({
          type: 'visibility',
          message: `元素不可见的原因: ${hiddenReasons.join(', ')}`
        });
      }

      // Check if in a portal/dialog
      const portal = firstEl.closest('[role="dialog"], [popover], dialog, [data-radix-portal]');
      if (portal && !dom?.isVisible?.(portal)) {
        diagnosis.suggestions.push({
          type: 'portal',
          message: '元素在一个隐藏的弹窗或对话框中，可能需要先打开该弹窗'
        });
      }

      return diagnosis;
    }

    // 4. Elements exist and visible but might not be interactable
    const interactableElements = visibleElements.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight &&
             rect.bottom > 0 &&
             rect.left < window.innerWidth &&
             rect.right > 0 &&
             !el.disabled &&
             el.getAttribute('aria-disabled') !== 'true';
    });

    if (interactableElements.length === 0) {
      diagnosis.reason = 'not_interactable';
      diagnosis.details = {
        total: elements.length,
        visible: visibleElements.length,
        interactable: 0,
        explanation: `找到 ${elements.length} 个元素，${visibleElements.length} 个可见，但都不可交互`
      };

      // Check if disabled
      const firstVisible = visibleElements[0];
      if (firstVisible.disabled || firstVisible.getAttribute('aria-disabled') === 'true') {
        diagnosis.suggestions.push({
          type: 'disabled',
          message: '元素被禁用 (disabled 或 aria-disabled="true")'
        });
      }

      // Check if outside viewport
      const rect = firstVisible.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight ||
          rect.right < 0 || rect.left > window.innerWidth) {
        diagnosis.suggestions.push({
          type: 'viewport',
          message: '元素在视口之外，可能需要先滚动到该元素'
        });
      }

      return diagnosis;
    }

    // 5. All good!
    diagnosis.reason = 'ok';
    diagnosis.details = {
      total: elements.length,
      visible: visibleElements.length,
      interactable: interactableElements.length,
      explanation: `找到 ${interactableElements.length} 个可交互元素`
    };

    return diagnosis;
  }

  /**
   * Diagnose text-based locator failure
   */
  function diagnoseTextLocatorFailure(text, options = {}) {
    const diagnosis = {
      text,
      found: false,
      reason: null,
      details: null,
      suggestions: []
    };

    const dom = window.__domReview.browserActionDom;
    const INTERACTIVE_SELECTOR = 'button,a,input,textarea,select,[role="button"],[role="link"],[tabindex]';

    // Find all interactive elements
    const interactiveElements = document.querySelectorAll(INTERACTIVE_SELECTOR);
    const normalizedTarget = text.toLowerCase().trim();

    // Find elements with similar text
    const matches = [];
    for (const el of interactiveElements) {
      const elText = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
      if (elText.includes(normalizedTarget)) {
        const visible = dom?.isVisible?.(el) ?? (el.offsetWidth > 0 && el.offsetHeight > 0);
        matches.push({
          element: el,
          text: elText,
          visible,
          similarity: stringSimilarity(normalizedTarget, elText)
        });
      }
    }

    if (matches.length === 0) {
      diagnosis.reason = 'not_found';
      diagnosis.details = {
        explanation: `页面中找不到包含文本 "${text}" 的可交互元素`
      };

      // Find partial matches
      const partialMatches = [];
      for (const el of interactiveElements) {
        const elText = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
        const similarity = stringSimilarity(normalizedTarget, elText);
        if (similarity > 0.5) {
          partialMatches.push({ text: elText.slice(0, 50), similarity });
        }
      }

      if (partialMatches.length > 0) {
        partialMatches.sort((a, b) => b.similarity - a.similarity);
        diagnosis.suggestions = partialMatches.slice(0, 3).map(m => ({
          type: 'similar_text',
          message: `相似的文本: "${m.text}"`
        }));
      }

      return diagnosis;
    }

    // Found matches but not visible
    matches.sort((a, b) => b.similarity - a.similarity);
    const visibleMatches = matches.filter(m => m.visible);

    if (visibleMatches.length === 0) {
      diagnosis.found = true;
      diagnosis.reason = 'not_visible';
      diagnosis.details = {
        total: matches.length,
        visible: 0,
        explanation: `找到 ${matches.length} 个匹配的元素，但都不可见`
      };
      diagnosis.suggestions.push({
        type: 'visibility',
        message: '元素存在但不可见，可能需要先展开菜单或对话框'
      });
      return diagnosis;
    }

    diagnosis.found = true;
    diagnosis.reason = 'ok';
    diagnosis.details = {
      total: matches.length,
      visible: visibleMatches.length,
      explanation: `找到 ${visibleMatches.length} 个可见的匹配元素`
    };

    return diagnosis;
  }

  /**
   * Create enhanced error with diagnostics
   */
  function createDiagnosticError(message, diagnosis) {
    const err = new Error(message);
    err.code = 'ELEMENT_NOT_FOUND';
    err.diagnosis = diagnosis;

    // Build helpful error message
    const parts = [message];

    if (diagnosis.reason) {
      parts.push(`\n原因: ${diagnosis.reason}`);
    }

    if (diagnosis.details) {
      if (diagnosis.details.explanation) {
        parts.push(`详情: ${diagnosis.details.explanation}`);
      }
      if (diagnosis.details.hiddenReasons) {
        parts.push(`隐藏原因: ${diagnosis.details.hiddenReasons.join(', ')}`);
      }
    }

    if (diagnosis.suggestions && diagnosis.suggestions.length > 0) {
      parts.push('\n建议:');
      diagnosis.suggestions.forEach((sug, i) => {
        parts.push(`  ${i + 1}. ${sug.message}`);
      });
    }

    err.message = parts.join('\n');
    return err;
  }

  window.__domReview.browserDebug = {
    diagnoseSelectorFailure,
    diagnoseTextLocatorFailure,
    createDiagnosticError,
    stringSimilarity,
    findSimilarSelectors,
  };
})();
