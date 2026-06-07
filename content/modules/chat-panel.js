/**
 * DevTailor — Chat Panel Module
 *
 * Manages chat history, message rendering, prompt cards, screenshot preview,
 * and send button state inside the sidebar.
 *
 * Depends on: ui (shadow-ui.js), store (review-store.js), promptBuilder
 * Registers: window.__domReview.chatPanel
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const chatTools = window.__domReview.chatTools;
  const chatScrollFactory = window.__domReview.chatScroll;
  const chatImages = window.__domReview.chatImages;
  const chatPersistenceFactory = window.__domReview.chatPersistence;
  const chatMarkdown = window.__domReview.chatMarkdown;
  const chatPreviewEditor = window.__domReview.chatPreviewEditor;
  const chatBridgeEvents = window.__domReview.chatBridgeEvents;
  const chatSend = window.__domReview.chatSend;
  const {
    toolFamily,
    toolIcon,
    toolKindLabel,
    toolStatusLabel,
    toolStatusClass,
    describeToolInput,
    formatToolContent,
    truncate,
    stringifyAny,
    inferBrowserToolName,
    normalizeToolTitle,
  } = chatTools;
  const {
    normalizeImages,
    isImageDataUrl,
  } = chatImages;

  const messages = [];
  let scrollManager = null;
  let imageManager = null;
  let persistenceManager = null;
  let previewEditor = null;
  let bridgeEvents = null;
  let sendManager = null;
  let inputComposing = false;
  let sessionMenuOpen = false;
  let sessionsCache = [];
  const openToolGroups = new Set();
  const MAX_MESSAGES = 50;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // --- DOM refs ---

  function getMessagesEl() {
    return window.__domReview.ui.getChatMessages();
  }

  function getJumpButton() {
    return window.__domReview.ui.getChatJumpButton?.();
  }

  function getInputEl() {
    return window.__domReview.ui.getChatInput();
  }

  function getSendBtn() {
    return window.__domReview.ui.getSendButton();
  }

  function isImeComposingEvent(event) {
    return Boolean(inputComposing || event.isComposing || event.keyCode === 229 || event.key === 'Process');
  }

  function resizeChatInput(input) {
    if (!input || input.tagName !== 'TEXTAREA') return;
    input.style.height = 'auto';
    const max = 112;
    const next = Math.min(input.scrollHeight, max);
    input.style.height = `${Math.max(36, next)}px`;
  }

  function getScreenshotPreview() {
    return window.__domReview.ui.getScreenshotPreview();
  }

  function getChatHint() {
    return window.__domReview.ui.getChatHint();
  }

  // --- Message management ---

  function addMessage(role, type, content, meta = {}) {
    messages.push({
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      role,
      type,
      content,
      ...meta,
      timestamp: Date.now()
    });
    if (messages.length > MAX_MESSAGES) {
      messages.splice(0, messages.length - MAX_MESSAGES);
    }
    renderMessages();
    if (role === 'user') {
      scrollToBottom();
    } else {
      followLatestIfPinned();
    }
    schedulePersist();
  }

  function clearHistory() {
    messages.length = 0;
    getImageManager().clear({ render: false });
    renderMessages();
    renderScreenshotPreview();
    persistNow();
  }

  function hydrateSession(projectInfo, clientId) {
    getPersistenceManager().hydrate(projectInfo, clientId);
  }

  function schedulePersist() {
    getPersistenceManager().schedulePersist();
  }

  function persistNow() {
    getPersistenceManager().persistNow();
  }

  function shortSessionId(id) {
    const value = String(id || '');
    if (!value) return '会话';
    return value.length > 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
  }

  function sessionTitle(session) {
    return session?.title || '新会话';
  }

  function updateSessionButton(id, title) {
    const label = title || '新会话';
    window.__domReview.ui.setSessionButtonLabel?.(label);
  }

  function refreshConnectionStatus() {
    const wsClient = window.__domReview.wsClient;
    if (!wsClient) return;
    const connected = wsClient.getStatus?.() === 'connected';
    const active = Boolean(wsClient.isActive?.());
    window.__domReview.ui.setConnectionStatus?.(
      wsClient.getStatus?.() || 'disconnected',
      wsClient.getSessionTitle?.() || '新会话',
      active,
    );
    window.__domReview.ui.setActivationBannerVisible?.(connected && !active);
    getSendManager().refreshSendState();
  }

  async function activateCurrentTab() {
    const client = window.__domReview.wsClient;
    if (!client) return;
    if (client.getStatus?.() !== 'connected') {
      client.connect?.();
      refreshConnectionStatus();
      return;
    }
    if (client.isActive?.()) return;
    const result = await client.activate?.();
    if (!result?.ok) {
      showHint(result?.error || '连接接管失败，请确认 Bridge 已启动');
    }
    refreshConnectionStatus();
  }

  function renderSessionMenu({ loading = false, unsupported = false, error = '', sessions = sessionsCache } = {}) {
    const menu = window.__domReview.ui.getSessionMenu?.();
    if (!menu) return;
    if (!sessionMenuOpen) {
      menu.classList.add('dt-hidden');
      return;
    }
    menu.classList.remove('dt-hidden');
    const currentId = window.__domReview.wsClient?.getSessionId?.();
    if (loading) {
      menu.innerHTML = '<div class="dt-session-empty">正在加载会话列表…</div>';
      return;
    }
    if (unsupported) {
      menu.innerHTML = '<div class="dt-session-empty">当前 Agent 不支持 ACP 会话列表，继续使用本地展示缓存。</div>';
      return;
    }
    if (error) {
      menu.innerHTML = `<div class="dt-session-empty">${escapeHtml(error)}</div>`;
      return;
    }
    if (!sessions.length) {
      menu.innerHTML = '<div class="dt-session-empty">暂无可切换会话。</div>';
      return;
    }
    menu.innerHTML = sessions.map(session => {
      const id = String(session.sessionId || '');
      const title = sessionTitle(session);
      const updated = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : id;
      return `
        <button class="dt-session-item ${id === currentId ? 'is-active' : ''}" data-session-id="${escapeHtml(id)}" type="button">
          <span class="dt-session-item__title">${escapeHtml(title)}</span>
          <span class="dt-session-item__meta">${escapeHtml(updated || id)}</span>
          <span class="dt-session-item__delete" data-action="delete-session" data-session-id="${escapeHtml(id)}">删除</span>
        </button>
      `;
    }).join('');
  }

  async function loadActiveSessionFromBridge() {
    const wsClient = window.__domReview.wsClient;
    if (!wsClient?.getActiveSession) return;
    const result = await wsClient.getActiveSession();
    if (!result?.ok) return;
    if (result.activeSessionId) {
      updateSessionButton(result.activeSessionId, result.session?.title);
      if (wsClient.setSessionInfo) {
        wsClient.setSessionInfo(result.activeSessionId, result.session?.title || '新会话');
      }
      getSendManager().setSessionId(result.activeSessionId);
    }
    messages.length = 0;
    if (Array.isArray(result.messages)) {
      messages.push(...result.messages.filter(item => item && typeof item === 'object'));
    }
    renderMessages();
    scrollToBottom();
  }

  async function refreshSessionMenu() {
    const wsClient = window.__domReview.wsClient;
    if (!wsClient?.listSessions) return;
    renderSessionMenu({ loading: true });
    const result = await wsClient.listSessions();
    if (!sessionMenuOpen) return;
    if (!result?.ok) {
      renderSessionMenu({ error: result?.error || '会话列表加载失败' });
      return;
    }
    if (result.supported === false) {
      renderSessionMenu({ unsupported: true });
      return;
    }
    sessionsCache = Array.isArray(result.sessions) ? result.sessions : [];
    renderSessionMenu({ sessions: sessionsCache });
  }

  async function toggleSessionMenu() {
    sessionMenuOpen = !sessionMenuOpen;
    renderSessionMenu();
    if (sessionMenuOpen) {
      await refreshSessionMenu();
    }
  }

  async function loadSessionFromMenu(sessionId) {
    const wsClient = window.__domReview.wsClient;
    if (!sessionId || !wsClient?.loadSession) return;

    if (getSendManager().isRequestInFlight()) {
      showHint('正在中断当前任务并切换会话…');
      try { await getSendManager().handleStop(); } catch {}
    }

    sessionMenuOpen = false;
    renderSessionMenu();
    const result = await wsClient.loadSession(sessionId);
    if (!result?.ok) {
      showHint(result?.error || '会话切换失败');
    }
  }

  async function deleteSessionFromMenu(sessionId) {
    const wsClient = window.__domReview.wsClient;
    if (!sessionId || !wsClient?.deleteSession) return;

    const currentId = wsClient.getSessionId?.();
    if (sessionId === currentId && getSendManager().isRequestInFlight()) {
      showHint('正在中断当前任务并删除会话…');
      try { await getSendManager().handleStop(); } catch {}
    }

    const result = await wsClient.deleteSession(sessionId);
    if (!result?.ok) {
      showHint(result?.error || '会话删除失败');
      return;
    }
    await refreshSessionMenu();
    showHint('会话已删除');
  }

  // --- Rendering ---

  function renderMessages() {
    const container = getMessagesEl();
    if (!container) return;

    if (messages.length === 0) {
      container.innerHTML = '<div class="dt-chat-empty">标记会作为 AI 上下文附加到下一条消息。这里保留你的请求和生成的 Codex 提示词。</div>';
      return;
    }

    container.innerHTML = renderMessageBlocks(messages);
  }

  function renderMessageBlocks(msgs) {
    const out = [];
    let i = 0;
    while (i < msgs.length) {
      const msg = msgs[i];
      const requestInFlight = getSendManager().isRequestInFlight();
      if (msg.type === 'loading') {
        out.push(renderLoading(msg));
        i++;
        continue;
      }
      if (msg.type === 'thinking') {
        out.push(renderThinkingBlock(msg));
        i++;
        continue;
      }
      if (msg.type === 'tool') {
        // Group consecutive same-kind tools
        const group = [msg];
        let j = i + 1;
        while (j < msgs.length && msgs[j].type === 'tool' && toolFamily(msgs[j].kind) === toolFamily(msg.kind)) {
          group.push(msgs[j]);
          j++;
        }
        if (group.length === 1) {
          out.push(renderToolCard(msg));
        } else {
          out.push(renderToolGroup(group));
        }
        i = j;
        continue;
      }
      if (msg.type === 'prompt-card') {
        out.push(renderPromptCard(msg));
        i++;
        continue;
      }
      if (msg.type === 'stream') {
        // Stream messages may be followed by a footer if they are the last assistant turn
        const hasFooter = i === msgs.length - 1 && requestInFlight;
        out.push(renderTextBubble(msg, hasFooter));
        i++;
        continue;
      }
      // Default text / assistant final
      const hasFooter = i === msgs.length - 1 && msg.role === 'assistant' && !requestInFlight && msg.content;
      out.push(renderTextBubble(msg, hasFooter));
      i++;
    }
    return out.join('');
  }

  function renderTextBubble(msg, withFooter) {
    const images = normalizeImages(msg.images || msg.image);
    const imageHtml = images.length
      ? `<div class="dt-chat-attachments">${images.map((src, idx) =>
        `<img class="dt-chat-attachment" src="${escapeHtml(src)}" alt="发送的截图 ${idx + 1}" data-preview-image="${escapeHtml(src)}">`
      ).join('')}</div>`
      : '';

    if (msg.role === 'user') {
      const text = msg.content ? `<div>${escapeHtml(msg.content)}</div>` : '';
      return `<div class="dt-chat-msg dt-chat-msg--user">${text}${imageHtml}</div>`;
    }

    const md = chatMarkdown.render(msg.content);
    const footer = withFooter ? renderAssistantFooter(msg) : '';
    return `<div class="dt-chat-msg dt-chat-md">${md}${footer}</div>`;
  }

  // --- Thinking block (open-design style) ---

  function renderThinkingBlock(msg) {
    const preview = escapeHtml(msg.content.trim().slice(0, 140));
    const hasMore = msg.content.trim().length > 140;
    const isOpen = msg.open ? 'open' : '';
    const label = msg.closed || !getSendManager().isRequestInFlight() ? '已思考' : '思考中';
    return `
      <div class="dt-thinking-block ${isOpen}" data-msg-id="${escapeHtml(msg.id)}">
        <button class="dt-thinking-toggle" type="button" data-action="toggle-thinking" data-msg-id="${escapeHtml(msg.id)}">
          <span class="dt-thinking-icon" aria-hidden>✨</span>
          <span class="dt-thinking-label">${label}</span>
          <span class="dt-thinking-preview">${msg.open ? '' : preview}${!msg.open && hasMore ? '…' : ''}</span>
          <span class="dt-thinking-chev" aria-hidden>${msg.open ? '▾' : '▸'}</span>
        </button>
        ${msg.open ? `<pre class="dt-thinking-body">${escapeHtml(msg.content)}</pre>` : ''}
      </div>
    `;
  }

  // --- Tool cards (open-design style) ---

  function renderToolCard(msg) {
    const status = msg.status || 'pending';
    const browserName = inferBrowserToolName(msg.title, msg.input, msg.kind);
    const icon = toolIcon(msg.kind);
    const title = escapeHtml(normalizeToolTitle(msg.title, 'Tool'));
    const meta = escapeHtml(describeToolInput(msg.input, msg.title, msg.kind));
    const statusLabel = toolStatusLabel(status);
    const statusClass = toolStatusClass(status);
    const path = msg.locations?.[0]?.path ? escapeHtml(msg.locations[0].path) : '';
    const hasOutput = shouldShowToolOutput(msg, browserName);
    return `
      <div class="dt-tool-card dt-tool-card--${escapeHtml(toolFamily(msg.kind))}" data-msg-id="${escapeHtml(msg.id)}">
        <div class="dt-tool-card-head">
          <span class="dt-tool-card-icon" aria-hidden>${icon}</span>
          <span class="dt-tool-card-title" title="${title}">${title}</span>
          ${path ? `<code class="dt-tool-card-path">${path}</code>` : ''}
          ${meta && !path ? `<span class="dt-tool-card-meta">${truncate(meta, 120)}</span>` : ''}
          <span class="dt-tool-card-status ${statusClass}">${statusLabel}</span>
          ${hasOutput ? `<button class="dt-tool-card-toggle" type="button" data-action="toggle-tool" data-msg-id="${escapeHtml(msg.id)}" title="${msg.open ? '隐藏输出' : '查看输出'}" aria-label="${msg.open ? '隐藏输出' : '查看输出'}">${msg.open ? '▴' : '▾'}</button>` : ''}
        </div>
        ${msg.open && hasOutput ? renderToolOutput(msg) : ''}
      </div>
    `;
  }

  function shouldShowToolOutput(msg, browserName) {
    const hasOutput = msg.output != null || (msg.toolContent && msg.toolContent.length > 0);
    if (!hasOutput) return false;
    if (!browserName) return true;
    if (msg.status === 'failed' || msg.status === 'error') return true;
    return browserName === 'get_page_snapshot' || browserName === 'get_console_logs' || browserName === 'get_console_message';
  }

  function renderToolOutput(msg) {
    let text = '';
    if (typeof msg.output === 'string') {
      text = msg.output;
    } else if (msg.toolContent) {
      text = msg.toolContent.map(formatToolContent).filter(Boolean).join('\n\n');
    } else if (msg.output != null) {
      try { text = JSON.stringify(msg.output, null, 2); } catch { text = String(msg.output); }
    }
    if (!text) return '';
    return `<pre class="dt-tool-output">${escapeHtml(truncate(text, 4000))}</pre>`;
  }

  function renderToolGroup(items) {
    const family = toolFamily(items[0].kind);
    const icon = toolIcon(items[0].kind);
    const label = toolKindLabel(items[0].kind);
    const count = items.length;
    const allDone = items.every(m => m.status === 'completed');
    const anyError = items.some(m => m.status === 'failed' || m.status === 'canceled' || m.status === 'error');
    const anyRunning = items.some(m => m.status === 'in_progress' || m.status === 'running');
    const state = anyError ? '失败' : anyRunning ? '运行中…' : allDone ? '已完成' : '';
    const groupKey = getToolGroupKey(items);
    const isOpen = openToolGroups.has(groupKey);
    return `
      <div class="dt-tool-group" data-tool-family="${escapeHtml(family)}" data-group-key="${escapeHtml(groupKey)}">
        <button class="dt-tool-group-toggle ${anyRunning ? 'running' : ''}" type="button" data-action="toggle-tool-group" data-group-key="${escapeHtml(groupKey)}" aria-expanded="${isOpen ? 'true' : 'false'}">
          <span class="dt-tool-group-icon" aria-hidden>${icon}</span>
          <span class="dt-tool-group-summary"><strong>${count > 1 ? `${label} ×${count}` : label}</strong>${state ? `，${state}` : ''}</span>
          <span class="dt-tool-group-chev" aria-hidden>${isOpen ? '▾' : '▸'}</span>
        </button>
        ${isOpen ? `<div class="dt-tool-group-body">${items.map(renderToolCard).join('')}</div>` : ''}
      </div>
    `;
  }

  function getToolGroupKey(items) {
    const first = Array.isArray(items) ? items[0] : items;
    const family = toolFamily(first?.kind);
    const anchor = first?.toolCallId || first?.id || 'unknown';
    return `toolgroup:${family}:${anchor}`;
  }

  function renderLoading(msg) {
    const statusText = msg.statusText || 'Claude Code 思考中…';
    return `
      <div class="dt-waiting-pill">
        <span class="dt-waiting-dot" aria-hidden></span>
        <span class="dt-waiting-label">${escapeHtml(statusText)}</span>
      </div>
    `;
  }

  function renderAssistantFooter(msg) {
    const isStreaming = msg.type === 'stream' || getBridgeEvents().isStreamingMessage(msg);
    const label = isStreaming ? 'Working…' : 'Done';
    return `
      <div class="dt-assistant-footer">
        <span class="dt-assistant-footer-dot" data-active="${isStreaming ? 'true' : 'false'}"></span>
        <span class="dt-assistant-footer-label">${label}</span>
      </div>
    `;
  }

  function renderPromptCard(msg) {
    return `
      <div class="dt-prompt-card" data-msg-id="${escapeHtml(msg.id)}">
        <div class="dt-prompt-header">
          <span class="dt-prompt-label">Claude Code 提示词</span>
        </div>
        <div class="dt-prompt-body">${escapeHtml(msg.content)}</div>
        <div class="dt-prompt-footer">
          <span class="dt-prompt-hint">复制并粘贴到 Claude Code</span>
          <button class="dt-btn dt-btn--small" data-action="copy-prompt" data-msg-id="${escapeHtml(msg.id)}">复制</button>
        </div>
      </div>
    `;
  }

  function getScrollManager() {
    if (!scrollManager) {
      scrollManager = chatScrollFactory.create({
        getContainer: getMessagesEl,
        getJumpButton,
      });
    }
    return scrollManager;
  }

  function setupScrollManagement() {
    getScrollManager().setup();
  }

  function scrollToBottom(options = {}) {
    getScrollManager().scrollToBottom(options);
  }

  function followLatestIfPinned() {
    getScrollManager().followLatestIfPinned();
  }

  function isPinnedToBottom() {
    return getScrollManager().isPinned();
  }

  function getImageManager() {
    if (!imageManager) {
      imageManager = chatImages.create({
        getPreview: getScreenshotPreview,
        showHint,
        refreshSendState: () => getSendManager().refreshSendState(),
        schedulePersist,
      });
    }
    return imageManager;
  }

  function getPersistenceManager() {
    if (!persistenceManager) {
      persistenceManager = chatPersistenceFactory.create({
        messages,
        maxMessages: MAX_MESSAGES,
        normalizeImages,
        stringifyAny,
        getImages: () => getImageManager().getImages(),
        setImages: (value, options) => getImageManager().setImages(value, options),
        renderMessages,
        renderImages: renderScreenshotPreview,
        scrollToBottom,
        refreshSendState: () => getSendManager().refreshSendState(),
        getSendState: () => getSendManager().getState?.(),
        restoreSendState: (state) => getSendManager().restoreState?.(state),
      });
    }
    return persistenceManager;
  }

  function getPreviewEditor() {
    if (!previewEditor) {
      previewEditor = chatPreviewEditor.create({
        ui: window.__domReview.ui,
        isImageDataUrl,
        addImage,
        showHint,
      });
    }
    return previewEditor;
  }

  function getBridgeEvents() {
    if (!bridgeEvents) {
      bridgeEvents = chatBridgeEvents.create({
        messages,
        maxMessages: MAX_MESSAGES,
        toolHelpers: chatTools,
        renderMessages,
        followLatestIfPinned,
        scrollToBottom,
        schedulePersist,
        showHint,
        addMessage,
        refreshSendState: () => getSendManager().refreshSendState(),
        flushQueue: () => getSendManager().flushQueue(),
        clearSentMarks: () => getSendManager().clearSentMarks(),
        setRequestInFlight: (value) => getSendManager().setRequestInFlight(value),
      });
    }
    return bridgeEvents;
  }

  function getSendManager() {
    if (!sendManager) {
      sendManager = chatSend.create({
        normalizeImages,
        getInput: getInputEl,
        getSendButton: getSendBtn,
        getStore: () => window.__domReview.store,
        getPromptBuilder: () => window.__domReview.promptBuilder,
        getWsClient: () => window.__domReview.wsClient,
        getImageManager,
        addMessage,
        showHint,
        schedulePersist,
        clearHistory,
        startLoading: () => getBridgeEvents().startLoading(),
        onAcceptedSend: deactivateMarkMode,
        focusInput: () => window.__domReview.ui.focusChatInput?.(),
      });
    }
    return sendManager;
  }

  function deactivateMarkMode() {
    const selector = window.__domReview.selector;
    if (!selector?.isActive?.()) return;
    window.__domReview.badges?.closeFloating?.({ save: true, resume: false });
    selector.disable?.();
    window.__domReview.ui?.setMarkActive?.(false);
  }

  // --- Screenshot preview ---

  function setScreenshot(base64) {
    return getImageManager().setScreenshot(base64);
  }

  function addImage(base64) {
    return getImageManager().addImage(base64);
  }

  function removeScreenshot(index) {
    getImageManager().removeScreenshot(index);
  }

  function setScreenshotFromFile(file) {
    return getImageManager().setScreenshotFromFile(file);
  }

  function handlePaste(e) {
    getImageManager().handlePaste(e);
  }

  function renderScreenshotPreview() {
    getImageManager().renderPreview();
  }

  function showHint(message) {
    const hint = getChatHint();
    if (!hint) return;
    hint.textContent = message;
    hint.classList.add('show');
    clearTimeout(showHint._timer);
    showHint._timer = setTimeout(() => {
      hint.classList.remove('show');
    }, 2500);
  }

  // --- Copy prompt ---

  function copyPrompt(text, btnEl) {
    navigator.clipboard.writeText(text).then(() => {
      const original = btnEl.textContent;
      btnEl.textContent = '已复制 ✓';
      setTimeout(() => btnEl.textContent = original, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      const original = btnEl.textContent;
      btnEl.textContent = '已复制 ✓';
      setTimeout(() => btnEl.textContent = original, 2000);
    });
  }

  function handlePreviewClick(e) {
    return getPreviewEditor().handlePreviewClick(e);
  }

  // --- Event wiring ---

  function init() {
    // Wire send button
    const sendBtn = getSendBtn();
    if (sendBtn) {
      const keepInputFocus = (event) => {
        event.preventDefault();
      };
      sendBtn.addEventListener('pointerdown', keepInputFocus);
      sendBtn.addEventListener('mousedown', keepInputFocus);
      sendBtn.addEventListener('click', (event) => {
        event.preventDefault();
        getSendManager().handleSend();
      });
    }

    // Wire Enter key on input
    const input = getInputEl();
    if (input) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (isImeComposingEvent(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          getSendManager().handleSend();
        }
      });
      input.addEventListener('keyup', (e) => {
        e.stopPropagation();
      });
      input.addEventListener('compositionstart', () => {
        inputComposing = true;
      });
      input.addEventListener('compositionend', () => {
        inputComposing = false;
        getSendManager().refreshSendState();
        resizeChatInput(input);
      });
      input.addEventListener('beforeinput', (e) => {
        e.stopPropagation();
      });
      input.addEventListener('input', () => {
        resizeChatInput(input);
        getSendManager().refreshSendState();
      });
      input.addEventListener('paste', handlePaste);
      resizeChatInput(input);
    }

    // Wire copy buttons / thinking toggles / tool toggles via event delegation on messages container
    const container = getMessagesEl();
    if (container) {
      setupScrollManagement();
      container.addEventListener('click', (e) => {
        if (handlePreviewClick(e)) return;

        const thinkingBtn = e.target.closest('[data-action="toggle-thinking"]');
        if (thinkingBtn) {
          const msgId = thinkingBtn.dataset.msgId;
          const msg = messages.find(m => m.id === msgId);
          if (msg) {
            const shouldFollow = isPinnedToBottom();
            msg.open = !msg.open;
            renderMessages();
            if (shouldFollow) followLatestIfPinned();
          }
          return;
        }

        const toolBtn = e.target.closest('[data-action="toggle-tool"]');
        if (toolBtn) {
          const msgId = toolBtn.dataset.msgId;
          const msg = messages.find(m => m.id === msgId);
          if (msg) {
            const shouldFollow = isPinnedToBottom();
            msg.open = !msg.open;
            renderMessages();
            if (shouldFollow) followLatestIfPinned();
          }
          return;
        }

        const groupBtn = e.target.closest('[data-action="toggle-tool-group"]');
        if (groupBtn) {
          const groupKey = groupBtn.dataset.groupKey;
          if (groupKey) {
            const shouldFollow = isPinnedToBottom();
            if (openToolGroups.has(groupKey)) {
              openToolGroups.delete(groupKey);
            } else {
              openToolGroups.add(groupKey);
            }
            renderMessages();
            if (shouldFollow) followLatestIfPinned();
          }
          return;
        }

        const btn = e.target.closest('[data-action="copy-prompt"]');
        if (!btn) return;
        const msgId = btn.dataset.msgId;
        const msg = messages.find(m => m.id === msgId);
        if (msg && msg.content) {
          copyPrompt(msg.content, btn);
        }
      });
    }

    const jumpBtn = getJumpButton();
    if (jumpBtn) {
      jumpBtn.addEventListener('click', () => {
        scrollToBottom({ smooth: true });
      });
    }

    const preview = getScreenshotPreview();
    if (preview) {
      preview.addEventListener('click', (e) => {
        if (e.target.closest('.dt-screenshot-remove')) return;
        handlePreviewClick(e);
      });
    }

    const imagePreview = window.__domReview.ui.getImagePreview?.();
    const imagePreviewClose = window.__domReview.ui.getImagePreviewClose?.();
    const previewEditor = getPreviewEditor();
    if (imagePreview) {
      imagePreview.addEventListener('click', (e) => {
        if (e.target === imagePreview) previewEditor.close();
      });
      imagePreview.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') previewEditor.close();
      });
    }
    if (imagePreviewClose) {
      imagePreviewClose.addEventListener('click', () => previewEditor.close());
    }

    previewEditor.init();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') previewEditor.close();
    });

    // Wire bridge messages
    const wsClient = window.__domReview.wsClient;
    if (wsClient) {
      wsClient.onMessage((msg) => getBridgeEvents().handleMessage(msg));
      wsClient.onStatusChange(refreshConnectionStatus);
      if (wsClient.onProjectChange) {
        wsClient.onProjectChange((info) => {
          hydrateSession(info, wsClient.getClientId?.());
          loadActiveSessionFromBridge();
        });
      } else if (wsClient.getProjectInfo && wsClient.getProjectInfo()) {
        hydrateSession(wsClient.getProjectInfo(), wsClient.getClientId?.());
        loadActiveSessionFromBridge();
      }
      if (wsClient.onSessionChange) {
        wsClient.onSessionChange((id, title) => {
          getSendManager().setSessionId(id);
          updateSessionButton(id, title);
          refreshConnectionStatus();
        });
      }
      refreshConnectionStatus();
    }

    window.__domReview.ui.onStatusClick?.(activateCurrentTab);
    window.__domReview.ui.onActivateTabClick?.(activateCurrentTab);

    const sessionButton = window.__domReview.ui.getSessionButton?.();
    const sessionMenu = window.__domReview.ui.getSessionMenu?.();
    if (sessionButton) {
      sessionButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSessionMenu();
      });
    }
    if (sessionMenu) {
      sessionMenu.addEventListener('click', (event) => {
        const deleteBtn = event.target.closest('[data-action="delete-session"][data-session-id]');
        if (deleteBtn) {
          event.preventDefault();
          event.stopPropagation();
          deleteSessionFromMenu(deleteBtn.dataset.sessionId);
          return;
        }
        const item = event.target.closest('.dt-session-item[data-session-id]');
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        loadSessionFromMenu(item.dataset.sessionId);
      });
    }
    document.addEventListener('click', (event) => {
      if (!sessionMenuOpen) return;
      const path = event.composedPath?.() || [];
      if (path.includes(sessionButton) || path.includes(sessionMenu)) return;
      sessionMenuOpen = false;
      renderSessionMenu();
    });

    getSendManager().refreshSendState();
  }

  async function requestNewSession() {
    if (getSendManager().isRequestInFlight()) {
      showHint('正在中断当前任务并开启新会话…');
      try { await getSendManager().handleStop(); } catch {}
    }
    return getSendManager().requestNewSession();
  }

  function prepareForPageSelection() {
    getPreviewEditor().close();
    const input = getInputEl();
    if (input) input.blur();
  }

  // --- Public API ---

  window.__domReview.chatPanel = {
    init,
    addMessage,
    clearHistory,
    updateSendButton: (enabled) => getSendManager().updateSendButton(enabled),
    refreshSendState: () => getSendManager().refreshSendState(),
    setScreenshot,
    addImage,
    removeScreenshot,
    setScreenshotFromFile,
    showHint,
    requestNewSession,
    prepareForPageSelection,
    getScreenshot: () => getImageManager().getScreenshot(),
    getImages: () => getImageManager().getImages(),
  };
})();
