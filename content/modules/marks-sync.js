/**
 * DevTailor — Marks sync (content script <-> side panel)
 *
 * The content script owns the marks (review-store.js) and the pending page screenshots. This module
 *   - broadcasts a minimal snapshot after every change: `DT_MARKS_CHANGED` -> service worker, which
 *     relays it to the side panel as `DT_MARKS_UPDATED` with the sender's tabId;
 *   - answers the side panel's commands (`DT_GET_MARKS`, `DT_REMOVE_MARK`, `DT_BUILD_PAYLOAD`, ...)
 *     arriving through chrome.tabs.sendMessage, via marksCore.handleCommand.
 * Screenshot pixels never travel in the broadcast; the side panel fetches thumbnails or the full
 * images (at send time) on demand.
 *
 * Depends on: store, marksCore, promptBuilder
 * Registers: window.__domReview.marksSync
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const BROADCAST_DEBOUNCE_MS = 40;
  const THUMB_MAX_EDGE = 160;

  let shots = []; // { id, dataUrl, thumb, w, h, bytes }
  let shotSeq = 0;
  let timer = null;
  let started = false;
  let changeListeners = [];
  let tabId = null;
  let restoredDone = false; // never persist before the restore attempt, or an empty state would overwrite it
  let persistTimer = null;

  const core = () => window.__domReview.marksCore;
  const store = () => window.__domReview.store;

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
  }

  function makeThumb(img) {
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  }

  /** Add a page screenshot (data URL) to the pending attachments. Resolves to its id, or null. */
  async function addScreenshot(dataUrl) {
    if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl.slice(0, 40))) return null;
    if (shots.length >= core().LIMITS.MAX_SCREENSHOTS) return null;
    let img;
    try { img = await loadImage(dataUrl); } catch { return null; }
    let thumb = '';
    try { thumb = makeThumb(img); } catch { /* thumbnails are optional */ }
    const id = `s_${Date.now()}_${++shotSeq}`;
    shots.push({ id, dataUrl, thumb, w: img.naturalWidth, h: img.naturalHeight, bytes: 0 });
    notifyChange();
    return id;
  }

  const screenshots = {
    list: () => shots.slice(),
    images: () => shots.map((s) => s.dataUrl),
    remove(id) {
      const before = shots.length;
      shots = shots.filter((s) => s.id !== id);
      if (shots.length !== before) notifyChange();
    },
    clear() {
      if (!shots.length) return;
      shots = [];
      notifyChange();
    },
    thumbs(ids) {
      const out = {};
      for (const id of ids) {
        const shot = shots.find((s) => s.id === id);
        if (shot && shot.thumb) out[id] = shot.thumb;
      }
      return out;
    },
  };

  function snapshot() {
    return core().buildSnapshot({ url: location.href, marks: store().getAll(), screenshots: shots });
  }

  function notifyChange() {
    changeListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    scheduleBroadcast();
    schedulePersist();
  }

  // ---- survive reloads: mirror marks + screenshots into chrome.storage.session (keyed by tab id)
  const sessionArea = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) || null;

  function getTabId() {
    if (tabId !== null) return Promise.resolve(tabId);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (res) => {
          void chrome.runtime.lastError;
          tabId = res && res.tabId != null ? res.tabId : null;
          resolve(tabId);
        });
      } catch { resolve(null); }
    });
  }

  function schedulePersist() {
    if (!restoredDone) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  }

  async function persist() {
    persistTimer = null;
    const area = sessionArea();
    const id = await getTabId();
    if (!area || id === null) return;
    const key = core().persistKey(id);
    try {
      const state = core().buildPersisted({ origin: location.origin, marks: store().getAll(), shots });
      if (!state) { await area.remove(key); return; }
      try {
        await area.set({ [key]: state });
      } catch (err) {
        // Quota: keep the marks, drop the pixels rather than lose everything.
        console.warn('[DevTailor] persisting screenshots failed, keeping marks only:', err && err.message);
        await area.set({ [key]: { ...state, shots: [], droppedShots: state.shots.length } });
      }
    } catch (err) {
      console.warn('[DevTailor] persist failed:', err && err.message);
    }
  }

  async function restore() {
    const area = sessionArea();
    const id = await getTabId();
    try {
      if (!area || id === null) return;
      const key = core().persistKey(id);
      const saved = (await area.get(key))[key];
      const data = core().restorePersisted(saved, location.origin);
      // Anything the user already added in the meantime wins; do not merge into a live session.
      if (!data || store().getAll().length || shots.length) return;
      if (data.marks.length) store().fromJSON({ version: '1.0', reviews: data.marks });
      if (data.shots.length) {
        shots = data.shots.map((s) => ({ id: s.id, dataUrl: s.dataUrl, thumb: s.thumb || '', w: s.w, h: s.h, bytes: s.bytes || 0 }));
        shotSeq = Math.max(shotSeq, shots.length);
      }
      window.__domReview.badges?.render?.();
      notifyChange();
      if (saved.droppedShots) {
        window.__domReview.toolbar?.toast?.(`刷新后已恢复标记；有 ${saved.droppedShots} 张较早的截图因体积过大未能保留`);
      }
    } catch (err) {
      console.warn('[DevTailor] restore failed:', err && err.message);
    } finally {
      restoredDone = true;
      schedulePersist();
    }
  }

  function scheduleBroadcast() {
    clearTimeout(timer);
    timer = setTimeout(broadcast, BROADCAST_DEBOUNCE_MS);
  }

  function broadcast() {
    clearTimeout(timer);
    timer = null;
    try {
      chrome.runtime.sendMessage(core().buildChangedMessage({ url: location.href, marks: store().getAll(), screenshots: shots }), () => {
        void chrome.runtime.lastError; // no listener (side panel closed) is normal
      });
    } catch { /* extension context invalidated after a reload */ }
  }

  function locate(id) {
    const mark = store().get(id);
    if (!mark) return false;
    const hitTest = window.__domReview.hitTest;
    const el = hitTest ? hitTest.resolveSelector(mark.selector) : null;
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
    window.__domReview.badges?.flashReview?.(id);
    window.__domReview.toolbar?.pulse?.(id);
    return true;
  }

  function context() {
    return {
      store: store(),
      screenshots,
      url: () => location.href,
      buildParts: (marks, images) => window.__domReview.promptBuilder.buildParts(marks, images),
      locate,
    };
  }

  function onCommand(message, _sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('DT_')) return false;
    let res;
    try {
      res = core().handleCommand(message, context());
    } catch (err) {
      res = { ok: false, error: String((err && err.message) || err) };
    }
    if (res === undefined) return false;
    sendResponse(res);
    return false;
  }

  function init() {
    if (started) return;
    started = true;
    store().onChange(notifyChange);
    chrome.runtime.onMessage.addListener(onCommand);
    broadcast();
    void restore();
  }

  window.__domReview.marksSync = {
    init,
    addScreenshot,
    screenshots,
    snapshot,
    locate,
    broadcast,
    onChange(fn) {
      changeListeners.push(fn);
      return () => { changeListeners = changeListeners.filter((f) => f !== fn); };
    },
  };
})();
