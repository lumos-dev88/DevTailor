/**
 * DevTailor — Chat Bridge Event Handler
 *
 * Owns SSE/ACP event projection into display messages: stream, thinking,
 * tool calls, terminal statuses, done/error/session_reset.
 *
 * Registers: window.__domReview.chatBridgeEvents
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function create({
    messageStore,
    maxMessages,
    toolHelpers,
    followLatestIfPinned,
    scrollToBottom,
    schedulePersist,
    showHint,
    addMessage,
    refreshSendState,
    flushQueue,
    clearSentMarks,
    setRequestInFlight,
  }) {
    const {
      parseMaybeJsonObject,
      inferBrowserToolName,
      normalizeToolTitle,
      normalizeToolKind,
      normalizeToolId,
    } = toolHelpers;

    let activeStreamId = null;
    let activeLoadingId = null;

    function isStreamingMessage(msg) {
      return Boolean(msg && msg.id && msg.id === activeStreamId);
    }

    function startLoading(statusText) {
      if (activeLoadingId) {
        if (statusText) {
          messageStore.update(activeLoadingId, { statusText });
          followLatestIfPinned();
        }
        return;
      }
      const id = 'msg_' + Date.now() + '_loading';
      activeLoadingId = id;
      messageStore.append({
        id,
        role: 'assistant',
        type: 'loading',
        content: '',
        statusText: statusText || '…',
        timestamp: Date.now()
      });
      scrollToBottom();
    }

    function updateLoadingStatus(statusText) {
      if (!activeLoadingId) return;
      messageStore.update(activeLoadingId, { statusText });
      followLatestIfPinned();
    }

    function removeLoading() {
      if (!activeLoadingId) return false;
      const removed = messageStore.remove(activeLoadingId);
      activeLoadingId = null;
      return removed;
    }

    function startStream() {
      if (activeStreamId) return;
      removeLoading();
      const id = 'msg_' + Date.now() + '_stream';
      activeStreamId = id;
      messageStore.append({
        id,
        role: 'assistant',
        type: 'stream',
        content: '',
        timestamp: Date.now()
      });
      followLatestIfPinned();
    }

    function appendStream(delta) {
      if (!delta) return;
      const wasCreated = ensureStreamAtTail();
      if (!activeStreamId) return;

      // Only mark tool completed if we're continuing an existing stream
      if (!wasCreated) {
        markLastPendingToolCompleted();
      }
      closeActiveThinking();

      messageStore.update(activeStreamId, (msg) => {
        msg.content += delta;
      });
      schedulePersist();
    }

    function ensureStreamAtTail() {
      // No active stream, create new one
      if (!activeStreamId) {
        startStream();
        return true;
      }

      const idx = messageStore.findIndex(m => m.id === activeStreamId);

      // Stream message was removed, create new one
      if (idx === -1) {
        activeStreamId = null;
        startStream();
        return true;
      }

      // Stream is not at tail (other messages inserted after it), end old stream and create new one
      if (idx < messageStore.size - 1) {
        endStream();
        startStream();
        return true;
      }

      // Stream is at tail, continue using it
      return false;
    }

    function markLastPendingToolCompleted() {
      const lastTool = messageStore.findLast(m => m.type === 'tool' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'));
      if (!lastTool) return false;

      // Only mark as completed if we're actively streaming (which means the tool succeeded)
      // If there's no active stream, the tool might have failed or been interrupted
      if (activeStreamId) {
        messageStore.update(lastTool.id, { status: 'completed' });
        return true;
      }

      return false;
    }

    function endStream() {
      activeStreamId = null;
      removeLoading();
      closeActiveThinking();
    }

    function applySessionSnapshot(msg) {
      activeStreamId = null;
      activeLoadingId = null;
      const restored = Array.isArray(msg.messages) ? msg.messages : [];
      messageStore.replaceAll(restored.filter(item => item && typeof item === 'object'));
      scrollToBottom();
      refreshSendState();
      schedulePersist();
    }

    function appendThinking(delta) {
      if (!delta) return;
      removeLoading();
      markLastPendingToolCompleted();
      const lastThinking = messageStore.findLast(m => m.type === 'thinking');
      if (lastThinking && !lastThinking.closed) {
        messageStore.update(lastThinking.id, (msg) => { msg.content += delta; });
        if (!lastThinking.open) followLatestIfPinned();
        schedulePersist();
        return;
      }
      messageStore.append({
        id: 'msg_' + Date.now() + '_thinking',
        role: 'assistant',
        type: 'thinking',
        content: delta,
        closed: false,
        timestamp: Date.now()
      });
      followLatestIfPinned();
      schedulePersist();
    }

    function closeActiveThinking() {
      const lastThinking = messageStore.findLast(m => m.type === 'thinking' && !m.closed);
      if (!lastThinking) return false;
      messageStore.update(lastThinking.id, { closed: true });
      return true;
    }

    function addToolMessage(tool) {
      const toolTitleObject = parseMaybeJsonObject(tool.title);
      const browserName = inferBrowserToolName(tool.title, tool.input, tool.kind);
      const safeTitle = browserName ? normalizeToolTitle(browserName, 'Tool') : normalizeToolTitle(tool.title, 'Tool');
      const toolCallId = normalizeToolId(tool.toolCallId, tool.title);
      removeLoading();
      closeActiveThinking();
      const existing = messageStore.find(m => m.type === 'tool' && m.toolCallId === toolCallId);
      if (existing) {
        messageStore.update(existing.id, {
          title: safeTitle,
          kind: browserName
            ? `browser:${browserName}`
            : normalizeToolKind(tool.kind ?? toolTitleObject?.kind, existing.kind || 'other'),
          input: tool.input ?? toolTitleObject?.rawInput ?? existing.input ?? null,
          locations: tool.locations ?? toolTitleObject?.locations ?? existing.locations ?? [],
          status: typeof tool.status === 'string' ? tool.status : existing.status || 'pending',
        });
        followLatestIfPinned();
        schedulePersist();
        return;
      }
      messageStore.append({
        id: 'msg_' + Date.now() + '_tool',
        role: 'assistant',
        type: 'tool',
        toolCallId,
        title: safeTitle,
        kind: browserName
          ? `browser:${browserName}`
          : normalizeToolKind(tool.kind ?? toolTitleObject?.kind, 'other'),
        input: tool.input ?? toolTitleObject?.rawInput ?? null,
        locations: tool.locations ?? toolTitleObject?.locations ?? [],
        status: typeof tool.status === 'string' ? tool.status : 'pending',
        output: null,
        toolContent: null,
        timestamp: Date.now()
      });
      followLatestIfPinned();
      schedulePersist();
    }

    function updateToolMessage(toolCallId, updates) {
      if (!toolCallId) return;
      const msg = messageStore.find(m => m.type === 'tool' && m.toolCallId === toolCallId);
      if (!msg) return;
      const browserName = inferBrowserToolName(updates.title ?? msg.title, updates.input ?? msg.input, updates.kind ?? msg.kind);
      messageStore.update(msg.id, (m) => {
        if (updates.title != null) m.title = browserName ? normalizeToolTitle(browserName, m.title) : normalizeToolTitle(updates.title, m.title);
        if (updates.kind != null || browserName) m.kind = browserName ? `browser:${browserName}` : normalizeToolKind(updates.kind, m.kind || 'other');
        if (updates.input !== undefined) m.input = updates.input;
        if (updates.locations !== undefined) m.locations = updates.locations || [];
        if (updates.status != null) m.status = typeof updates.status === 'string' ? updates.status : String(updates.status);
        if (updates.output !== undefined) m.output = updates.output;
        if (updates.content !== undefined) m.toolContent = updates.content;
      });
      followLatestIfPinned();
      schedulePersist();
    }

    function updateLastToolStatus(status) {
      const msg = messageStore.findLast(item => item.type === 'tool');
      if (!msg) return;
      messageStore.update(msg.id, { status });
      followLatestIfPinned();
      schedulePersist();
    }

    function handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'stream':
          appendStream(msg.delta || '');
          break;
        case 'thinking':
          appendThinking(msg.delta || '');
          break;
        case 'tool_call':
          addToolMessage({
            title: msg.toolTitle || 'Tool',
            toolCallId: msg.toolCallId,
            kind: msg.toolKind,
            input: msg.toolInput,
            locations: msg.toolLocations,
            status: msg.toolStatus || 'pending',
          });
          break;
        case 'tool_update':
          updateToolMessage(msg.toolCallId, {
            title: msg.toolTitle,
            kind: msg.toolKind,
            input: msg.toolInput,
            locations: msg.toolLocations,
            status: msg.toolStatus,
            output: msg.toolOutput,
            content: msg.toolContent,
          });
          break;
        case 'tool_status':
          updateLastToolStatus(msg.toolStatus || 'running');
          break;
        case 'done':
          endStream();
          markLastPendingToolCompleted();
          clearSentMarks();
          setRequestInFlight(false);
          if (msg.reason === 'cancelled') {
            showHint('任务已停止');
          } else {
            // Mark any remaining pending tools as completed on successful completion
            const pendingTools = messageStore.filter(m => m.type === 'tool' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'));
            pendingTools.forEach(tool => {
              messageStore.update(tool.id, { status: 'completed' });
            });
          }
          followLatestIfPinned();
          refreshSendState();
          schedulePersist();
          flushQueue();
          break;
        case 'error': {
          endStream();
          const errMsg = msg.message || 'Unknown error';
          if (/session|agent|process|exited|killed|not ready|eprconnreset/i.test(errMsg)) {
            addMessage('assistant', 'text', `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;color:#f59e0b;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg> Claude Code 会话异常：${errMsg}\n\n下一条消息将自动重建会话。`);
          } else {
            addMessage('assistant', 'text', 'Error: ' + errMsg);
          }
          setRequestInFlight(false);
          renderMessages();
          followLatestIfPinned();
          refreshSendState();
          schedulePersist();
          flushQueue();
          break;
        }
        case 'session_reset':
          addMessage('assistant', 'text', '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;color:#10b981;"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Claude Code 会话已重建，可以继续发送消息。');
          setRequestInFlight(false);
          refreshSendState();
          flushQueue();
          break;
        case 'session_snapshot':
          applySessionSnapshot(msg);
          if (msg.sessionId) showHint('会话已切换');
          break;
      }
    }

    return {
      handleMessage,
      startLoading,
      isStreamingMessage,
    };
  }

  window.__domReview.chatBridgeEvents = { create };
})();
