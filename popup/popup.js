(() => {
  'use strict';

  const takeoverBtn = document.getElementById('takeover');
  const sidePanelBtn = document.getElementById('open-sidepanel');
  const status = document.getElementById('status');

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function takeover() {
    takeoverBtn.disabled = true;
    status.textContent = '正在注入并连接…';
    try {
      const tab = await activeTab();
      const result = await chrome.runtime.sendMessage({ type: 'TAKEOVER_TAB', tabId: tab?.id || null });
      status.style.color = result?.ok ? '#86efac' : '#fca5a5';
      status.textContent = result?.ok ? '已接管当前页，可以开始标记。' : (result?.error || '接管当前页失败。');
    } catch (err) {
      status.textContent = err?.message || '接管当前页失败。';
    } finally {
      takeoverBtn.disabled = false;
    }
  }

  async function openSidePanel() {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: 'OPEN_SIDE_PANEL', tabId: tab?.id || null, windowId: tab?.windowId || null,
    });
    if (!result?.ok) status.textContent = result?.error || '打开侧边栏失败。';
  }

  takeoverBtn.addEventListener('click', takeover);
  sidePanelBtn.addEventListener('click', openSidePanel);
})();
