/**
 * DevTailor — Screenshot Module
 *
 * Captures the current tab via chrome.tabs.captureVisibleTab() and
 * inserts the resulting image into the chat input.
 *
 * Depends on: ui (shadow-ui.js), chatPanel
 * Registers: window.__domReview.screenshot
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function capture() {
    const ui = window.__domReview.ui;
    const host = document.getElementById('dom-review-host');
    const wasVisible = ui && ui.isSidebarVisible && ui.isSidebarVisible();

    // Completely hide the host (sidebar + FAB) so it doesn't appear in the screenshot
    if (host) host.style.display = 'none';

    setTimeout(() => {
      try {
        chrome.runtime.sendMessage(
          { type: 'CAPTURE_VISIBLE_TAB' },
          (response) => {
            restoreUi(host, ui, wasVisible);

            if (chrome.runtime.lastError) {
              reportScreenshotError(`截图失败: ${chrome.runtime.lastError.message}`);
              return;
            }

            if (!response || !response.success || !response.dataUrl) {
              reportScreenshotError(`截图失败: ${response?.error || '未知错误'}`);
              return;
            }

            const chatPanel = window.__domReview.chatPanel;
            if (!chatPanel || typeof chatPanel.addImage !== 'function') {
              reportScreenshotError('截图失败: 聊天面板未准备好，请刷新页面后重试');
              return;
            }

            if (chatPanel.addImage(response.dataUrl)) {
              chatPanel.showHint?.('截图已添加，发送时会一起带给 AI');
              chatPanel.refreshSendState?.();
            } else {
              reportScreenshotError('截图失败: 浏览器返回的图片格式不受支持');
            }
          }
        );
      } catch (err) {
        restoreUi(host, ui, wasVisible);
        reportScreenshotError(`截图失败: ${err.message || err}`);
      }
    }, 150);
  }

  function restoreUi(host, ui, wasVisible) {
    if (host) host.style.display = 'block';
    if (wasVisible && ui && ui.showSidebar) {
      ui.showSidebar();
    } else if (!wasVisible && ui && ui.hideSidebar) {
      ui.hideSidebar();
    }
  }

  function reportScreenshotError(message) {
    const errorMsg = `[DevTailor] ${message}`;
    console.error(errorMsg);
    window.__domReview.chatPanel?.showHint?.(errorMsg);
  }

  window.__domReview.screenshot = { capture };
})();
