/**
 * DevTailor — Popup Script (Simplified)
 *
 * Shows extension toggle and allowed-sites management.
 * Prompt export and data import/export have moved to the sidebar.
 */
(() => {
  'use strict';

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }

  function main() {

  const countEl = document.getElementById('count');
  const noPage = document.getElementById('no-page');
  const toggleBtn = document.getElementById('toggle-btn');

  const siteList = document.getElementById('site-list');
  const addSiteInput = document.getElementById('add-site-input');
  const addSiteBtn = document.getElementById('add-site-btn');
  const addSiteError = document.getElementById('add-site-error');
  const openSidePanelBtn = document.getElementById('open-sidepanel');

  if (!countEl || !noPage || !toggleBtn || !siteList || !addSiteInput || !addSiteBtn || !addSiteError || !openSidePanelBtn) {
    console.warn('[DevTailor] Popup DOM is incomplete.');
    return;
  }

  const DEFAULT_PATTERNS = ['*://localhost/*', '*://127.0.0.1/*'];

  let extensionEnabled = true;

  // --- Toggle ---

  function updateToggleUI(enabled) {
    extensionEnabled = enabled;
    toggleBtn.classList.toggle('active', enabled);
    toggleBtn.title = enabled ? '禁用扩展' : '启用扩展';
    document.body.classList.toggle('disabled', !enabled);
  }

  async function toggleExtension() {
    const newState = !extensionEnabled;
    await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: newState });
    updateToggleUI(newState);

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return;
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (enabled) => {
          const host = document.getElementById('dom-review-host');
          if (host) host.style.display = enabled ? '' : 'none';
        },
        args: [newState]
      }).catch(() => {});
    });

    showToast(newState ? '已启用，请刷新页面。' : '已禁用，请刷新页面。');
  }

  // --- Pattern helpers ---

  function stripPort(host) {
    if (!host) return '';
    if (host.startsWith('[')) {
      const end = host.indexOf(']');
      return end === -1 ? host : host.slice(0, end + 1);
    }
    return host.split(':')[0];
  }

  function normalizeInput(input) {
    const value = input.trim();
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

  function isDefaultPattern(pattern) {
    return DEFAULT_PATTERNS.includes(pattern);
  }

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

  function urlMatchesAnyPattern(url, patterns) {
    return patterns.some(p => urlMatchesPattern(url, p));
  }

  function getActiveTab() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab || null));
    });
  }

  async function ensureInjected(tabId) {
    if (!tabId) return { injected: false, error: 'Missing tabId' };
    try {
      return await chrome.runtime.sendMessage({ type: 'ENSURE_INJECTED', tabId });
    } catch (err) {
      return { injected: false, error: err?.message || 'Failed to inject DevTailor' };
    }
  }

  async function getReviewCount(tabId) {
    if (!tabId) return null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          if (!window.__domReview || !window.__domReview.store) return null;
          return window.__domReview.store.getAll().length;
        }
      });
      const value = results && results[0] ? results[0].result : null;
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  // --- Allowed Sites rendering ---

  function renderAllowedSites(customPatterns) {
    siteList.innerHTML = '';

    for (const pattern of DEFAULT_PATTERNS) {
      const li = document.createElement('li');
      li.className = 'site-item site-item--default';
      li.innerHTML = `<span class="site-label">${escapeHtml(pattern)}</span><span class="site-tag">默认</span>`;
      siteList.appendChild(li);
    }

    for (const pattern of customPatterns) {
      const li = document.createElement('li');
      li.className = 'site-item';
      li.innerHTML = `<span class="site-label">${escapeHtml(pattern)}</span>`;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'site-remove';
      removeBtn.textContent = '×';
      removeBtn.title = '移除';
      removeBtn.addEventListener('click', () => removePattern(pattern));
      li.appendChild(removeBtn);
      siteList.appendChild(li);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showError(msg) {
    addSiteError.textContent = msg;
    addSiteError.style.display = 'block';
  }

  function clearError() {
    addSiteError.style.display = 'none';
    addSiteError.textContent = '';
  }

  async function openSidePanel() {
    const tab = await getActiveTab();
    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_SIDE_PANEL',
      tabId: tab?.id || null,
      windowId: tab?.windowId || null
    });
    if (!response || !response.ok) {
      showToast(response?.error || '打开侧边栏失败。');
      return;
    }
    showToast('Chat 侧边栏已打开。');
  }

  // --- Add / Remove patterns ---

  async function addPattern() {
    clearError();
    const pattern = normalizeInput(addSiteInput.value);

    if (!pattern) {
      showError('输入站点地址，如 example.com 或 192.168.1.50:3000');
      return;
    }

    if (isDefaultPattern(pattern)) {
      showError('此站点已包含在默认列表中。');
      return;
    }

    let granted;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
      showError('格式无效。请尝试：example.com、https://example.com 或 192.168.1.50:3000');
      return;
    }

    if (!granted) {
      showError('浏览器拒绝了权限请求。');
      return;
    }

    const tab = await getActiveTab();
    const response = await chrome.runtime.sendMessage({
      type: 'ADD_CUSTOM_PATTERN',
      pattern,
      tabId: tab?.id || null,
      url: tab?.url || ''
    });
    if (response && response.success) {
      addSiteInput.value = '';
      renderAllowedSites(response.patterns);
      if (tab?.url && urlMatchesPattern(tab.url, pattern)) {
        const total = await getReviewCount(tab.id);
        if (total != null) showReady(total);
      }
      const activeNow = response.injected || response.alreadyInjected;
      showToast(activeNow ? '站点已添加，当前页已激活。' : '站点已添加，请刷新已打开的页面。');
    } else if (response && response.error) {
      showError(response.error);
    }
  }

  async function removePattern(pattern) {
    const response = await chrome.runtime.sendMessage({ type: 'REMOVE_CUSTOM_PATTERN', pattern });
    if (response && response.success) {
      renderAllowedSites(response.patterns);
      showToast('站点已移除。');
    }
  }

  // --- Init ---

  function init() {
    chrome.runtime.sendMessage({ type: 'GET_ENABLED' }, (enabled) => {
      updateToggleUI(enabled !== false);
    });

    chrome.runtime.sendMessage({ type: 'GET_CUSTOM_PATTERNS' }, (customPatterns) => {
      renderAllowedSites(customPatterns || []);
    });

    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !tab.url) {
        showNoPage();
        return;
      }

      const url = tab.url;

      chrome.runtime.sendMessage({ type: 'GET_CUSTOM_PATTERNS' }, (customPatterns) => {
        const allPatterns = [...DEFAULT_PATTERNS, ...(customPatterns || [])];

        if (!urlMatchesAnyPattern(url, allPatterns)) {
          showNoPage();
          return;
        }

        getReviewCount(tab.id).then(async total => {
          if (total == null) {
            await ensureInjected(tab.id);
            total = await getReviewCount(tab.id);
          }
          if (total != null) {
            showReady(total);
          }
        });
      });
    });
  }

  function showNoPage() {
    noPage.style.display = '';
    countEl.textContent = '-';
    countEl.classList.add('badge--zero');
  }

  function showReady(total) {
    noPage.style.display = 'none';

    if (total === 0) {
      countEl.textContent = '0';
      countEl.classList.add('badge--zero');
    } else {
      countEl.textContent = total;
      countEl.classList.remove('badge--zero');
    }
  }

  function showToast(text) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = text || '完成';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  }

  // --- Event handlers ---

  toggleBtn.addEventListener('click', toggleExtension);
  openSidePanelBtn.addEventListener('click', openSidePanel);
  addSiteBtn.addEventListener('click', addPattern);
  addSiteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addPattern();
  });
  init();
  }
})();
