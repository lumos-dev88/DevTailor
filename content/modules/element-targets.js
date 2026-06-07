/**
 * DevTailor — Element Targets Module
 *
 * Saves confirmed marks as reusable project/page element targets.
 * AI and users co-maintain these short-lived locator memories.
 *
 * Registers: window.__domReview.elementTargets
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const BRIDGE_URL = 'http://localhost:34781';
  const TEST_ID_ATTRIBUTES = ['data-ai-id', 'data-testid', 'data-test', 'data-cy', 'testid'];

  function pagePatternForCurrentPage() {
    return `${location.origin}${location.pathname}`;
  }

  function locatorRecipesForReview(review) {
    const recipes = [];
    const context = review.context || {};
    const a11y = context.a11y || {};
    const testId = context.testId || context.attributes?.['data-ai-id'] || context.attributes?.['data-testid'];
    if (testId) {
      recipes.push({ type: 'testId', attr: context.attributes?.['data-ai-id'] ? 'data-ai-id' : 'data-testid', value: testId, weight: 100, priority: 1, recommended: true });
    }
    if (a11y.role && a11y.label) {
      recipes.push({ type: 'role+label', role: a11y.role, label: a11y.label, weight: 90, priority: 2, recommended: !testId });
    }
    if (a11y.role && context.text) {
      recipes.push({ type: 'role+text', role: a11y.role, text: context.text, weight: 65, priority: 3, recommended: false });
    }
    if (a11y.label) {
      recipes.push({ type: 'label', value: a11y.label, weight: 80, priority: 4, recommended: recipes.length === 0 });
    }
    if (review.selector) {
      recipes.push({ type: 'css', value: review.selector, weight: 35, priority: 5, recommended: recipes.length === 0 });
    }
    if (context.text) {
      recipes.push({ type: 'text', value: context.text, weight: 50, priority: 6, recommended: false });
    }
    return recipes;
  }

  function attrFromContext(context, name) {
    return context.attributes?.[name] || '';
  }

  function testIdFromContext(context) {
    for (const attr of TEST_ID_ATTRIBUTES) {
      const value = attrFromContext(context, attr);
      if (value) return { attr, value };
    }
    return null;
  }

  function pageRegionFromBox(box) {
    if (!box) return '';
    const cx = Number(box.x || 0) + Number(box.w || box.width || 0) / 2;
    const cy = Number(box.y || 0) + Number(box.h || box.height || 0) / 2;
    const horizontal = cx < innerWidth / 3 ? 'left' : cx > innerWidth * 2 / 3 ? 'right' : 'center';
    const vertical = cy < innerHeight / 3 ? 'top' : cy > innerHeight * 2 / 3 ? 'bottom' : 'middle';
    return `${vertical}-${horizontal}`;
  }

  function nearbyTextsForReview(review) {
    const context = review.context || {};
    return [
      context.a11y?.label,
      context.text,
      context.framework?.componentName,
      context.parentText,
      context.nearbyText,
    ].filter(Boolean).map(text => String(text).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6);
  }

  function buildTargetPayload(review, options = {}) {
    const context = review.context || {};
    const a11y = context.a11y || {};
    const testId = testIdFromContext(context);
    const box = context.boundingBox || null;
    const semantic = {
      role: a11y.role || '',
      name: a11y.label || '',
      label: a11y.label || '',
      text: context.text || '',
      ariaLabel: attrFromContext(context, 'aria-label') || a11y.label || '',
      placeholder: attrFromContext(context, 'placeholder'),
      title: attrFromContext(context, 'title'),
      testId: testId?.value || '',
      testIdAttr: testId?.attr || '',
      inputType: attrFromContext(context, 'type'),
    };
    const contextIdentity = {
      pagePath: location.pathname,
      sectionTitle: context.framework?.componentName || '',
      nearbyTexts: nearbyTextsForReview(review),
      containerText: context.parentText || '',
      aiRegion: attrFromContext(context, 'data-ai-region'),
    };
    const structure = {
      tag: context.tagName || '',
      selector: review.selector || '',
    };
    const visual = {
      rect: box,
      region: pageRegionFromBox(box),
    };
    return {
      name: String(options.name || '').trim(),
      description: String(options.description ?? review.comment ?? '').trim(),
      pagePattern: options.pagePattern || pagePatternForCurrentPage(),
      pageUrl: location.href,
      selector: review.selector || '',
      xpath: review.xpath || '',
      semantic,
      context: contextIdentity,
      structure,
      visual,
      locatorRecipes: locatorRecipesForReview(review),
      fingerprint: {
        tag: context.tagName || '',
        text: context.text || '',
        a11y: context.a11y || null,
        boundingBox: context.boundingBox || null,
        framework: context.framework || null,
        semantic,
        context: contextIdentity,
        structure,
        visual,
      },
    };
  }

  async function saveFromReview(review, options = {}) {
    if (!review) throw new Error('Missing mark');
    const payload = buildTargetPayload(review, options);
    if (!payload.name) throw new Error('Missing target name');
    if (!payload.selector && !payload.xpath && !payload.locatorRecipes.length) {
      throw new Error('Missing locator: provide selector, xpath, or locatorRecipes');
    }

    const response = await fetch(`${BRIDGE_URL}/element-targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return body.target;
  }

  async function savePayload(payload = {}) {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Missing target name');
    if (!payload.selector && !payload.xpath && !Array.isArray(payload.locatorRecipes)) {
      throw new Error('Missing locator: provide selector, xpath, or locatorRecipes');
    }
    const bodyPayload = {
      pageUrl: location.href,
      pagePattern: pagePatternForCurrentPage(),
      ...payload,
      name,
    };
    const response = await fetch(`${BRIDGE_URL}/element-targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return body.target;
  }

  async function listCurrentPage() {
    const url = `${BRIDGE_URL}/element-targets?url=${encodeURIComponent(location.href)}`;
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return body.targets || [];
  }

  async function deleteTarget(targetId) {
    const id = String(targetId || '').trim();
    if (!id) throw new Error('Missing element target id');
    const response = await fetch(`${BRIDGE_URL}/element-targets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  function targetMatches(target, params = {}) {
    const targetId = String(params.targetId || '').trim();
    const targetName = String(params.targetName || '').trim().toLowerCase();
    if (targetId && String(target.id || target.targetId || '') === targetId) return true;
    if (targetName && String(target.name || '').trim().toLowerCase() === targetName) return true;
    return false;
  }

  function paramsFromTarget(target) {
    const semantic = target.semantic || {};
    const structure = target.structure || {};
    const recipes = Array.isArray(target.locatorRecipes) ? target.locatorRecipes : [];
    const testIdRecipe = recipes.find(item => item.type === 'testId' && item.value);
    const roleLabelRecipe = recipes.find(item => item.type === 'role+label' && item.role && item.label);
    const roleTextRecipe = recipes.find(item => item.type === 'role+text' && item.role && item.text);
    const labelRecipe = recipes.find(item => item.type === 'label' && item.value);
    const textRecipe = recipes.find(item => item.type === 'text' && item.value);
    const cssRecipe = recipes.find(item => (item.type === 'css' || item.type === 'selector') && item.value);

    if (testIdRecipe) return { testId: testIdRecipe.value };
    if (semantic.testId) return { testId: semantic.testId };
    if (roleLabelRecipe) return { role: roleLabelRecipe.role, label: roleLabelRecipe.label };
    if (semantic.role && (semantic.label || semantic.name || semantic.ariaLabel)) {
      return { role: semantic.role, label: semantic.label || semantic.name || semantic.ariaLabel };
    }
    if (labelRecipe) return { label: labelRecipe.value };
    if (roleTextRecipe) return { role: roleTextRecipe.role, text: roleTextRecipe.text };
    if (semantic.role && semantic.text) return { role: semantic.role, text: semantic.text };
    if (cssRecipe) return { selector: cssRecipe.value };
    if (target.selector || structure.selector) return { selector: target.selector || structure.selector };
    if (textRecipe) return { text: textRecipe.value };
    if (semantic.text) return { text: semantic.text };
    return {};
  }

  async function resolveParams(params = {}) {
    if (!params.targetId && !params.targetName) return params;
    const targets = await listCurrentPage();
    const target = targets.find(item => targetMatches(item, params));
    if (!target) {
      throw new Error(`Element target not found: ${params.targetId || params.targetName}`);
    }
    const resolved = paramsFromTarget(target);
    if (!Object.keys(resolved).length) {
      throw new Error(`Element target has no usable locator: ${target.name || target.id}`);
    }
    const { targetId, targetName, ...rest } = params;
    return {
      ...resolved,
      ...rest,
      resolvedTarget: {
        id: target.id || target.targetId,
        name: target.name,
      },
    };
  }

  window.__domReview.elementTargets = {
    saveFromReview,
    savePayload,
    listCurrentPage,
    deleteTarget,
    buildTargetPayload,
    resolveParams,
  };
})();
