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
    messages,
    maxMessages,
    toolHelpers,
    renderMessages,
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

    function trimMessages() {
      if (messages.length > maxMessages) {
        messages.splice(0, messages.length - maxMessages);
      }
    }

    function isStreamingMessage(msg) {
      return Boolean(msg && msg.id && msg.id === activeStreamId);
    }

    function startLoading(statusText) {
      if (activeLoadingId) {
        if (statusText) {
          const msg = messages.find(m => m.id === activeLoadingId);
          if (msg) {
            msg.statusText = statusText;
            renderMessages();
            followLatestIfPinned();
          }
        }
        return;
      }
      const id = 'msg_' + Date.now() + '_loading';
      activeLoadingId = id;
      messages.push({
        id,
        role: 'assistant',
        type: 'loading',
        content: '',
        statusText: statusText || 'Claude Code 思考中…',
        timestamp: Date.now()
      });
      trimMessages();
      renderMessages();
      scrollToBottom();
    }

    function updateLoadingStatus(statusText) {
      if (!activeLoadingId) return;
      const msg = messages.find(m => m.id === activeLoadingId);
      if (msg) {
        msg.statusText = statusText;
        renderMessages();
        followLatestIfPinned();
      }
    }

    function removeLoading() {
      if (!activeLoadingId) return;
      const idx = messages.findIndex(m => m.id === activeLoadingId);
      if (idx >= 0) messages.splice(idx, 1);
      activeLoadingId = null;
    }

    function startStream() {
      if (activeStreamId) return;
      removeLoading();
      const id = 'msg_' + Date.now() + '_stream';
      activeStreamId = id;
      messages.push({
        id,
        role: 'assistant',
        type: 'stream',
        content: '',
        timestamp: Date.now()
      });
      trimMessages();
      renderMessages();
      followLatestIfPinned();
    }

    function appendStream(delta) {
      ensureStreamAtTail();
      if (!activeStreamId) return;
      markLastPendingToolCompleted();
      closeActiveThinking();
      const msg = messages.find(m => m.id === activeStreamId);
      if (!msg) return;
      msg.content += delta;
      renderMessages();
      followLatestIfPinned();
      schedulePersist();
    }

    function ensureStreamAtTail() {
      if (!activeStreamId) {
        startStream();
        return;
      }
      const idx = messages.findIndex(m => m.id === activeStreamId);
      if (idx === -1) {
        activeStreamId = null;
        startStream();
        return;
      }
      if (idx < messages.length - 1) {
        activeStreamId = null;
        startStream();
      }
    }

    function markLastPendingToolCompleted() {
      const lastTool = [...messages].reverse().find(m => m.type === 'tool' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'));
      if (lastTool) {
        lastTool.status = 'completed';
      }
    }

    function endStream() {
      activeStreamId = null;
      removeLoading();
      closeActiveThinking();
    }

    function applySessionSnapshot(msg) {
      activeStreamId = null;
      activeLoadingId = null;
      messages.length = 0;
      const restored = Array.isArray(msg.messages) ? msg.messages : [];
      messages.push(...restored.filter(item => item && typeof item === 'object'));
      renderMessages();
      scrollToBottom();
      refreshSendState();
      schedulePersist();
    }

    function appendThinking(delta) {
      updateLoadingStatus('思考中…');
      markLastPendingToolCompleted();
      const lastThinking = [...messages].reverse().find(m => m.type === 'thinking');
      if (lastThinking && !lastThinking.closed) {
        lastThinking.content += delta;
        renderMessages();
        followLatestIfPinned();
        schedulePersist();
        return;
      }
      messages.push({
        id: 'msg_' + Date.now() + '_thinking',
        role: 'assistant',
        type: 'thinking',
        content: delta,
        closed: false,
        timestamp: Date.now()
      });
      trimMessages();
      renderMessages();
      followLatestIfPinned();
      schedulePersist();
    }

    function closeActiveThinking() {
      const lastThinking = [...messages].reverse().find(m => m.type === 'thinking' && !m.closed);
      if (!lastThinking) return false;
      lastThinking.closed = true;
      return true;
    }

    function addToolMessage(tool) {
      const toolTitleObject = parseMaybeJsonObject(tool.title);
      const browserName = inferBrowserToolName(tool.title, tool.input, tool.kind);
      const safeTitle = browserName ? normalizeToolTitle(browserName, 'Tool') : normalizeToolTitle(tool.title, 'Tool');
      const toolCallId = normalizeToolId(tool.toolCallId, tool.title);
      updateLoadingStatus(safeTitle || '调用工具…');
      const existing = messages.find(m => m.type === 'tool' && m.toolCallId === toolCallId);
      if (existing) {
        existing.title = safeTitle;
        existing.kind = browserName
          ? `browser:${browserName}`
          : normalizeToolKind(tool.kind ?? toolTitleObject?.kind, existing.kind || 'other');
        existing.input = tool.input ?? toolTitleObject?.rawInput ?? existing.input ?? null;
        existing.locations = tool.locations ?? toolTitleObject?.locations ?? existing.locations ?? [];
        existing.status = typeof tool.status === 'string' ? tool.status : existing.status || 'pending';
        renderMessages();
        followLatestIfPinned();
        schedulePersist();
        return;
      }
      messages.push({
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
      trimMessages();
      renderMessages();
      followLatestIfPinned();
      schedulePersist();
    }

    function updateToolMessage(toolCallId, updates) {
      if (!toolCallId) return;
      const msg = messages.find(m => m.type === 'tool' && m.toolCallId === toolCallId);
      if (!msg) return;
      const browserName = inferBrowserToolName(updates.title ?? msg.title, updates.input ?? msg.input, updates.kind ?? msg.kind);
      if (updates.title != null) msg.title = browserName ? normalizeToolTitle(browserName, msg.title) : normalizeToolTitle(updates.title, msg.title);
      if (updates.kind != null || browserName) msg.kind = browserName ? `browser:${browserName}` : normalizeToolKind(updates.kind, msg.kind || 'other');
      if (updates.input !== undefined) msg.input = updates.input;
      if (updates.locations !== undefined) msg.locations = updates.locations || [];
      if (updates.status != null) msg.status = typeof updates.status === 'string' ? updates.status : String(updates.status);
      if (updates.output !== undefined) msg.output = updates.output;
      if (updates.content !== undefined) msg.toolContent = updates.content;
      renderMessages();
      followLatestIfPinned();
      schedulePersist();
    }

    function updateLastToolStatus(status) {
      const msg = [...messages].reverse().find(item => item.type === 'tool');
      if (!msg) return;
      msg.status = status;
      renderMessages();
      followLatestIfPinned();
      schedulePersist();
    }

    function handleMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'stream':
          if (!activeStreamId) startStream();
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
          }
          renderMessages();
          followLatestIfPinned();
          refreshSendState();
          schedulePersist();
          flushQueue();
          break;
        case 'error': {
          endStream();
          const errMsg = msg.message || 'Unknown error';
          if (/session|agent|process|exited|killed|not ready|eprconnreset/i.test(errMsg)) {
            addMessage('assistant', 'text', `⚠️ Claude Code 会话异常：${errMsg}\n\n下一条消息将自动重建会话。`);
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
          addMessage('assistant', 'text', '♻️ Claude Code 会话已重建，可以继续发送消息。');
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
