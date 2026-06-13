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

  const MAX_MESSAGES = 50;
  const messageStore = window.__domReview.createMessageStore({ maxMessages: MAX_MESSAGES });
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
    messageStore.append({
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      role,
      type,
      content,
      ...meta,
      timestamp: Date.now()
    });
    if (role === 'user') {
      scrollToBottom();
    } else {
      followLatestIfPinned();
    }
    schedulePersist();
  }

  function clearHistory() {
    messageStore.clear();
    getImageManager().clear({ render: false });
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
    // Refresh empty state when connection status changes
    if (messageStore.size === 0) {
      renderMessages();
    }
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
    messageStore.replaceAll(result.messages);
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
      return;
    }
    if (Array.isArray(result.messages)) {
      messageStore.replaceAll(result.messages);
      scrollToBottom();
      schedulePersist();
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

    if (messageStore.size === 0) {
      container.innerHTML = `<div class="dt-chat-empty">${getEmptyStateText()}</div>`;
      return;
    }

    container.innerHTML = renderMessageBlocks(messageStore.getAll());
  }

  function getEmptyStateText() {
    const wsClient = window.__domReview.wsClient;
    const status = wsClient?.getStatus?.() || 'disconnected';
    const projectInfo = wsClient?.getProjectInfo?.() || {};
    const agentName = projectInfo.agentLabel || projectInfo.agentKey || null;

    if (status === 'disconnected') {
      return agentName
        ? `等待连接到 ${agentName}…<br><br>请确保 DevTailor Bridge 已启动`
        : `等待连接到 Bridge…<br><br>请确保 DevTailor Bridge 已启动`;
    }
    if (status === 'connecting') {
      return `连接中…`;
    }
    return `标记会作为 AI 上下文附加到下一条消息<br><br>试试点击「标记」按钮标注页面元素，或直接输入你的需求`;
  }

  function renderMessageBlocks(msgs) {
    const out = [];
    let i = 0;
    while (i < msgs.length) {
      const msg = msgs[i];
      const requestInFlight = getSendManager().isRequestInFlight();
      if (msg.type === 'loading') {
        out.push(renderLoadingDots());
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
      ? `<div class="dt-chat-attachments dt-chat-attachments--user">${images.map((src, idx) =>
        `<img class="dt-chat-attachment" src="${escapeHtml(src)}" alt="发送的截图 ${idx + 1}" data-preview-image="${escapeHtml(src)}">`
      ).join('')}</div>`
      : '';

    if (msg.role === 'user') {
      const syntheticImageText = images.length && /^发送\s+\d+\s+张图片$/.test(String(msg.content || '').trim());
      const text = msg.content && !syntheticImageText
        ? `<div class="dt-chat-msg dt-chat-msg--user">${escapeHtml(msg.content)}</div>`
        : '';
      return `<div class="dt-chat-user-stack">${text}${imageHtml}</div>`;
    }

    const md = chatMarkdown.render(msg.content);
    return `<div class="dt-chat-msg dt-chat-md">${md}</div>`;
  }

  function renderLoadingDots() {
    return `
      <div class="dt-loading-dots" aria-label="加载中">
        <span></span><span></span><span></span>
      </div>
    `;
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
          <span class="dt-thinking-icon" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8.00192 6.64454C8.75026 6.64454 9.35732 7.25169 9.35739 8.00001C9.35739 8.74838 8.7503 9.35548 8.00192 9.35548C7.25367 9.35533 6.64743 8.74829 6.64743 8.00001C6.6475 7.25178 7.25371 6.64468 8.00192 6.64454Z" fill="currentColor"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M9.97165 1.29981C11.5853 0.718916 13.271 0.642197 14.3144 1.68555C15.3577 2.72902 15.2811 4.41466 14.7002 6.02833C14.4707 6.66561 14.1504 7.32937 13.75 8.00001C14.1504 8.67062 14.4707 9.33444 14.7002 9.97169C15.2811 11.5854 15.3578 13.271 14.3144 14.3145C13.271 15.3579 11.5854 15.2811 9.97165 14.7002C9.3344 14.4708 8.67059 14.1505 7.99997 13.75C7.32933 14.1505 6.66558 14.4708 6.02829 14.7002C4.41461 15.2811 2.72899 15.3578 1.68552 14.3145C0.642155 13.271 0.71887 11.5854 1.29977 9.97169C1.52915 9.33454 1.84865 8.67049 2.24899 8.00001C1.84866 7.32953 1.52915 6.66544 1.29977 6.02833C0.718852 4.41459 0.64207 2.729 1.68552 1.68555C2.72897 0.642112 4.41456 0.718887 6.02829 1.29981C6.66541 1.52918 7.32949 1.8487 7.99997 2.24903C8.67045 1.84869 9.33451 1.52919 9.97165 1.29981ZM12.9404 9.2129C12.4391 9.893 11.8616 10.5681 11.2148 11.2149C10.568 11.8616 9.89296 12.4391 9.21286 12.9404C9.62532 13.1579 10.0271 13.338 10.4121 13.4766C11.9146 14.0174 12.9172 13.8738 13.3955 13.3955C13.8737 12.9173 14.0174 11.9146 13.4765 10.4121C13.3379 10.0271 13.1578 9.62535 12.9404 9.2129ZM3.05856 9.2129C2.84121 9.62523 2.66197 10.0272 2.52341 10.4121C1.98252 11.9146 2.12627 12.9172 2.60446 13.3955C3.08278 13.8737 4.08544 14.0174 5.58786 13.4766C5.97264 13.338 6.37389 13.1577 6.7861 12.9404C6.10624 12.4393 5.43168 11.8614 4.78513 11.2149C4.13823 10.5679 3.55992 9.89313 3.05856 9.2129ZM7.99899 3.792C7.23179 4.31419 6.45306 4.95512 5.70407 5.70411C4.95509 6.45309 4.31415 7.23184 3.79196 7.99903C4.3143 8.76666 4.95471 9.54653 5.70407 10.2959C6.45309 11.0449 7.23271 11.6848 7.99997 12.207C8.76725 11.6848 9.54683 11.0449 10.2959 10.2959C11.0449 9.54686 11.6848 8.76729 12.207 8.00001C11.6848 7.23275 11.0449 6.45312 10.2959 5.70411C9.5465 4.95475 8.76662 4.31434 7.99899 3.792ZM5.58786 2.52344C4.08533 1.98255 3.08272 2.12625 2.60446 2.6045C2.12621 3.08275 1.98252 4.08536 2.52341 5.5879C2.66189 5.97253 2.8414 6.37409 3.05856 6.78614C3.55983 6.10611 4.1384 5.43189 4.78513 4.78516C5.43186 4.13843 6.10606 3.55987 6.7861 3.0586C6.37405 2.84144 5.97249 2.66192 5.58786 2.52344ZM13.3955 2.6045C12.9172 2.12631 11.9146 1.98257 10.4121 2.52344C10.0272 2.66201 9.62519 2.84125 9.21286 3.0586C9.8931 3.55996 10.5679 4.13827 11.2148 4.78516C11.8614 5.43172 12.4392 6.10627 12.9404 6.78614C13.1577 6.37393 13.338 5.97267 13.4765 5.5879C14.0174 4.08549 13.8736 3.08281 13.3955 2.6045Z" fill="currentColor"/>
            </svg>
          </span>
          <span class="dt-thinking-label">${label}</span>
          <span class="dt-thinking-preview">${msg.open ? '' : preview}${!msg.open && hasMore ? '…' : ''}</span>
          <span class="dt-thinking-chev" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${msg.open ? '<polyline points="6 9 12 15 18 9"/>' : '<polyline points="9 18 15 12 9 6"/>'}
            </svg>
          </span>
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
    const isOpen = msg.open && hasOutput;
    const headerAttrs = hasOutput
      ? `button class="dt-tool-card-head" type="button" data-action="toggle-tool" data-msg-id="${escapeHtml(msg.id)}" title="${isOpen ? '隐藏输出' : '查看输出'}" aria-label="${isOpen ? '隐藏输出' : '查看输出'}" aria-expanded="${isOpen ? 'true' : 'false'}"`
      : 'div class="dt-tool-card-head"';
    const headerClose = hasOutput ? 'button' : 'div';
    return `
      <div class="dt-tool-card dt-tool-card--${escapeHtml(toolFamily(msg.kind))} ${isOpen ? 'open' : ''}" data-msg-id="${escapeHtml(msg.id)}">
        <${headerAttrs}>
          <span class="dt-tool-card-icon" aria-hidden>${icon}</span>
          <span class="dt-tool-card-title" title="${title}">${title}</span>
          ${path ? `<code class="dt-tool-card-path">${path}</code>` : ''}
          ${meta && !path ? `<span class="dt-tool-card-meta">${truncate(meta, 120)}</span>` : ''}
          <span class="dt-tool-card-status ${statusClass}">${statusLabel}</span>
          ${hasOutput ? `<span class="dt-tool-card-chev" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${isOpen ? '<polyline points="6 9 12 15 18 9"/>' : '<polyline points="9 18 15 12 9 6"/>'}
            </svg>
          </span>` : ''}
        </${headerClose}>
        ${isOpen ? renderToolOutput(msg) : ''}
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
      <div class="dt-tool-group ${isOpen ? 'open' : ''}" data-tool-family="${escapeHtml(family)}" data-group-key="${escapeHtml(groupKey)}">
        <button class="dt-tool-group-toggle ${anyRunning ? 'running' : ''}" type="button" data-action="toggle-tool-group" data-group-key="${escapeHtml(groupKey)}" aria-expanded="${isOpen ? 'true' : 'false'}">
          <span class="dt-tool-group-icon" aria-hidden>${icon}</span>
          <span class="dt-tool-group-summary"><strong>${count > 1 ? `${label} ×${count}` : label}</strong>${state ? `，${state}` : ''}</span>
          <span class="dt-tool-group-chev" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${isOpen ? '<polyline points="6 9 12 15 18 9"/>' : '<polyline points="9 18 15 12 9 6"/>'}
            </svg>
          </span>
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

  function renderPromptCard(msg) {
    const projectInfo = window.__domReview.wsClient?.getProjectInfo?.() || {};
    const agentName = projectInfo.agentLabel || projectInfo.agentKey || 'Agent';
    return `
      <div class="dt-prompt-card" data-msg-id="${escapeHtml(msg.id)}">
        <div class="dt-prompt-header">
          <span class="dt-prompt-label">${agentName} 提示词</span>
        </div>
        <div class="dt-prompt-body">${escapeHtml(msg.content)}</div>
        <div class="dt-prompt-footer">
          <span class="dt-prompt-hint">复制并粘贴到 ${agentName}</span>
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

  function keepMessageInView(msgId) {
    const container = getMessagesEl();
    if (!container || !msgId) return;
    const block = container.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    if (!block) return;
    const blockRect = block.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (blockRect.top < containerRect.top || blockRect.bottom > containerRect.bottom) {
      block.scrollIntoView({ block: 'nearest' });
    }
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
        messageStore,
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
        messageStore,
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
        getCurrentSessionId: () => window.__domReview.wsClient?.getSessionId?.(),
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
      btnEl.innerHTML = '已复制 <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-left:2px;"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => btnEl.textContent = original, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      const original = btnEl.textContent;
      btnEl.innerHTML = '已复制 <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-left:2px;"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => btnEl.textContent = original, 2000);
    });
  }

  function handlePreviewClick(e) {
    return getPreviewEditor().handlePreviewClick(e);
  }

  // --- Event wiring ---

  function init() {
    // Subscribe messageStore to auto-render on changes
    messageStore.subscribe(renderMessages);

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
          e.preventDefault();
          e.stopPropagation();
          const msgId = thinkingBtn.dataset.msgId;
          const msg = messageStore.find(m => m.id === msgId);
          if (msg) {
            const willOpen = !msg.open;
            messageStore.update(msgId, { open: willOpen });
            if (willOpen) keepMessageInView(msgId);
          }
          return;
        }

        const toolBtn = e.target.closest('[data-action="toggle-tool"]');
        if (toolBtn) {
          e.preventDefault();
          e.stopPropagation();
          const msgId = toolBtn.dataset.msgId;
          const msg = messageStore.find(m => m.id === msgId);
          if (msg) {
            const shouldFollow = isPinnedToBottom();
            const willOpen = !msg.open;
            messageStore.update(msgId, { open: willOpen });
            if (willOpen) keepMessageInView(msgId);
            if (shouldFollow) followLatestIfPinned();
          }
          return;
        }

        const groupBtn = e.target.closest('[data-action="toggle-tool-group"]');
        if (groupBtn) {
          e.preventDefault();
          e.stopPropagation();
          const groupKey = groupBtn.dataset.groupKey;
          if (groupKey) {
            const shouldFollow = isPinnedToBottom();
            const willOpen = !openToolGroups.has(groupKey);
            if (openToolGroups.has(groupKey)) {
              openToolGroups.delete(groupKey);
            } else {
              openToolGroups.add(groupKey);
            }
            renderMessages();
            if (willOpen) {
              const group = getMessagesEl()?.querySelector(`.dt-tool-group[data-group-key="${CSS.escape(groupKey)}"]`);
              if (group) group.scrollIntoView({ block: 'nearest' });
            }
            if (shouldFollow) followLatestIfPinned();
          }
          return;
        }

        const btn = e.target.closest('[data-action="copy-prompt"]');
        if (!btn) return;
        const msgId = btn.dataset.msgId;
        const msg = messageStore.find(m => m.id === msgId);
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

    // Only bind activate button, not status indicator
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
