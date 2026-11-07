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
  const composer = $('#composer');
  const promptEl = $('#prompt');
  const sendBtn = $('#send-btn');
  const attachBtn = $('#btn-attach');
  const imageFileInput = $('#image-file-input');
  const screenshotPreview = $('#screenshot-preview');
  const imageLightbox = $('#image-lightbox');
  const imageLightboxImg = $('#image-lightbox-img');
  const imageLightboxClose = $('#image-lightbox-close');
  const newSessionBtn = $('#btn-new-session');
  const historyBtn = $('#btn-history');

  const chatMarkdown = window.__domReview?.chatMarkdown;
  const chatImages = window.__domReview?.chatImages;
  const normalizeImages = chatImages?.normalizeImages || (() => []);
  const markdownRenderCache = new Map();

  /* ── State ────────────────────────────────────── */
  let clientId = null;
  let sseConnected = false;
  let requestInFlight = false;
  let sendInProgress = false;
  let stopInFlight = false;
  let pollTimer = null;

  let activeStreamId = null;
  let activeLoadingId = null;
  let currentSessionId = null;
  let syncedClientId = null;
  let snapshotRequestSerial = 0;
  let imageManager = null;

  /* ── Bridge proxy ─────────────────────────────── */
  function bridgeRequest(path, options = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'DEVTAILOR_BRIDGE_PROXY_REQUEST',
          path,
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body,
        },
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

  /* ── Message store ────────────────────────────── */
  const messages = [];

  const messageStore = {
    append(msg) {
      messages.push(msg);
      renderMessages();
    },
    update(id, updates) {
      const idx = messages.findIndex(m => m.id === id);
      if (idx === -1) return;
      const msg = messages[idx];
      if (typeof updates === 'function') {
        updates(msg);
      } else {
        Object.assign(msg, updates);
      }
      renderMessages();
    },
    remove(id) {
      const idx = messages.findIndex(m => m.id === id);
      if (idx === -1) return false;
      messages.splice(idx, 1);
      renderMessages();
      return true;
    },
    find(predicate) {
      return messages.find(predicate) || null;
    },
    findLast(predicate) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (predicate(messages[i])) return messages[i];
      }
      return null;
    },
    filter(predicate) {
      return messages.filter(predicate);
    },
    replaceAll(items) {
      messages.length = 0;
      messages.push(...items);
      renderMessages();
    },
    size() {
      return messages.length;
    },
    get(id) {
      return messages.find(m => m.id === id) || null;
    },
    getAll() {
      return messages;
    },
  };

  /* ── Status ───────────────────────────────────── */
  function setPip(state) {
    bridgePip.classList.remove('is-online', 'is-offline', 'is-checking');
    if (state === 'online') bridgePip.classList.add('is-online');
    else if (state === 'offline') bridgePip.classList.add('is-offline');
    else bridgePip.classList.add('is-checking');
  }

  async function refreshStatus(options = {}) {
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
      clientId = null;
      snapshotRequestSerial++;
      updateSendState();
      return;
    }
    if (!sseConnected) setPip('online');
    bridgeStatus.textContent = sseConnected ? 'SSE 已连接' : '已连接';
    projectName.textContent = body.projectName || '-';
    runtimeLabel.textContent = body.agentLabel || body.agentKey || '-';
    activeTab.textContent = body.activeClientId || '未接管';
    clientId = body.activeClientId || null;
    updateSendState();

    const activeSessionChanged = Boolean(
      body.activeSessionId && body.activeSessionId !== currentSessionId
    );
    if (
      clientId &&
      (options.forceSessionSync || syncedClientId !== clientId || activeSessionChanged)
    ) {
      await syncActiveSessionSnapshot(options.syncReason || 'status');
    }
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
    if (messages.length > 0) {
      welcome.classList.add('is-hidden');
    } else {
      welcome.classList.remove('is-hidden');
    }
  }

  function updateSendState() {
    const hasText = promptEl.value.trim().length > 0;
    const hasImages = (imageManager?.count?.() || 0) > 0;
    const connected = Boolean(clientId);

    if (sendInProgress) {
      sendBtn.disabled = true;
      sendBtn.textContent = '发送中';
      sendBtn.classList.remove('dt-send-btn--stop');
    } else if (requestInFlight) {
      sendBtn.disabled = stopInFlight;
      sendBtn.textContent = stopInFlight ? '停止中' : '停止';
      sendBtn.classList.toggle('dt-send-btn--stop', true);
    } else {
      sendBtn.disabled = !(connected && (hasText || hasImages));
      sendBtn.textContent = '发送';
      sendBtn.classList.remove('dt-send-btn--stop');
    }
  }

  async function syncActiveSessionSnapshot(reason = 'initial') {
    const targetClientId = clientId;
    if (!targetClientId) return false;

    const requestSerial = ++snapshotRequestSerial;
    const response = await bridgeRequest(
      `/sessions/active?clientId=${encodeURIComponent(targetClientId)}`
    );
    const body = parseBridgeJson(response);
    if (
      requestSerial !== snapshotRequestSerial ||
      targetClientId !== clientId
    ) {
      return false;
    }
    if (!response.ok || !body?.ok) {
      if (reason !== 'status') {
        showHint('当前会话同步失败，将继续接收新消息');
      }
      return false;
    }

    activeStreamId = null;
    activeLoadingId = null;
    currentSessionId = body.activeSessionId || body.session?.id || null;
    syncedClientId = targetClientId;

    const restored = Array.isArray(body.messages) ? body.messages : [];
    messageStore.replaceAll(restored);
    const tail = restored[restored.length - 1];
    if (body.isProcessing && tail?.type === 'stream' && tail.id) {
      activeStreamId = tail.id;
    }
    setRequestInFlight(Boolean(body.isProcessing));
    updateSendState();
    return true;
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
    const images = normalizeImages(msg.images || msg.image);
    const imageHtml = images.length
      ? `<div class="dt-chat-attachments dt-chat-attachments--user">${images.map((src, idx) =>
        `<img class="dt-chat-attachment" src="${escapeHtml(src)}" alt="发送的图片 ${idx + 1}" data-preview-image="${escapeHtml(src)}">`
      ).join('')}</div>`
      : '';

    if (msg.role === 'user') {
      const syntheticImageText = images.length && /^发送\s+\d+\s+张图片$/.test(String(msg.content || '').trim());
      const text = msg.content && !syntheticImageText
        ? `<div class="dt-chat-msg dt-chat-msg--user">${escapeHtml(msg.content)}</div>`
        : '';
      return `<div class="dt-chat-user-stack">${text}${imageHtml}</div>`;
    }

    const content = String(msg.content || '');
    const cached = markdownRenderCache.get(msg.id);
    const html = cached?.content === content
      ? cached.html
      : chatMarkdown?.render?.(content) || escapeHtml(content).replace(/\n/g, '<br>');
    if (cached?.content !== content) {
      markdownRenderCache.set(msg.id, { content, html });
    }
    return `<div class="dt-chat-msg dt-chat-md">${html}</div>`;
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
    if (msg.type === 'approval') return renderApprovalCard(msg);
    if (msg.type === 'question') return renderQuestionCard(msg);
    return renderTextBubble(msg);
  }

  function renderApprovalCard(msg) {
    const status = msg.status || 'pending';
    const idAttr = escapeHtml(msg.id);
    const toolName = escapeHtml(msg.toolName || 'tool');
    const action = escapeHtml(msg.action || '');
    const risk = escapeHtml(msg.risk || '');
    let footer = '';
    if (status === 'pending' && !msg.observing) {
      footer = `
        <div class="dt-approval-actions">
          <button class="dt-approval-btn dt-approval-reject" type="button" data-action="approval-decide" data-decision="rejected" data-msg-id="${idAttr}">拒绝</button>
          <button class="dt-approval-btn dt-approval-approve" type="button" data-action="approval-decide" data-decision="approved" data-msg-id="${idAttr}">批准</button>
        </div>`;
    } else if (status === 'submitting') {
      footer = '<div class="dt-approval-note">提交中…</div>';
    } else if (status === 'pending' && msg.observing) {
      footer = '<div class="dt-approval-note">等待发起会话的界面处理…</div>';
    } else if (status === 'approved') {
      footer = '<div class="dt-approval-note dt-approval-note--approved">已批准</div>';
    } else if (status === 'rejected') {
      footer = '<div class="dt-approval-note dt-approval-note--rejected">已拒绝</div>';
    }
    return `
      <div class="dt-approval-card dt-approval-card--${status}" data-msg-id="${idAttr}">
        <div class="dt-approval-head">
          <span class="dt-approval-badge">需要审批</span>
          <span class="dt-approval-tool" title="${toolName}">${toolName}</span>
        </div>
        ${action ? `<div class="dt-approval-action">${action}</div>` : ''}
        ${risk ? `<div class="dt-approval-risk">${risk}</div>` : ''}
        ${footer}
      </div>
    `;
  }

  const OTHER_SENTINEL = '__other__';

  function renderQuestionCard(msg) {
    const status = msg.status || 'pending';
    const idAttr = escapeHtml(msg.id);
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    const selections = Array.isArray(msg.selections) ? msg.selections : [];
    const otherText = Array.isArray(msg.otherText) ? msg.otherText : [];
    const interactive = status === 'pending' && !msg.observing;

    const body = questions.map((q, qIdx) => {
      const header = q.header ? `<span class="dt-question-chip">${escapeHtml(q.header)}</span>` : '';
      const qText = escapeHtml(q.question || '');
      const qBody = q.body ? `<div class="dt-question-body">${escapeHtml(q.body)}</div>` : '';
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      const groupName = `q_${idAttr}_${qIdx}`;
      const selected = Array.isArray(selections[qIdx]) ? selections[qIdx] : [];

      const opts = (Array.isArray(q.options) ? q.options : []).map((o) => {
        const checked = selected.includes(o.label) ? 'checked' : '';
        const desc = o.description ? `<span class="dt-question-opt-desc">${escapeHtml(o.description)}</span>` : '';
        return `
          <label class="dt-question-opt">
            <input type="${inputType}" name="${groupName}" value="${escapeHtml(o.label)}"
              data-action="question-select" data-msg-id="${idAttr}" data-q-idx="${qIdx}"
              data-label="${escapeHtml(o.label)}" ${checked} ${interactive ? '' : 'disabled'}>
            <span class="dt-question-opt-label">${escapeHtml(o.label)}</span>
            ${desc}
          </label>`;
      }).join('');

      let other = '';
      if (q.otherLabel) {
        const otherChecked = selected.includes(OTHER_SENTINEL) ? 'checked' : '';
        const otherVal = escapeHtml(otherText[qIdx] || '');
        other = `
          <label class="dt-question-opt">
            <input type="${inputType}" name="${groupName}" value="${OTHER_SENTINEL}"
              data-action="question-select" data-msg-id="${idAttr}" data-q-idx="${qIdx}"
              data-label="${OTHER_SENTINEL}" ${otherChecked} ${interactive ? '' : 'disabled'}>
            <span class="dt-question-opt-label">${escapeHtml(q.otherLabel)}</span>
          </label>
          <input type="text" class="dt-question-other" placeholder="${escapeHtml(q.otherDescription || '其他…')}"
            value="${otherVal}" data-action="question-other" data-msg-id="${idAttr}" data-q-idx="${qIdx}"
            ${interactive ? '' : 'disabled'}>`;
      }

      return `
        <div class="dt-question-item">
          <div class="dt-question-q">${header}<span class="dt-question-q-text">${qText}</span></div>
          ${qBody}
          <div class="dt-question-opts">${opts}${other}</div>
        </div>`;
    }).join('');

    let footer = '';
    if (interactive) {
      footer = `
        <div class="dt-question-actions">
          <button class="dt-question-btn dt-question-skip" type="button" data-action="question-skip" data-msg-id="${idAttr}">跳过</button>
          <button class="dt-question-btn dt-question-submit" type="button" data-action="question-submit" data-msg-id="${idAttr}">提交</button>
        </div>`;
    } else if (status === 'submitting') {
      footer = '<div class="dt-question-note">提交中…</div>';
    } else if (status === 'pending' && msg.observing) {
      footer = '<div class="dt-question-note">等待发起会话的界面回答…</div>';
    } else if (status === 'answered') {
      footer = '<div class="dt-question-note dt-question-note--answered">已回答</div>';
    } else if (status === 'dismissed') {
      footer = '<div class="dt-question-note dt-question-note--dismissed">已跳过</div>';
    }

    return `
      <div class="dt-question-card dt-question-card--${status}" data-msg-id="${idAttr}">
        <div class="dt-question-head">
          <span class="dt-question-badge">需要补充信息</span>
        </div>
        ${body}
        ${footer}
      </div>
    `;
  }

  /* ── Render messages ──────────────────────────── */
  function renderMessages() {
    const liveIds = new Set(messages.map(message => message.id));
    for (const id of markdownRenderCache.keys()) {
      if (!liveIds.has(id)) markdownRenderCache.delete(id);
    }
    messagesEl.innerHTML = messages.map(renderMessageBlock).join('');
    updateWelcome();
    scrollToEnd();
  }

  function addMessage(role, type, content, extra = {}) {
    const msg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      role,
      type,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    messageStore.append(msg);
    return msg;
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

  imageManager = chatImages?.create?.({
    getPreview: () => screenshotPreview,
    showHint,
    refreshSendState: updateSendState,
  }) || null;

  function openImagePreview(src) {
    if (!src || !imageLightbox || !imageLightboxImg) return;
    imageLightboxImg.src = src;
    imageLightbox.hidden = false;
    imageLightbox.setAttribute('aria-hidden', 'false');
    imageLightboxClose?.focus();
  }

  function closeImagePreview() {
    if (!imageLightbox || !imageLightboxImg) return;
    imageLightbox.hidden = true;
    imageLightbox.setAttribute('aria-hidden', 'true');
    imageLightboxImg.removeAttribute('src');
  }

  /* ── Stream / loading management ──────────────── */
  function startLoading(statusText) {
    if (activeLoadingId) {
      if (statusText) {
        messageStore.update(activeLoadingId, { statusText });
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
      timestamp: Date.now(),
    });
  }

  function removeLoading() {
    if (!activeLoadingId) return;
    messageStore.remove(activeLoadingId);
    activeLoadingId = null;
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
      timestamp: Date.now(),
    });
  }

  function endStream() {
    activeStreamId = null;
    removeLoading();
    closeActiveThinking();
  }

  function closeActiveThinking() {
    const lastThinking = messageStore.findLast(m => m.type === 'thinking' && !m.closed);
    if (!lastThinking) return;
    messageStore.update(lastThinking.id, { closed: true });
  }

  function markLastPendingToolCompleted() {
    const lastTool = messageStore.findLast(m => m.type === 'tool' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'));
    if (!lastTool) return;
    if (activeStreamId) {
      messageStore.update(lastTool.id, { status: 'completed' });
    }
  }

  /* ── SSE event projection ─────────────────────── */
  function handleSseMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'stream':
        if (!activeStreamId) startStream();
        markLastPendingToolCompleted();
        closeActiveThinking();
        if (activeStreamId) {
          messageStore.update(activeStreamId, (m) => { m.content += msg.delta || ''; });
        }
        break;

      case 'thinking': {
        if (!msg.delta) return;
        removeLoading();
        markLastPendingToolCompleted();
        const lastThinking = messageStore.findLast(m => m.type === 'thinking');
        if (lastThinking && !lastThinking.closed) {
          messageStore.update(lastThinking.id, (m) => { m.content += msg.delta; });
        } else {
          messageStore.append({
            id: 'msg_' + Date.now() + '_thinking',
            role: 'assistant',
            type: 'thinking',
            content: msg.delta,
            closed: false,
            open: false,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'tool_call': {
        removeLoading();
        closeActiveThinking();
        const toolCallId = msg.toolCallId || msg.toolTitle || 'tool_' + Date.now();
        const existing = messageStore.find(m => m.type === 'tool' && m.toolCallId === toolCallId);
        if (existing) {
          messageStore.update(existing.id, {
            title: msg.toolTitle || existing.title,
            status: msg.toolStatus || existing.status,
          });
        } else {
          messageStore.append({
            id: 'msg_' + Date.now() + '_tool',
            role: 'assistant',
            type: 'tool',
            toolCallId,
            title: msg.toolTitle || 'Tool',
            kind: msg.toolKind || 'other',
            input: msg.toolInput || null,
            status: msg.toolStatus || 'pending',
            output: null,
            open: false,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'tool_update': {
        const tool = messageStore.find(m => m.type === 'tool' && m.toolCallId === msg.toolCallId);
        if (!tool) break;
        messageStore.update(tool.id, {
          status: msg.toolStatus || tool.status,
          output: msg.toolOutput !== undefined ? msg.toolOutput : tool.output,
        });
        break;
      }

      case 'tool_status': {
        const lastTool = messageStore.findLast(m => m.type === 'tool');
        if (lastTool) {
          messageStore.update(lastTool.id, { status: msg.toolStatus || 'running' });
        }
        break;
      }

      case 'approval_request': {
        removeLoading();
        closeActiveThinking();
        const existing = messageStore.find(m => m.type === 'approval' && m.approvalId === msg.approvalId);
        if (existing) {
          messageStore.update(existing.id, { status: 'pending', observing: false });
        } else {
          messageStore.append({
            id: 'msg_' + Date.now() + '_approval',
            role: 'assistant',
            type: 'approval',
            approvalId: msg.approvalId,
            toolName: msg.toolName || 'tool',
            action: msg.action || '',
            risk: msg.risk || '',
            detail: msg.detail || null,
            status: 'pending',
            observing: false,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'approval_pending': {
        // Fired to all UIs; the decision-owner already has approval_request.
        const mine = clientId && msg.targetClientId === clientId;
        if (mine) break;
        const existing = messageStore.find(m => m.type === 'approval' && m.approvalId === msg.approvalId);
        if (!existing) {
          messageStore.append({
            id: 'msg_' + Date.now() + '_approval',
            role: 'assistant',
            type: 'approval',
            approvalId: msg.approvalId,
            toolName: msg.toolName || 'tool',
            action: '',
            risk: '',
            detail: null,
            status: 'pending',
            observing: true,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'approval_resolved': {
        const existing = messageStore.find(m => m.type === 'approval' && m.approvalId === msg.approvalId);
        if (existing) {
          messageStore.update(existing.id, { status: msg.decision === 'approved' ? 'approved' : 'rejected' });
        }
        break;
      }

      case 'question_request': {
        removeLoading();
        closeActiveThinking();
        const questions = Array.isArray(msg.questions) ? msg.questions : [];
        const existing = messageStore.find(m => m.type === 'question' && m.questionId === msg.questionId);
        if (existing) {
          messageStore.update(existing.id, { status: 'pending', observing: false, questions });
        } else {
          messageStore.append({
            id: 'msg_' + Date.now() + '_question',
            role: 'assistant',
            type: 'question',
            questionId: msg.questionId,
            questions,
            selections: questions.map(() => []),
            otherText: questions.map(() => ''),
            status: 'pending',
            observing: false,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'question_pending': {
        // Fired to all UIs; the answer-owner already has question_request.
        const mine = clientId && msg.targetClientId === clientId;
        if (mine) break;
        const existing = messageStore.find(m => m.type === 'question' && m.questionId === msg.questionId);
        if (!existing) {
          messageStore.append({
            id: 'msg_' + Date.now() + '_question',
            role: 'assistant',
            type: 'question',
            questionId: msg.questionId,
            questions: [],
            selections: [],
            otherText: [],
            status: 'pending',
            observing: true,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'question_resolved': {
        const existing = messageStore.find(m => m.type === 'question' && m.questionId === msg.questionId);
        if (existing) {
          messageStore.update(existing.id, { status: msg.answered ? 'answered' : 'dismissed' });
        }
        break;
      }

      case 'done':
        endStream();
        markLastPendingToolCompleted();
        messageStore.filter(m => m.type === 'tool' && (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'))
          .forEach(tool => messageStore.update(tool.id, { status: msg.reason === 'cancelled' ? 'canceled' : 'completed' }));
        if (msg.reason === 'cancelled') showHint('任务已停止');
        setRequestInFlight(false);
        updateSendState();
        break;

      case 'error':
        endStream();
        addMessage('assistant', 'text', 'Error: ' + (msg.message || 'Unknown error'));
        setRequestInFlight(false);
        updateSendState();
        break;

      case 'display_message': {
        const incoming = msg.displayMessage;
        if (!incoming || incoming.role !== 'user' || !incoming.id) break;
        const existing = messageStore.get(incoming.id);
        if (!existing) {
          const optimistic = messageStore.findLast(item =>
            item.role === 'user' &&
            item.optimistic &&
            item.content === incoming.content
          );
          if (optimistic) {
            messageStore.update(optimistic.id, { ...incoming, optimistic: false });
          } else {
            messageStore.append({ ...incoming, optimistic: false });
          }
        }
        currentSessionId = msg.sessionId || currentSessionId;
        syncedClientId = clientId;
        setRequestInFlight(Boolean(msg.isProcessing));
        updateSendState();
        break;
      }

      case 'session_reset':
        activeStreamId = null;
        activeLoadingId = null;
        currentSessionId = msg.sessionId || null;
        syncedClientId = clientId;
        if (msg.reason === 'user_requested') {
          messageStore.replaceAll([]);
          setRequestInFlight(false);
          updateSendState();
        }
        break;

      case 'session_snapshot': {
        activeStreamId = null;
        activeLoadingId = null;
        currentSessionId = msg.sessionId || null;
        syncedClientId = clientId;
        const restored = Array.isArray(msg.messages) ? msg.messages : [];
        messageStore.replaceAll(restored);
        const tail = restored[restored.length - 1];
        if (msg.reason === 'reconnect' && tail?.type === 'stream' && tail.id) {
          activeStreamId = tail.id;
        }
        setRequestInFlight(Boolean(msg.isProcessing));
        updateSendState();
        break;
      }

      case 'connected':
        // Project info from bridge
        break;

      case 'active_client':
        refreshStatus({ forceSessionSync: true, syncReason: 'active_client' });
        break;

      case 'session_info':
        if (msg.sessionId && msg.sessionId !== currentSessionId) {
          currentSessionId = msg.sessionId;
          syncActiveSessionSnapshot('session_info');
        }
        break;
    }
  }

  /* ── SSE listener ─────────────────────────────── */
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'DEVTAILOR_SIDEPANEL_PROXY_EVENT') return;

    // Filter by clientId if we know ours
    if (message.clientId && clientId && message.clientId !== clientId) return;

    if (message.event === 'open') {
      sseConnected = true;
      setPip('online');
      bridgeStatus.textContent = 'SSE 已连接';
      // The content script emits its reconnect snapshot only to its own
      // listeners, so the side panel must independently restore the session.
      refreshStatus({ forceSessionSync: true, syncReason: 'reconnect' });
      return;
    }

    if (message.event === 'message') {
      try {
        const data = JSON.parse(message.data || '');
        handleSseMessage(data);
      } catch {
        // ignore parse errors
      }
      return;
    }

    if (message.event === 'error') {
      sseConnected = false;
      setPip('offline');
      bridgeStatus.textContent = '连接断开';
      return;
    }
  });

  /* ── Send flow ─────────────────────────────────── */
  function setRequestInFlight(value) {
    requestInFlight = Boolean(value);
    if (!requestInFlight) {
      stopInFlight = false;
    }
  }

  async function executeSend(text, images) {
    if (!clientId) {
      showHint(bridgeStatus.textContent === '未连接' ? 'Bridge 未连接：请确认 Claude Code 已用 scripts/claude-devtailor.sh 启动' : '尚未接管标签页：请先在页面中点击“接管”');
      return { ok: false };
    }

    const payload = {
      type: 'review',
      payload: {
        pageUrl: '',
        userIntent: text,
        items: [],
        screenshots: images,
        screenshot: images[0] || null,
      },
      clientId,
      tabId: clientId,
    };

    const response = await bridgeRequest('/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      showHint('发送失败，请稍后重试');
      return { ok: false, error: response.error };
    }

    return { ok: true };
  }

  async function handleSend() {
    if (sendInProgress) return;
    if (requestInFlight) {
      handleStop();
      return;
    }

    const text = promptEl.value.trim();
    const pendingImages = imageManager?.getImages?.() || [];
    if (!text && pendingImages.length === 0) return;

    if (!clientId) {
      showHint(bridgeStatus.textContent === '未连接' ? 'Bridge 未连接：请确认 Claude Code 已用 scripts/claude-devtailor.sh 启动' : '尚未接管标签页：请先在页面中点击“接管”');
      return;
    }

    sendInProgress = true;
    const sendStartedAt = Date.now();
    updateSendState();

    try {
      const result = await executeSend(text, pendingImages);
      if (result.ok) {
        const optimisticContent = text || `发送 ${pendingImages.length} 张图片`;
        const persistedMessage = messageStore.findLast(item =>
          item.role === 'user' &&
          !item.optimistic &&
          item.content === optimisticContent &&
          Number(item.timestamp || 0) >= sendStartedAt
        );
        if (!persistedMessage) {
          addMessage('user', 'text', optimisticContent, {
            optimistic: true,
            images: pendingImages.slice(),
            image: pendingImages[0] || null,
          });
        }
        imageManager?.clear?.();
        promptEl.value = '';
        promptEl.style.height = 'auto';
        setRequestInFlight(true);
        startLoading();
      }
    } finally {
      sendInProgress = false;
      updateSendState();
      promptEl.focus();
    }
  }

  async function handleStop() {
    if (stopInFlight) return;
    if (!clientId) return;

    stopInFlight = true;
    updateSendState();
    showHint('正在停止任务...');

    const response = await bridgeRequest('/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, tabId: clientId }),
    });

    const body = parseBridgeJson(response);
    if (!response.ok || !body?.ok) {
      stopInFlight = false;
      showHint('停止失败，请稍后重试');
      updateSendState();
      return;
    }
    if (!body.canceled) {
      stopInFlight = false;
      setRequestInFlight(false);
      showHint('当前没有正在执行的任务');
      updateSendState();
    }
  }

  async function requestNewSession() {
    if (!clientId) {
      showHint('未检测到活跃标签页');
      return;
    }
    if (requestInFlight) {
      showHint('任务执行中，请结束后再开启新会话');
      return;
    }

    const response = await bridgeRequest('/new-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, tabId: clientId }),
    });

    const body = parseBridgeJson(response);
    if (!response.ok || !body?.ok) {
      showHint(body?.error || '开启新会话失败');
      return;
    }

    messageStore.replaceAll([]);
    activeStreamId = null;
    activeLoadingId = null;
    setRequestInFlight(false);
    updateSendState();
    showHint(body.reused ? '当前已是新会话' : '已开启新会话');
  }

  /* ── Composer events ──────────────────────────── */
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  promptEl.addEventListener('input', () => {
    promptEl.style.height = 'auto';
    promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
    updateSendState();
  });

  promptEl.addEventListener('paste', (event) => {
    imageManager?.handlePaste?.(event);
  });

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
      promptEl.value = q;
      promptEl.dispatchEvent(new Event('input'));
      handleSend();
    }
  });

  messagesEl.addEventListener('click', (e) => {
    const previewImage = e.target.closest('[data-preview-image], .dt-chat-md img');
    if (previewImage) {
      openImagePreview(previewImage.dataset.previewImage || previewImage.currentSrc || previewImage.src);
      return;
    }

    const thinkingBtn = e.target.closest('[data-action="toggle-thinking"]');
    if (thinkingBtn) {
      const msg = messageStore.get(thinkingBtn.dataset.msgId);
      if (msg) {
        msg.open = !msg.open;
        renderMessages();
      }
      return;
    }

    const toolBtn = e.target.closest('[data-action="toggle-tool"]');
    if (toolBtn) {
      const msg = messageStore.get(toolBtn.dataset.msgId);
      if (msg) {
        msg.open = !msg.open;
        renderMessages();
      }
      return;
    }

    const approvalBtn = e.target.closest('[data-action="approval-decide"]');
    if (approvalBtn) {
      const msg = messageStore.get(approvalBtn.dataset.msgId);
      const decision = approvalBtn.dataset.decision === 'approved' ? 'approved' : 'rejected';
      if (msg && msg.status === 'pending' && !msg.observing) {
        submitApprovalDecision(msg, decision);
      }
    }

    const questionSubmit = e.target.closest('[data-action="question-submit"]');
    if (questionSubmit) {
      const msg = messageStore.get(questionSubmit.dataset.msgId);
      if (msg && msg.status === 'pending' && !msg.observing) submitQuestionAnswer(msg);
    }

    const questionSkip = e.target.closest('[data-action="question-skip"]');
    if (questionSkip) {
      const msg = messageStore.get(questionSkip.dataset.msgId);
      if (msg && msg.status === 'pending' && !msg.observing) submitQuestionAnswer(msg, true);
    }
  });

  // Selection state is mutated in place (no re-render) so text-input focus
  // survives concurrent SSE-driven re-renders of the message list.
  messagesEl.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-action="question-select"]');
    if (!sel) return;
    const msg = messageStore.get(sel.dataset.msgId);
    if (!msg || msg.status !== 'pending' || msg.observing) return;
    const qIdx = Number(sel.dataset.qIdx);
    const q = msg.questions?.[qIdx];
    if (!q) return;
    if (!Array.isArray(msg.selections[qIdx])) msg.selections[qIdx] = [];
    const label = sel.dataset.label;
    if (q.multiSelect) {
      const cur = msg.selections[qIdx];
      const at = cur.indexOf(label);
      if (sel.checked && at === -1) cur.push(label);
      else if (!sel.checked && at !== -1) cur.splice(at, 1);
    } else {
      msg.selections[qIdx] = sel.checked ? [label] : [];
    }
  });

  messagesEl.addEventListener('input', (e) => {
    const other = e.target.closest('[data-action="question-other"]');
    if (!other) return;
    const msg = messageStore.get(other.dataset.msgId);
    if (!msg || msg.status !== 'pending' || msg.observing) return;
    const qIdx = Number(other.dataset.qIdx);
    if (!Array.isArray(msg.otherText)) msg.otherText = [];
    msg.otherText[qIdx] = other.value;
  });

  async function submitApprovalDecision(msg, decision) {
    messageStore.update(msg.id, { status: 'submitting' });
    const response = await bridgeRequest('/approval-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: msg.approvalId, decision }),
    });
    const body = parseBridgeJson(response);
    if (response.ok && body && body.ok) {
      messageStore.update(msg.id, { status: decision });
    } else {
      // Another UI decided first, or the request expired.
      messageStore.update(msg.id, { status: 'pending' });
      showHint(response.status === 409 ? '该审批已被处理' : '提交审批失败');
    }
  }

  function buildQuestionAnswers(msg) {
    const answers = {};
    const questions = Array.isArray(msg.questions) ? msg.questions : [];
    questions.forEach((q, qIdx) => {
      const selected = Array.isArray(msg.selections?.[qIdx]) ? msg.selections[qIdx] : [];
      const otherText = ((msg.otherText?.[qIdx]) || '').trim();
      const values = selected.filter(l => l !== OTHER_SENTINEL);
      if ((selected.includes(OTHER_SENTINEL) || (values.length === 0 && otherText)) && otherText) {
        values.push(otherText);
      }
      if (values.length === 0) return;
      answers[q.question] = q.multiSelect ? values.join(', ') : values[0];
    });
    return answers;
  }

  async function submitQuestionAnswer(msg, skip = false) {
    const answers = skip ? null : buildQuestionAnswers(msg);
    if (!skip && (!answers || Object.keys(answers).length === 0)) {
      showHint('请至少选择或填写一个答案');
      return;
    }
    messageStore.update(msg.id, { status: 'submitting' });
    const response = await bridgeRequest('/question-answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: msg.questionId, answers }),
    });
    const body = parseBridgeJson(response);
    if (response.ok && body && body.ok) {
      messageStore.update(msg.id, { status: skip ? 'dismissed' : 'answered' });
    } else {
      // Another UI answered first, or the request expired.
      messageStore.update(msg.id, { status: 'pending' });
      showHint(response.status === 409 ? '该提问已被回答' : '提交回答失败');
    }
  }

  screenshotPreview?.addEventListener('click', (event) => {
    const previewImage = event.target.closest('[data-preview-image]');
    if (previewImage) {
      openImagePreview(previewImage.dataset.previewImage || previewImage.currentSrc || previewImage.src);
    }
  });

  attachBtn?.addEventListener('click', () => {
    imageFileInput?.click();
  });

  imageFileInput?.addEventListener('change', () => {
    const files = Array.from(imageFileInput.files || []);
    files.forEach(file => imageManager?.setScreenshotFromFile?.(file));
    imageFileInput.value = '';
  });

  imageLightboxClose?.addEventListener('click', closeImagePreview);
  imageLightbox?.addEventListener('click', (event) => {
    if (event.target === imageLightbox) closeImagePreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !imageLightbox?.hidden) closeImagePreview();
  });

  newSessionBtn?.addEventListener('click', requestNewSession);
  historyBtn?.addEventListener('click', () => {
    showHint('历史会话列表会在接入 Bridge sessions 后显示。');
  });

  /* ── Init ──────────────────────────────────────── */
  updateSendState();
  refreshStatus({ forceSessionSync: true, syncReason: 'initial' });
  pollTimer = setInterval(refreshStatus, 30000);
  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
})();
