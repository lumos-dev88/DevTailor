/**
 * DevTailor — Screenshot Module
 *
 * Captures the visible area of the current tab (chrome.tabs.captureVisibleTab through the service
 * worker) with DevTailor's own UI hidden, and adds it to the pending attachments owned by
 * marks-sync.js. The side panel's mark tray shows them and sends them with the next message.
 *
 * Depends on: marksSync, toolbar (toast)
 * Registers: window.__domReview.screenshot
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  let capturing = false;

  function notify(message) {
    window.__domReview.toolbar?.toast?.(message);
  }

  function capture() {
    if (capturing) return;
    const sync = window.__domReview.marksSync;
    if (!sync) {
      reportError('标记同步模块未加载，请刷新页面后重试');
      return;
    }
    if (sync.screenshots.list().length >= window.__domReview.marksCore.LIMITS.MAX_SCREENSHOTS) {
      notify(`最多附带 ${window.__domReview.marksCore.LIMITS.MAX_SCREENSHOTS} 张截图，请先在侧边栏删除一些`);
      return;
    }
    capturing = true;
    const host = document.getElementById('dom-review-host');
    const previousDisplay = host ? host.style.display : '';
    // Hide the toolbar so it does not appear in the screenshot.
    if (host) host.style.display = 'none';

    setTimeout(() => {
      const restore = () => {
        if (host) host.style.display = previousDisplay;
        capturing = false;
      };
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, async (response) => {
          restore();
          if (chrome.runtime.lastError) {
            reportError(`截图失败: ${chrome.runtime.lastError.message}`);
            return;
          }
          if (!response || !response.success || !response.dataUrl) {
            reportError(`截图失败: ${response?.error || '未知错误'}`);
            return;
          }
          const id = await sync.addScreenshot(response.dataUrl);
          if (id) notify('截图已添加，会随下一条侧边栏消息一起发送');
          else reportError('截图失败: 浏览器返回的图片格式不受支持');
        });
      } catch (err) {
        restore();
        reportError(`截图失败: ${err.message || err}`);
      }
    }, 150);
  }

  function reportError(message) {
    console.error(`[DevTailor] ${message}`);
    notify(message);
  }

  window.__domReview.screenshot = { capture };
})();
