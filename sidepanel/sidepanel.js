(() => {
  'use strict';

  /* ── DOM refs ─────────────────────────────────── */
  const $ = (s) => document.querySelector(s);
  const statusDot = $('#status-dot');
  const bridgePip = $('#bridge-pip');
  const bridgeStatus = $('#bridge-status');
  const projectName = $('#project-name');
  const runtimeLabel = $('#runtime-label');
  const activeTab = $('#active-tab');
  const metaStrip = $('#meta-strip');
  const stream = $('#stream');
  const welcome = $('#welcome');
  const welcomeSuggestions = $('#welcome-suggestions');
  const messagesEl = $('#messages');
  const thinkingEl = $('#thinking');
  const composer = $('#composer');
  const promptEl = $('#prompt');
  const sendBtn = $('#send-btn');
  const newSessionBtn = $('#btn-new-session');
  const historyBtn = $('#btn-history');

  const MESSAGES = [];
  let pollTimer = null;

  /* ── Bridge proxy ─────────────────────────────── */
  function bridgeRequest(path) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'DEVTAILOR_BRIDGE_PROXY_REQUEST', path, method: 'GET' },
        (response) => {
          resolve(
            response || {
              ok: false,
              error: chrome.runtime.lastError?.message || 'Bridge request failed',
            }
          );
        }
      );
    });
  }

  function parseBridgeJson(response) {
    if (!response?.body) return null;
    try {
      return JSON.parse(response.body);
    } catch {
      return null;
    }
  }

  /* ── Status ───────────────────────────────────── */
  function setPip(state) {
    bridgePip.classList.remove('is-online', 'is-offline', 'is-checking');
    if (state === 'online') bridgePip.classList.add('is-online');
    else if (state === 'offline') bridgePip.classList.add('is-offline');
    else bridgePip.classList.add('is-checking');
  }

  async function refreshStatus() {
    setPip('checking');
    bridgeStatus.textContent = '检查中…';
    const response = await bridgeRequest('/health');
    const body = parseBridgeJson(response);
    if (!response.ok || !body) {
      setPip('offline');
      bridgeStatus.textContent = '未连接';
      projectName.textContent = '-';
      runtimeLabel.textContent = '-';
      activeTab.textContent = '-';
      return;
    }
    setPip('online');
    bridgeStatus.textContent = '已连接';
    projectName.textContent = body.projectName || '-';
    runtimeLabel.textContent = body.agentLabel || body.agentKey || '-';
    activeTab.textContent = body.activeClientId || '未接管';
  }

  /* Toggle meta strip */
  statusDot.addEventListener('click', () => {
    metaStrip.classList.toggle('is-open');
    refreshStatus();
  });

  /* ── Helpers ──────────────────────────────────── */
  function scrollToEnd() {
    requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
    });
  }

  function updateWelcome() {
    if (MESSAGES.length > 0) {
      welcome.classList.add('is-hidden');
    } else {
      welcome.classList.remove('is-hidden');
    }
  }

  function updateSendState() {
    const hasText = promptEl.value.trim().length > 0;
    sendBtn.disabled = !hasText;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function truncate(str, max) {
    const value = String(str || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function toolStatusLabel(status) {
    const map = {
      pending: '准备中',
      in_progress: '运行中',
      running: '运行中',
      completed: '已完成',
      failed: '失败',
      error: '失败',
      canceled: '已取消',
    };
    return map[status] || status || '准备中';
  }

  function toolStatusClass(status) {
    if (status === 'completed') return 'dt-tool-status-ok';
    if (status === 'failed' || status === 'error' || status === 'canceled') return 'dt-tool-status-error';
    if (status === 'in_progress' || status === 'running') return 'dt-tool-status-running';
    return 'dt-tool-status-pending';
  }

  function toolIcon(kind) {
    if (kind === 'browser') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/></svg>';
    }
    if (kind === 'edit') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>';
  }

  function renderTextBubble(msg) {
    if (msg.role === 'user') {
      return `<div class="dt-chat-user-stack"><div class="dt-chat-msg dt-chat-msg--user">${escapeHtml(msg.content)}</div></div>`;
    }
    return `<div class="dt-chat-msg dt-chat-md">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>`;
  }

  function renderThinkingBlock(msg) {
    const preview = escapeHtml(msg.content.trim().slice(0, 140));
    const hasMore = msg.content.trim().length > 140;
    const isOpen = msg.open ? 'open' : '';
    const label = msg.closed ? '已思考' : '思考中';
    return `
      <div class="dt-thinking-block ${isOpen}" data-msg-id="${escapeHtml(msg.id)}">
        <button class="dt-thinking-toggle" type="button" data-action="toggle-thinking" data-msg-id="${escapeHtml(msg.id)}" aria-expanded="${msg.open ? 'true' : 'false'}">
          <span class="dt-thinking-icon" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 6.65A1.35 1.35 0 1 1 8 9.35A1.35 1.35 0 0 1 8 6.65Z" fill="currentColor"/>
              <path d="M8 2.4C10.9.1 14.2.3 15 1.1C15.8 1.9 15.9 5.2 13.6 8C15.9 10.8 15.8 14.1 15 14.9C14.2 15.7 10.9 15.9 8 13.6C5.2 15.9 1.9 15.8 1.1 14.9C.3 14.1.1 10.8 2.4 8C.1 5.2.3 1.9 1.1 1.1C1.9.3 5.2.1 8 2.4Z" fill="currentColor" fill-opacity=".55"/>
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

  function renderToolCard(msg) {
    const status = msg.status || 'pending';
    const hasOutput = Boolean(msg.output);
    const isOpen = msg.open && hasOutput;
    const title = escapeHtml(msg.title || 'Tool');
    const meta = escapeHtml(msg.meta || '');
    const family = msg.kind === 'browser' ? 'browser' : 'execute';
    const headerAttrs = hasOutput
      ? `button class="dt-tool-card-head" type="button" data-action="toggle-tool" data-msg-id="${escapeHtml(msg.id)}" aria-expanded="${isOpen ? 'true' : 'false'}"`
      : 'div class="dt-tool-card-head"';
    const headerClose = hasOutput ? 'button' : 'div';
    return `
      <div class="dt-tool-card dt-tool-card--${family} ${isOpen ? 'open' : ''}" data-msg-id="${escapeHtml(msg.id)}">
        <${headerAttrs}>
          <span class="dt-tool-card-icon" aria-hidden>${toolIcon(msg.kind)}</span>
          <span class="dt-tool-card-title" title="${title}">${title}</span>
          ${meta ? `<span class="dt-tool-card-meta">${truncate(meta, 120)}</span>` : ''}
          <span class="dt-tool-card-status ${toolStatusClass(status)}">${toolStatusLabel(status)}</span>
          ${hasOutput ? `<span class="dt-tool-card-chev" aria-hidden>
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              ${isOpen ? '<polyline points="6 9 12 15 18 9"/>' : '<polyline points="9 18 15 12 9 6"/>'}
            </svg>
          </span>` : ''}
        </${headerClose}>
        ${isOpen ? `<pre class="dt-tool-output">${escapeHtml(truncate(msg.output, 4000))}</pre>` : ''}
      </div>
    `;
  }

  function renderLoadingDots() {
    return '<div class="dt-loading-dots" aria-label="加载中"><span></span><span></span><span></span></div>';
  }

  function renderMessageBlock(msg) {
    if (msg.type === 'loading') return renderLoadingDots();
    if (msg.type === 'thinking') return renderThinkingBlock(msg);
    if (msg.type === 'tool') return renderToolCard(msg);
    return renderTextBubble(msg);
  }

  /* ── Render messages ──────────────────────────── */
  function renderMessages() {
    messagesEl.innerHTML = MESSAGES.map(renderMessageBlock).join('');
    scrollToEnd();
  }

  function pushMessage(message) {
    MESSAGES.push({
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      ...message,
    });
    updateWelcome();
    renderMessages();
  }

  function showThinking() {
    thinkingEl.hidden = false;
    scrollToEnd();
  }

  function hideThinking() {
    thinkingEl.hidden = true;
  }

  function resetDemoSession() {
    MESSAGES.length = 0;
    hideThinking();
    updateWelcome();
    renderMessages();
    promptEl.focus();
  }

  function showHint(message) {
    const hint = $('#sidepanel-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.add('show');
    clearTimeout(showHint.timer);
    showHint.timer = setTimeout(() => {
      hint.classList.remove('show');
    }, 2200);
  }

  /* ── Demo response ────────────────────────────── */
  function demoReply(userText) {
    showThinking();
    const thinking = {
      type: 'thinking',
      role: 'assistant',
      content: `理解用户问题：${userText}\n收集当前页面状态、已标记元素和控制台上下文。\n规划下一步：先检查页面，再给出可执行修改建议。`,
      closed: false,
      open: false,
    };
    pushMessage(thinking);

    setTimeout(() => {
      thinking.closed = true;
      pushMessage({
        type: 'tool',
        role: 'assistant',
        kind: 'browser',
        title: '页面状态',
        meta: 'URL / 标题 / 视口 / 可交互元素',
        status: 'completed',
        output: '当前是 sidePanel demo。接入真实 Bridge SSE 后，这里会显示 get_page_snapshot、run_actions、workspace tools 等工具结果。',
        open: false,
      });
    }, 650);

    setTimeout(() => {
      pushMessage({
        type: 'text',
        role: 'assistant',
        content: `收到你的问题「${userText}」。\n\n这块消息区现在按 DevTailor 当前 Chat UI 的结构渲染：用户消息、AI 回复、思考块和工具调用卡片会使用同一套视觉语言。`,
      });
      hideThinking();
    }, 1300);
  }

  /* ── Composer events ──────────────────────────── */
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = promptEl.value.trim();
    if (!text) return;
    pushMessage({ type: 'text', role: 'user', content: text });
    promptEl.value = '';
    promptEl.style.height = 'auto';
    updateSendState();
    demoReply(text);
  });

  promptEl.addEventListener('input', () => {
    /* Auto-resize */
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
    updateSendState();
  });

  /* Enter to send, Shift+Enter for newline */
  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  /* ── Suggestion chips ─────────────────────────── */
  welcomeSuggestions.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const q = chip.dataset.q;
    if (q) {
      pushMessage({ type: 'text', role: 'user', content: q });
      demoReply(q);
    }
  });

  messagesEl.addEventListener('click', (e) => {
    const thinkingBtn = e.target.closest('[data-action="toggle-thinking"]');
    if (thinkingBtn) {
      const msg = MESSAGES.find(item => item.id === thinkingBtn.dataset.msgId);
      if (msg) {
        msg.open = !msg.open;
        renderMessages();
      }
      return;
    }

    const toolBtn = e.target.closest('[data-action="toggle-tool"]');
    if (toolBtn) {
      const msg = MESSAGES.find(item => item.id === toolBtn.dataset.msgId);
      if (msg) {
        msg.open = !msg.open;
        renderMessages();
      }
    }
  });

  newSessionBtn?.addEventListener('click', resetDemoSession);
  historyBtn?.addEventListener('click', () => {
    showHint('历史会话列表会在接入 Bridge sessions 后显示。');
  });

  /* ── Init ──────────────────────────────────────── */
  updateSendState();
  refreshStatus();
  pollTimer = setInterval(refreshStatus, 30000);
  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
