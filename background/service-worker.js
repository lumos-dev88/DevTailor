/**
 * DevTailor — Service Worker (Background)
 *
 * Handles:
 * - Keyboard shortcut command relay (Ctrl/Cmd+Shift+X)
 * - Action icon state for allowed tabs
 * - Dynamic content script registration for custom URL patterns
 * - Message relay between popup and content scripts
 */

const STORAGE_KEY = 'dr_custom_patterns';
const ENABLED_KEY = 'dr_enabled';
const BRIDGE_URL = 'http://localhost:34781';
const pendingBrowserActions = new Map();

const MAIN_WORLD_START_SCRIPTS = [
  'content/modules/browser-console-bridge.js'
];
const MAIN_WORLD_SCRIPTS = [
  'content/modules/framework-bridge.js'
];
const ISOLATED_WORLD_SCRIPTS = [
  'lib/marked.umd.js',
  'content/modules/review-store.js',
  'content/modules/element-targets.js',
  'content/modules/selector-generator.js',
  'content/modules/framework-detector.js',
  'content/modules/context-capture.js',
  'content/modules/visbug-hit-test.js',
  'content/modules/shadow-ui.js',
  'content/modules/element-saver.js',
  'content/modules/badges.js',
  'content/modules/sidebar.js',
  'content/modules/chat-markdown.js',
  'content/modules/chat-tools.js',
  'content/modules/chat-scroll.js',
  'content/modules/chat-images.js',
  'content/modules/chat-persistence.js',
  'content/modules/chat-preview-editor.js',
  'content/modules/chat-bridge-events.js',
  'content/modules/chat-send.js',
  'content/modules/chat-panel.js',
  'content/modules/prompt-builder.js',
  'content/modules/browser-console.js',
  'content/modules/browser-action-dom.js',
  'content/modules/browser-actions.js',
  'content/modules/ws-client.js',
  'content/modules/screenshot.js',
  'content/modules/selector-mode.js',
  'content/modules/export-import.js',
  'content/content-script.js'
];
const ISOLATED_WORLD_CSS = ['content/content-style.css'];
const DEFAULT_PATTERNS = ['*://localhost/*', '*://127.0.0.1/*'];

function stripPort(host) {
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(':')[0];
}

function normalizePattern(pattern) {
  const value = String(pattern || '').trim();
  if (!value) return null;

  const match = value.match(/^(\*|https?):\/\/([^/]+)(?:\/.*)?$/i);
  if (match) {
    const scheme = match[1].toLowerCase();
    const host = stripPort(match[2].toLowerCase());
    if (!host || /\s/.test(host)) return null;
    return `${scheme}://${host}/*`;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}/*`;
  } catch {
    const host = stripPort(value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase());
    if (!host || /\s/.test(host)) return null;
    return `*://${host}/*`;
  }
}

async function getCustomPatterns() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const rawPatterns = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
  const patterns = [...new Set(rawPatterns.map(normalizePattern).filter(Boolean))];
  if (JSON.stringify(rawPatterns) !== JSON.stringify(patterns)) {
    await saveCustomPatterns(patterns);
  }
  return patterns;
}

async function saveCustomPatterns(patterns) {
  await chrome.storage.sync.set({ [STORAGE_KEY]: patterns });
}

async function registerDynamicScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['dr-custom-console', 'dr-custom-main', 'dr-custom-isolated'] });
  } catch {
    // Scripts may not exist yet — ignore
  }

  const patterns = await getCustomPatterns();
  if (patterns.length === 0) return;

  await chrome.scripting.registerContentScripts([
    {
      id: 'dr-custom-console',
      matches: patterns,
      js: MAIN_WORLD_START_SCRIPTS,
      runAt: 'document_start',
      world: 'MAIN'
    },
    {
      id: 'dr-custom-main',
      matches: patterns,
      js: MAIN_WORLD_SCRIPTS,
      runAt: 'document_idle',
      world: 'MAIN'
    },
    {
      id: 'dr-custom-isolated',
      matches: patterns,
      js: ISOLATED_WORLD_SCRIPTS,
      css: ISOLATED_WORLD_CSS,
      runAt: 'document_idle'
    }
  ]);
}

async function injectDevTailorIntoTab(tabId) {
  if (!tabId) return { injected: false, error: 'Missing tabId' };
  try {
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
        [
          'dom-review-host',
          'dom-review-badges',
          'dom-review-highlights',
          'dom-review-selector-overlay',
          'dom-review-selector-hint',
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
    return { injected: false, error: err?.message || 'Failed to inject DevTailor into tab' };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('DevTailor extension installed');
  await registerDynamicScripts();
});

registerDynamicScripts();

// --- Keyboard shortcut: toggle sidebar ---

async function toggleSidebar(tabId) {
  await injectDevTailorIntoTab(tabId);
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__domReview && window.__domReview.ui) {
        window.__domReview.wsClient?.connect?.();
        window.__domReview.ui.toggleSidebar();
        return window.__domReview.ui.isSidebarVisible();
      }
      return false;
    }
  }).catch(() => {});
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
      if (tab && tab.id) toggleSidebar(tab.id);
    });
  }
});

// --- Tab URL detection for action icon title ---

function urlMatchesPattern(url, pattern) {
  try {
    const parsedUrl = new URL(url);
    const parsedPattern = String(pattern || '').match(/^(\*|https?):\/\/([^/]+)(\/.*)$/i);
    if (!parsedPattern) return false;

    const scheme = parsedPattern[1].toLowerCase();
    const hostPattern = stripPort(parsedPattern[2].toLowerCase());
    const urlScheme = parsedUrl.protocol.replace(':', '').toLowerCase();
    const urlHost = parsedUrl.hostname.toLowerCase();

    if (!['http', 'https'].includes(urlScheme)) return false;
    if (scheme !== '*' && scheme !== urlScheme) return false;
    if (hostPattern === '*') return true;
    if (hostPattern.startsWith('*.')) {
      const suffix = hostPattern.slice(2);
      return urlHost === suffix || urlHost.endsWith(`.${suffix}`);
    }
    return urlHost === hostPattern;
  } catch {
    return false;
  }
}

async function updateActionState(tabId, url) {
  if (!url) return;
  const customPatterns = await getCustomPatterns();
  const allPatterns = [...DEFAULT_PATTERNS, ...customPatterns];
  const isAllowed = allPatterns.some(p => urlMatchesPattern(url, p));

  if (isAllowed) {
    chrome.action.setTitle({ tabId, title: 'DevTailor — Toggle sidebar' });
    chrome.action.setBadgeText({ tabId, text: '' });
  } else {
    chrome.action.setTitle({ tabId, title: 'DevTailor — site not allowed' });
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
  }
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
  fetch(`${BRIDGE_URL}/browser-action-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: existing.requestId,
      ok: true,
      result: {
        navigationStarted: true,
        action: existing.action || null,
        url: url || null,
        elapsedMs: Date.now() - existing.startedAt,
        note: 'The page started navigating before the content script could post a normal browser action result.',
      },
    }),
  }).catch(() => {});
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
  if (changeInfo.url) {
    await updateActionState(tabId, changeInfo.url);
  }
});

// --- Message relay ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  if (message.type === 'ENSURE_INJECTED') {
    (async () => {
      const tabId = message.tabId || sender.tab?.id || null;
      const result = await injectDevTailorIntoTab(tabId);
      sendResponse(result);
    })();
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

  if (message.type === 'GET_ENABLED') {
    chrome.storage.sync.get(ENABLED_KEY).then(result => {
      sendResponse(result[ENABLED_KEY] !== false);
    });
    return true;
  }

  if (message.type === 'SET_ENABLED') {
    chrome.storage.sync.set({ [ENABLED_KEY]: message.enabled }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'GET_CUSTOM_PATTERNS') {
    getCustomPatterns().then(sendResponse);
    return true;
  }

  if (message.type === 'ADD_CUSTOM_PATTERN') {
    (async () => {
      const pattern = message.pattern;
      const tabId = message.tabId;
      const tabUrl = message.url || '';
      const patterns = await getCustomPatterns();
      let alreadyExists = false;
      if (patterns.includes(pattern)) {
        alreadyExists = true;
      } else {
        patterns.push(pattern);
        await saveCustomPatterns(patterns);
        await registerDynamicScripts();
      }

      let activation = { injected: false };
      if (tabId && tabUrl && urlMatchesPattern(tabUrl, pattern)) {
        activation = await injectDevTailorIntoTab(tabId);
        await updateActionState(tabId, tabUrl);
      }
      sendResponse({ success: true, alreadyExists, patterns, ...activation });
    })();
    return true;
  }

  if (message.type === 'REMOVE_CUSTOM_PATTERN') {
    (async () => {
      const pattern = message.pattern;
      let patterns = await getCustomPatterns();
      patterns = patterns.filter(p => p !== pattern);
      await saveCustomPatterns(patterns);
      await registerDynamicScripts();
      try {
        await chrome.permissions.remove({ origins: [pattern] });
      } catch {
        // Permission may not exist or can't be revoked — ignore
      }
      sendResponse({ success: true, patterns });
    })();
    return true;
  }
});
