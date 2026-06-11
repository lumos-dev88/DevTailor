/**
 * DevTailor — Message Store
 *
 * Thin reactive facade over the messages array.
 * Coalesces mutations via requestAnimationFrame so multiple rapid updates
 * trigger a single re-render.
 *
 * Registers: window.__domReview.createMessageStore
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function createMessageStore({ maxMessages = 50 } = {}) {
    let messages = [];
    let rafId = null;
    const subscribers = new Set();

    function _notify() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        subscribers.forEach((fn) => {
          try { fn(); } catch (e) { console.error('MessageStore subscriber error:', e); }
        });
      });
    }

    function append(msg) {
      if (!msg || typeof msg !== 'object') return;
      messages.push(msg);
      if (messages.length > maxMessages) {
        messages.splice(0, messages.length - maxMessages);
      }
      _notify();
    }

    function update(idOrIndex, patch) {
      let idx = typeof idOrIndex === 'number' ? idOrIndex : messages.findIndex(m => m.id === idOrIndex);
      if (idx < 0 || idx >= messages.length) return false;
      const msg = messages[idx];
      if (typeof patch === 'function') {
        patch(msg);
      } else if (patch && typeof patch === 'object') {
        Object.assign(msg, patch);
      }
      _notify();
      return true;
    }

    function getAll() {
      return [...messages];
    }

    function subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }

    function find(predicate) {
      return messages.find(predicate) || null;
    }

    function findIndex(predicate) {
      return messages.findIndex(predicate);
    }

    function findLast(predicate) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (predicate(messages[i])) return messages[i];
      }
      return null;
    }

    function filter(predicate) {
      return messages.filter(predicate);
    }

    function remove(idOrIndex) {
      let idx = typeof idOrIndex === 'number' ? idOrIndex : messages.findIndex(m => m.id === idOrIndex);
      if (idx < 0 || idx >= messages.length) return false;
      messages.splice(idx, 1);
      _notify();
      return true;
    }

    function clear() {
      if (messages.length === 0) return;
      messages.length = 0;
      _notify();
    }

    function replaceAll(newMessages) {
      messages = Array.isArray(newMessages) ? newMessages.filter(item => item && typeof item === 'object') : [];
      if (messages.length > maxMessages) {
        messages.splice(0, messages.length - maxMessages);
      }
      _notify();
    }

    return {
      get size() { return messages.length; },
      append,
      update,
      getAll,
      subscribe,
      find,
      findIndex,
      findLast,
      filter,
      remove,
      clear,
      replaceAll,
    };
  }

  window.__domReview.createMessageStore = createMessageStore;
})();
