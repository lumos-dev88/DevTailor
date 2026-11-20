/**
 * DevTailor — SSE Client Module
 *
 * Receives Bridge events through the extension background proxy.
 * Kept as window.__domReview.wsClient. The page no longer renders chat: this client owns the
 * tab's takeover (activate), executes `browser_action` requests, and feeds the toolbar (status dot,
 * pending-approval red dot).
 *
 * Registers: window.__domReview.wsClient
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const RECONNECT_BASE_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 30000;
  const HEARTBEAT_INTERVAL = 30000;
  const HEARTBEAT_TIMEOUT = 60000;
  const CLIENT_ID_RETRY_DELAY = 100;
  const CLIENT_ID_MAX_RETRIES = 8;
  const FALLBACK_CLIENT_ID_KEY = 'devtailor:fallback-client-id';
  const RECOVERY_DEBOUNCE_MS = 300;

  let clientId = null;
  let status = 'disconnected';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastHeartbeatTime = 0;
  let clientIdPromise = null;
  let listeners = [];
  let statusListeners = [];
  let projectListeners = [];
  let sessionListeners = [];
  let projectInfo = null;
  let lastSentProjectId = null;
  let sessionId = null;
  let sessionTitle = null;
  let activeClientId = null;
  let isActiveClient = false;
  let currentBridgeUrl = null;
  let connecting = false;
  let recoveryTimer = null;
  let everConnected = false;
  let backend = null;
  let disconnectedAt = 0;

  function getBridgeUrl() {
    return currentBridgeUrl;
  }

  function setBridgeUrl(url) {
    if (typeof url === 'string' && url) currentBridgeUrl = url;
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Extension message failed'));
            return;
          }
          resolve(response || {});
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function responseFromProxy(result) {
    const body = typeof result.body === 'string' ? result.body : '';
    return {
      ok: Boolean(result.ok),
      status: Number(result.status || 0),
      statusText: result.statusText || '',
      text: () => Promise.resolve(body),
      json: () => Promise.resolve().then(() => body ? JSON.parse(body) : {}),
    };
  }

  async function bridgeFetch(path, options = {}) {
    const result = await runtimeMessage({
      type: 'DEVTAILOR_BRIDGE_PROXY_REQUEST',
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    });
    if (result.bridgeUrl) setBridgeUrl(result.bridgeUrl);
    return responseFromProxy(result);
  }

  /**
   * JSON call through the service-worker proxy, parsed with bridgeCore:
   * { ok, status, reachable, data, code, message }. Never throws.
   */
  async function call(path, options = {}) {
    const core = window.__domReview.bridgeCore;
    try {
      const result = await runtimeMessage({
        type: 'DEVTAILOR_BRIDGE_PROXY_REQUEST',
        path,
        method: options.method || 'GET',
        headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      if (result.bridgeUrl) setBridgeUrl(result.bridgeUrl);
      return core.parseProxyResponse(result);
    } catch (err) {
      return core.parseProxyResponse({ ok: false, status: 0, error: err?.message || String(err) });
    }
  }

  function isExtensionContextInvalidated(error) {
    return /Extension context invalidated/i.test(error?.message || String(error || ''));
  }

  function setStatus(newStatus) {
    if (status === newStatus) return;
    if (status === 'connected') disconnectedAt = Date.now();
    status = newStatus;
    statusListeners.forEach(fn => {
      try { fn(status); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE status listener error:', e); }
    });
  }

  function notifyStatus() {
    statusListeners.forEach(fn => {
      try { fn(status); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE status listener error:', e); }
    });
  }

  function setActiveClient(nextActiveClientId) {
    const nextIsActive = Boolean(clientId && nextActiveClientId === clientId);
    if (activeClientId === nextActiveClientId && isActiveClient === nextIsActive) return;
    activeClientId = nextActiveClientId || null;
    isActiveClient = nextIsActive;
    notifyStatus();
  }

  function getStatus() {
    return status;
  }

  function getStableFallbackClientId() {
    try {
      const existing = window.sessionStorage && window.sessionStorage.getItem(FALLBACK_CLIENT_ID_KEY);
      if (existing) return existing;
      const generated = `tab_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (window.sessionStorage) window.sessionStorage.setItem(FALLBACK_CLIENT_ID_KEY, generated);
      return generated;
    } catch {
      return `tab_fallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  }

  function isChromeTabClientId(id) {
    return /^tab_\d+$/.test(String(id || ''));
  }

  /**
   * Bridge/Hub requests must carry the project they belong to (X-DevTailor-Project).
   * The service worker owns the header; we only tell it which project /health reported,
   * and only when that id changes. Failures stay silent: the header is an optimization
   * for a Hub fronting several projects, never a reason to break the page.
   */
  function syncProjectIdToBackground(info) {
    const projectId = typeof info?.projectId === 'string' ? info.projectId : '';
    // A Hub serving several projects with no single top-level project: stay header-less
    // and let the Hub apply its own fallback rules.
    if (!projectId && Array.isArray(info?.projects) && info.projects.length > 1) return;
    if (projectId === lastSentProjectId) return;
    // Nothing learned yet and nothing to report (a bridge that answers /health without
    // details): no point in a message, the header stays off.
    if (!projectId && lastSentProjectId === null) return;
    lastSentProjectId = projectId;
    try {
      chrome.runtime.sendMessage({ type: 'SET_PROJECT_ID', projectId }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context invalidated (page reload/extension update) — ignore.
    }
  }

  function setProjectInfo(info) {
    if (!info) return;
    syncProjectIdToBackground(info);
    if (!info.projectId) return;
    const next = {
      projectId: info.projectId,
      projectName: info.projectName || 'project',
      bridgeInstanceId: info.bridgeInstanceId || null,
      agentKey: info.agentKey || null,
      agentLabel: info.agentLabel || null,
    };
    if (
      projectInfo &&
      projectInfo.projectId === next.projectId &&
      projectInfo.projectName === next.projectName &&
      projectInfo.bridgeInstanceId === next.bridgeInstanceId &&
      projectInfo.agentKey === next.agentKey &&
      projectInfo.agentLabel === next.agentLabel
    ) {
      return;
    }
    projectInfo = next;
    projectListeners.forEach(fn => {
      try { fn(projectInfo); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE project listener error:', e); }
    });
  }

  function getProjectInfo() {
    return projectInfo;
  }

  function getClientId() {
    return clientId;
  }

  function getSessionId() {
    return sessionId;
  }

  function getSessionTitle() {
    return sessionTitle;
  }

  function setSessionInfo(id, title) {
    const nextTitle = typeof title === 'string' && title.trim() ? title.trim() : null;
    if (sessionId === id && sessionTitle === nextTitle) return;
    sessionId = id || null;
    sessionTitle = nextTitle;
    sessionListeners.forEach(fn => {
      try { fn(sessionId, sessionTitle); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE session listener error:', e); }
    });
  }

  function setSessionId(id) {
    setSessionInfo(id, null);
  }

  function handleBridgeMessageData(data) {
    lastHeartbeatTime = Date.now();
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'browser_action') {
        handleBrowserAction(msg);
        return;
      }
      if (msg.type === 'connected') {
        setProjectInfo(msg);
        setActiveClient(msg.activeClientId || null);
        if (msg.activeSessionId || msg.activeSessionTitle) {
          setSessionInfo(msg.activeSessionId || null, msg.activeSessionTitle || null);
        }
      }
      if (msg.type === 'active_client') {
        setActiveClient(msg.activeClientId || null);
      }
      if (msg.type === 'session_info' && msg.sessionId) {
        setSessionInfo(msg.sessionId, msg.sessionTitle || null);
      }
      if (msg.type === 'session_reset') {
        setSessionInfo(msg.sessionId || null, msg.sessionTitle || null);
      }
      listeners.forEach(fn => {
        try { fn(msg); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE message listener error:', e); }
      });
    } catch {
      console.warn('[DevTailor] Invalid SSE message:', data);
    }
  }

  /** Ask the bridge which session is current and tell the chat layer. */
  async function syncActiveSession(reason = 'reconnect', extra = {}) {
    const res = await call(`/sessions/active?clientId=${encodeURIComponent(clientId || 'default')}`);
    if (!res.ok || !res.data) {
      emit({ type: 'active_session_sync', ok: false, reason, failure: window.__domReview.bridgeCore.failureInfo(res), ...extra });
      return;
    }
    const body = res.data;
    setSessionInfo(body.activeSessionId || null, body.session?.title || null);
    emit({ type: 'active_session_sync', ok: true, reason, body, backend, ...extra });
  }

  async function connectViaProxy() {
    if (connecting) return;
    connecting = true;
    clearTimeout(reconnectTimer);
    setStatus('connecting');

    try {
      const result = await runtimeMessage({
        type: 'DEVTAILOR_BRIDGE_PROXY_CONNECT',
        clientId,
      });
      if (!result.ok) {
        throw new Error(result.error || 'Failed to start Bridge proxy');
      }
      connecting = false;
    } catch (err) {
      connecting = false;
      console.warn('[DevTailor] Bridge proxy connect failed:', err.message || err);
      setStatus('disconnected');
      scheduleReconnect();
    }
  }

  function connect(options = {}) {
    if (connecting) return;
    if (!isChromeTabClientId(clientId)) {
      initClientId().then(() => connect(options));
      return;
    }
    connectViaProxy();
  }

  function disconnect(stopReconnect = true) {
    if (stopReconnect) {
      clearTimeout(reconnectTimer);
      reconnectAttempts = 0;
    }
    stopHeartbeat();
    connecting = false;
    if (clientId) {
      runtimeMessage({
        type: 'DEVTAILOR_BRIDGE_PROXY_DISCONNECT',
        clientId,
      }).catch(() => {});
    }
    setStatus('disconnected');
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeSinceLastHeartbeat = now - lastHeartbeatTime;

      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
        console.warn('[DevTailor] SSE heartbeat timeout, reconnecting...');
        reconnectSoon();
        return;
      }

      if (status === 'connected') {
        bridgeFetch('/health', { method: 'GET' })
          .then(response => {
            if (response.ok) {
              lastHeartbeatTime = Date.now();
            } else {
              console.warn('[DevTailor] Heartbeat failed:', response.status);
              reconnectSoon();
            }
          })
          .catch(err => {
            console.warn('[DevTailor] Heartbeat error:', err.message);
            reconnectSoon();
          });
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_MAX_DELAY, RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1));
    setStatus('connecting');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function reconnectNow() {
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    connecting = false;
    disconnect(false);
    connect();
  }

  function reconnectSoon() {
    clearTimeout(reconnectTimer);
    connecting = false;
    disconnect(false);
    reconnectAttempts = 0;
    reconnectTimer = setTimeout(connect, 50);
  }

  function recoverConnection() {
    clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      if (!isChromeTabClientId(clientId)) {
        initClientId().then(() => connect());
        return;
      }
      if (status !== 'connected' && !connecting) {
        connect();
      }
    }, RECOVERY_DEBOUNCE_MS);
  }

  async function send(payload, options = {}) {
    if (status !== 'connected') {
      connect();
      return { ok: false, status, code: 'bridge_offline', error: window.__domReview.bridgeCore.errorInfo('bridge_offline').text };
    }
    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const res = await call('/review', { method: 'POST', body: { ...body, clientId, tabId: clientId } });
    if (!res.ok) {
      const info = window.__domReview.bridgeCore.failureInfo(res);
      if (!res.reachable && options.reconnectOnError !== false) reconnectSoon();
      return { ok: false, status, code: info.code, error: info.text };
    }
    return { ok: true, turnId: res.data?.turnId || null, sessionId: res.data?.sessionId || null };
  }

  async function cancel() {
    if (status !== 'connected') {
      return { ok: false, status };
    }
    const res = await call('/cancel', { method: 'POST', body: { clientId, tabId: clientId } });
    if (!res.ok) {
      const info = window.__domReview.bridgeCore.failureInfo(res);
      return { ok: false, code: info.code, error: info.text };
    }
    return { ok: true, canceled: Boolean(res.data?.canceled), reason: res.data?.reason };
  }

  async function activate() {
    if (status !== 'connected') {
      connect();
      return { ok: false, status };
    }
    const res = await call('/activate', { method: 'POST', body: { clientId, tabId: clientId } });
    if (!res.ok) {
      return { ok: false, error: window.__domReview.bridgeCore.failureInfo(res).text };
    }
    const body = res.data || {};
    setActiveClient(body.activeClientId || clientId);
    if (body.activeSessionId || body.activeSessionTitle) {
      setSessionInfo(body.activeSessionId || null, body.activeSessionTitle || null);
    }
    return body;
  }

  /** POST /new-session { clientId } — starts a fresh conversation for this tab. */
  async function newSession() {
    if (status !== 'connected') {
      return { ok: false, status, error: window.__domReview.bridgeCore.errorInfo('bridge_offline').text };
    }
    const res = await call('/new-session', { method: 'POST', body: { clientId, tabId: clientId } });
    if (!res.ok) {
      const info = window.__domReview.bridgeCore.failureInfo(res);
      return { ok: false, code: info.code, error: info.text };
    }
    const body = res.data || {};
    if (body.sessionId) setSessionInfo(body.sessionId, body.title || null);
    return { ok: true, ...body };
  }

  function getActiveSession() {
    return call(`/sessions/active?clientId=${encodeURIComponent(clientId || 'default')}`);
  }

  async function handleBrowserAction(action) {
    const requestId = action && action.requestId;
    try {
      registerBrowserAction(requestId, action?.action);
      if (!window.__domReview.browserActions || typeof window.__domReview.browserActions.handle !== 'function') {
        throw new Error('Browser actions module is not loaded');
      }
      const result = await window.__domReview.browserActions.handle(action);
      await postBrowserActionResult({
        requestId,
        ok: true,
        result,
      });
    } catch (err) {
      await postBrowserActionResult({
        requestId,
        ok: false,
        error: {
          code: isExtensionContextInvalidated(err) ? 'EXTENSION_CONTEXT_INVALIDATED' : 'ACTION_FAILED',
          message: err.message || String(err),
          detail: err.detail || null,
        },
      });
    } finally {
      clearBrowserAction(requestId);
    }
  }

  function registerBrowserAction(requestId, actionName) {
    if (!requestId) return;
    try {
      chrome.runtime.sendMessage({
        type: 'REGISTER_BROWSER_ACTION',
        requestId,
        action: actionName || null,
      }, () => {});
    } catch {}
  }

  function clearBrowserAction(requestId) {
    if (!requestId) return;
    try {
      chrome.runtime.sendMessage({
        type: 'CLEAR_BROWSER_ACTION',
        requestId,
      }, () => {});
    } catch {}
  }

  function postBrowserActionResult(result) {
    return bridgeFetch('/browser-action-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }).catch(err => {
      console.warn('[DevTailor] Failed to post browser action result:', err);
    });
  }

  function emit(msg) {
    listeners.forEach(fn => {
      try { fn(msg); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE message listener error:', e); }
    });
  }

  function onMessage(callback) {
    listeners.push(callback);
    return () => { listeners = listeners.filter(fn => fn !== callback); };
  }

  function onStatusChange(callback) {
    statusListeners.push(callback);
    return () => { statusListeners = statusListeners.filter(fn => fn !== callback); };
  }

  function onProjectChange(callback) {
    projectListeners.push(callback);
    if (projectInfo) {
      try { callback(projectInfo); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE project listener error:', e); }
    }
    return () => { projectListeners = projectListeners.filter(fn => fn !== callback); };
  }

  function onSessionChange(callback) {
    sessionListeners.push(callback);
    if (sessionId) {
      try { callback(sessionId, sessionTitle); } catch (e) { if (!isExtensionContextInvalidated(e)) console.warn('[DevTailor] SSE session listener error:', e); }
    }
    return () => { sessionListeners = sessionListeners.filter(fn => fn !== callback); };
  }

  function initClientId() {
    if (isChromeTabClientId(clientId)) return Promise.resolve(clientId);
    if (clientIdPromise) return clientIdPromise;

    clientIdPromise = new Promise(resolve => {
      const finish = (id) => {
        if (!isChromeTabClientId(clientId) || isChromeTabClientId(id)) {
          clientId = id;
        }
        const resolved = clientId;
        clientIdPromise = null;
        resolve(resolved);
      };
      const useFallback = () => {
        finish(clientId || getStableFallbackClientId());
      };
      const retryOrFallback = (attempt) => {
        if (attempt < CLIENT_ID_MAX_RETRIES) {
          setTimeout(() => {
            requestTabId(attempt + 1);
          }, CLIENT_ID_RETRY_DELAY);
          return;
        }
        useFallback();
      };

      function requestTabId(attempt) {
        try {
          chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
            if (chrome.runtime.lastError) {
              retryOrFallback(attempt);
              return;
            }
            const tabId = response && response.tabId;
            if (tabId == null) {
              retryOrFallback(attempt);
              return;
            }
            finish(`tab_${tabId}`);
          });
        } catch (e) {
          retryOrFallback(attempt);
        }
      }

      requestTabId(0);
    });
    return clientIdPromise;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'DEVTAILOR_BRIDGE_PROXY_EVENT') return false;
    if (message.clientId && clientId && message.clientId !== clientId) return false;

    if (message.bridgeUrl) setBridgeUrl(message.bridgeUrl);

    if (message.event === 'open') {
      const url = message.bridgeUrl || getBridgeUrl();
      console.log('[DevTailor] SSE connected through background proxy', {
        clientId,
        url: url ? `${url}/events` : null,
      });
      connecting = false;
      reconnectAttempts = 0;
      const reconnect = everConnected;
      const disconnectedMs = reconnect && disconnectedAt ? Date.now() - disconnectedAt : 0;
      everConnected = true;
      setStatus('connected');
      lastHeartbeatTime = Date.now();
      startHeartbeat();
      bridgeFetch(`/health?clientId=${encodeURIComponent(clientId || 'default')}`)
        .then(async response => {
          if (!response.ok) return;
          const info = await response.json();
          // setProjectInfo forwards the project id to the background (header) even when
          // /health carries no top-level projectId.
          setProjectInfo(info);
          if (info?.projectId) {
            backend = typeof info.backend === 'string' ? info.backend : backend;
            if (Object.prototype.hasOwnProperty.call(info, 'activeClientId')) {
              setActiveClient(info.activeClientId || null);
            }
            if (info.activeSessionId || info.activeSessionTitle) {
              setSessionInfo(info.activeSessionId || null, info.activeSessionTitle || null);
            }
          }
          await syncActiveSession(reconnect ? 'reconnect' : 'initial', { reconnect, disconnectedMs });
        })
        .catch(err => console.warn('[DevTailor] Proxy health check failed:', err.message || err));
      return false;
    }

    if (message.event === 'message') {
      handleBridgeMessageData(message.data || '');
      return false;
    }

    if (message.event === 'error') {
      console.warn('[DevTailor] Background Bridge proxy SSE error', {
        clientId,
        bridgeUrl: message.bridgeUrl || null,
        error: message.error || null,
      });
      connecting = false;
      setStatus('disconnected');
      scheduleReconnect();
      return false;
    }

    return false;
  });

  window.__domReview.wsClient = {
    connect,
    disconnect,
    activate,
    send,
    cancel,
    newSession,
    getActiveSession,
    call,
    getStatus,
    getReconnectAttempts: () => reconnectAttempts,
    getBackend: () => backend,
    getBridgeUrl,
    request: bridgeFetch,
    isActive: () => isActiveClient,
    getActiveClientId: () => activeClientId,
    getProjectInfo,
    getClientId,
    getSessionId,
    getSessionTitle,
    setSessionInfo,
    onMessage,
    onStatusChange,
    onProjectChange,
    onSessionChange,
    reconnectNow,
  };

  window.addEventListener('online', recoverConnection);
  window.addEventListener('pageshow', recoverConnection);
  window.addEventListener('focus', recoverConnection);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recoverConnection();
  });

  connect();
})();
