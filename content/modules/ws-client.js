/**
 * DevTailor — SSE Client Module
 *
 * Receives bridge events via EventSource and sends review requests via fetch.
 * Kept as window.__domReview.wsClient to avoid touching the chat panel API.
 *
 * Registers: window.__domReview.wsClient
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const BRIDGE_URL = 'http://localhost:34781';
  const MAX_RECONNECT_ATTEMPTS = 3;
  const RECONNECT_BASE_DELAY = 1000;
  const FALLBACK_CLIENT_ID_KEY = 'devtailor:fallback-client-id';

  let clientId = null;
  let events = null;
  let status = 'disconnected';
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let listeners = [];
  let statusListeners = [];
  let projectListeners = [];
  let sessionListeners = [];
  let projectInfo = null;
  let sessionId = null;
  let sessionTitle = null;
  let activeClientId = null;
  let isActiveClient = false;

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

  function connect() {
    if (!clientId) {
      initClientId().then(connect);
      return;
    }
    if (events && events.readyState !== EventSource.CLOSED) return;

    clearTimeout(reconnectTimer);
    setStatus('connecting');

    try {
      events = new EventSource(`${BRIDGE_URL}/events?clientId=${encodeURIComponent(clientId)}`);
    } catch (e) {
      console.error('[DevTailor] Failed to create EventSource:', e);
      scheduleReconnect();
      return;
    }

    events.onopen = () => {
      console.log('[DevTailor] SSE connected');
      reconnectAttempts = 0;
      setStatus('connected');

      // Detect bridge restart (new projectId means all agent sessions are gone)
      fetch(`${BRIDGE_URL}/health`)
        .then(r => r.ok ? r.json() : null)
        .then(info => {
          if (!info || !info.projectId) return;
          if (projectInfo && projectInfo.projectId !== info.projectId) {
            emit({ type: 'session_reset', reason: 'bridge_restarted' });
          }
          setProjectInfo(info);
          if (Object.prototype.hasOwnProperty.call(info, 'activeClientId')) {
            setActiveClient(info.activeClientId || null);
          }
          if (info.activeSessionId || info.activeSessionTitle) {
            setSessionInfo(info.activeSessionId || null, info.activeSessionTitle || null);
          }
        })
        .catch(() => {});
    };

    events.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
        console.warn('[DevTailor] Invalid SSE message:', event.data);
      }
    };

    events.onerror = () => {
      console.warn('[DevTailor] SSE connection error');
      disconnect(false);
      scheduleReconnect();
    };
  }

  function disconnect(stopReconnect = true) {
    if (stopReconnect) {
      reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
      clearTimeout(reconnectTimer);
    }
    if (events) {
      events.close();
      events = null;
    }
    setStatus('disconnected');
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[DevTailor] Max SSE reconnect attempts reached');
      setStatus('disconnected');
      return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1);
    setStatus('connecting');
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(payload, options = {}) {
    if (status !== 'connected') {
      return { ok: false, queued: false, status };
    }
    if (!isActiveClient) {
      return { ok: false, queued: false, status, error: 'inactive_tab' };
    }

    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    fetch(`${BRIDGE_URL}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        clientId,
        tabId: clientId,
      }),
    }).then(async response => {
      if (!response.ok) {
        const message = await response.text();
        emit({ type: 'error', message: message || `HTTP ${response.status}` });
      }
    }).catch(err => {
      emit({ type: 'error', message: err.message || 'Failed to send request to DevTailor Bridge' });
      if (options.reconnectOnError !== false) connect();
    });

    return { ok: true, queued: false };
  }

  async function cancel() {
    if (status !== 'connected') {
      return { ok: false, status };
    }

    try {
      const response = await fetch(`${BRIDGE_URL}/cancel`, {
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
      return { ok: false, status };
    }

    try {
      const response = await fetch(`${BRIDGE_URL}/activate`, {
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
    return fetch(`${BRIDGE_URL}/new-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, tabId: clientId }),
    }).then(async response => {
      if (!response.ok) {
        const message = await response.text();
        emit({ type: 'error', message: message || `HTTP ${response.status}` });
        return { ok: false, error: message };
      }
      const body = await response.json().catch(() => ({}));
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
      const url = `${BRIDGE_URL}/sessions?clientId=${encodeURIComponent(clientId || 'default')}`;
      const response = await fetch(url);
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
      const url = `${BRIDGE_URL}/sessions/active?clientId=${encodeURIComponent(clientId || 'default')}`;
      const response = await fetch(url);
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
      const response = await fetch(`${BRIDGE_URL}/sessions/load`, {
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
      const response = await fetch(`${BRIDGE_URL}/sessions/delete`, {
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
    return fetch(`${BRIDGE_URL}/browser-action-result`, {
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
    if (clientId) return Promise.resolve(clientId);
    return new Promise(resolve => {
      const useFallback = () => {
        clientId = getStableFallbackClientId();
        resolve(clientId);
      };

      try {
        chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
          if (chrome.runtime.lastError) {
            useFallback();
            return;
          }
          const tabId = response && response.tabId;
          clientId = tabId != null
            ? `tab_${tabId}`
            : getStableFallbackClientId();
          resolve(clientId);
        });
      } catch (e) {
        useFallback();
      }
    });
  }

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
  };

  connect();
})();
