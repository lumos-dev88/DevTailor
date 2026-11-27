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
// The side panel subscribes under a synthetic id (`panel_<tabId>`) so it can receive replies when
// no tab is taken over; these ids are registered/removed by the panel itself.
const sidePanelClientIds = new Set();
let injectionStateMutation = Promise.resolve();
let activationMutation = Promise.resolve();
let sidePanelFocusRequestedAt = 0;
// Windows whose side panel is open. The side panel is per-window (only one at a time), and Chrome
// has no close API, so remember which window's panel is open: clicking the toolbar button again
// makes the worker tell that window's panel to close itself. The worker is killed after ~30s idle,
// so this Set is only an in-memory mirror of chrome.storage.session, which survives worker
// restarts and is cleared when the browser closes or the extension reloads. Without persistence
// the first click after a worker restart forgets the panel is open and the toggle does nothing.
const sidePanelOpenWindows = new Set();
const SIDE_PANEL_OPEN_WINDOWS_KEY = 'dt_side_panel_open_windows';
let sidePanelWindowsMutation = Promise.resolve();
const sidePanelWindowsHydrated = (async () => {
  const stored = await chrome.storage.session.get(SIDE_PANEL_OPEN_WINDOWS_KEY).catch(() => null);
  for (const winKey of stored?.[SIDE_PANEL_OPEN_WINDOWS_KEY] ?? []) sidePanelOpenWindows.add(winKey);
})();

function persistSidePanelWindows() {
  // Serialize writes so overlapping open/close events cannot drop each other's update.
  sidePanelWindowsMutation = sidePanelWindowsMutation.catch(() => {}).then(() =>
    chrome.storage.session.set({ [SIDE_PANEL_OPEN_WINDOWS_KEY]: [...sidePanelOpenWindows] })
  );
}
// Live panel instance token per window (winKey -> token). Rapid toggling can reload the panel
// before the old instance's beforeunload CLOSED lands: the stale notice must not wipe the new
// instance's state. In-memory only — a worker restart just loses the READY it would compare with,
// and a CLOSED with no known token is still honoured.
const sidePanelWindowTokens = new Map();
// Toggle coalescing per window (winKey -> busy-until timestamp): a toggle takes hundreds of ms to
// settle (the panel document has to load, beforeunload notices travel late). Clicks landing inside
// the window are swallowed instead of interleaving with the in-flight decision — rapid clicking
// must not be able to corrupt the open/close state at all.
const sidePanelToggleBusy = new Map();
const SIDE_PANEL_TOGGLE_COALESCE_MS = 500;
// Timestamp of the latest "the panel is already open -> ask it to close" request, and the window it
// was meant for (so one window's close request cannot close another window's panel).
let sidePanelCloseRequestedAt = 0;
let sidePanelCloseRequestedWindowId = null;
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

// The extension action owns popup.html, so the browser's default action click must not open the
// side panel; opening stays explicit via OPEN_SIDE_PANEL.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('DevTailor extension installed');
  await cleanupLegacyRegistration();
});

cleanupLegacyRegistration();

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
  // The panel has no tab: it still needs its own stream's lifecycle events.
  const message = {
    type: 'DEVTAILOR_BRIDGE_PROXY_EVENT',
    ...payload,
  };
  if (tabId) chrome.tabs.sendMessage(tabId, message).catch(() => {});

  // Also forward to the side panel. It listens to one stream at a time: the taken-over tab's while
  // a takeover exists, otherwise its own synthetic stream (`panel_<tabId>`). The panel picks the
  // copy whose `panelClientId` matches the stream it follows, so simply send one copy per known
  // panel stream.
  for (const panelClientId of sidePanelClientIds) {
    chrome.runtime.sendMessage({
      type: 'DEVTAILOR_SIDEPANEL_PROXY_EVENT',
      tabId,
      panelClientId,
      ...payload,
    }).catch(() => {});
  }
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
    // The panel has no `sender.tab`; it resolves the id through chrome.tabs.query itself.
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  // The panel owns its synthetic client id: it derives and registers it so the runtime broadcast
  // knows where to forward replies and card events while no tab is taken over.
  if (message.type === 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT') {
    if (typeof message.clientId === 'string' && message.clientId) sidePanelClientIds.add(message.clientId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT') {
    const clientId = typeof message.clientId === 'string' ? message.clientId : '';
    if (clientId) {
      sidePanelClientIds.delete(clientId);
      // The stream was opened under the panel's tab id (or null), so the exact key is unknown here:
      // drop every proxy registered under this synthetic client id.
      const stale = [...bridgeSseProxies.values()].filter((proxy) => proxy.clientId === clientId);
      for (const proxy of stale) stopBridgeSseProxy(proxy.tabId, proxy.clientId);
    }
    sendResponse({ ok: true });
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
    // Close fallback for a panel that was still loading when the second toolbar click happened: it
    // never heard DT_SIDEPANEL_CLOSE_REQUEST, so it asks on load. Window-scoped and time-boxed.
    const closeRequested = Date.now() - sidePanelCloseRequestedAt < 5000
      && sidePanelCloseRequestedWindowId != null && sidePanelCloseRequestedWindowId === message.windowId
      && (message.loadedAt == null || message.loadedAt < sidePanelCloseRequestedAt);
    const winKey = message.windowId ?? (message.tabId != null ? message.tabId : null);
    // Register the live instance so a superseded panel's late CLOSED can be told apart.
    if (winKey != null && message.panelToken != null) sidePanelWindowTokens.set(winKey, message.panelToken);
    if (closeRequested) {
      // Consume the request so a later panel load does not close itself again.
      sidePanelCloseRequestedAt = 0;
      sidePanelCloseRequestedWindowId = null;
      if (winKey != null) {
        sidePanelOpenWindows.delete(winKey);
        persistSidePanelWindows();
      }
    } else {
      // READY can reveal stale persisted state. Hydrate first so healing this window cannot overwrite
      // keys restored for other windows on a cold worker start.
      sidePanelWindowsHydrated.then(() => {
        if (winKey != null) {
          sidePanelOpenWindows.add(winKey);
          persistSidePanelWindows();
        }
      });
    }
    sendResponse({
      focusInput: Date.now() - sidePanelFocusRequestedAt < 5000,
      closePanel: closeRequested,
    });
    return false;
  }

  if (message.type === 'DT_SIDEPANEL_CLOSED') {
    const tabId = message.tabId ?? null;
    const winKey = message.windowId ?? (tabId != null ? tabId : null);
    // Rapid toggling: the panel can be closed and re-opened before the old instance's beforeunload
    // notice lands. A CLOSED from a token we already replaced with a newer READY is stale — the
    // live instance owns the state now, so ignore it entirely (state + streams).
    const knownToken = winKey != null ? sidePanelWindowTokens.get(winKey) : undefined;
    if (message.panelToken != null && knownToken !== undefined && knownToken !== message.panelToken) {
      sendResponse({ ok: true, stale: true });
      return false;
    }
    // A beforeunload message can wake a cold worker: run the delete after hydration settles, or it
    // lands on an empty Set and hydration re-adds the stale window.
    sidePanelWindowsHydrated.then(() => {
      if (winKey != null) {
        sidePanelOpenWindows.delete(winKey);
        sidePanelWindowTokens.delete(winKey);
      } else {
        sidePanelOpenWindows.clear();
        sidePanelWindowTokens.clear();
      }
      persistSidePanelWindows();
    });
    // The panel is gone: drop its synthetic id and its event stream, or they linger until the
    // worker restarts (the panel's own DISCONNECT is best-effort during beforeunload).
    const closedPanelId = tabId != null ? `panel_${tabId}` : null;
    const closedIds = closedPanelId ? [closedPanelId] : [...sidePanelClientIds];
    for (const id of closedIds) {
      sidePanelClientIds.delete(id);
      const stale = [...bridgeSseProxies.values()].filter((proxy) => proxy.clientId === id);
      for (const proxy of stale) stopBridgeSseProxy(proxy.tabId, proxy.clientId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'OPEN_SIDE_PANEL') {
    (async () => {
      const tabId = message.tabId || sender.tab?.id || null;
      const windowId = message.windowId || sender.tab?.windowId || null;
      const target = tabId ? { tabId } : (windowId ? { windowId } : null);
      if (!target) throw new Error('No active tab or window for side panel');
      const openKey = windowId ?? tabId ?? '';
      // Swallow clicks that land while a toggle is still settling: letting them through interleaves
      // open/close decisions and races the panel load. Sync check — the gesture is untouched.
      const now = Date.now();
      const busyUntil = sidePanelToggleBusy.get(openKey) ?? 0;
      if (now < busyUntil) {
        sendResponse({ ok: true, throttled: true });
        return;
      }
      sidePanelToggleBusy.set(openKey, now + SIDE_PANEL_TOGGLE_COALESCE_MS);
      // chrome.sidePanel.open() is gesture-gated: it must run in the same synchronous turn as the
      // click that produced this message — no awaits before the call (an awaited storage read or
      // message roundtrip in between makes Chrome reject it with "may only be called in response
      // to a user gesture"). On an already-open panel the call is a harmless no-op, so call it
      // unconditionally and decide open-vs-close afterwards.
      const openPromise = chrome.sidePanel.open(target);
      const clickAt = now;
      if (message.focusInput) sidePanelFocusRequestedAt = clickAt;
      // Settle the storage hydration on a cold worker start before deciding.
      await sidePanelWindowsHydrated;
      // The side panel is per-window: if this window's panel is already open, clicking the toolbar
      // button means "close it", no matter which tab was used to open it. Chrome has no close API:
      // a loaded panel never asks again, so push the request; a panel still loading learns it from
      // the DT_SIDEPANEL_READY reply (closePanel) instead.
      const wasOpen = sidePanelOpenWindows.has(openKey);
      if (wasOpen) {
        // The open() above was a no-op (the panel was already open); this click means "close".
        sidePanelOpenWindows.delete(openKey);
        persistSidePanelWindows();
        sidePanelCloseRequestedAt = clickAt;
        sidePanelCloseRequestedWindowId = windowId ?? null;
        // notBefore lets a panel that THIS click's open() just created (stale open-state, no live
        // panel) ignore the request instead of closing right after opening; a panel that existed
        // before the click closes itself.
        chrome.runtime.sendMessage({
          type: 'DT_SIDEPANEL_CLOSE_REQUEST', tabId, windowId, notBefore: clickAt,
        }).catch(() => {
          // No panel listening: the state was stale and the open() above (re)opened it. Its
          // DT_SIDEPANEL_READY will re-mark the window as open.
        });
        openPromise.catch(() => {});
        sendResponse({ ok: true, opened: false });
        return;
      }
      // Mark optimistically BEFORE awaiting the open promise: while the panel document is loading
      // (hundreds of ms) a rapid second click must already see "open" so it toggles to close
      // instead of racing into another open decision.
      sidePanelOpenWindows.add(openKey);
      persistSidePanelWindows();
      try {
        await openPromise;
      } catch (err) {
        sidePanelOpenWindows.delete(openKey);
        persistSidePanelWindows();
        throw err;
      }
      sendResponse({ ok: true, opened: true });
      if (message.focusInput) {
        // An already-open panel hears this; a panel that is still loading asks DT_SIDEPANEL_READY.
        setTimeout(() => chrome.runtime.sendMessage({ type: 'DT_SIDEPANEL_FOCUS_INPUT' }).catch(() => {}), 300);
      }
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

  if (message.type === 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT_STREAM') {
    (async () => {
      // The panel has no sender.tab: it supplies the synthetic stream key explicitly.
      const result = await startBridgeSseProxy(message.tabId ?? null, message.clientId);
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
