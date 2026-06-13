/**
 * DevTailor — Chat Send Manager
 *
 * Owns input send flow, queueing while disconnected/busy, send button state,
 * current request state, and new-session requests.
 *
 * Registers: window.__domReview.chatSend
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function create({
    normalizeImages,
    getInput,
    getSendButton,
    getStore,
    getPromptBuilder,
    getWsClient,
    getImageManager,
    addMessage,
    showHint,
    schedulePersist,
    clearHistory,
    startLoading,
    onAcceptedSend,
    focusInput,
  }) {
    let requestInFlight = false;
    let stopInFlight = false;
    let sentMarkIds = [];
    let pendingQueue = [];
    let currentSessionId = null;
    let flushTimer = null;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [100, 500, 2000]; // Progressive backoff

    function isRequestInFlight() {
      return requestInFlight;
    }

    function setRequestInFlight(value) {
      requestInFlight = Boolean(value);
      if (!requestInFlight) {
        stopInFlight = false;
      }
      refreshSendState();
    }

    function clearSentMarks() {
      if (!sentMarkIds.length) return;
      const store = getStore?.();
      const ids = sentMarkIds.slice();
      sentMarkIds = [];
      ids.forEach(id => {
        if (store?.get(id)) store.remove(id);
      });
    }

    async function executeSend(text, marks, images, options = {}) {
      const promptBuilder = getPromptBuilder?.();
      const wsClient = getWsClient?.();
      const attachedImages = normalizeImages(images);
      if (!promptBuilder || !wsClient) {
        console.warn('[DevTailor] promptBuilder or wsClient not loaded');
        addMessage('assistant', 'text', 'DevTailor Bridge 客户端未加载，请刷新页面后重试。');
        return { ok: false, error: 'Client not loaded' };
      }

      const payload = promptBuilder.buildPayload(marks, text, attachedImages);
      const result = await wsClient.send(payload, { queue: false });
      if (!result.ok) {
        if (options.requeue !== false) {
          pendingQueue.unshift({ text, marks, images: attachedImages });
        }
        showHint(options.requeue === false ? '发送失败，稍后重试' : '发送失败，已重新加入队列');
        refreshSendState();
        return { ok: false, error: result.error };
      }

      sentMarkIds = marks.map(mark => mark.id);
      requestInFlight = true;
      retryCount = 0; // Reset retry count on successful send
      addMessage('user', 'text', text || (attachedImages.length ? `发送 ${attachedImages.length} 张图片` : `发送 ${marks.length} 个标记`), {
        images: attachedImages,
        image: attachedImages[0] || null,
      });
      startLoading?.();
      refreshSendState();
      schedulePersist();
      return { ok: true };
    }

    async function flushQueue() {
      clearTimeout(flushTimer);

      if (pendingQueue.length === 0) {
        retryCount = 0;
        return;
      }

      if (requestInFlight) {
        // Wait for current request to finish
        flushTimer = setTimeout(flushQueue, 500);
        return;
      }

      const wsClient = getWsClient?.();
      if (!wsClient || wsClient.getStatus() !== 'connected') {
        const delay = retryCount < RETRY_DELAYS.length ? RETRY_DELAYS[retryCount] : 2000;
        retryCount = Math.min(retryCount + 1, MAX_RETRIES);
        flushTimer = setTimeout(flushQueue, delay);
        return;
      }

      if (!wsClient.isActive?.()) {
        retryCount = 0;
        flushTimer = setTimeout(flushQueue, 1000);
        return;
      }

      // Connection OK, try to send next message
      const next = pendingQueue[0]; // Peek, don't shift yet
      const result = await executeSend(next.text, next.marks, next.images || next.screenshot, { requeue: false });

      if (result.ok) {
        // Success, remove from queue
        pendingQueue.shift();
        retryCount = 0;

        // Process next item if queue not empty
        if (pendingQueue.length > 0) {
          flushTimer = setTimeout(flushQueue, 100);
        }
      } else {
        // Failed to send, retry with backoff
        if (retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS[retryCount] || 2000;
          retryCount++;
          flushTimer = setTimeout(flushQueue, delay);
        } else {
          // Max retries reached, give up on this message
          pendingQueue.shift();
          retryCount = 0;
          showHint('消息发送失败次数过多，已跳过');

          // Try next message
          if (pendingQueue.length > 0) {
            flushTimer = setTimeout(flushQueue, 500);
          }
        }
      }
    }

    function clearQueue() {
      clearTimeout(flushTimer);
      pendingQueue = [];
      retryCount = 0;
      refreshSendState();
    }

    async function handleSend() {
      if (requestInFlight) {
        handleStop();
        return;
      }

      const input = getInput?.();
      const text = input ? input.value.trim() : '';

      if (window.__domReview.sidebar && window.__domReview.sidebar.syncCommentsFromUI) {
        window.__domReview.sidebar.syncCommentsFromUI();
      }

      const store = getStore?.();
      const marks = store ? store.getAll() : [];
      const imageManager = getImageManager?.();
      const pendingImages = imageManager ? imageManager.getImages() : [];
      if (!text && marks.length === 0 && pendingImages.length === 0) {
        showHint('请输入描述、截图，或先标记至少一个元素');
        restoreInputFocus();
        return;
      }

      const wsClient = getWsClient?.();
      if (!getPromptBuilder?.() || !wsClient) {
        console.warn('[DevTailor] promptBuilder or wsClient not loaded');
        addMessage('assistant', 'text', 'DevTailor Bridge 客户端未加载，请刷新页面后重试。');
        restoreInputFocus();
        return;
      }

      onAcceptedSend?.();

      if (requestInFlight || wsClient.getStatus() !== 'connected' || !wsClient.isActive?.()) {
        pendingQueue.push({ text, marks: marks.slice(), images: pendingImages.slice() });
        showHint(wsClient.getStatus() === 'connected'
          ? '当前页面未接管连接，请点击状态栏连接后发送'
          : `消息已加入队列（共 ${pendingQueue.length} 条），可发送时自动提交`);
        clearInput(input);
        imageManager?.clear();
        refreshSendState();
        schedulePersist();
        restoreInputFocus();
        return;
      }

      const attachedImages = pendingImages.slice();
      imageManager?.clear();

      await executeSend(text, marks, attachedImages);

      clearInput(input);
      schedulePersist();
      restoreInputFocus();
    }

    async function handleStop() {
      if (stopInFlight) return;
      const wsClient = getWsClient?.();
      if (!wsClient || wsClient.getStatus() !== 'connected' || typeof wsClient.cancel !== 'function') {
        showHint('当前连接不支持停止任务');
        restoreInputFocus();
        return;
      }

      stopInFlight = true;
      refreshSendState();
      showHint('正在停止任务...');

      const result = await wsClient.cancel();
      if (!result.ok) {
        stopInFlight = false;
        showHint('停止失败，请稍后重试');
        refreshSendState();
        restoreInputFocus();
        return;
      }
      if (!result.canceled) {
        stopInFlight = false;
        setRequestInFlight(false);
        showHint('当前没有正在执行的任务');
      }
      refreshSendState();
      restoreInputFocus();
    }

    function restoreInputFocus() {
      requestAnimationFrame(() => {
        try { focusInput?.(); } catch {}
      });
    }

    function clearInput(input) {
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function updateSendButton(enabled, options = {}) {
      const btn = getSendButton?.();
      if (!btn) return;
      const label = options.label || '发送';
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.classList.toggle('dt-send-btn--stop', Boolean(options.stop));
    }

    function refreshSendState() {
      const input = getInput?.();
      const text = input ? input.value.trim() : '';
      const marks = getStore?.()?.getAll() || [];
      const wsClient = getWsClient?.();
      const connected = wsClient && wsClient.getStatus() === 'connected';
      const active = Boolean(connected && wsClient.isActive?.());
      const imageCount = getImageManager?.()?.count() || 0;
      if (requestInFlight) {
        updateSendButton(!stopInFlight, {
          label: stopInFlight ? '停止中' : '停止',
          stop: true,
        });
      } else {
        updateSendButton(Boolean(active && (text || marks.length > 0 || imageCount > 0 || pendingQueue.length > 0)), {
          label: '发送',
          stop: false,
        });
      }

      if (active && !requestInFlight && pendingQueue.length > 0) {
        flushQueue();
      }
    }

    async function requestNewSession() {
      const wsClient = getWsClient?.();
      if (!wsClient) return;
      if (requestInFlight) {
        showHint('任务执行中，请结束后再开启新会话');
        return;
      }
      const result = await wsClient.newSession();
      if (result.ok) {
        currentSessionId = result.sessionId || null;
        clearHistory();
        refreshSendState();
        showHint(result.reused ? '当前已是新会话' : '已开启新会话');
      } else {
        showHint(result.error || '开启新会话失败');
      }
    }

    function setSessionId(id) {
      currentSessionId = id || null;
    }

    function getState() {
      const input = getInput?.();
      return {
        inputText: input ? input.value : '',
        pendingQueue: pendingQueue.map(item => ({
          text: item.text || '',
        })),
      };
    }

    function restoreState(state) {
      if (!state || typeof state !== 'object') return;
      requestInFlight = false;
      stopInFlight = false;
      const input = getInput?.();
      if (input && typeof state.inputText === 'string') {
        input.value = state.inputText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (Array.isArray(state.pendingQueue)) {
        pendingQueue = state.pendingQueue
          .filter(item => item && typeof item === 'object')
          .map(item => ({ text: item.text || '', marks: [], images: [] }));
      }
      refreshSendState();
    }

    return {
      clearSentMarks,
      executeSend,
      flushQueue,
      clearQueue,
      handleSend,
      handleStop,
      updateSendButton,
      refreshSendState,
      requestNewSession,
      setSessionId,
      setRequestInFlight,
      isRequestInFlight,
      getState,
      restoreState,
    };
  }

  window.__domReview.chatSend = { create };
})();
