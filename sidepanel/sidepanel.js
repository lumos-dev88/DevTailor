(() => {
  'use strict';

  /* ── DOM refs ─────────────────────────────────── */
  const $ = (s) => document.querySelector(s);
  const statusDot = $('#status-dot');
  const bridgePip = $('#bridge-pip');
  const bridgeStatus = $('#bridge-status');
  const instanceSelect = $('#instance-select');
  const takeoverBtn = $('#btn-takeover');
  const runtimeLabel = $('#runtime-label');
  const activeTab = $('#active-tab');
  const metaStrip = $('#meta-strip');
  const stream = $('#stream');
  const welcome = $('#welcome');
  const welcomeSuggestions = $('#welcome-suggestions');
  const messagesEl = $('#messages');
  const jumpBtn = $('#chat-jump');
  const composer = $('#composer');
  const promptEl = $('#prompt');
  const sendBtn = $('#send-btn');
  const cancelBtn = $('#cancel-btn');
  const attachBtn = $('#btn-attach');
  const imageFileInput = $('#image-file-input');
  const screenshotPreview = $('#screenshot-preview');
  const imageLightbox = $('#image-lightbox');
  const imageLightboxImg = $('#image-lightbox-img');
  const imageLightboxClose = $('#image-lightbox-close');
  const newSessionBtn = $('#btn-new-session');
  const sessionTitleEl = $('#session-title');
  const promptCtxEl = $('#prompt-ctx');
  /** 上一条提示带入的上下文（按会话记，切会话后不显示别的会话的） */
  let lastPromptCtx = null;
  const statusBanner = $('#status-banner');

  const core = window.__domReview.bridgeCore;
  const chatRender = window.__domReview.chatRender;
  const marksCore = window.__domReview.marksCore;
  const chatMarkdown = window.__domReview?.chatMarkdown;
  const chatImages = window.__domReview?.chatImages;
  const normalizeImages = chatImages?.normalizeImages || (() => []);
  const markdownRenderCache = new Map();

  // Shared chat component styles (permission card, diff/console, notices…).
  const chatStyle = document.createElement('style');
  chatStyle.textContent = window.__domReview.chatStyles.css;
  document.head.appendChild(chatStyle);

  /* ── 极简工具状态（工具名 + 状态） ────────────── */
  // session bar 里的一小段文字：只描述最近一次工具调用，不进消息流、不碰滚动和 composer。
  const toolStatus = window.__domReview.toolStatus.create({
    elements: {
      root: $('#tool-status'),
      text: $('#tool-status-text'),
    },
  });

  /* ── State ────────────────────────────────────── */
  let clientId = null;
  // The panel's own SSE identity (`panel_<tabId>`). Used to subscribe to /events so replies and
  // card events reach it even when no tab is taken over.
  let panelClientId = null;
  let panelSseConnecting = false;
  let panelTabId = null;
  // 侧边栏是窗口级的：关闭请求按窗口匹配（worker 推 DT_SIDEPANEL_CLOSE_REQUEST 时带 windowId）。
  let panelWindowId = null;
  // 面板自身加载时间，用于判断它是否先于关闭请求存在。
  const panelLoadedAt = Date.now();
  // 面板实例标识：快速连点时旧实例的 beforeunload CLOSED 可能晚于新实例的 READY 到达，
  // worker 靠它区分「旧实例的迟到通知」和「当前实例的关闭」，避免误清新面板的状态。
  const panelToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let bridgeReachable = false;
  let sseConnected = false;
  // 发送即完成（像聊天）：没有「处理中」锁。sendInProgress 只在 POST /review 在途的几十毫秒内
  // 防重复提交（连按 Enter / 双击），请求一返回立即放开，可以连续发多条。
  let sendInProgress = false;
  let cancelInFlight = false;
  let pollTimer = null;
  let imageManager = null;
  let syncedSessionKey = null;
  let healthSerial = 0;
  let disconnectedAt = 0;
  let syncSerial = 0;

  /* ── References tray (全局待发送参考元素, owned by the service worker) ── */
  // Must be created before markTray: markTray's onChange calls updateSendState(), which reads
  // referencesTray — creating it later would leave that read in the temporal dead zone.
  const referencesTray = window.__sidepanelReferencesTray.create({
    els: {
      root: $('#ref-tray'),
      toggle: $('#ref-tray-toggle'),
      title: $('#ref-tray-title'),
      clear: $('#ref-tray-clear'),
      body: $('#ref-tray-body'),
    },
    send: (message) => runtimeMessage(message),
    onCountChange: () => updateSendState(),
  });

  /* ── Mark tray (page marks + screenshots of the followed tab) ── */
  const sentTracker = window.__domReview.marksCore.createSentTracker(); // marks carried by in-flight turn(s)
  let reconciling = false;
  const markTray = window.__sidepanelMarkTray.create({
    els: {
      root: $('#mark-tray'),
      toggle: $('#mark-tray-toggle'),
      title: $('#mark-tray-title'),
      clearSent: $('#mark-tray-clear-sent'),
      clearAll: $('#mark-tray-clear-all'),
      body: $('#mark-tray-body'),
    },
    sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    showNotice: () => Boolean(clientId),
    onChange: (state) => {
      reconcileSentMarks(state);
      updateSendState();
    },
  });

  function applyReferences(message) {
    if (!message || message.type !== window.__domReview.referencesCore.MSG.UPDATED) return;
    referencesTray.applyList(Array.isArray(message.references) ? message.references : []);
  }

  /** A reloaded page restores marks as unsent while their turn is still running: mark them sent again. */
  function reconcileSentMarks(state) {
    if (reconciling || !state || state.status !== 'ready') return;
    const stale = sentTracker.staleIds(state.marks);
    if (!stale.length) return;
    reconciling = true;
    markTray.controller.markSent(stale, false).finally(() => { reconciling = false; });
  }

  function tabIdFromClient(id) {
    const m = /^tab_(\d+)$/.exec(id || '');
    return m ? Number(m[1]) : null;
  }

  /** The focused browser tab (null when the only tab is an extension page). */
  async function activeBrowserTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || tab.id == null || /^chrome-extension:/.test(tab.url || '')) return null;
      return tab;
    } catch {
      return null;
    }
  }

  async function activeBrowserTabId() {
    const tab = await activeBrowserTab();
    return tab ? tab.id : null;
  }

  /**
   * The panel's own SSE client id: `panel_<tabId>` of the focused browser tab (or `panel_panel`
   * when there is none). Its own stream is only opened while no tab is taken over: with a takeover
   * the panel piggybacks on that tab's stream and filtering by `tabId === clientId`.
   */
  async function ensurePanelClientId() {
    const tab = await activeBrowserTab();
    const tabId = tab ? tab.id : null;
    panelWindowId = tab ? (tab.windowId ?? null) : null;
    const next = tabId == null ? 'panel_panel' : `panel_${tabId}`;
    // 接管后侧边栏跟随该 tab 的流，自己的流只是兜底：已开就保持不变，避免多余断开。
    if (next === panelClientId || (clientId && panelTabId != null)) return panelClientId;
    const previous = panelClientId;
    panelClientId = next;
    panelTabId = tabId;
    if (previous && previous !== next) {
      sseConnected = false;
      runtimeMessage({ type: 'DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT', clientId: previous }).catch(() => {});
    }
    // 没接管时才开自己的流；接管后跟随该 tab 的流（tabId 变化时由 refreshStatus 重新判断）。
    if (!clientId) connectPanelSse();
    return panelClientId;
  }

  /**
   * Open the panel's own Hub SSE stream through the background proxy (no page involved). The panel
   * has no `sender.tab`, so it supplies the synthetic key (`panel_<tabId>`); registering the id lets
   * the worker route runtime broadcasts to this stream.
   */
  function connectPanelSse() {
    if (!bridgeReachable || !panelClientId || panelSseConnecting) return;
    panelSseConnecting = true;
    // Register first so the worker knows this synthetic id, then open the proxy stream.
    runtimeMessage({ type: 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT', clientId: panelClientId }).catch(() => {});
    runtimeMessage({
      type: 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT_STREAM',
      clientId: panelClientId,
      tabId: panelTabId,
    })
      .catch(() => {})
      .finally(() => { panelSseConnecting = false; });
  }

  /** The tray follows the taken-over tab; without a takeover it shows the focused browser tab. */
  let followSerial = 0;
  async function followTray() {
    const serial = ++followSerial;
    const tabId = clientId ? tabIdFromClient(clientId) : await activeBrowserTabId();
    // A newer call (e.g. the takeover became known while this one waited for tabs.query) wins.
    if (serial !== followSerial) return;
    await markTray.follow(tabId);
  }

  /** Sent marks are settled: drop them (accepted) or make them sendable again (error; legacy path). */
  function settleSentMarks(outcome) {
    const { clear, unsend } = sentTracker.settle(outcome);
    if (clear) markTray.controller.clearSent();
    else if (unsend.length) markTray.controller.markUnsent(unsend);
  }

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

  let selectedInstanceId = '';

  function runtimeMessage(message) {
    return new Promise(resolve => chrome.runtime.sendMessage(message, response => resolve(
      response || { ok: false, error: chrome.runtime.lastError?.message || '扩展后台不可用' }
    )));
  }

  function renderInstanceSelect(health) {
    const model = window.__domReview.instanceHeader.instanceOptions(health, selectedInstanceId);
    instanceSelect.replaceChildren(...model.options.map(item => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      option.dataset.offline = String(item.offline);
      return option;
    }));
    instanceSelect.value = model.selected;
    instanceSelect.title = model.options.find(item => item.value === model.selected)?.label || '自动选择实例';
  }

  /** JSON call parsed with bridgeCore: { ok, status, reachable, data, code, message }. */
  async function call(path, options = {}) {
    const response = await bridgeRequest(path, {
      method: options.method || 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return core.parseProxyResponse(response);
  }

  /* ── Conversation (shared reducer) ────────────── */
  // The side panel is the long-lived view: no practical message cap.
  const messageStore = window.__domReview.createMessageStore({ maxMessages: 20000 });

  const conversation = window.__domReview.chatConversation.create({
    store: messageStore,
    getClientId: () => clientId,
    onChange: (kind) => {
      if (kind === 'reset') toolStatus.clear();
      if (kind === 'user' || kind === 'reset') scroll.scrollToBottom();
      else scroll.followLatestIfPinned();
    },
    onMeta: applyMeta,
    onDone: (ev) => {
      if (ev.reason === 'cancelled') showHint('任务已取消', 'info');
      toolStatus.clear();
      settleSentMarks('done');
      updateSendState();
    },
    onError: (_ev, info) => {
      if (info.kind === 'terminal' || info.kind === 'auth') showHint(info.text);
      settleSentMarks('error');
      updateSendState();
    },
    onToolStatus: (ev) => toolStatus.update(ev),
  });
  const meta = conversation.meta;

  const scroll = window.__domReview.chatScroll.create({
    getContainer: () => stream,
    getJumpButton: () => jumpBtn,
  });
  scroll.setup();
  jumpBtn.addEventListener('click', () => scroll.scrollToBottom({ smooth: true }));

  const messageStoreApi = {
    get(id) { return messageStore.find((m) => m.id === id); },
  };

  /* ── Status ───────────────────────────────────── */
  function setPip(state) {
    bridgePip.classList.remove('is-online', 'is-offline', 'is-checking');
    if (state === 'online') bridgePip.classList.add('is-online');
    else if (state === 'offline') bridgePip.classList.add('is-offline');
    else bridgePip.classList.add('is-checking');
  }

  function renderStatusBanner() {
    const model = core.statusModel({
      bridge: bridgeReachable ? 'connected' : 'disconnected',
      activeClient: Boolean(clientId),
      authRequired: meta.authRequired,
    });
    const quiet = model.key === 'ready';
    statusBanner.hidden = quiet;
    statusBanner.className = `status-banner status-banner--${model.tone}`;
    statusBanner.innerHTML = quiet ? '' : chatRender.inlineText(model.text);
    return model;
  }

  async function refreshStatus(options = {}) {
    const serial = ++healthSerial;
    if (!bridgeReachable) setPip('checking');
    const response = await bridgeRequest('/health');
    if (serial !== healthSerial) return;
    const body = parseBridgeJson(response);
    if (!response.ok || !body) {
      bridgeReachable = false;
      designDocs.setConnected(false);
      // Bridge 未连接时不可能有工具在跑：直接清掉（下次事件会重新填）。
      toolStatus.clear();
      setPip('offline');
      bridgeStatus.textContent = '未连接';
      runtimeLabel.textContent = '-';
      activeTab.textContent = '-';
      clientId = null;
      syncedSessionKey = null;
      syncSerial++;
      // Hub 不可用时先别急着开自己的流（会失败并重试）；下次轮询再连。
      await ensurePanelClientId();
      applyMeta(meta);
      updateSendState();
      followTray();
      return;
    }
    bridgeReachable = true;
    designDocs.setConnected(true);
    renderInstanceSelect(body);
    if (!sseConnected) setPip('online');
    bridgeStatus.textContent = sseConnected ? 'SSE 已连接' : '已连接';
    runtimeLabel.textContent = body.agentLabel || body.agentKey || '-';
    activeTab.textContent = body.activeClientId || '未接管';
    clientId = body.activeClientId || null;
    // 没接管时侧边栏用自己的 SSE 流收回复；接管后跟随该 tab 的流即可。
    await ensurePanelClientId();
    applyMeta(meta);
    updateSendState();
    followTray();

    const key = JSON.stringify([body.defaultInstanceId, clientId]);
    const activeSessionChanged = Boolean(body.activeSessionId && body.activeSessionId !== meta.sessionId);
    if (options.forceSessionSync || syncedSessionKey !== key || activeSessionChanged) {
      await syncActiveSession(key, options);
    }
  }

  async function syncActiveSession(key, options) {
    const targetClientId = clientId;
    const serial = ++syncSerial;
    const path = targetClientId ? `/sessions/active?clientId=${encodeURIComponent(targetClientId)}` : '/sessions/active';
    const res = await call(path);
    if (serial !== syncSerial || targetClientId !== clientId) return;
    if (!res.ok) {
      if (options.syncReason !== 'status') showHint(core.failureInfo(res).text);
      return;
    }
    syncedSessionKey = key;
    conversation.applyActive(res.data);
    updateSendState();
  }

  /* Toggle meta strip */
  statusDot.addEventListener('click', () => {
    metaStrip.classList.toggle('is-open');
    refreshStatus({ forceSessionSync: true, syncReason: 'manual' });
  });

  instanceSelect.addEventListener('change', async () => {
    selectedInstanceId = instanceSelect.value;
    const result = await runtimeMessage({ type: 'SET_INSTANCE_SELECTION', instanceId: selectedInstanceId });
    if (!result.ok) showHint(result.error || '保存实例选择失败');
    await refreshStatus({ forceSessionSync: true, syncReason: 'instance' });
  });

  takeoverBtn.addEventListener('click', async () => {
    takeoverBtn.disabled = true;
    const tabId = await activeBrowserTabId();
    const result = await runtimeMessage({ type: 'TAKEOVER_TAB', tabId });
    takeoverBtn.disabled = false;
    if (!result.ok) {
      showHint(result.error || '接管当前页失败。');
      return;
    }
    showHint('已接管当前页，可以开始标记。', 'info');
    await refreshStatus({ forceSessionSync: true, syncReason: 'takeover' });
  });

  function renderPromptCtx(metaNow) {
    if (!promptCtxEl) return;
    const model = lastPromptCtx && lastPromptCtx.sessionId === metaNow.sessionId
      ? core.promptContextModel(lastPromptCtx)
      : null;
    if (!model || model.empty) {
      promptCtxEl.hidden = true;
      return;
    }
    promptCtxEl.hidden = false;
    promptCtxEl.textContent = `带入 ${model.label}`;
    promptCtxEl.title = model.title;
  }

  /* ── Meta (session title, composer lock) ── */
  function applyMeta(m) {
    const metaNow = m || meta;
    sessionTitleEl.textContent = metaNow.sessionId ? (metaNow.title || '新会话') : '未选择会话';
    sessionTitleEl.title = metaNow.sessionId ? `${metaNow.title || '新会话'}\n${metaNow.sessionId}` : '';
    renderPromptCtx(metaNow);

    renderStatusBanner();
    updateSendState();
  }

  /* ── Helpers ──────────────────────────────────── */
  function updateWelcome() {
    welcome.classList.toggle('is-hidden', messageStore.size > 0);
  }

  function updateSendState() {
    const hasText = promptEl.value.trim().length > 0;
    const hasImages = (imageManager?.count?.() || 0) > 0;
    // 标记和参考元素都依附页面：只有已接管（clientId）时才随消息发送。
    const hasReferences = clientId && referencesTray.count() > 0;
    const hasPageContext = Boolean(clientId) && (markTray.hasContent() || hasReferences);
    // 纯聊天（文字 / 图片）不依赖接管：没接管也能发，不带页面上下文。
    const canSend = hasText || hasImages || hasPageContext;

    sendBtn.disabled = sendInProgress || !canSend;

    // 取消按钮不参与发送：只在「有可取消的东西」时出现（未决审批/提问卡，或工具正在运行）。
    const cancellable = (Boolean(clientId) || Boolean(panelClientId)) && hasCancellable();
    cancelBtn.hidden = !cancellable;
    cancelBtn.disabled = cancelInFlight;
    cancelBtn.textContent = cancelInFlight ? '取消中…' : '取消';
  }

  function hasCancellable() {
    if (toolStatus.getState().state === 'running') return true;
    return messageStore.filter((m) => (
      (m.type === 'approval' && !m.observing && !window.__domReview.bridgeCore.isApprovalFinal(m))
      || (m.type === 'question' && m.status === 'pending' && !m.observing)
    )).length > 0;
  }

  function escapeHtml(str) {
    return core.escapeHtml(str);
  }

  function showHint(message, tone) {
    const hint = $('#sidepanel-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.toggle('is-info', tone === 'info');
    hint.classList.add('show');
    clearTimeout(showHint.timer);
    showHint.timer = setTimeout(() => {
      hint.classList.remove('show');
    }, 4200);
  }

  /* ── Message rendering ────────────────────────── */
  /** Mark chips under a user message; a compacted DevTailor prompt folds them into a <details>. */
  function renderBubbleMarks(bubble) {
    const chips = bubble.marks.map((m) => {
      const label = escapeHtml(m.desc || m.selector || '');
      const tip = escapeHtml([m.selector, m.comment, m.file].filter(Boolean).join('\n'));
      return `<span class="tray-chip tray-chip--static" title="${tip}"><span class="tray-chip__n" style="background:${escapeHtml(m.color || '#3b82f6')}">${escapeHtml(m.index)}</span><span class="tray-chip__t">${label}</span></span>`;
    }).join('');
    if (!bubble.parsed) return `<div class="dt-bubble-marks" aria-label="随消息发送的标记">${chips}</div>`;
    return `<details class="dt-bubble-marks dt-bubble-marks--fold"><summary>含 ${bubble.marks.length} 个标记</summary><div class="dt-bubble-marks__list">${chips}</div></details>`;
  }

  function renderTextBubble(msg) {
    const images = normalizeImages(msg.images || msg.image);
    const imageHtml = images.length
      ? `<div class="dt-chat-attachments dt-chat-attachments--user">${images.map((src, idx) =>
        `<img class="dt-chat-attachment" src="${escapeHtml(src)}" alt="发送的图片 ${idx + 1}" data-preview-image="${escapeHtml(src)}">`
      ).join('')}</div>`
      : '';

    if (msg.role === 'user') {
      const bubble = marksCore.userBubbleModel(msg);
      const syntheticText = /^发送\s+\d+\s+(张图片|个标记)$/.test(String(bubble.text || '').trim());
      const showText = bubble.text && !((images.length || bubble.marks.length) && syntheticText);
      const text = showText
        ? `<div class="dt-chat-msg dt-chat-msg--user">${escapeHtml(bubble.text)}</div>`
        : '';
      const chips = bubble.marks.length ? renderBubbleMarks(bubble) : '';
      return `<div class="dt-chat-user-stack">${text}${chips}${imageHtml}</div>`;
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

  function renderLoadingDots() {
    return '<div class="dt-loading-dots" aria-label="加载中"><span></span><span></span><span></span></div>';
  }

  function renderMessageBlock(msg) {
    let html;
    switch (msg.type) {
      case 'loading': return renderLoadingDots();
      case 'approval': return chatRender.renderApprovalCard(msg);
      case 'notice': return chatRender.renderNotice(msg);
      case 'question': return renderQuestionCard(msg);
      default: html = renderTextBubble(msg);
    }
    return chatRender.markHistory(html, msg);
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

  /**
   * Keyed incremental render: only the rows whose HTML changed are replaced,
   * 按消息 key 增量替换，避免重绘时丢失审批卡片按钮状态、文字选区和滚动位置。
   */
  const rows = new Map(); // message id -> { html, node }
  const rowTemplate = document.createElement('template');

  function renderMessages() {
    const msgs = messageStore.getAll();
    const liveIds = new Set(msgs.map((message) => message.id));
    for (const id of markdownRenderCache.keys()) {
      if (!liveIds.has(id)) markdownRenderCache.delete(id);
    }
    for (const [id, row] of rows) {
      if (!liveIds.has(id)) {
        row.node.remove();
        rows.delete(id);
      }
    }

    let previous = null;
    for (const msg of msgs) {
      const html = renderMessageBlock(msg).trim();
      let row = rows.get(msg.id);
      if (!row || row.html !== html) {
        rowTemplate.innerHTML = html;
        const node = rowTemplate.content.firstElementChild;
        if (!node) continue;
        node.dataset.row = msg.id;
        if (row && row.node.isConnected) row.node.replaceWith(node);
        row = { html, node };
        rows.set(msg.id, row);
      }
      const expected = previous ? previous.nextElementSibling : messagesEl.firstElementChild;
      if (row.node !== expected) messagesEl.insertBefore(row.node, expected);
      previous = row.node;
    }
    updateWelcome();
  }

  messageStore.subscribe(renderMessages);

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

  /* ── SSE event projection ─────────────────────── */
  function handleSseMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Follow the taken-over tab while a takeover exists, otherwise the panel's own stream. Per-client
    // events carry the receiver's tabId, so keep only the ones addressed to that client id.
    const ownClient = clientId || panelClientId;
    if (msg.tabId && ownClient && msg.tabId !== ownClient) return;
    if (msg.tabId && !ownClient && msg.type !== 'active_client') return;
    // 卡片事件可能不带 tabId：明确发给别的 client 的（approval_pending / question_pending）跳过。
    if (!msg.tabId && msg.targetClientId && ownClient && msg.targetClientId !== ownClient) return;

    if (msg.type === 'session_reset') {
      syncSerial++;
      syncedSessionKey = null;
      toolStatus.clear();
    }
    try {
      if (conversation.handle(msg)) return;
      projectSseMessage(msg);
    } finally {
      updateSendState(); // cancel button follows pending approvals / questions / running tools
    }
  }

  function projectSseMessage(msg) {
    switch (msg.type) {
      case 'question_request': {
        conversation.endStream();
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

      case 'tool_status':
        // 正常情况下 tool_status 已被 conversation.handle 消费（旧的 canceled → endStream，
        // 新形态带 toolName → onToolStatus 回调）。这里是兜底：万一事件没被归约器吃掉，
        // 极简状态条也能自己判断（不带 toolName 的旧形态 normalize() 返回 null，什么都不会变）。
        toolStatus.update(msg);
        break;

      case 'active_client':
        refreshStatus({ forceSessionSync: true, syncReason: 'active_client' });
        break;

      default:
        // Unknown event types are ignored.
        break;
    }
  }

  /** True when the SSE event belongs to this panel's own stream (no taken-over tab). */
  /**
   * True when the event belongs to this panel's own stream. The worker broadcasts one copy per known
   * panel id, so a copy tagged with our id can still originate from another stream (the page tab's);
   * `clientId` carries the stream that produced it, and only our own id counts.
   */
  function isPanelEvent(message) {
    return Boolean(
      panelClientId
      && message.panelClientId === panelClientId
      && message.clientId === panelClientId,
    );
  }

  /* ── SSE listener ─────────────────────────────── */
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'DT_MARKS_UPDATED') {
      markTray.model.applyUpdate(message);
      return;
    }
    if (message && message.type === window.__domReview.referencesCore.MSG.UPDATED) {
      applyReferences(message);
      return;
    }
    if (message && message.type === 'DT_SIDEPANEL_FOCUS_INPUT') {
      focusComposer();
      return;
    }
    // Second toolbar click while the panel is open: no sidePanel.close(), so the worker asks us.
    // Window-scoped: only close when the request targets our window (or is broadcast without one).
    if (message && message.type === 'DT_SIDEPANEL_CLOSE_REQUEST') {
      const sameWindow = message.windowId == null || message.windowId === panelWindowId;
      // notBefore is the click timestamp for this close request. If stale state made that click's
      // open() create this panel, panelLoadedAt >= notBefore and it must stay open.
      const preExisting = message.notBefore == null || panelLoadedAt < message.notBefore;
      if (sameWindow && preExisting) window.close();
      return;
    }
    if (!message || message.type !== 'DEVTAILOR_SIDEPANEL_PROXY_EVENT') return;

    // One lifecycle event per open stream reaches us (the worker tags each copy). With a takeover we
    // follow that tab's stream; without one we follow our own `panel_<tabId>` stream.
    const followsPanelStream = !clientId && isPanelEvent(message);
    const isTabStream = Boolean(clientId && message.clientId === clientId);
    if (!followsPanelStream && !isTabStream) return;

    if (message.event === 'open') {
      sseConnected = true;
      setPip('online');
      bridgeStatus.textContent = 'SSE 已连接';
      disconnectedAt = 0;
      // Restore persisted messages missed while the event proxy was disconnected.
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
      if (!disconnectedAt) disconnectedAt = Date.now();
      // 事件通道断了就没有可信的工具状态：先清掉（下一条 tool_status 会重新填）。
      toolStatus.clear();
      setPip('offline');
      bridgeStatus.textContent = '连接断开';
      // 面板自己的流断了就重连（下一次 refreshStatus 也会带起）。
      if (followsPanelStream) setTimeout(connectPanelSse, 1000);
      return;
    }
  });

  /* ── Send flow ─────────────────────────────────── */
  async function executeSend(text, images) {
    // 发送只依赖 Hub 连接：没接管时发纯聊天（文字 / 图片，不带页面上下文），接管后照旧带页面数据。
    if (!bridgeReachable) {
      showHint(core.errorInfo('bridge_offline').text);
      return { ok: false };
    }

    const sendClientId = clientId || panelClientId || (await ensurePanelClientId());
    if (!sendClientId) {
      showHint(core.errorInfo('bridge_offline').text);
      return { ok: false };
    }

    // The page owns the marks and its screenshots: ask the followed tab for the payload parts.
    // Without a takeover there is no page context to collect (marks/references belong to a page).
    const parts = clientId ? await markTray.controller.buildPayload() : null;
    const pageImages = parts ? parts.screenshots : [];
    const allImages = [...pageImages, ...images];
    const markIds = parts ? parts.markIds : [];
    const sentMarks = markTray.model.getState().marks.filter((m) => markIds.includes(m.id));

    // 参考元素 come from the global list, never from the page's marks/screenshots. They describe a
    // page, so they are only sent together with a takeover (clientId present).
    const referencesCore = window.__domReview.referencesCore;
    const referenceList = clientId
      ? await runtimeMessage({ type: referencesCore.MSG.GET })
      : { ok: true, references: [] };
    const sentReferences = referencesCore.toSendReferences(referenceList && referenceList.ok ? referenceList.references : []);
    const sentReferenceIds = sentReferences.map((ref) => ref.id);

    const payload = {
      type: 'review',
      payload: {
        pageUrl: parts ? parts.pageUrl : '',
        userIntent: text,
        items: parts ? parts.items : [],
        screenshots: allImages,
        screenshot: allImages[0] || null,
        references: sentReferences,
      },
      clientId: sendClientId,
      tabId: sendClientId,
    };

    // Mark optimistically BEFORE the request so the marks are never picked up by a concurrent BUILD.
    // 2xx from POST /review = the message is accepted: marks are cleared right away (no `done` wait).
    // Failure (non-2xx / network): roll back and make them sendable again. Screenshots are consumed on success.
    if (markIds.length) {
      sentTracker.begin(markIds);
      await markTray.controller.markSent(markIds, false);
    }
    const res = await call('/review', { method: 'POST', body: payload });
    if (!res.ok) {
      if (markIds.length) {
        sentTracker.rollback(markIds);
        await markTray.controller.markUnsent(markIds);
      }
      showHint(core.failureInfo(res).text);
      return { ok: false, error: res.message };
    }
    // 记下这条提示带了什么，显示在顶部「上下文」左侧
    lastPromptCtx = {
      sessionId: meta.sessionId,
      marks: markIds.length,
      references: sentReferenceIds.length,
      images: allImages.length,
      designDocs: (designDocs.getState().docs || []).filter((d) => d.enabled).length,
    };
    renderPromptCtx(meta);
    // 参考元素：只有 Hub 明确回 referencesAccepted == 发送条数 才算接收。
    const resolved = referencesCore.resolveSentReferences(res, sentReferenceIds);
    if (sentReferenceIds.length) {
      if (!resolved.keep) {
        await runtimeMessage({ type: referencesCore.MSG.ACCEPTED, ids: sentReferenceIds });
      } else if (resolved.reason === 'unsupported') {
        showHint('当前 Hub 版本不支持参考元素，参考未被接收', 'info');
      } else if (resolved.reason === 'count_mismatch') {
        showHint(`Hub 只接收了 ${resolved.count} 个参考元素，剩余保留待发`);
      }
    }
    // Accepted: screenshots are consumed and the sent marks are cleared now (the user bubble keeps a copy).
    if (pageImages.length && clientId) await markTray.controller.markSent([], true);
    settleSentMarks('done');
    return {
      ok: true,
      markCount: markIds.length,
      referenceCount: sentReferenceIds.length,
      acceptedReferences: Boolean(sentReferenceIds.length && !resolved.keep),
      imageCount: allImages.length,
      marks: sentMarks,
      images: allImages,
    };
  }

  async function handleSend() {
    if (sendInProgress) return;

    const text = promptEl.value.trim();
    const pendingImages = imageManager?.getImages?.() || [];
    // 没接管时只有文字 / 图片可发（标记和参考依附页面，不算可发送内容）。
    const hasPageContext = Boolean(clientId) && (markTray.hasContent() || referencesTray.count() > 0);
    if (!text && pendingImages.length === 0 && !hasPageContext) return;

    if (!bridgeReachable) {
      showHint(core.errorInfo('bridge_offline').text);
      return;
    }

    sendInProgress = true;
    const sendStartedAt = Date.now();
    updateSendState();

    try {
      const result = await executeSend(text, pendingImages);
      if (result.ok) {
        const optimisticContent = text
          || (result.markCount
            ? `发送 ${result.markCount} 个标记${result.referenceCount ? ` · 参考 ${result.referenceCount}` : ''}`
            : (result.referenceCount
              ? `发送参考 ${result.referenceCount}`
              : `发送 ${result.imageCount} 张图片`));
        // The bridge echoes the user message to every UI (display_message); it may beat this response.
        const echoed = messageStore.findLast(item =>
          item.role === 'user' &&
          !item.optimistic &&
          item.content === optimisticContent &&
          Number(item.timestamp || 0) >= sendStartedAt
        );
        if (echoed) {
          // The bridge echo carries text and images only: keep the marks on the bubble.
          if (result.marks && result.marks.length) messageStore.update(echoed.id, (m) => { m.marks = result.marks; });
        } else {
          conversation.addUserMessage({ content: optimisticContent, images: result.images.slice(), marks: result.marks });
        }
        imageManager?.clear?.();
        promptEl.value = '';
        promptEl.style.height = 'auto';
      }
    } finally {
      sendInProgress = false;
      updateSendState();
      if (!promptEl.disabled) promptEl.focus();
    }
  }

  /** 取消当前任务（不阻塞发送）。nothing_to_cancel 不是错误：只给个轻提示。 */
  async function handleStop() {
    if (cancelInFlight) return;
    // /cancel 只作用于某个客户端：没接管时用侧边栏自己的 clientId。
    const targetClientId = clientId || panelClientId || (await ensurePanelClientId());
    if (!targetClientId) return;

    cancelInFlight = true;
    updateSendState();
    try {
      const res = await call('/cancel', { method: 'POST', body: { clientId: targetClientId, tabId: targetClientId } });
      if (!res.ok) {
        showHint(core.failureInfo(res).text);
        return;
      }
      conversation.endStream();
      toolStatus.clear();
      if (res.data && res.data.canceled === false) {
        showHint('当前没有正在执行的任务', 'info');
      } else {
        showHint('已取消', 'info');
      }
    } finally {
      cancelInFlight = false;
      updateSendState();
    }
  }

  cancelBtn.addEventListener('click', handleStop);

  /* ── Design spec (DESIGN.md) ──────────────────── */
  const designDocs = window.__sidepanelDesignDocs.create({
    els: {
      toggle: $('#design-docs-toggle'),
      summary: $('#design-docs-summary'),
      body: $('#design-docs-body'),
      list: $('#design-docs-list'),
      error: $('#design-docs-error'),
      uploadBtn: $('#design-docs-upload'),
      fileInput: $('#design-docs-file'),
    },
    call,
  });

  /* ── New session (POST /new-session) ──────────── */
  async function startNewSession() {
    // 新会话只影响展示层，不依赖接管：没接管时用侧边栏自己的 clientId。
    if (!bridgeReachable) {
      showHint(core.errorInfo('bridge_offline').text);
      return;
    }
    const targetClientId = clientId || (await ensurePanelClientId());
    newSessionBtn.disabled = true;
    const res = await call('/new-session', { method: 'POST', body: { clientId: targetClientId, tabId: targetClientId } });
    newSessionBtn.disabled = false;
    if (!res.ok) {
      showHint(core.failureInfo(res).text);
      return;
    }
    showHint(res.data && res.data.reused ? '当前已是新会话' : '已开启新会话', 'info');
    refreshStatus({ forceSessionSync: true, syncReason: 'new_session' });
  }

  newSessionBtn.addEventListener('click', startNewSession);

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

    const approvalBtn = e.target.closest('[data-action="approval-decision"]');
    if (approvalBtn) {
      conversation.submitApproval(approvalBtn.dataset.msgId, approvalBtn.dataset.decision, (path, body) => call(path, { method: 'POST', body })).then((result) => {
        if (result && result.ok === false && result.error) showHint(result.error);
      });
      return;
    }

    const questionSubmit = e.target.closest('[data-action="question-submit"]');
    if (questionSubmit) {
      const msg = messageStoreApi.get(questionSubmit.dataset.msgId);
      if (msg && msg.status === 'pending' && !msg.observing) submitQuestionAnswer(msg);
    }

    const questionSkip = e.target.closest('[data-action="question-skip"]');
    if (questionSkip) {
      const msg = messageStoreApi.get(questionSkip.dataset.msgId);
      if (msg && msg.status === 'pending' && !msg.observing) submitQuestionAnswer(msg, true);
    }
  });

  // Selection state is mutated in place (no re-render) so text-input focus
  // survives concurrent SSE-driven re-renders of the message list.
  messagesEl.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-action="question-select"]');
    if (!sel) return;
    const msg = messageStoreApi.get(sel.dataset.msgId);
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
    const msg = messageStoreApi.get(other.dataset.msgId);
    if (!msg || msg.status !== 'pending' || msg.observing) return;
    const qIdx = Number(other.dataset.qIdx);
    if (!Array.isArray(msg.otherText)) msg.otherText = [];
    msg.otherText[qIdx] = other.value;
  });

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
    const res = await call('/question-answer', { method: 'POST', body: { questionId: msg.questionId, answers } });
    if (res.ok) {
      messageStore.update(msg.id, { status: skip ? 'dismissed' : 'answered' });
    } else {
      // Another UI answered first, or the request expired.
      messageStore.update(msg.id, { status: 'pending' });
      showHint(res.status === 409 ? '该提问已被回答' : '提交回答失败');
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

  /* ── Tray follows the browser tabs ─────────────── */
  function focusComposer() {
    if (!promptEl.disabled) promptEl.focus();
  }

  chrome.tabs.onActivated.addListener(() => {
    if (!clientId) {
      // The panel's own stream follows the focused tab; reconnect under the new id.
      ensurePanelClientId();
      followTray();
    }
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return;
    if (tabId === markTray.model.getState().tabId) markTray.controller.refresh();
    else if (!clientId) followTray();
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === markTray.model.getState().tabId) markTray.follow(null);
  });

  // Hub / worker restart dropped the panel's own stream: open a fresh one once it is reachable.
  window.addEventListener('focus', () => {
    if (bridgeReachable && !sseConnected && !clientId) connectPanelSse();
  });

  // The side panel opens itself (toolbar button / shortcut) and may be asked to focus the composer
  // or to close itself (a second click on the toolbar button; Chrome has no sidePanel.close()).

  /* ── Init ──────────────────────────────────────── */
  applyMeta(meta);
  updateSendState();
  referencesTray.refresh();
  // 面板的 clientId / SSE 流不依赖接管：先确定自己的身份（含 windowId），再声明就绪，
  // 这样 READY 的关闭兜底能按窗口匹配。
  ensurePanelClientId().finally(() => {
    try {
      chrome.runtime.sendMessage({
        type: 'DT_SIDEPANEL_READY',
        tabId: panelTabId, windowId: panelWindowId, loadedAt: panelLoadedAt, panelToken,
      }, (res) => {
        void chrome.runtime.lastError;
        if (res && res.focusInput) focusComposer();
        if (res && res.closePanel) window.close();
      });
    } catch { /* service worker not reachable */ }
    runtimeMessage({ type: 'GET_INSTANCE_SELECTION' }).then(result => {
      selectedInstanceId = result.instanceId || '';
      refreshStatus({ forceSessionSync: true, syncReason: 'initial' });
    });
  });
  pollTimer = setInterval(refreshStatus, 30000);
  // The worker forgets an open panel on restart: clear its own entry and our stream when the panel
  // closes (chrome.sidePanel has no close API, so this fires for every close path).
  window.addEventListener('beforeunload', () => {
    if (pollTimer) clearInterval(pollTimer);
    runtimeMessage({ type: 'DT_SIDEPANEL_CLOSED', tabId: panelTabId, windowId: panelWindowId, panelToken }).catch(() => {});
    if (panelClientId) {
      runtimeMessage({ type: 'DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT', clientId: panelClientId }).catch(() => {});
    }
  });
})();
