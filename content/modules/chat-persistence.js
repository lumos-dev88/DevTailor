/**
 * DevTailor — Chat Persistence
 *
 * Keeps UI-only draft/image state in chrome.storage.local. Display messages
 * are owned by DevTailor Bridge sessions and are not persisted here.
 *
 * Registers: window.__domReview.chatPersistence
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const STORAGE_PREFIX = 'devtailor:chat:v1:';
  const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const DEFAULT_MAX_MESSAGES = 50;
  const DEFAULT_MAX_IMAGES = 3;

  function create({
    messages,
    maxMessages = DEFAULT_MAX_MESSAGES,
    maxPersistedImages = DEFAULT_MAX_IMAGES,
    normalizeImages,
    stringifyAny,
    getImages,
    setImages,
    renderMessages,
    renderImages,
    scrollToBottom,
    refreshSendState,
    getSendState,
    restoreSendState,
  }) {
    let sessionKey = null;
    let currentBridgeInstanceId = null;
    let hydrated = false;
    let persistTimer = null;

    function buildSessionKey(projectInfo) {
      if (!projectInfo || !projectInfo.projectId) return null;
      const agentKey = projectInfo.agentKey || 'agent';
      return `${STORAGE_PREFIX}${projectInfo.projectId}:${encodeURIComponent(agentKey)}`;
    }

    function hydrate(projectInfo, clientId) {
      const nextKey = buildSessionKey(projectInfo, clientId);
      const nextBridgeInstanceId = projectInfo.bridgeInstanceId || null;
      if (!nextKey) return;
      if (nextKey === sessionKey && nextBridgeInstanceId === currentBridgeInstanceId) return;

      sessionKey = nextKey;
      currentBridgeInstanceId = nextBridgeInstanceId;
      hydrated = false;

      chrome.storage.local.get([sessionKey], (result) => {
        if (sessionKey !== nextKey) return;
        const saved = result[sessionKey];
        messages.length = 0;

        const sameBridgeInstance = saved && saved.bridgeInstanceId && saved.bridgeInstanceId === currentBridgeInstanceId;
        setImages(sameBridgeInstance ? (saved.images || saved.screenshot) : [], { render: false });
        if (sameBridgeInstance && saved.sendState && typeof saved.sendState === 'object') {
          restoreSendState?.(saved.sendState);
        }
        hydrated = true;
        renderMessages?.();
        scrollToBottom?.();
        renderImages?.();
        refreshSendState?.();
        if (saved && !sameBridgeInstance) {
          persistNow();
        }
        pruneOldSessions();
      });
    }

    function schedulePersist() {
      if (!hydrated || !sessionKey) return;
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persistNow, 400);
    }

    function persistNow() {
      if (!sessionKey) return;
      clearTimeout(persistTimer);
      const images = getImages();
      const payload = {
        version: 1,
        pageKey: `${location.hostname}${location.pathname}`,
        bridgeInstanceId: currentBridgeInstanceId,
        messages: [],
        images,
        screenshot: images[0] || null,
        sendState: getSendState?.() || null,
        updatedAt: Date.now(),
      };
      chrome.storage.local.set({ [sessionKey]: payload });
    }

    function pruneOldSessions() {
      chrome.storage.local.get(null, (items) => {
        const cutoff = Date.now() - SESSION_TTL_MS;
        const expired = Object.entries(items)
          .filter(([key, value]) => key.startsWith(STORAGE_PREFIX) && value && value.updatedAt && value.updatedAt < cutoff)
          .map(([key]) => key);
        if (expired.length) chrome.storage.local.remove(expired);
      });
    }

    return {
      hydrate,
      schedulePersist,
      persistNow,
      pruneOldSessions,
    };
  }

  window.__domReview.chatPersistence = { create };
})();
