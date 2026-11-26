/**
 * DevTailor — Service Worker (Background)
 *
 * Handles on-demand page injection/takeover and all Hub HTTP/SSE proxying.
 */

importScripts('instance-header.js', 'injection-state.js', '../content/modules/references-core.js');

const LEGACY_PATTERNS_KEY = 'dr_custom_patterns';
const INSTANCE_KEY = 'dt_selected_instance_id';
const INJECTED_TABS_KEY = 'dt_injected_tabs';
const ACTIVE_TAB_KEY = 'dt_active_tab';
const BRIDGE_URLS = ['http://localhost:34781', 'http://127.0.0.1:34781'];
const BRIDGE_CONNECT_TIMEOUT_MS = 1500;
const pendingBrowserActions = new Map();
const bridgeSseProxies = new Map();
const injectionPromises = new Map();
let injectionStateMutation = Promise.resolve();
let activationMutation = Promise.resolve();
let sidePanelFocusRequestedAt = 0;
let preferredBridgeUrlIndex = 0;
let selectedInstanceId = '';
const instanceHeader = self.__domReview.instanceHeader;
const injectionState = self.__domReview.injectionState;
const referencesCore = self.__domReview.referencesCore;
const instanceReady = chrome.storage.local.get(INSTANCE_KEY).then(result => {
  selectedInstanceId = instanceHeader.normalizeInstanceId(result[INSTANCE_KEY]);
});

const MAIN_WORLD_START_SCRIPTS = [
  'content/modules/browser-console-bridge.js'
];
const MAIN_WORLD_SCRIPTS = [
  'content/modules/framework-bridge.js'
];
// Complete isolated-world on-demand injection list; order matters.
const ISOLATED_WORLD_SCRIPTS = [
  'content/modules/review-store.js',
  'content/modules/marks-core.js',
  'content/modules/references-core.js',
  'content/modules/toolbar-core.js',
  'content/modules/element-targets.js',
  'content/modules/selector-generator.js',
  'content/modules/framework-detector.js',
  'content/modules/context-capture.js',
  'content/modules/visbug-hit-test.js',
  'content/modules/shadow-ui.js',
  'content/modules/badges.js',
  'content/modules/sidebar.js',
  'content/modules/bridge-core.js',
  'content/modules/prompt-builder.js',
  'content/modules/browser-console.js',
  'content/modules/browser-action-dom.js',
  'content/modules/browser-actions.js',
  'content/modules/ws-client.js',
  'content/modules/marks-sync.js',
  'content/modules/screenshot.js',
  'content/modules/references.js',
  'content/modules/selector-mode.js',
  'content/modules/toolbar.js',
  'content/content-script.js'
];
const ISOLATED_WORLD_CSS = ['content/content-style.css'];

function isInjectableUrl(url) {
  try {
    const protocol = new URL(url || '').protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function cleanupLegacyRegistration() {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const ids = registered.map(script => script.id).filter(id => id.startsWith('dr-custom-'));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch {}
  await chrome.storage.sync.remove(LEGACY_PATTERNS_KEY).catch(() => {});
}

async function performInjection(tabId) {
  if (!tabId) return { injected: false, error: '缺少标签页。' };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isInjectableUrl(tab?.url || '')) {
      return { injected: false, unsupported: true, error: '此页面不支持注入。请在普通 http/https 网页上使用 DevTailor（Chrome 内置页和扩展商店不可用）。' };
    }

    const existing = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__domReview && window.__domReview.ui && window.__domReview.wsClient)
    });
    if (existing && existing[0] && existing[0].result) {
      return { injected: false, alreadyInjected: true };
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try { window.__domReview?.wsClient?.disconnect?.(); } catch {}
        [
          'dom-review-host',
          'dom-review-badges',
          'dom-review-highlights',
          'dom-review-selector-overlay',
          'dom-review-selector-hint',
          'dom-review-reference-overlay',
          'dom-review-reference-hint',
          'dom-review-reference-popup',
          'dom-review-reference-styles',
          'devtailor-host',
          'devtailor-badges',
          'devtailor-highlights'
        ].forEach(id => document.getElementById(id)?.remove());
      }
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: MAIN_WORLD_START_SCRIPTS,
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: MAIN_WORLD_SCRIPTS,
      world: 'MAIN'
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ISOLATED_WORLD_CSS
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ISOLATED_WORLD_SCRIPTS
    });
    return { injected: true };
  } catch (err) {
    const detail = err?.message || '注入失败';
    return { injected: false, error: `无法接管此页面：${detail}。Chrome 内置页和扩展商店不允许扩展注入。` };
  }
}

async function injectDevTailorIntoTab(tabId) {
  if (injectionPromises.has(tabId)) return injectionPromises.get(tabId);
  const promise = performInjection(tabId).finally(() => injectionPromises.delete(tabId));
  injectionPromises.set(tabId, promise);
  return promise;
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('DevTailor extension installed');
  await cleanupLegacyRegistration();
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

cleanupLegacyRegistration();

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// --- Explicit takeover / keyboard shortcut ---

async function getInjectionSession() {
  const saved = await chrome.storage.session.get([INJECTED_TABS_KEY, ACTIVE_TAB_KEY]);
  return {
    rememberedTabIds: injectionState.normalizeTabIds(saved[INJECTED_TABS_KEY]),
    activeTabId: Number(saved[ACTIVE_TAB_KEY]) || null,
  };
}

async function saveInjectionSession(state) {
  await chrome.storage.session.set({
    [INJECTED_TABS_KEY]: state.rememberedTabIds,
    [ACTIVE_TAB_KEY]: state.activeTabId,
  });
}

function mutateInjectionSession(reducer) {
  const operation = injectionStateMutation.then(async () => {
    const current = await getInjectionSession();
    const next = reducer(current);
    await saveInjectionSession(next);
    return next;
  });
  injectionStateMutation = operation.catch(() => {});
  return operation;
}

async function activateInjectedTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const deadline = Date.now() + 6000;
        const ws = window.__domReview?.wsClient;
        if (!ws) return { ok: false, error: 'DevTailor 页面客户端尚未就绪。' };
        ws.connect?.();
        while (Date.now() < deadline && ws.getStatus?.() !== 'connected') {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (ws.getStatus?.() !== 'connected') return { ok: false, error: 'Hub 未连接，请确认 devtailor-hub 正在运行。' };
        return await ws.activate();
      },
    });
    const result = results?.[0]?.result;
    return result && result.ok !== false ? { ok: true, ...result } : { ok: false, error: result?.error || '接管当前页失败。' };
  } catch (err) {
    return { ok: false, error: err?.message || '接管当前页失败。' };
  }
}

function queueActivation(tabId, claimOwnership) {
  const operation = activationMutation.then(async () => {
    if (!claimOwnership) {
      const current = await getInjectionSession();
      if (current.activeTabId !== Number(tabId)) return { ok: false, stale: true };
    }
    const activation = await activateInjectedTab(tabId);
    if (activation.ok && claimOwnership) {
      await mutateInjectionSession(current => injectionState.afterTakeover(current.rememberedTabIds, tabId));
    }
    return activation;
  });
  activationMutation = operation.catch(() => {});
  return operation;
}

// --- Reference elements: the single writer of the pending list ---
// chrome.storage.session holds the global list (not per tab); every write goes through one serialised
// mutation so two concurrent ADDs cannot overwrite each other with a stale whole table. Content
// scripts send MSG.ADD; the side panel sends note edits / removals / clears. Each change is
// broadcast to extension pages (DT_REFERENCES_UPDATED).

const REFERENCES_KEY = 'dt_references';
let referencesMutation = Promise.resolve();

function readReferences() {
  return chrome.storage.session.get(REFERENCES_KEY).then((res) => (
    Array.isArray(res[REFERENCES_KEY]) ? res[REFERENCES_KEY] : []
  ));
}

function broadcastReferences(list) {
  const message = { type: referencesCore.MSG.UPDATED, references: list };
  chrome.runtime.sendMessage(message).catch(() => {}); // no side panel / page listener is normal
}

/**
 * Read-only check for the page: is `tabId` the one the user is looking at? A background tab must
 * not produce a "reference screenshot" of whatever page happens to be frontmost.
 */
async function referenceTabCheck(tabId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const foreground = Boolean(tab && Number(tab.id) === Number(tabId));
    return { ok: true, match: foreground, foreground };
  } catch {
    return { ok: true, match: false, foreground: false };
  }
}

/**
 * Apply `reducer` to the stored list and return its result (the caller turns it into a response).
 * Quota failures are reported back instead of being swallowed: the page keeps the entry and tells
 * the user the reference was not saved.
 */
function mutateReferences(reducer) {
  const operation = referencesMutation.then(async () => {
    const current = await readReferences();
    const outcome = reducer(current);
    if (!outcome.changed) return outcome;
    try {
      await chrome.storage.session.set({ [REFERENCES_KEY]: outcome.list });
    } catch (err) {
      console.warn('[DevTailor] storing references failed:', err && err.message);
      return { ok: false, error: `storage_failed:${(err && err.message) || 'quota'}`, list: current };
    }
    broadcastReferences(outcome.list);
    return outcome;
  });
  referencesMutation = operation.catch((err) => {
    console.warn('[DevTailor] reference mutation failed:', err && err.message);
    return { ok: false, error: String((err && err.message) || err) };
  });
  return operation;
}

/**
 * Ctrl/Cmd+Shift+X. A page that is not taken over gets injected + taken over, but never when some
 * other tab already owns the takeover (the toolbar only appears/hides there). With no owner the
 * previous behaviour applies: take this page over.
 */
async function handleToggleCommand(tabId) {
  const session = await getInjectionSession();
  if (session.activeTabId != null && Number(session.activeTabId) !== Number(tabId)) {
    const injection = await injectDevTailorIntoTab(tabId);
    return injection.injected || injection.alreadyInjected
      ? toggleToolbar(tabId)
      : { ok: false, action: 'show', error: injection.error || '注入失败' };
  }
  const takenOver = Number(session.activeTabId) === Number(tabId);
  if (!takenOver) {
    const takeover = await takeoverTab(tabId);
    return takeover.ok ? { ok: true, action: 'takeover' } : { ok: false, action: 'takeover', error: takeover.error || '接管当前页失败。' };
  }
  return toggleToolbar(tabId);
}

function toggleToolbar(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const toolbar = window.__domReview && window.__domReview.toolbar;
      if (!toolbar) return { ok: false, error: '工具条未加载，请刷新页面' };
      const visible = toolbar.toggleVisibility();
      return { ok: true, visible };
    }
  }).then(results => results?.[0]?.result || { ok: false, error: '切换工具条失败' })
    .catch(err => ({ ok: false, error: err?.message || '切换工具条失败' }));
}

async function takeoverTab(tabId) {
  const injection = await injectDevTailorIntoTab(tabId);
  if (!injection.injected && !injection.alreadyInjected) return { ok: false, ...injection };
  await mutateInjectionSession(current => ({
    rememberedTabIds: injectionState.normalizeTabIds([...current.rememberedTabIds, tabId]),
    activeTabId: current.activeTabId,
  }));
  const activation = await queueActivation(tabId, true);
  return { ...injection, ...activation };
}

function executeRunJsInTab(tabId, message, sendResponse) {
  if (!tabId) {
    sendResponse({ success: false, error: 'No sender tab for run_js' });
    return;
  }

  const timeoutMs = Math.max(1000, Math.min(Number(message.timeoutMs) || 30000, 120000));
  const world = message.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
  let settled = false;

  const finish = (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sendResponse(response);
  };

  const timer = setTimeout(() => {
    finish({ success: false, error: `run_js timed out after ${timeoutMs}ms` });
  }, timeoutMs + 1000);

  chrome.scripting.executeScript({
    target: { tabId },
    world,
    func: async (fnString, args, dialogAction, innerTimeoutMs) => {
      function serialize(value) {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          return String(value);
        }
      }

      function dialogValue(action) {
        if (action === 'dismiss') return null;
        if (action === 'accept' || action == null) return '';
        return String(action);
      }

      const oldAlert = window.alert;
      const oldConfirm = window.confirm;
      const oldPrompt = window.prompt;

      try {
        window.alert = function () {};
        window.confirm = function () { return dialogAction !== 'dismiss'; };
        window.prompt = function () { return dialogValue(dialogAction); };

        const fn = (0, eval)(`(${String(fnString || '() => {}')})`);
        if (typeof fn !== 'function') {
          throw new Error('run_js input must evaluate to a function');
        }

        const execution = Promise.resolve(fn.apply(null, Array.isArray(args) ? args : []));
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`run_js timed out after ${innerTimeoutMs}ms`)), innerTimeoutMs);
        });
        const value = await Promise.race([execution, timeout]);
        return { ok: true, result: serialize(value) };
      } catch (err) {
        return {
          ok: false,
          error: (err && err.stack) || (err && err.message) || String(err),
        };
      } finally {
        window.alert = oldAlert;
        window.confirm = oldConfirm;
        window.prompt = oldPrompt;
      }
    },
    args: [
      String(message.function || '() => {}'),
      Array.isArray(message.args) ? message.args : [],
      message.dialogAction || 'accept',
      timeoutMs,
    ],
  }).then(results => {
    const first = results && results[0] && results[0].result;
    if (!first) {
      finish({ success: false, error: 'run_js returned no result' });
      return;
    }
    if (!first.ok) {
      finish({ success: false, error: first.error || 'run_js failed' });
      return;
    }
    finish({ success: true, result: first.result });
  }).catch(err => {
    finish({ success: false, error: err.message || 'run_js injection failed' });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab && tab.id) handleToggleCommand(tab.id).catch(() => {});
    });
  }
});

async function updateActionState(tabId, url) {
  const supported = isInjectableUrl(url);
  chrome.action.setTitle({
    tabId,
    title: supported ? 'DevTailor — 点击后可接管当前页' : 'DevTailor — 此页面不支持注入',
  });
  chrome.action.setBadgeText({ tabId, text: supported ? '' : '!' });
  if (!supported) chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
}

function rememberBrowserAction(tabId, requestId, action) {
  if (!tabId || !requestId) return;
  const existing = pendingBrowserActions.get(tabId);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingBrowserActions.delete(tabId);
  }, 30000);
  pendingBrowserActions.set(tabId, { requestId, action, timer, startedAt: Date.now() });
}

function clearBrowserAction(tabId, requestId) {
  const existing = pendingBrowserActions.get(tabId);
  if (!existing) return;
  if (requestId && existing.requestId !== requestId) return;
  clearTimeout(existing.timer);
  pendingBrowserActions.delete(tabId);
}

function postBrowserActionNavigation(tabId, url) {
  const existing = pendingBrowserActions.get(tabId);
  if (!existing) return;
  clearBrowserAction(tabId, existing.requestId);
  bridgeProxyRequest({
    path: '/browser-action-result',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      requestId: existing.requestId,
      ok: true,
      result: {
        navigationStarted: true,
        action: existing.action || null,
        url: url || null,
        elapsedMs: Date.now() - existing.startedAt,
        note: 'The page started navigating before the content script could post a normal browser action result.',
      },
    },
  }).catch(() => {});
}

function bridgeProxyKey(tabId, clientId) {
  return `${tabId || 'unknown'}:${clientId || 'default'}`;
}

function sendBridgeProxyEvent(tabId, payload) {
  if (!tabId) return;
  const message = {
    type: 'DEVTAILOR_BRIDGE_PROXY_EVENT',
    ...payload,
  };
  chrome.tabs.sendMessage(tabId, message).catch(() => {});

  // Also forward to sidePanel so it can piggyback on the active tab's SSE stream.
  chrome.runtime.sendMessage({
    type: 'DEVTAILOR_SIDEPANEL_PROXY_EVENT',
    tabId,
    ...payload,
  }).catch(() => {});
}

function stopBridgeSseProxy(tabId, clientId) {
  const key = bridgeProxyKey(tabId, clientId);
  const existing = bridgeSseProxies.get(key);
  if (!existing) return;
  bridgeSseProxies.delete(key);
  try { existing.controller.abort(); } catch {}
}

async function restartBridgeSseProxies() {
  const proxies = [...bridgeSseProxies.values()].map(({ tabId, clientId }) => ({ tabId, clientId }));
  for (const proxy of proxies) stopBridgeSseProxy(proxy.tabId, proxy.clientId);
  await Promise.all(proxies.map(proxy => startBridgeSseProxy(proxy.tabId, proxy.clientId)));
}

function orderedBridgeUrls() {
  return [
    ...BRIDGE_URLS.slice(preferredBridgeUrlIndex),
    ...BRIDGE_URLS.slice(0, preferredBridgeUrlIndex),
  ];
}

function rememberBridgeUrl(bridgeUrl) {
  const index = BRIDGE_URLS.indexOf(bridgeUrl);
  if (index >= 0) preferredBridgeUrlIndex = index;
}

async function fetchBridgeUrl(bridgeUrl, path, options = {}) {
  // The first request after an MV3 worker restart must wait for local selection restoration.
  await instanceReady;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_CONNECT_TIMEOUT_MS);
  const externalSignal = options.signal;
  const abortFromExternal = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }

  try {
    // Extension service-worker GETs carry no Origin header, so the bridge guard
    // identifies the extension by this custom header (pages cannot send it without
    // a CORS preflight that the guard refuses). Do not drop it.
    // A concrete instance selection is attached uniformly to HTTP and SSE requests.
    // Automatic mode sends no instance header. The external abort listener stays
    // attached after the response arrives: for a
    // streaming response (SSE) the caller aborts later to close the connection.
    return await fetch(`${bridgeUrl}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...instanceHeader.buildInstanceHeaders(selectedInstanceId),
        'X-DevTailor-Client': chrome.runtime.id,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function dispatchSseChunk(tabId, state, chunk) {
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';

  for (const line of lines) {
    if (line === '') {
      if (state.data.length > 0) {
        sendBridgeProxyEvent(tabId, {
          event: 'message',
          data: state.data.join('\n'),
          bridgeUrl: state.bridgeUrl,
        });
        state.data = [];
      }
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      state.data.push(line.slice(5).replace(/^ /, ''));
    }
  }
}

async function readSseResponse(tabId, clientId, bridgeUrl, response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Bridge SSE response has no readable body');

  const decoder = new TextDecoder();
  const state = { buffer: '', data: [], bridgeUrl };
  let receivedData = false;

  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    receivedData = true;
    dispatchSseChunk(tabId, state, decoder.decode(value, { stream: true }));
  }

  const tail = decoder.decode();
  if (tail) dispatchSseChunk(tabId, state, tail);
  if (state.data.length > 0) {
    sendBridgeProxyEvent(tabId, {
      event: 'message',
      data: state.data.join('\n'),
      bridgeUrl,
    });
  }

  if (!signal.aborted && receivedData) {
    const proxy = bridgeSseProxies.get(bridgeProxyKey(tabId, clientId));
    if (proxy && !proxy.controller.signal.aborted) {
      sendBridgeProxyEvent(tabId, {
        event: 'error',
        clientId,
        bridgeUrl,
        error: 'Bridge SSE stream ended unexpectedly',
      });
    }
  }
}

async function startBridgeSseProxy(tabId, clientId) {
  if (!tabId || !clientId) return { ok: false, error: 'Missing tabId or clientId' };
  stopBridgeSseProxy(tabId, clientId);

  const key = bridgeProxyKey(tabId, clientId);
  const controller = new AbortController();
  bridgeSseProxies.set(key, { controller, tabId, clientId });

  (async () => {
    let lastError = null;
    let retryCount = 0;
    const maxRetries = 3;

    for (const bridgeUrl of orderedBridgeUrls()) {
      if (controller.signal.aborted) return;
      try {
        const response = await fetchBridgeUrl(bridgeUrl, `/events?clientId=${encodeURIComponent(clientId)}`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        rememberBridgeUrl(bridgeUrl);

        sendBridgeProxyEvent(tabId, {
          event: 'open',
          clientId,
          bridgeUrl,
        });
        await readSseResponse(tabId, clientId, bridgeUrl, response, controller.signal);
        if (!controller.signal.aborted) {
          sendBridgeProxyEvent(tabId, {
            event: 'error',
            clientId,
            bridgeUrl,
            error: 'Bridge SSE stream ended',
          });
        }
        return;
      } catch (err) {
        if (controller.signal.aborted) return;
        lastError = err;
      }
    }

    if (retryCount < maxRetries && !controller.signal.aborted) {
      retryCount++;
      const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (!controller.signal.aborted) {
        const result = await startBridgeSseProxy(tabId, clientId);
        return;
      }
    }

    bridgeSseProxies.delete(key);
    sendBridgeProxyEvent(tabId, {
      event: 'error',
      clientId,
      error: lastError?.message || 'Failed to connect to DevTailor Bridge through background proxy',
    });
  })();

  return { ok: true };
}

async function bridgeProxyRequest(message) {
  const path = String(message.path || '/');
  const method = String(message.method || 'GET').toUpperCase();
  const headers = { ...(message.headers || {}) };
  let body = message.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  let lastError = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const bridgeUrl of orderedBridgeUrls()) {
      try {
        const response = await fetchBridgeUrl(bridgeUrl, path, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
        });
        const text = await response.text();
        rememberBridgeUrl(bridgeUrl);
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          bridgeUrl,
          body: text,
        };
      } catch (err) {
        lastError = err;
      }
    }

    if (attempt < maxRetries) {
      const delay = Math.min(500 * Math.pow(2, attempt), 2000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return {
    ok: false,
    status: 0,
    error: lastError?.message || 'Failed to reach DevTailor Bridge',
  };
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateActionState(tabId, tab.url);
  } catch {
    // Tab may not be accessible
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    postBrowserActionNavigation(tabId, changeInfo.url || tab.url);
  }
  if (changeInfo.url) await updateActionState(tabId, changeInfo.url);
  const saved = await getInjectionSession();
  const action = injectionState.navigationAction({
    tabId,
    status: changeInfo.status,
    rememberedTabIds: saved.rememberedTabIds,
    activeTabId: saved.activeTabId,
    url: tab.url,
  });
  if (!action.inject) return;
  const injection = await injectDevTailorIntoTab(tabId);
  if (action.activate && (injection.injected || injection.alreadyInjected)) await queueActivation(tabId, false);
});

// Content scripts mirror marks + screenshots here so they survive a page reload (see marks-sync.js).
// storage.session is trusted-contexts-only by default; content scripts need it opened up.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (err) {
  console.warn('[DevTailor] storage.session access level not set:', err && err.message);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  // A closed tab can never come back: drop its saved marks, injection and ownership state.
  try { chrome.storage.session.remove(`dt_state_${tabId}`); } catch {}
  mutateInjectionSession(state =>
    injectionState.afterTabClosed(state.rememberedTabIds, state.activeTabId, tabId)
  ).catch(() => {});
  for (const [key, proxy] of bridgeSseProxies) {
    if (!key.startsWith(`${tabId}:`)) continue;
    bridgeSseProxies.delete(key);
    try { proxy.controller.abort(); } catch {}
  }
});

// --- Message relay ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  if (message.type === 'DT_MARKS_CHANGED') {
    // Page marks changed: relay a minimal snapshot to the side panel, tagged with the sender tab.
    const tabId = sender.tab?.id ?? null;
    if (tabId != null) {
      const { type: _type, ...snapshot } = message;
      chrome.runtime.sendMessage({ type: 'DT_MARKS_UPDATED', tabId, ...snapshot }).catch(() => {});
    }
    return false;
  }

  if (message.type === 'DT_SIDEPANEL_READY') {
    sendResponse({ focusInput: Date.now() - sidePanelFocusRequestedAt < 5000 });
    return false;
  }

  if (message.type === 'OPEN_SIDE_PANEL') {
    (async () => {
      const tabId = message.tabId || sender.tab?.id || null;
      const windowId = message.windowId || sender.tab?.windowId || null;
      // sidePanel.open must run inside the user gesture that triggered this message: no awaits before it.
      if (message.focusInput) sidePanelFocusRequestedAt = Date.now();
      if (tabId) {
        await chrome.sidePanel.open({ tabId });
      } else if (windowId) {
        await chrome.sidePanel.open({ windowId });
      } else {
        throw new Error('No active tab or window for side panel');
      }
      if (message.focusInput) {
        // An already-open panel hears this; a panel that is still loading asks DT_SIDEPANEL_READY.
        setTimeout(() => chrome.runtime.sendMessage({ type: 'DT_SIDEPANEL_FOCUS_INPUT' }).catch(() => {}), 300);
      }
      sendResponse({ ok: true });
    })().catch(err => {
      sendResponse({ ok: false, error: err?.message || 'Failed to open side panel' });
    });
    return true;
  }

  if (message.type === 'ENSURE_INJECTED') {
    (async () => {
      const tabId = message.tabId || sender.tab?.id || null;
      const result = await injectDevTailorIntoTab(tabId);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'TAKEOVER_TAB') {
    (async () => {
      let tabId = message.tabId || sender.tab?.id || null;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tab?.id || null;
      }
      // Explicit "接管当前页" in the popup / side panel still switches the takeover. Only the
      // keyboard shortcut treats an owned takeover as untouchable (see handleToggleCommand).
      sendResponse(await takeoverTab(tabId));
    })().catch(err => sendResponse({ ok: false, error: err?.message || '接管当前页失败。' }));
    return true;
  }

  if (message.type === 'RELEASE_TAKEOVER') {
    // The page toolbar asked to stop being the taken-over tab. Clear only this tab's ownership,
    // keeping it in `dt_injected_tabs` so a refresh re-injects without re-taking over.
    const tabId = sender.tab?.id ?? null;
    if (tabId == null) {
      sendResponse({ ok: false, error: '无法确定要取消接管的标签页。' });
      return false;
    }
    mutateInjectionSession(current =>
      injectionState.afterRelease(current.rememberedTabIds, current.activeTabId, tabId)
    ).then(next => sendResponse({
      ok: true,
      released: next.activeTabId == null,
      activeTabId: next.activeTabId,
    })).catch(err => sendResponse({ ok: false, error: err?.message || '取消接管失败。' }));
    return true;
  }

  // --- Reference elements (single writer lives here, see mutateReferences) ---
  if (message.type === referencesCore.MSG.ADD) {
    (async () => {
      const raw = message.reference;
      if (!referencesCore.isValidAddMessage(message)) {
        sendResponse({ ok: false, error: 'invalid_reference' });
        return;
      }
      const checked = referencesCore.validateIncomingReference(raw);
      if (!checked.ok) { sendResponse({ ok: false, error: checked.error }); return; }
      const outcome = await mutateReferences((current) => {
        const next = referencesCore.addReference(current, checked.reference);
        return { changed: next.ok, list: next.list, full: Boolean(next.full), error: next.error };
      });
      sendResponse(outcome.ok
        ? { ok: true, reference: outcome.list[outcome.list.length - 1], count: outcome.list.length }
        : { ok: false, error: outcome.error || 'invalid_reference', full: Boolean(outcome.full), count: outcome.list.length });
    })();
    return true;
  }

  if (message.type === referencesCore.MSG.UPDATE_NOTE) {
    (async () => {
      if (!referencesCore.isValidUpdateMessage(message)) {
        sendResponse({ ok: false, error: 'invalid_message' });
        return;
      }
      const outcome = await mutateReferences((current) => {
        const next = referencesCore.updateNote(current, message.id, message.note);
        return { changed: next.changed, list: next.list };
      });
      // `changed:false` is a successful no-op (same note / unknown id), not an error.
      sendResponse({ ok: true, updated: outcome.changed, count: outcome.list.length });
    })();
    return true;
  }

  if (message.type === referencesCore.MSG.REMOVE) {
    (async () => {
      if (typeof message.id !== 'string' || !message.id) {
        sendResponse({ ok: false, error: 'invalid_id' });
        return;
      }
      const outcome = await mutateReferences((current) => {
        const next = referencesCore.removeReference(current, message.id);
        return { changed: next.ok, list: next.list };
      });
      sendResponse(outcome.ok ? { ok: true, removed: outcome.changed, count: outcome.list.length } : outcome);
    })();
    return true;
  }

  if (message.type === referencesCore.MSG.CLEAR) {
    (async () => {
      const outcome = await mutateReferences(() => ({ changed: true, list: [] }));
      sendResponse(outcome.ok ? { ok: true, cleared: true, count: 0 } : outcome);
    })();
    return true;
  }

  /** Only these ids leave the list after a Hub accepted them; ids added meanwhile survive. */
  if (message.type === referencesCore.MSG.ACCEPTED) {
    (async () => {
      const sentIds = Array.isArray(message.ids) ? message.ids.filter((id) => typeof id === 'string') : [];
      const outcome = await mutateReferences((current) => ({
        changed: current.some((ref) => sentIds.includes(ref.id)),
        list: referencesCore.acceptSent(current, sentIds),
      }));
      sendResponse(outcome.ok ? { ok: true, count: outcome.list.length } : outcome);
    })();
    return true;
  }

  if (message.type === referencesCore.MSG.GET) {
    readReferences().then(list => sendResponse({ ok: true, references: list })).catch(err =>
      sendResponse({ ok: false, error: err?.message || '读取参考元素失败' }));
    return true;
  }

  if (message.type === 'DT_REFERENCE_TAB_CHECK') {
    referenceTabCheck(sender.tab?.id ?? null).then(sendResponse);
    return true;
  }

  if (message.type === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs.captureVisibleTab(sender.tab?.windowId, {
      format: 'jpeg',
      quality: 85,
    }).then(dataUrl => {
      sendResponse({ success: true, dataUrl });
    }).catch(err => {
      sendResponse({ success: false, error: err.message || 'Failed to capture visible tab' });
    });
    return true;
  }

  if (message.type === 'EXECUTE_RUN_JS') {
    executeRunJsInTab(sender.tab?.id ?? null, message, sendResponse);
    return true;
  }

  if (message.type === 'REGISTER_BROWSER_ACTION') {
    rememberBrowserAction(sender.tab?.id ?? null, message.requestId, message.action);
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CLEAR_BROWSER_ACTION') {
    clearBrowserAction(sender.tab?.id ?? null, message.requestId);
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'DEVTAILOR_BRIDGE_PROXY_CONNECT') {
    (async () => {
      const tabId = sender.tab?.id ?? null;
      const result = await startBridgeSseProxy(tabId, message.clientId);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === 'DEVTAILOR_BRIDGE_PROXY_DISCONNECT') {
    stopBridgeSseProxy(sender.tab?.id ?? null, message.clientId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'DEVTAILOR_BRIDGE_PROXY_REQUEST') {
    bridgeProxyRequest(message).then(sendResponse);
    return true;
  }

  if (message.type === 'GET_INSTANCE_SELECTION') {
    instanceReady.then(() => sendResponse({ instanceId: selectedInstanceId }));
    return true;
  }

  if (message.type === 'SET_INSTANCE_SELECTION') {
    instanceReady.then(async () => {
      selectedInstanceId = instanceHeader.normalizeInstanceId(message.instanceId || '');
      await chrome.storage.local.set({ [INSTANCE_KEY]: selectedInstanceId });
      await restartBridgeSseProxies();
      sendResponse({ ok: true, instanceId: selectedInstanceId });
    });
    return true;
  }
});
