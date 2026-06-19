/**
 * DevTailor — SSE Client Module
 *
 * Receives Bridge events through the extension background proxy.
 * Kept as window.__domReview.wsClient to avoid touching the chat panel API.
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
  let sessionId = null;
  let sessionTitle = null;
  let activeClientId = null;
  let isActiveClient = false;
  let currentBridgeUrl = null;
  let connecting = false;
  let recoveryTimer = null;

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

  function isExtensionContextInvalidated(error) {
    return /Extension context invalidated/i.test(error?.message || String(error || ''));
  }

  function setStatus(newStatus) {
    if (status === newStatus) return;
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

  function setProjectInfo(info) {
    if (!info || !info.projectId) return;
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

  async function syncActiveSessionSnapshot(reason = 'reconnect') {
    try {
      const url = `/sessions/active?clientId=${encodeURIComponent(clientId || 'default')}`;
      const response = await bridgeFetch(url);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok || !body.activeSessionId) return;
      setSessionInfo(body.activeSessionId, body.session?.title || null);
      emit({
        type: 'session_snapshot',
        tabId: clientId,
        sessionId: body.activeSessionId,
        sessionTitle: body.session?.title || null,
        messages: Array.isArray(body.messages) ? body.messages : [],
        isProcessing: Boolean(body.isProcessing),
        reason,
      });
    } catch (err) {
      console.warn('[DevTailor] Failed to resync active session snapshot:', err.message || err);
    }
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
      return { ok: false, queued: false, status };
    }
    if (!isActiveClient) {
      return { ok: false, queued: false, status, error: 'inactive_tab' };
    }

    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    try {
      const response = await bridgeFetch('/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          clientId,
          tabId: clientId,
        }),
      });
      if (!response.ok) {
        const message = await response.text();
        emit({ type: 'error', message: message || `HTTP ${response.status}` });
        return { ok: false, queued: false, status, error: message || `HTTP ${response.status}` };
      }
      return { ok: true, queued: false };
    } catch (err) {
      emit({ type: 'error', message: err.message || 'Failed to send request to DevTailor Bridge' });
      if (options.reconnectOnError !== false) reconnectSoon();
      return { ok: false, queued: false, status, error: err.message || 'Failed to send request to DevTailor Bridge' };
    }
  }

  async function cancel() {
    if (status !== 'connected') {
      return { ok: false, status };
    }

    try {
      const response = await bridgeFetch('/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, tabId: clientId }),
      });
      if (!response.ok) {
        const message = await response.text();
        emit({ type: 'error', message: message || `HTTP ${response.status}` });
        return { ok: false, error: message };
      }
      return await response.json();
    } catch (err) {
      const message = err.message || 'Failed to cancel current task';
      emit({ type: 'error', message });
      return { ok: false, error: message };
    }
  }

  async function activate() {
    if (status !== 'connected') {
      connect();
      return { ok: false, status };
    }

    try {
      const response = await bridgeFetch('/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, tabId: clientId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || `HTTP ${response.status}`;
        emit({ type: 'error', message });
        return { ok: false, error: message };
      }
      setActiveClient(body.activeClientId || clientId);
      if (body.activeSessionId || body.activeSessionTitle) {
        setSessionInfo(body.activeSessionId || null, body.activeSessionTitle || null);
      }
      return body;
    } catch (err) {
      const message = err.message || 'Failed to activate current tab';
      emit({ type: 'error', message });
      return { ok: false, error: message };
    }
  }

  function newSession() {
    if (status !== 'connected') {
      return Promise.resolve({ ok: false, status });
    }
    return bridgeFetch('/new-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, tabId: clientId }),
    }).then(async response => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || `HTTP ${response.status}`;
        return { ok: false, error: message };
      }
      if (body.sessionId) setSessionInfo(body.sessionId, body.sessionTitle || '新会话');
      else setSessionInfo(null, null);
      return { ok: true, ...body };
    }).catch(err => {
      emit({ type: 'error', message: err.message || 'Failed to reset session' });
      return { ok: false, error: err.message };
    });
  }

  async function listSessions() {
    if (status !== 'connected') {
      return { ok: false, status };
    }
    try {
      const url = `/sessions?clientId=${encodeURIComponent(clientId || 'default')}`;
      const response = await bridgeFetch(url);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, error: body.error || `HTTP ${response.status}` };
      }
      return body;
    } catch (err) {
      return { ok: false, error: err.message || 'Failed to list sessions' };
    }
  }

  async function getActiveSession() {
    if (status !== 'connected') {
      return { ok: false, status };
    }
    try {
      const url = `/sessions/active?clientId=${encodeURIComponent(clientId || 'default')}`;
      const response = await bridgeFetch(url);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, error: body.error || `HTTP ${response.status}` };
      }
      return body;
    } catch (err) {
      return { ok: false, error: err.message || 'Failed to get active session' };
    }
  }

  async function loadSession(targetSessionId) {
    if (status !== 'connected') {
      return { ok: false, status };
    }
    try {
      const response = await bridgeFetch('/sessions/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, tabId: clientId, sessionId: targetSessionId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || `HTTP ${response.status}`;
        emit({ type: 'error', message });
        return { ok: false, error: message };
      }
      setSessionInfo(targetSessionId, body.sessionTitle || body.session?.title || null);
      return body;
    } catch (err) {
      emit({ type: 'error', message: err.message || 'Failed to load session' });
      return { ok: false, error: err.message };
    }
  }

  async function deleteSession(targetSessionId) {
    if (status !== 'connected') {
      return { ok: false, status };
    }
    try {
      const response = await bridgeFetch('/sessions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, tabId: clientId, sessionId: targetSessionId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body.error || `HTTP ${response.status}`;
        emit({ type: 'error', message });
        return { ok: false, error: message };
      }
      if (body.activeSessionId) setSessionInfo(body.activeSessionId, body.activeSessionTitle || body.sessionTitle || null);
      return body;
    } catch (err) {
      emit({ type: 'error', message: err.message || 'Failed to delete session' });
      return { ok: false, error: err.message };
    }
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
      setStatus('connected');
      lastHeartbeatTime = Date.now();
      startHeartbeat();
      bridgeFetch(`/health?clientId=${encodeURIComponent(clientId || 'default')}`)
        .then(async response => {
          if (!response.ok) return;
          const info = await response.json();
          if (info?.projectId) {
            setProjectInfo(info);
            if (Object.prototype.hasOwnProperty.call(info, 'activeClientId')) {
              setActiveClient(info.activeClientId || null);
            }
            if (info.activeSessionId || info.activeSessionTitle) {
              setSessionInfo(info.activeSessionId || null, info.activeSessionTitle || null);
            }
          }
          await syncActiveSessionSnapshot('reconnect');
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
    listSessions,
    getActiveSession,
    loadSession,
    deleteSession,
    getStatus,
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
