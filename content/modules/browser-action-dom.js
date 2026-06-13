/**
 * DevTailor — Browser Action DOM Helpers
 *
 * Finds and interacts with elements in the current page for Browser MCP.
 *
 * Registers: window.__domReview.browserActionDom
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const INTERACTIVE_SELECTOR = [
    'button',
    'a',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="tab"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[tabindex]',
  ].join(',');
  const PORTAL_SURFACE_SELECTOR = [
    'dialog[open]',
    '[popover]',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="tooltip"]',
    '[role="alert"]',
    '[role="status"]',
    '[data-radix-popper-content-wrapper]',
    '[data-radix-portal]',
    '[data-headlessui-portal]',
  ].join(',');
  const MAX_INTERACTIVE_ELEMENTS = 100;
  const MAX_PORTAL_SURFACES = 20;
  const interactiveCache = new Map();
  const TEXT_INPUT_TYPES = new Set([
    '', 'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week',
  ]);
  const TEST_ID_ATTRIBUTES = ['data-ai-id', 'data-testid', 'data-test', 'data-cy', 'testid'];
  const DEVTAILOR_UI_IDS = [
    'dom-review-host',
    'dom-review-highlights',
    'dom-review-badges',
    'devtailor-host',
    'devtailor-highlights',
    'devtailor-badges',
  ];
  const DEVTAILOR_UI_SELECTOR = DEVTAILOR_UI_IDS.map(id => `#${id}`).join(', ');

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity || 1) !== 0;
  }

  function rectOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  function centerOfRect(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function elementText(el) {
    const value = el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * 文本规范化器（可配置）
   */
  const TEXT_NORMALIZERS = {
    // 默认规范化：空格 + 大小写
    default: (text) => {
      return text.replace(/\s+/g, ' ').trim().toLowerCase();
    },

    // 中文增强：统一标点 + 空格 + 大小写
    chinese: (text) => {
      return text
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/[（）]/g, m => m === '（' ? '(' : ')')
        .replace(/[【】]/g, m => m === '【' ? '[' : ']')
        .replace(/[《》]/g, m => m === '《' ? '<' : '>')
        .replace(/，/g, ',')
        .replace(/。/g, '.')
        .replace(/：/g, ':')
        .replace(/；/g, ';')
        .replace(/！/g, '!')
        .replace(/？/g, '?')
        .replace(/　/g, ' ')  // 全角空格
        .replace(/[​-‍﻿]/g, '')  // 零宽字符
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    },

    // 纯字母数字：移除所有标点
    alphanumeric: (text) => {
      return text
        .replace(/[^\w\s一-龥]/g, '')  // 保留字母、数字、中文
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    },

    // 无规范化：原样匹配
    none: (text) => text,
  };

  /**
   * 文本匹配器（支持多种策略）
   */
  function matchText(actual, expected, options = {}) {
    const {
      exact = false,
      normalizer = 'chinese',
      matcher = 'substring',
    } = options;

    // 获取规范化器
    const normalize = typeof normalizer === 'function'
      ? normalizer
      : TEXT_NORMALIZERS[normalizer] || TEXT_NORMALIZERS.default;

    // 规范化文本
    const normalizedActual = normalize(String(actual || ''));
    const normalizedExpected = normalize(String(expected || ''));

    // 应用匹配器
    if (exact) {
      return normalizedActual === normalizedExpected;
    }

    if (matcher === 'substring') {
      return normalizedActual.includes(normalizedExpected);
    }

    if (matcher === 'regex' && expected instanceof RegExp) {
      return expected.test(normalizedActual);
    }

    if (typeof matcher === 'function') {
      return matcher(normalizedActual, normalizedExpected);
    }

    return false;
  }

  function normalizedText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function stableHash(value) {
    const input = String(value || '');
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isDevTailorElement(el) {
    return Boolean(el?.closest?.(DEVTAILOR_UI_SELECTOR));
  }

  function isAnyDevTailorElement(el) {
    if (!el || !(el instanceof Element)) return false;
    if (isDevTailorElement(el)) return true;
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    if (typeof ShadowRoot === 'function' && root instanceof ShadowRoot) {
      return isDevTailorElement(root.host);
    }
    return false;
  }

  function devTailorUiElements() {
    return DEVTAILOR_UI_IDS
      .map(id => document.getElementById(id))
      .filter(Boolean);
  }

  async function withDevTailorUiHidden(fn) {
    const originals = devTailorUiElements().map(el => ({ el, display: el.style.display }));
    try {
      for (const { el } of originals) {
        el.style.display = 'none';
      }
      if (originals.length) await nextFrame();
      return await fn();
    } finally {
      for (const { el, display } of originals) {
        el.style.display = display;
      }
    }
  }

  function accessibleLabel(el) {
    const direct = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.getAttribute('id'),
    ];
    const labelledBy = el.getAttribute('aria-labelledby');
    let referenced = '';
    if (labelledBy) {
      referenced = labelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ');
    }
    let labels = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      labels = Array.from(el.labels || []).map(label => label.textContent || '').join(' ');
    }
    return [...direct, referenced, labels].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function testIdOf(el) {
    for (const attr of TEST_ID_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value) return { attr, value };
    }
    return null;
  }

  function elementRole(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase()) ? 'textbox' : (el.type || 'input');
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'select';
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function elementSummary(el) {
    if (!el || !(el instanceof Element)) return null;
    const className = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: className.slice(0, 160) || null,
      role: elementRole(el),
      text: elementText(el).slice(0, 160),
      label: accessibleLabel(el).slice(0, 160),
      selectorHint: selectorHint(el),
      rect: rectOf(el),
      visible: isVisible(el),
    };
  }

  function selectorHint(el) {
    try {
      const generated = window.__domReview.selectorGen?.generate?.(el);
      if (generated?.css) return generated.css;
    } catch {}
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = testIdOf(el);
    if (testId) return `[${testId.attr}="${CSS.escape(testId.value)}"]`;
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${CSS.escape(name)}"]`;
    const type = el.getAttribute('type');
    if (type) return `${tag}[type="${CSS.escape(type)}"]`;
    return tag;
  }

  function pathSignature(el) {
    const parts = [];
    let current = el;
    while (current && current instanceof Element && parts.length < 6) {
      const parent = current.parentElement;
      const tag = current.tagName.toLowerCase();
      const role = current.getAttribute('role');
      const testId = testIdOf(current);
      let part = tag;
      if (current.id) part += `#${current.id}`;
      else if (testId) part += `[${testId.attr}=${testId.value}]`;
      else if (role) part += `[role=${role}]`;
      if (parent) {
        const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join('>');
  }

  function locatorRecipes(el) {
    const recipes = [];
    const testId = testIdOf(el);
    const role = elementRole(el);
    const label = accessibleLabel(el);
    const text = elementText(el);
    const selector = selectorHint(el);
    if (testId) recipes.push({ type: 'testId', attr: testId.attr, value: testId.value });
    if (role && (label || text)) recipes.push({ type: 'role', role, name: label || text });
    if (label) recipes.push({ type: 'label', value: label });
    if (text) recipes.push({ type: 'text', value: text });
    if (selector) recipes.push({ type: 'selector', value: selector });
    recipes.push({ type: 'path', value: pathSignature(el) });
    return recipes;
  }

  function stableElementId(el, duplicateIndex = 0) {
    const recipes = locatorRecipes(el);
    const primary = recipes.find(item => item.type === 'testId') ||
      recipes.find(item => item.type === 'role') ||
      recipes.find(item => item.type === 'label') ||
      recipes.find(item => item.type === 'text') ||
      recipes[0];
    const base = JSON.stringify({
      tag: el.tagName.toLowerCase(),
      primary,
      path: pathSignature(el),
    });
    const suffix = duplicateIndex > 0 ? `_${duplicateIndex + 1}` : '';
    return `e_${stableHash(base)}${suffix}`;
  }

  function elementFingerprint(el, index, elementId = null) {
    const rect = rectOf(el);
    const text = elementText(el);
    const testId = testIdOf(el);
    return {
      elementId: elementId || stableElementId(el, index),
      tag: el.tagName.toLowerCase(),
      role: elementRole(el),
      text: text.slice(0, 120),
      label: accessibleLabel(el).slice(0, 120),
      placeholder: (el.getAttribute('placeholder') || '').slice(0, 120),
      name: (el.getAttribute('name') || '').slice(0, 120),
      testId: testId ? testId.value : '',
      testIdAttr: testId ? testId.attr : '',
      selectorHint: selectorHint(el),
      locatorRecipes: locatorRecipes(el).slice(0, 5),
      pathSignature: pathSignature(el),
      rect,
      visible: isVisible(el),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
      selected: typeof el.selected === 'boolean' ? el.selected : undefined,
      expanded: el.getAttribute('aria-expanded') || undefined,
    };
  }

  function collectRoots() {
    const roots = [document];
    const seenRoots = new Set(roots);
    const visit = (root) => {
      let all = [];
      try { all = Array.from(root.querySelectorAll('*')); } catch { return; }
      for (const el of all) {
        if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
          seenRoots.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          visit(el.shadowRoot);
        }
        if (el instanceof HTMLIFrameElement) {
          try {
            const doc = el.contentDocument;
            if (doc && !seenRoots.has(doc)) {
              seenRoots.add(doc);
              roots.push(doc);
              visit(doc);
            }
          } catch {}
        }
      }
    };
    visit(document);
    return roots;
  }

  function queryAllDeep(selector) {
    const seen = new Set();
    const elements = [];
    for (const root of collectRoots()) {
      let found = [];
      try { found = Array.from(root.querySelectorAll(selector)); } catch { continue; }
      for (const el of found) {
        if (!(el instanceof Element) || seen.has(el) || isAnyDevTailorElement(el)) continue;
        seen.add(el);
        elements.push(el);
      }
    }
    return elements;
  }

  function queryOneDeep(selector) {
    return queryAllDeep(selector)[0] || null;
  }

  function selectorExistsInDocument(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function scoreCandidateForSnapshot(el) {
    const rect = el.getBoundingClientRect();
    const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    const role = elementRole(el);
    let score = inViewport ? 1000 : 0;
    if (testIdOf(el)) score += 200;
    if (role && role !== el.tagName.toLowerCase()) score += 120;
    if (accessibleLabel(el)) score += 80;
    if (elementText(el)) score += 40;
    score -= Math.max(0, rect.top);
    return score;
  }

  function interactiveElements() {
    const elements = queryAllDeep(INTERACTIVE_SELECTOR)
      .filter(el => isVisible(el))
      .sort((a, b) => scoreCandidateForSnapshot(b) - scoreCandidateForSnapshot(a))
      .slice(0, MAX_INTERACTIVE_ELEMENTS);
    interactiveCache.clear();
    const seenIds = new Map();
    return elements.map((el, index) => {
      const baseId = stableElementId(el, 0);
      const count = seenIds.get(baseId) || 0;
      seenIds.set(baseId, count + 1);
      const elementId = count > 0 ? `${baseId}_${count + 1}` : baseId;
      const info = elementFingerprint(el, index, elementId);
      interactiveCache.set(info.elementId, info);
      return info;
    });
  }

  function scoreElement(el, cached) {
    let score = 0;
    const rect = rectOf(el);
    const text = elementText(el);
    if (el.tagName.toLowerCase() === cached.tag) score += 20;
    if (elementRole(el) === cached.role) score += 20;
    if (cached.testId && testIdOf(el)?.value === cached.testId) score += 60;
    if (cached.text && text === cached.text) score += 30;
    else if (cached.text && text.includes(cached.text)) score += 15;
    const label = accessibleLabel(el);
    if (cached.label && label === cached.label) score += 20;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const oldCx = cached.rect.x + cached.rect.width / 2;
    const oldCy = cached.rect.y + cached.rect.height / 2;
    const distance = Math.hypot(cx - oldCx, cy - oldCy);
    score += Math.max(0, 30 - distance / 10);
    return score;
  }

  function fingerprintMatches(el, cached) {
    if (!el || !cached || !isVisible(el)) return false;
    if (cached.tag && el.tagName.toLowerCase() !== cached.tag) return false;
    if (cached.role && elementRole(el) !== cached.role) return false;
    const cachedText = normalizedText(cached.text);
    const currentText = normalizedText(elementText(el));
    if (cachedText && currentText && currentText !== cachedText && !currentText.includes(cachedText)) {
      return false;
    }
    const cachedLabel = normalizedText(cached.label);
    const currentLabel = normalizedText(accessibleLabel(el));
    if (cachedLabel && currentLabel && currentLabel !== cachedLabel && !currentLabel.includes(cachedLabel)) {
      return false;
    }
    return true;
  }

  function candidatesByRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object') return [];
    switch (recipe.type) {
      case 'testId':
        return queryAllDeep(`[${recipe.attr || 'data-testid'}="${CSS.escape(String(recipe.value || ''))}"]`);
      case 'role':
        return queryAllDeep(INTERACTIVE_SELECTOR).filter(el => {
          if (elementRole(el) !== recipe.role) return false;
          const name = normalizedText(`${accessibleLabel(el)} ${elementText(el)}`);
          return name.includes(normalizedText(recipe.name));
        });
      case 'label':
        return queryAllDeep(INTERACTIVE_SELECTOR).filter(el => normalizedText(accessibleLabel(el)).includes(normalizedText(recipe.value)));
      case 'text':
        return queryAllDeep(INTERACTIVE_SELECTOR).filter(el => normalizedText(elementText(el)).includes(normalizedText(recipe.value)));
      case 'selector':
        return queryAllDeep(String(recipe.value || ''));
      case 'path':
        return queryAllDeep(INTERACTIVE_SELECTOR).filter(el => pathSignature(el) === recipe.value);
      default:
        return [];
    }
  }

  function resolveByRecipes(cached) {
    const recipes = Array.isArray(cached?.locatorRecipes) ? cached.locatorRecipes : [];
    let best = null;
    let bestScore = 0;
    for (const recipe of recipes) {
      for (const el of candidatesByRecipe(recipe)) {
        if (!isVisible(el)) continue;
        const score = scoreElement(el, cached) + (recipe.type === 'testId' ? 80 : recipe.type === 'role' ? 50 : 0);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      if (best && bestScore >= 90) return best;
    }
    return best && bestScore >= 60 ? best : null;
  }

  function findByElementId(elementId) {
    const cached = interactiveCache.get(elementId);
    if (!cached) return null;
    const byRecipe = resolveByRecipes(cached);
    if (byRecipe && fingerprintMatches(byRecipe, cached)) return byRecipe;
    if (cached.selectorHint) {
      try {
        const exact = queryOneDeep(cached.selectorHint);
        if (exact && fingerprintMatches(exact, cached)) return exact;
      } catch {}
    }
    let best = null;
    let bestScore = 0;
    for (const el of queryAllDeep(INTERACTIVE_SELECTOR).filter(isVisible)) {
      const score = scoreElement(el, cached);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best && fingerprintMatches(best, cached) && bestScore >= 60 ? best : null;
  }

  function selectorForMark(markId) {
    if (!markId) return null;
    const mark = window.__domReview.store?.get?.(markId);
    return mark?.selector || null;
  }

  function findByText(text, options = {}) {
    const needle = String(text || '').trim();
    if (!needle) return null;
    const candidates = queryAllDeep(INTERACTIVE_SELECTOR).filter(isVisible);
    const normalizedNeedle = needle.toLowerCase();
    const role = options.role ? String(options.role).toLowerCase() : '';
    const exact = Boolean(options.exact);
    return candidates.find(el => {
      if (role && elementRole(el).toLowerCase() !== role) return false;
      const value = el.value || el.getAttribute('aria-label') || el.textContent || '';
      const normalized = String(value).trim().toLowerCase();
      return exact ? normalized === normalizedNeedle : normalized === normalizedNeedle || normalized.includes(normalizedNeedle);
    }) || null;
  }

  function hasLocatorFields(params = {}) {
    return Boolean(params.role || params.label || params.nearText || params.testId || params.index != null || params.text);
  }

  function matchesLocator(el, params = {}) {
    if (!el || !isVisible(el)) return false;

    // Role 匹配
    if (params.role && elementRole(el).toLowerCase() !== String(params.role).toLowerCase()) return false;

    // TestId 匹配
    if (params.testId) {
      const testId = testIdOf(el);
      if (!testId) return false;
      if (normalizedText(testId.value) !== normalizedText(params.testId)) return false;
    }

    // Text 匹配
    if (params.text) {
      const haystack = `${elementText(el)} ${accessibleLabel(el)}`;
      if (!matchText(haystack, params.text, {
        exact: params.exact,
        normalizer: params.normalizer || 'chinese'
      })) return false;
    }

    // Label 匹配（核心优化：支持降级策略）
    if (params.label) {
      const label = accessibleLabel(el);

      // 策略 1: 标准匹配（中文增强规范化）
      const standardMatch = matchText(label, params.label, {
        exact: params.exact,
        normalizer: params.normalizer || 'chinese'
      });

      // 策略 2: 降级到纯字母数字匹配（移除所有标点）
      const fallbackMatch = !params.exact && matchText(label, params.label, {
        normalizer: 'alphanumeric'
      });

      // 如果两种策略都失败，返回 false（保持 AND 逻辑）
      if (!standardMatch && !fallbackMatch) return false;
    }

    // NearText 匹配
    if (params.nearText) {
      const containerText = el.closest('article,li,tr,form,section,div')?.textContent || '';
      if (!matchText(containerText, params.nearText, {
        normalizer: params.normalizer || 'chinese'
      })) return false;
    }

    return true;
  }

  function findByLocator(params = {}) {
    const candidates = queryAllDeep(INTERACTIVE_SELECTOR).filter(el => matchesLocator(el, params));
    if (!candidates.length) return null;
    const index = Number(params.index);
    if (Number.isInteger(index) && index >= 0) return candidates[index] || null;
    return candidates[0];
  }

  function findElement(params = {}, options = {}) {
    const allowActive = options.allowActive !== false;

    if (params.selector) {
      const el = selectorExistsInDocument(String(params.selector)) || queryOneDeep(String(params.selector));
      if (el) return el;
      throw new Error(`Selector did not match any element: ${params.selector}`);
    }

    const markSelector = selectorForMark(params.markId);
    if (markSelector) {
      const el = selectorExistsInDocument(markSelector) || queryOneDeep(markSelector);
      if (el) return el;
      throw new Error(`Marked element selector did not match any element: ${markSelector}`);
    }

    if (hasLocatorFields(params)) {
      const el = findByLocator(params);
      if (el) return el;
      throw new Error('Locator did not match any visible interactive element');
    }

    if (params.elementId) {
      const el = findByElementId(String(params.elementId));
      if (el) return el;
      throw new Error(`ElementId is stale or no longer matches its snapshot fingerprint: ${params.elementId}`);
    }

    if (params.text) {
      const el = findByText(params.text);
      if (el) return el;
      throw new Error(`Text did not match any visible interactive element: ${params.text}`);
    }

    const gridPoint = params.grid ? gridToPoint(params.grid, params.gridSize) : null;
    if (gridPoint) {
      return pageElementFromPoint(gridPoint.x, gridPoint.y);
    }

    if (params.point && Number.isFinite(params.point.x) && Number.isFinite(params.point.y)) {
      return pageElementFromPoint(Number(params.point.x), Number(params.point.y));
    }

    return allowActive && document.activeElement instanceof Element ? document.activeElement : null;
  }

  function containsOrEquals(parent, child) {
    return parent === child || parent.contains(child);
  }

  function sameRect(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < 1 &&
      Math.abs(a.y - b.y) < 1 &&
      Math.abs(a.width - b.width) < 1 &&
      Math.abs(a.height - b.height) < 1;
  }

  function viewportPoint(x, y) {
    return x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
  }

  function pageElementFromPoint(x, y) {
    const first = document.elementFromPoint(Number(x), Number(y));
    if (!isAnyDevTailorElement(first)) return first;
    const blockers = devTailorUiElements();
    const originals = blockers.map(el => ({ el, display: el.style.display }));
    try {
      for (const item of originals) {
        item.el.style.display = 'none';
      }
      const next = document.elementFromPoint(Number(x), Number(y));
      if (next && !isAnyDevTailorElement(next)) return next;
    } finally {
      for (const item of originals) {
        item.el.style.display = item.display;
      }
    }
    return first;
  }

  function gridToPoint(grid, gridSize = 80) {
    const match = /^([A-Za-z]+)(\d+)$/.exec(String(grid || '').trim());
    if (!match) return null;
    const letters = match[1].toUpperCase();
    let col = 0;
    for (let i = 0; i < letters.length; i++) {
      col = col * 26 + (letters.charCodeAt(i) - 64);
    }
    const row = Number(match[2]);
    if (!col || !Number.isFinite(row) || row <= 0) return null;
    const size = Math.max(20, Math.min(Number(gridSize) || 80, 240));
    return {
      x: (col - 0.5) * size,
      y: (row - 0.5) * size,
    };
  }

  function actionableDiagnostics(el, point = null, hit = null) {
    return {
      target: elementSummary(el),
      point: point ? { x: Math.round(point.x), y: Math.round(point.y) } : null,
      hitElement: hit ? elementSummary(hit) : null,
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
    };
  }

  function actionableError(message, code, el, point = null, hit = null) {
    const err = new Error(message);
    err.code = code || 'NOT_ACTIONABLE';
    err.detail = actionableDiagnostics(el, point, hit);
    return err;
  }

  function clickablePoint(el) {
    const rect = el.getBoundingClientRect();
    const candidates = [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.1],
      [0.5, 0.9],
    ];
    for (const [rx, ry] of candidates) {
      const x = rect.left + rect.width * rx;
      const y = rect.top + rect.height * ry;
      if (!viewportPoint(x, y)) continue;
      const hit = pageElementFromPoint(x, y);
      if (hit && containsOrEquals(el, hit)) return { x, y, hit };
    }
    const center = centerOfRect(rect);
    return {
      ...center,
      hit: viewportPoint(center.x, center.y) ? pageElementFromPoint(center.x, center.y) : null,
    };
  }

  function dispatchMouseSequence(el, point) {
    const x = point.x;
    const y = point.y;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      let event;
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        event = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        });
      } else {
        event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        });
      }
      el.dispatchEvent(event);
    }
  }

  async function waitForActionable(el, params = {}) {
    const timeoutMs = Math.max(500, Math.min(Number(params.actionTimeoutMs) || 3000, 10000));
    const deadline = Date.now() + timeoutMs;
    let lastPoint = null;
    let lastHit = null;

    while (Date.now() <= deadline) {
      if (!el || !(el instanceof Element)) {
        throw actionableError('Element not found', 'ELEMENT_NOT_FOUND', el);
      }
      if (!isVisible(el)) {
        await sleep(80);
        continue;
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
        throw actionableError('Element is disabled', 'ELEMENT_DISABLED', el);
      }

      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await nextFrame();
      const rectA = rectOf(el);
      await nextFrame();
      const rectB = rectOf(el);
      if (!sameRect(rectA, rectB)) {
        await sleep(80);
        continue;
      }

      const point = clickablePoint(el);
      const hit = point.hit || pageElementFromPoint(point.x, point.y);
      lastPoint = point;
      lastHit = hit;
      if (hit && containsOrEquals(el, hit)) {
        return { point, hit, stableRect: rectB };
      }
      await sleep(80);
    }

    throw actionableError('Element is covered, moving, or not actionable at any candidate click point', 'ELEMENT_NOT_ACTIONABLE', el, lastPoint, lastHit);
  }

  function startChangeObserver() {
    const before = {
      url: location.href,
      title: document.title,
      activeTag: document.activeElement instanceof Element ? document.activeElement.tagName.toLowerCase() : null,
      activeId: document.activeElement instanceof Element ? document.activeElement.id || null : null,
      textLength: document.body ? String(document.body.innerText || document.body.textContent || '').length : 0,
    };
    let mutationCount = 0;
    const observer = new MutationObserver(list => {
      mutationCount += list.length;
    });
    try {
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {}

    return async function finish(waitMs) {
      await sleep(waitMs == null ? 120 : waitMs);
      try { observer.disconnect(); } catch {}
      const after = {
        url: location.href,
        title: document.title,
        activeTag: document.activeElement instanceof Element ? document.activeElement.tagName.toLowerCase() : null,
        activeId: document.activeElement instanceof Element ? document.activeElement.id || null : null,
        textLength: document.body ? String(document.body.innerText || document.body.textContent || '').length : 0,
      };
      return {
        urlChanged: before.url !== after.url,
        titleChanged: before.title !== after.title,
        focusChanged: before.activeTag !== after.activeTag || before.activeId !== after.activeId,
        textLengthChanged: before.textLength !== after.textLength,
        mutationCount,
        noObservedEffect: before.url === after.url &&
          before.title === after.title &&
          before.activeTag === after.activeTag &&
          before.activeId === after.activeId &&
          before.textLength === after.textLength &&
          mutationCount === 0,
        before,
        after,
      };
    };
  }

  async function click(params = {}) {
    const explicitPoint = params.grid
      ? gridToPoint(params.grid, params.gridSize)
      : (params.point && Number.isFinite(params.point.x) && Number.isFinite(params.point.y)
          ? { x: Number(params.point.x), y: Number(params.point.y) }
          : null);
    if (explicitPoint) {
      return withDevTailorUiHidden(async () => {
        const elAtPoint = document.elementFromPoint(explicitPoint.x, explicitPoint.y);
        if (!elAtPoint || !(elAtPoint instanceof Element) || !isVisible(elAtPoint) || isAnyDevTailorElement(elAtPoint)) {
          throw actionableError('No visible page element at requested point', 'POINT_NOT_ACTIONABLE', elAtPoint, explicitPoint);
        }
        const finishObserver = startChangeObserver();
        dispatchMouseSequence(elAtPoint, explicitPoint);
        if (typeof elAtPoint.click === 'function') elAtPoint.click();
        const effects = await finishObserver(params.settleAfterMs);
        return {
          clicked: true,
          element: elementFingerprint(elAtPoint, 0),
          point: { x: Math.round(explicitPoint.x), y: Math.round(explicitPoint.y) },
          rect: rectOf(elAtPoint),
          actionability: {
            visible: true,
            enabled: !(elAtPoint.disabled || elAtPoint.getAttribute('aria-disabled') === 'true'),
            stable: true,
            receivesEvents: true,
            hitElement: elementSummary(elAtPoint),
          },
          effects,
          warning: effects.noObservedEffect ? 'Click dispatched at explicit point but no URL, focus, text, or DOM mutation was observed shortly after it.' : undefined,
        };
      });
    }

    const el = findElement(params, { allowActive: false });
    if (!el || !isVisible(el)) {
      throw actionableError('Element not found or not visible', 'ELEMENT_NOT_VISIBLE', el);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      throw actionableError('Element is disabled', 'ELEMENT_DISABLED', el);
    }
    return withDevTailorUiHidden(async () => {
      const { point, hit, stableRect } = await waitForActionable(el, params);
      const finishObserver = startChangeObserver();
      dispatchMouseSequence(hit || el, point);
      if (typeof el.click === 'function') el.click();
      const effects = await finishObserver(params.settleAfterMs);
      return {
        clicked: true,
        element: elementFingerprint(el, 0),
        point: { x: Math.round(point.x), y: Math.round(point.y) },
        rect: stableRect || rectOf(el),
        actionability: {
          visible: true,
          enabled: true,
          stable: true,
          receivesEvents: true,
          hitElement: elementSummary(hit),
        },
        effects,
        warning: effects.noObservedEffect ? 'Click dispatched but no URL, focus, text, or DOM mutation was observed shortly after it.' : undefined,
      };
    });
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function dispatchInputEvents(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isTextEditable(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
    if (el.isContentEditable) return true;
    if (String(el.getAttribute('role') || '').toLowerCase() === 'textbox') return true;
    return false;
  }

  function setSelectionToEnd(el) {
    if (typeof el.setSelectionRange !== 'function') return;
    const length = String(el.value || '').length;
    try { el.setSelectionRange(length, length); } catch {}
  }

  function resolveTextMode(params = {}) {
    if (params.mode) return String(params.mode);
    return 'replace';
  }

  function writeTextValue(el, text, mode, options = {}) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (!isTextEditable(el)) {
        throw new Error('Element is not text-editable');
      }
      const currentValue = String(el.value || '');
      const nextValue = mode === 'append' ? `${currentValue}${text}` : text;
      setNativeValue(el, nextValue);
      setSelectionToEnd(el);
      dispatchInputEvents(el);
      return el.value;
    }

    if (el.isContentEditable || String(el.getAttribute('role') || '').toLowerCase() === 'textbox' || options.forceTextContent) {
      if (mode === 'append' && el.isContentEditable) {
        el.focus?.();
        document.execCommand('insertText', false, text);
      } else {
        el.textContent = mode === 'append' ? `${el.textContent || ''}${text}` : text;
      }
      const inputType = mode === 'append' ? 'insertText' : 'insertReplacementText';
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: text }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.textContent;
    }

    throw new Error('Element is not text-editable');
  }

  function locatorParamsForTextAction(params = {}) {
    const {
      text,
      submitKey,
      mode,
      blurAfter,
      waitAfterMs,
      force,
      ...locatorParams
    } = params;
    return locatorParams;
  }

  function typeText(params = {}) {
    const el = findElement(locatorParamsForTextAction(params));
    if (!el || !isVisible(el)) {
      throw new Error('Element not found or not visible');
    }
    const text = String(params.text ?? '');
    const mode = resolveTextMode(params);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.focus?.();

    const value = writeTextValue(el, text, mode);

    if (params.submitKey) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: params.submitKey, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: params.submitKey, bubbles: true, cancelable: true }));
    }

    if (params.blurAfter) {
      el.blur?.();
    }

    return {
      typed: true,
      mode,
      value,
      element: elementFingerprint(el, 0),
      rect: rectOf(el),
    };
  }

  function fillText(params = {}) {
    const el = findElement(locatorParamsForTextAction(params));
    if (!el || !isVisible(el)) {
      throw new Error('Element not found or not visible');
    }
    const text = String(params.text ?? '');
    const mode = resolveTextMode(params);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.focus?.();
    const value = writeTextValue(el, text, mode, { forceTextContent: params.force === true });
    if (params.blurAfter !== false) {
      el.blur?.();
    }
    return {
      filled: true,
      mode,
      value,
      element: elementFingerprint(el, 0),
      rect: rectOf(el),
    };
  }

  function dispatchEscape(target) {
    const init = {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function dispatchPointerExit(el) {
    if (!el || !(el instanceof Element)) return;
    for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
      let event;
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        event = new PointerEvent(type, {
          bubbles: type !== 'pointerleave',
          cancelable: true,
          composed: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        });
      } else {
        event = new MouseEvent(type, {
          bubbles: type !== 'mouseleave',
          cancelable: true,
          composed: true,
        });
      }
      el.dispatchEvent(event);
    }
  }

  function clearState(params = {}) {
    const active = document.activeElement instanceof Element ? document.activeElement : null;
    const hovered = document.elementFromPoint(
      Math.max(0, window.innerWidth - 1),
      Math.max(0, window.innerHeight - 1),
    );
    const before = active ? elementFingerprint(active, 0) : null;
    let inputSelectionCleared = false;

    if (params.clearSelection !== false) {
      try { window.getSelection?.().removeAllRanges(); } catch {}
      if (
        active
        && typeof active.setSelectionRange === 'function'
        && typeof active.value === 'string'
      ) {
        try {
          const end = active.value.length;
          active.setSelectionRange(end, end);
          inputSelectionCleared = true;
        } catch {}
      }
    }

    dispatchPointerExit(hovered);
    dispatchPointerExit(active);
    if (active && typeof active.blur === 'function') {
      active.blur();
    }

    if (params.pressEscape) {
      dispatchEscape(document.activeElement instanceof Element ? document.activeElement : document.body);
    }

    return {
      cleared: true,
      blurred: Boolean(active),
      activeBefore: before,
      activeAfter: document.activeElement instanceof Element
        ? {
            tag: document.activeElement.tagName.toLowerCase(),
            id: document.activeElement.id || null,
          }
        : null,
      selectionCleared: params.clearSelection !== false,
      inputSelectionCleared,
      escapePressed: Boolean(params.pressEscape),
    };
  }

  function keyParts(key) {
    const parts = String(key || '').split('+').map(part => part.trim()).filter(Boolean);
    const main = parts.pop() || '';
    const lowerMods = new Set(parts.map(part => part.toLowerCase()));
    return {
      key: main,
      ctrlKey: lowerMods.has('control') || lowerMods.has('ctrl'),
      metaKey: lowerMods.has('meta') || lowerMods.has('cmd') || lowerMods.has('command'),
      altKey: lowerMods.has('alt') || lowerMods.has('option'),
      shiftKey: lowerMods.has('shift'),
    };
  }

  function pressKey(params = {}) {
    const shouldFindTarget = params.selector || params.elementId || params.text || params.point || params.grid || hasLocatorFields(params);
    const target = shouldFindTarget
      ? findElement(params)
      : document.activeElement;
    const el = target instanceof Element ? target : document.body;
    if (!el) throw new Error('No active element for key press');
    if (shouldFindTarget) {
      el.focus?.();
    }

    const parsed = keyParts(params.key || '');
    if (!parsed.key) throw new Error('press_key requires key');
    const init = {
      key: parsed.key,
      code: parsed.key.length === 1 ? `Key${parsed.key.toUpperCase()}` : parsed.key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: parsed.ctrlKey,
      metaKey: parsed.metaKey,
      altKey: parsed.altKey,
      shiftKey: parsed.shiftKey,
    };
    const down = new KeyboardEvent('keydown', init);
    el.dispatchEvent(down);
    if (!down.defaultPrevented && parsed.key === 'Enter' && el instanceof HTMLFormElement) {
      el.requestSubmit?.();
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return {
      pressed: true,
      key: params.key,
      target: el instanceof Element ? elementFingerprint(el, 0) : null,
    };
  }

  function textInScope(text, selector) {
    const expected = String(text || '');
    if (!expected) return false;
    const scope = selector ? (selectorExistsInDocument(String(selector)) || queryOneDeep(String(selector))) : document.body;
    if (!scope || !isVisible(scope)) return false;
    const actual = String(scope.innerText || scope.textContent || '');
    return actual.includes(expected);
  }

  function portalSurfaces() {
    return queryAllDeep(PORTAL_SURFACE_SELECTOR)
      .filter(isVisible)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      })
      .slice(0, MAX_PORTAL_SURFACES)
      .map((el, index) => ({
        surfaceId: `p_${stableHash(`${elementRole(el)}:${accessibleLabel(el)}:${elementText(el).slice(0, 120)}:${pathSignature(el)}`)}`,
        index,
        tag: el.tagName.toLowerCase(),
        role: elementRole(el),
        label: accessibleLabel(el).slice(0, 160),
        text: elementText(el).slice(0, 500),
        selectorHint: selectorHint(el),
        rect: rectOf(el),
        childInteractiveCount: queryAllDeep(INTERACTIVE_SELECTOR).filter(child => containsOrEquals(el, child) && isVisible(child)).length,
      }));
  }

  function snapshot(params = {}) {
    const options = Array.isArray(params) ? { selectors: params } : (params || {});
    const selectors = Array.isArray(options.selectors) ? options.selectors : [];
    const level = options.level || 'interactive-only';
    const maxElements = Math.max(0, Math.min(Number(options.maxElements) || 80, 200));
    const roleFilter = new Set(Array.isArray(options.roles)
      ? options.roles.map(role => String(role).toLowerCase())
      : []);
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    const elements = selectors.map(selector => {
      try {
        const el = selectorExistsInDocument(selector) || queryOneDeep(selector);
        if (!el) return { selector, exists: false };
        return {
          selector,
          exists: true,
          visible: isVisible(el),
          rect: rectOf(el),
        };
      } catch (err) {
        return { selector, exists: false, error: err.message || String(err) };
      }
    });
    const elementsList = level === 'summary'
      ? []
      : interactiveElements()
        .filter(item => !roleFilter.size || roleFilter.has(String(item.role || '').toLowerCase()))
        .slice(0, maxElements);
    return {
      url: location.href,
      title: document.title,
      viewport,
      elements,
      console: {
        errorCount: window.__domReview.browserConsole?.countByType?.('error') ?? undefined,
        warnCount: window.__domReview.browserConsole?.countByType?.('warn') ?? undefined,
      },
      snapshot: {
        level,
        maxElements,
        returnedInteractiveElements: elementsList.length,
      },
      portalSurfaces: level === 'summary' ? [] : portalSurfaces(),
      interactiveElements: elementsList,
    };
  }

  function findElementForAssertion(params = {}) {
    if (params.selector) return selectorExistsInDocument(String(params.selector)) || queryOneDeep(String(params.selector));
    const markSelector = selectorForMark(params.markId);
    if (markSelector) return selectorExistsInDocument(markSelector) || queryOneDeep(markSelector);
    if (hasLocatorFields(params)) return findByLocator(params);
    if (params.elementId) return findByElementId(String(params.elementId));
    if (params.text) return findByText(params.text);
    const gridPoint = params.grid ? gridToPoint(params.grid, params.gridSize) : null;
    if (gridPoint) {
      return pageElementFromPoint(gridPoint.x, gridPoint.y);
    }
    if (params.point && Number.isFinite(params.point.x) && Number.isFinite(params.point.y)) {
      return pageElementFromPoint(Number(params.point.x), Number(params.point.y));
    }
    return null;
  }

  function assertText(params = {}) {
    const expected = String(params.text || '');
    if (!expected) throw new Error('assert_text requires text');
    let actual = '';
    if (params.selector) {
      const el = selectorExistsInDocument(String(params.selector)) || queryOneDeep(String(params.selector));
      if (!el || !isVisible(el)) {
        return {
          ok: false,
          expected,
          actual: '',
          message: `Expected text "${expected}" in ${params.selector}, but the element was not visible`,
        };
      }
      actual = elementText(el) || String(el.textContent || '');
    } else {
      actual = String(document.body?.innerText || document.body?.textContent || '');
    }
    const ok = actual.includes(expected);
    return {
      ok,
      expected,
      actual: actual.slice(0, 500),
      message: ok ? 'Text assertion passed' : `Expected page text to include "${expected}"`,
    };
  }

  function assertUrl(params = {}) {
    const expected = String(params.pattern || '');
    if (!expected) throw new Error('assert_url requires pattern');
    const actual = location.href;
    let ok = false;
    try {
      ok = new RegExp(expected).test(actual);
    } catch {
      ok = actual.includes(expected);
    }
    return {
      ok,
      expected,
      actual,
      message: ok ? 'URL assertion passed' : `Expected URL to match "${expected}"`,
    };
  }

  function assertElement(params = {}) {
    const expectedExists = params.exists !== false;
    const el = findElementForAssertion(params);
    const actualExists = Boolean(el);
    const visible = el ? isVisible(el) : false;
    const ok = expectedExists ? actualExists && visible : !actualExists;
    return {
      ok,
      expected: expectedExists ? 'element exists and is visible' : 'element does not exist',
      actual: actualExists ? (visible ? 'element exists and is visible' : 'element exists but is hidden') : 'element does not exist',
      element: el ? elementFingerprint(el, 0) : null,
      message: ok ? 'Element assertion passed' : 'Element assertion failed',
    };
  }

  function runJs(params = {}) {
    const fnString = String(params.function || '() => {}');
    const args = Array.isArray(params.args) ? params.args : [];
    const dialogAction = params.dialogAction || 'accept';
    const timeoutMs = Math.max(1000, Math.min(Number(params.timeout) || 30000, 120000));
    const world = params.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'EXECUTE_RUN_JS',
        function: fnString,
        args,
        dialogAction,
        timeoutMs,
        world,
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || 'run_js failed'));
          return;
        }
        resolve(response.result);
      });
    });
  }

  window.__domReview.browserActionDom = {
    click,
    typeText,
    fillText,
    pressKey,
    clearState,
    snapshot,
    assertText,
    assertUrl,
    assertElement,
    textInScope,
    isVisible,
    runJs,
  };
})();
