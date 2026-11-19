'use strict';
// Minimal in-memory stand-in for content/modules/message-store.js (same surface, synchronous).
function createStore() {
  let messages = [];
  return {
    get size() { return messages.length; },
    append(m) { messages.push(m); },
    update(idOrIndex, patch) {
      const idx = typeof idOrIndex === 'number' ? idOrIndex : messages.findIndex((m) => m.id === idOrIndex);
      if (idx < 0 || idx >= messages.length) return false;
      if (typeof patch === 'function') patch(messages[idx]);
      else Object.assign(messages[idx], patch);
      return true;
    },
    getAll() { return [...messages]; },
    find(p) { return messages.find(p) || null; },
    findIndex(p) { return messages.findIndex(p); },
    findLast(p) { for (let i = messages.length - 1; i >= 0; i--) if (p(messages[i])) return messages[i]; return null; },
    filter(p) { return messages.filter(p); },
    remove(id) { const i = messages.findIndex((m) => m.id === id); if (i < 0) return false; messages.splice(i, 1); return true; },
    clear() { messages = []; },
    replaceAll(list) { messages = [...list]; },
  };
}

/**
 * Minimal hand-rolled DOM stand-in for content/modules/browser-action-dom.js.
 * No jsdom in this repo — this stub only supports what the tests exercise:
 * attribute/text access, parent chains (incl. shadow host), rects and computed overflow.
 */
function createDomEnvironment() {
  const styleByEl = new WeakMap();

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.attrs = new Map();
      this.parentElement = null;
      this.children = [];
      this.textContent = '';
      this.value = '';
      this.labels = [];
      this._rect = { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 };
    }
    getAttribute(name) {
      const v = this.attrs.get(name);
      return v === undefined ? null : v;
    }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getBoundingClientRect() {
      const r = this._rect;
      return { ...r, x: r.left, y: r.top };
    }
    getRootNode() { return { host: this._host || null }; }
  }
  class FakeInput extends FakeElement {
    constructor(tagName = 'input') { super(tagName); }
  }
  class FakeTextarea extends FakeInput {
    constructor() { super('textarea'); }
  }
  class FakeSelect extends FakeInput {
    constructor() { super('select'); }
  }

  function element(tagName) {
    const cls = tagName === 'textarea' ? FakeTextarea : tagName === 'select' ? FakeSelect : tagName === 'input' ? FakeInput : FakeElement;
    return new cls(tagName);
  }

  function rect(el, rectLike) {
    el._rect = {
      top: rectLike.top ?? 0,
      left: rectLike.left ?? 0,
      bottom: rectLike.bottom ?? (rectLike.top ?? 0) + (rectLike.height ?? 0),
      right: rectLike.right ?? (rectLike.left ?? 0) + (rectLike.width ?? 0),
      width: rectLike.width ?? 0,
      height: rectLike.height ?? 0,
    };
  }

  function style(el, props) {
    styleByEl.set(el, props || {});
  }

  function append(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    return child;
  }

  function getComputedStyle(el) {
    return { overflowX: '', overflowY: '', overflow: '', visibility: 'visible', display: 'block', opacity: '1', ...(styleByEl.get(el) || {}) };
  }

  function mountDocument({ body = element('body'), title = 'test' } = {}) {
    const byId = new Map();
    const matches = (el, selector) => {
      if (!selector) return false;
      return String(selector).split(',').some((part) => {
        part = part.trim();
        if (!part) return false;
        if (part.startsWith('#')) return el.getAttribute('id') === part.slice(1);
        if (part.startsWith('[')) {
          const m = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(part);
          if (!m) return false;
          const attr = m[1];
          const val = m[2];
          const has = el.getAttribute(attr) !== null;
          return val === undefined ? has : el.getAttribute(attr) === val;
        }
        return el.tagName.toLowerCase() === part.toLowerCase();
      });
    };
    const walk = (node, fn) => { fn(node); for (const c of node.children) walk(c, fn); };
    const document = {
      title,
      body,
      getElementById(id) { return byId.get(id) || null; },
      querySelector(selector) {
        let found = null;
        walk(body, (el) => { if (!found && matches(el, selector)) found = el; });
        return found;
      },
      querySelectorAll(selector) {
        const out = [];
        walk(body, (el) => { if (matches(el, selector)) out.push(el); });
        return out;
      },
      registerId(id, el) { byId.set(id, el); },
    };
    return document;
  }

  return {
    FakeElement, FakeInput, FakeTextarea, FakeSelect,
    element, rect, style, append, getComputedStyle,
    mountDocument,
    makeWindow(overrides = {}) {
      return {
        innerWidth: 1024,
        innerHeight: 768,
        devicePixelRatio: 1,
        getComputedStyle,
        __domReview: {},
        ...overrides,
      };
    },
  };
}

module.exports = { createStore, createDomEnvironment };
