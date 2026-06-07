/**
 * DevTailor — Review Store Module
 *
 * Central CRUD store for review marks.
 * Session-only (no persistence). Replaced DOM persistence with SSE + ACP.
 *
 * Registers: window.__domReview.store
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let data = { version: '1.0', page: location.href, reviews: [] };
  let listeners = [];

  // --- Private helpers ---

  function _notify() {
    const copy = data.reviews.slice();
    listeners.forEach(fn => { try { fn(copy); } catch (e) { console.warn('[DevTailor] listener error:', e); } });
  }

  function _persist() {
    reindex();
    _notify();
  }

  function reindex() {
    data.reviews.forEach((review, idx) => {
      review.index = idx + 1;
    });
  }

  // --- CRUD ---

  function add(review) {
    const enriched = {
      index: data.reviews.length + 1,
      priority: 'medium',
      category: 'style',
      resolved: false,
      replies: [],
      updated: null,
      ...review
    };
    data.reviews.push(enriched);
    _persist();
  }

  function get(id) {
    return data.reviews.find(r => r.id === id) || null;
  }

  function getAll() {
    return data.reviews.slice();
  }

  function update(id, changes) {
    const idx = data.reviews.findIndex(r => r.id === id);
    if (idx === -1) return false;
    data.reviews[idx] = { ...data.reviews[idx], ...changes, updated: new Date().toISOString() };
    _persist();
    return true;
  }

  function remove(id) {
    data.reviews = data.reviews.filter(r => r.id !== id);
    _persist();
  }

  function resolve(id) { return update(id, { resolved: true }); }
  function unresolve(id) { return update(id, { resolved: false }); }

  // --- Events ---

  function onChange(callback) {
    listeners.push(callback);
    return () => { listeners = listeners.filter(fn => fn !== callback); };
  }

  // --- Export / Import ---

  function toJSON() {
    return JSON.parse(JSON.stringify(data));
  }

  function fromJSON(imported) {
    if (!imported || !Array.isArray(imported.reviews)) {
      throw new Error('Invalid review data');
    }
    data = { version: imported.version || '1.0', page: location.href, reviews: imported.reviews };
    _persist();
  }

  function clear() {
    data.reviews = [];
    _persist();
  }

  // --- Public API ---

  window.__domReview.store = {
    add, get, getAll, update, remove,
    resolve, unresolve,
    onChange,
    toJSON, fromJSON, clear
  };
})();
