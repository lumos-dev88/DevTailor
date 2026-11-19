/**
 * DevTailor — Review Store Module
 *
 * Central CRUD store for review marks. This is the single source of truth for page marks:
 * the toolbar drawer, the in-page badges and (through marks-sync.js) the side panel's mark tray
 * all read from it. The store itself is in-memory; marks-sync.js mirrors it (plus pending screenshots)
 * into chrome.storage.session per tab so a page reload restores them.
 *
 * Listeners get `(reviews, change)` where change = { type, ids } and type is one of
 * add | update | remove | clear | sent | import.
 *
 * Browser: window.__domReview.store. Node (tests): module.exports = { createStore }.
 */
(() => {
  'use strict';

  function createStore(getHref = () => (typeof location !== 'undefined' ? location.href : '')) {
    let data = { version: '1.0', page: getHref(), reviews: [] };
    let listeners = [];

    function notify(change) {
      const copy = data.reviews.slice();
      listeners.forEach((fn) => {
        try { fn(copy, change); } catch (e) { console.warn('[DevTailor] listener error:', e); }
      });
    }

    function reindex() {
      data.reviews.forEach((review, idx) => {
        review.index = idx + 1;
      });
    }

    function commit(change) {
      reindex();
      notify(change);
    }

    function add(review) {
      const enriched = {
        index: data.reviews.length + 1,
        priority: 'medium',
        category: 'style',
        resolved: false,
        sent: false,
        replies: [],
        updated: null,
        ...review,
      };
      data.reviews.push(enriched);
      commit({ type: 'add', ids: [enriched.id] });
    }

    function get(id) {
      return data.reviews.find((r) => r.id === id) || null;
    }

    function getAll() {
      return data.reviews.slice();
    }

    function update(id, changes) {
      const idx = data.reviews.findIndex((r) => r.id === id);
      if (idx === -1) return false;
      data.reviews[idx] = { ...data.reviews[idx], ...changes, updated: new Date().toISOString() };
      commit({ type: 'update', ids: [id] });
      return true;
    }

    function remove(id) {
      const before = data.reviews.length;
      data.reviews = data.reviews.filter((r) => r.id !== id);
      if (data.reviews.length === before) return false;
      commit({ type: 'remove', ids: [id] });
      return true;
    }

    function resolve(id) { return update(id, { resolved: true }); }
    function unresolve(id) { return update(id, { resolved: false }); }

    /** Flag marks as "已发送" (kept visible until the turn finishes) or undo it. */
    function setSent(ids, sent) {
      const wanted = new Set(Array.isArray(ids) ? ids : []);
      const changed = [];
      data.reviews.forEach((review) => {
        if (wanted.has(review.id) && Boolean(review.sent) !== Boolean(sent)) {
          review.sent = Boolean(sent);
          changed.push(review.id);
        }
      });
      if (changed.length) commit({ type: 'sent', ids: changed });
      return changed.length;
    }

    function removeSent() {
      const ids = data.reviews.filter((r) => r.sent).map((r) => r.id);
      if (!ids.length) return 0;
      data.reviews = data.reviews.filter((r) => !r.sent);
      commit({ type: 'remove', ids });
      return ids.length;
    }

    function onChange(callback) {
      listeners.push(callback);
      return () => { listeners = listeners.filter((fn) => fn !== callback); };
    }

    function toJSON() {
      return JSON.parse(JSON.stringify(data));
    }

    function fromJSON(imported) {
      if (!imported || !Array.isArray(imported.reviews)) {
        throw new Error('Invalid review data');
      }
      data = { version: imported.version || '1.0', page: getHref(), reviews: imported.reviews };
      commit({ type: 'import', ids: data.reviews.map((r) => r.id) });
    }

    function clear() {
      if (!data.reviews.length) return;
      const ids = data.reviews.map((r) => r.id);
      data.reviews = [];
      commit({ type: 'clear', ids });
    }

    return {
      add, get, getAll, update, remove,
      resolve, unresolve, setSent, removeSent,
      onChange,
      toJSON, fromJSON, clear,
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createStore };
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.store = createStore();
  }
})();
