/** Pure decisions for restoring on-demand injection after navigation/worker restart. */
(() => {
  'use strict';

  function normalizeTabIds(value) {
    return [...new Set((Array.isArray(value) ? value : [])
      .map(Number).filter(id => Number.isInteger(id) && id > 0))];
  }

  function navigationAction({ tabId, status, rememberedTabIds, activeTabId, url }) {
    const supported = /^https?:\/\//i.test(String(url || ''));
    const remembered = normalizeTabIds(rememberedTabIds).includes(Number(tabId));
    if (status !== 'complete' || !supported || !remembered) return { inject: false, activate: false };
    return { inject: true, activate: Number(activeTabId) === Number(tabId) };
  }

  function afterTakeover(rememberedTabIds, tabId) {
    return { rememberedTabIds: normalizeTabIds([...(rememberedTabIds || []), tabId]), activeTabId: Number(tabId) };
  }

  function afterTabClosed(rememberedTabIds, activeTabId, tabId) {
    return {
      rememberedTabIds: normalizeTabIds(rememberedTabIds).filter(id => id !== Number(tabId)),
      activeTabId: Number(activeTabId) === Number(tabId) ? null : Number(activeTabId) || null,
    };
  }

  /**
   * The page toolbar released the takeover. Drop the ownership only when it belongs to the
   * sending tab; the tab stays in `rememberedTabIds` so a refresh keeps the injected UI
   * (without silently re-taking over the page). Another tab's ownership is never touched.
   */
  function afterRelease(rememberedTabIds, activeTabId, tabId) {
    const id = Number(tabId);
    const owned = Number(activeTabId) === id;
    return {
      rememberedTabIds: normalizeTabIds(rememberedTabIds),
      activeTabId: owned ? null : (Number(activeTabId) || null),
    };
  }

  const api = { normalizeTabIds, navigationAction, afterTakeover, afterTabClosed, afterRelease };
  if (typeof module === 'object' && module.exports) module.exports = api;
  const root = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null);
  if (root) {
    root.__domReview = root.__domReview || {};
    root.__domReview.injectionState = api;
  }
})();
