/**
 * DevTailor — conversation reducer
 *
 * Turns bridge SSE events into display messages in a message store plus a small `meta`
 * record (session id/title, auth state). The side panel is the only chat surface.
 *
 * Chat-style model: sending is fire-and-forget; there is no "processing" lock, no queue, and no
 * required `done` event. Each assistant reply is its own bubble (keyed by displayMessage.id); the
 * live stream is closed by the next user message, a new reply id, a tool/approval card, an error
 * or a canceled tool_status. A legacy `done` event is still accepted as a close signal.
 *
 * `store` is any object shaped like content/modules/message-store.js:
 *   append / update(id, patch|fn) / find / findIndex / findLast / filter / remove /
 *   replaceAll / size (number) / getAll
 *
 * Browser: window.__domReview.chatConversation. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const core = (typeof module === 'object' && module.exports)
    ? require('./bridge-core.js')
    : window.__domReview.bridgeCore;

  const DONE_NOTICES = {
    max_tokens: '回复因达到长度上限而停止',
    max_turn_requests: '已达到单轮最大请求数，回复被中止',
    refusal: 'Claude 拒绝了这个请求',
  };

  function initialMeta() {
    return {
      sessionId: null,
      title: null,
      cwd: null,
      origin: null,
      isTemporary: false,
      authRequired: false,
    };
  }

  function create(options = {}) {
    const {
      store,
      now = Date.now,
      getClientId = () => null,
      onChange = () => {},
      onMeta = () => {},
      onDone = () => {},
      onError = () => {},
      onToolStatus = () => {},
    } = options;
    if (!store) throw new Error('chatConversation.create: store is required');

    const meta = initialMeta();
    let activeStreamId = null;
    let counter = 0;
    let metaDirty = false;

    const uid = (suffix) => `msg_${now()}_${++counter}_${suffix}`;
    const storeSize = () => (typeof store.size === 'number' ? store.size : store.getAll().length);
    const touchMeta = () => { metaDirty = true; };
    function emitMeta() {
      metaDirty = false;
      try { onMeta(meta); } catch (err) { /* UI callback errors must not break event handling */ }
    }

    function isCurrentSessionEvent(ev) {
      return !ev.sessionId || !meta.sessionId || ev.sessionId === meta.sessionId;
    }

    // ---------------------------------------------------------------- loading / stream

    // Legacy no-op kept for callers: the loading placeholder no longer exists.
    function removeLoading() { return false; }

    /** Close the live stream bubble (it stays in the transcript; it just stops being "streaming"). */
    function endStream() {
      activeStreamId = null;
      removeLoading();
    }

    function ensureStreamAtTail() {
      if (!activeStreamId) return startStream();
      const idx = store.findIndex((m) => m.id === activeStreamId);
      if (idx === -1) {
        activeStreamId = null;
        return startStream();
      }
      if (idx < storeSize() - 1) {
        endStream();
        return startStream();
      }
      return false;
    }

    function startStream() {
      removeLoading();
      const id = uid('stream');
      activeStreamId = id;
      store.append({ id, role: 'assistant', type: 'stream', content: '', timestamp: now() });
      return true;
    }

    function appendStream(delta) {
      if (!delta) return;
      removeLoading();
      ensureStreamAtTail();
      store.update(activeStreamId, (m) => { m.content += delta; });
      onChange('stream');
    }

    function addNotice(content, tone = 'muted', extra = {}) {
      store.append({ id: uid('notice'), role: 'assistant', type: 'notice', content, tone, timestamp: now(), ...extra });
      onChange('append');
    }

    // ---------------------------------------------------------------- approvals

    function updateApproval(id, action) {
      const card = store.find((m) => m.id === id);
      if (!card) return null;
      const next = core.reduceApproval(card, action, now());
      if (next !== card) store.update(id, (m) => { Object.assign(m, next); });
      return next;
    }

    function cancelSessionApprovals(sessionId) {
      store.filter((m) => m.type === 'approval' && !core.isApprovalFinal(m))
        .forEach((m) => updateApproval(m.id, { type: 'session_cancelled', sessionId }));
    }

    function handleApprovalRequest(ev) {
      if (!ev.approvalId) return;
      endStream();
      const id = core.approvalMessageId(ev.approvalId);
      if (store.find((m) => m.id === id)) updateApproval(id, { type: 'request', ev });
      else store.append(core.createApproval(ev, { observing: false, now: now() }));
      onChange('approval');
    }

    function handleApprovalPending(ev) {
      if (!ev.approvalId) return;
      const id = core.approvalMessageId(ev.approvalId);
      if (store.find((m) => m.id === id)) return;
      const me = getClientId();
      if (me && ev.targetClientId && ev.targetClientId === me) return; // our own request is on its way
      store.append(core.createApproval({ approvalId: ev.approvalId, toolName: ev.toolName }, { observing: true, now: now() }));
      onChange('approval');
    }

    function handleApprovalResolved(ev) {
      if (!ev.approvalId) return;
      updateApproval(core.approvalMessageId(ev.approvalId), { type: 'resolved', ev });
      onChange('approval');
    }

    /** post(path, body) -> parsed response (core.parseProxyResponse). */
    async function submitApproval(msgId, decision, post) {
      const card = store.find((m) => m.id === msgId);
      if (!card || !core.isApprovalInteractive(card)) return { ok: false, ignored: true };
      updateApproval(msgId, { type: 'submit', decision });
      const submitting = store.find((m) => m.id === msgId);
      if (!submitting || submitting.status !== 'submitting') return { ok: false, ignored: true };
      const body = { approvalId: card.approvalId, decision };
      let parsed;
      try {
        parsed = await post('/approval-decision', body);
      } catch (err) {
        parsed = { ok: false, status: 0, code: 'bridge_offline', message: String(err && err.message || err) };
      }
      const failure = parsed.ok ? null : core.failureInfo(parsed);
      updateApproval(msgId, { type: 'submit_result', ok: parsed.ok, status: parsed.status, error: failure ? failure.text : '' });
      onChange('approval');
      return { ok: parsed.ok, status: parsed.status, error: failure ? failure.text : '' };
    }

    // ---------------------------------------------------------------- user messages

    function matchesOptimistic(optimistic, incoming) {
      if (optimistic.content === incoming.content) return true;
      const synthetic = /^发送\s+\d+\s+(张图片|个标记)$/;
      return synthetic.test(String(optimistic.content || '')) && synthetic.test(String(incoming.content || ''));
    }

    function addUserMessage({ content, images = [], image = null, marks = [] }) {
      endStream(); // a new user message closes the previous reply bubble
      const msg = {
        id: uid('user'),
        role: 'user',
        type: 'text',
        content,
        images,
        image: image || images[0] || null,
        marks,
        optimistic: true,
        timestamp: now(),
      };
      store.append(msg);
      onChange('user');
      return msg;
    }

    function handleDisplayMessage(ev) {
      const incoming = ev.displayMessage;
      if (!incoming || incoming.role !== 'user' || !incoming.id) return;
      if (!isCurrentSessionEvent(ev)) return;
      endStream();
      if (!store.find((m) => m.id === incoming.id)) {
        const optimistic = store.findLast((m) => m.role === 'user' && m.optimistic && matchesOptimistic(m, incoming));
        if (optimistic) store.update(optimistic.id, (m) => { Object.assign(m, incoming, { optimistic: false }); });
        else store.append({ ...incoming, optimistic: false });
      }
      onChange('user');
    }

    // ---------------------------------------------------------------- session state

    function setSessionFields(src) {
      if (!src) return;
      if (src.sessionId || src.id) meta.sessionId = src.sessionId || src.id;
      if (Object.prototype.hasOwnProperty.call(src, 'title') || Object.prototype.hasOwnProperty.call(src, 'sessionTitle')) {
        meta.title = (src.title !== undefined ? src.title : src.sessionTitle) || null;
      }
      if (src.cwd) meta.cwd = src.cwd;
      if (src.origin) meta.origin = src.origin;
      touchMeta();
    }

    function applyHistory(messages, sameSession) {
      const live = sameSession ? store.getAll() : [];
      const byId = new Map(live.map((msg) => [msg.id, msg]));
      const pending = live.filter((msg) => msg.role === 'user' && msg.optimistic);
      const restored = [];
      for (const msg of messages) {
        if (!msg?.id) continue;
        let existing = byId.get(msg.id);
        if (!existing && msg.role === 'user') {
          existing = pending.find((m) => byId.has(m.id) && msg.timestamp >= m.timestamp - 1000 && matchesOptimistic(m, msg));
        }
        byId.delete(existing?.id || msg.id);
        // The SSE update may arrive before an older HTTP snapshot.
        if (existing?.type === 'stream' && existing.content.length >= msg.content.length) {
          restored.push(existing);
        } else {
          restored.push({ ...existing, ...msg, optimistic: false, history: existing ? existing.history : true });
        }
      }
      store.replaceAll([...restored, ...byId.values()]);
    }

    /** Restore the Bridge's current display session, including its persisted messages. */
    function applyActive(body) {
      if (!body) return;
      const sessionId = body.activeSessionId || body.session?.sessionId || body.session?.id || null;
      const sameSession = !meta.sessionId || meta.sessionId === sessionId;
      if (!sameSession) resetTranscriptState();
      if (Array.isArray(body.messages)) applyHistory(body.messages, sameSession);
      if (body.session) {
        setSessionFields({ ...body.session, sessionId: body.session.sessionId || body.activeSessionId });
      } else if (!body.activeSessionId) {
        meta.sessionId = null;
        meta.title = null;
      }
      touchMeta();
      emitMeta();
      if (Array.isArray(body.messages)) onChange('history');
    }

    function resetTranscriptState() {
      activeStreamId = null;
      store.replaceAll([]);
    }

    function reset() {
      resetTranscriptState();
      touchMeta();
      emitMeta();
      onChange('reset');
    }

    // ---------------------------------------------------------------- main dispatcher

    function handleCore(ev) {
      switch (ev.type) {
        case 'stream':
          if (!isCurrentSessionEvent(ev)) return true;
          if (ev.displayMessage?.id && ev.displayMessage.role !== 'user') {
            // Every reply is its own bubble keyed by displayMessage.id. A new id closes the previous
            // stream; the same id (cumulative snapshots) only ever grows the existing bubble.
            const incoming = { ...ev.displayMessage, type: ev.displayMessage.type || 'stream' };
            removeLoading();
            if (activeStreamId && activeStreamId !== incoming.id) endStream();
            const text = typeof incoming.content === 'string' ? incoming.content : '';
            incoming.content = text;
            const existing = store.find((m) => m.id === incoming.id);
            if (!existing) store.append(incoming);
            else if (text.length > String(existing.content || '').length) store.update(incoming.id, incoming);
            if (incoming.type === 'stream') activeStreamId = incoming.id;
            onChange('stream');
          } else {
            appendStream(ev.delta || '');
          }
          return true;
        case 'tool_status':
          if (!isCurrentSessionEvent(ev)) return true;
          if (ev.toolStatus === 'canceled' || ev.toolName) endStream(); // a tool call card closes the reply bubble
          onChange('tool');
          // 新形态（带 toolName 的 running/success/error/timeout）额外交给侧边栏的极简状态条；
          // 旧形态（canceled，无 toolName）保持原行为：只 endStream()、不往状态条上抛。
          if (ev.toolName) {
            try { onToolStatus(ev); } catch (err) { /* UI callback errors must not break event handling */ }
          }
          return true;

        case 'done': {
          if (!isCurrentSessionEvent(ev)) return true;
          endStream();
          if (ev.reason === 'cancelled') {
            cancelSessionApprovals(ev.sessionId || meta.sessionId);
            addNotice('已取消', 'muted', { kind: 'cancelled' });
          } else {
            if (DONE_NOTICES[ev.reason]) addNotice(DONE_NOTICES[ev.reason], 'warn');
          }
          meta.authRequired = false;
          touchMeta();
          onChange('done');
          onDone(ev);
          return true;
        }

        case 'error': {
          if (ev.sessionId && !isCurrentSessionEvent(ev)) return true;
          endStream();
          const info = core.errorEventInfo(ev);
          if (ev.code === 'auth_required') meta.authRequired = true;
          addNotice(info.text, 'error', { code: info.code });
          touchMeta();
          onChange('error');
          onError(ev, info);
          return true;
        }

        case 'display_message':
          handleDisplayMessage(ev);
          return true;

        case 'approval_request':
          handleApprovalRequest(ev);
          return true;
        case 'approval_pending':
          handleApprovalPending(ev);
          return true;
        case 'approval_resolved':
          handleApprovalResolved(ev);
          return true;

        case 'session_info':
          if (ev.sessionId && meta.sessionId && ev.sessionId !== meta.sessionId) return true;
          if (ev.sessionId) meta.sessionId = ev.sessionId;
          if (Object.prototype.hasOwnProperty.call(ev, 'sessionTitle')) meta.title = ev.sessionTitle || null;
          touchMeta();
          return true;
        case 'session_reset':
          resetTranscriptState();
          meta.sessionId = ev.sessionId || null;
          meta.title = null;
          meta.authRequired = false;
          if (ev.reason && ev.reason !== 'user_requested') addNotice('会话已重建，可以继续发送消息。', 'info');
          touchMeta();
          onChange('reset');
          return true;
        case 'queue_status': // legacy: the server no longer queues; ignore
          return true;
        case 'connected':
          if (ev.activeSessionId && !meta.sessionId) meta.sessionId = ev.activeSessionId;
          if (ev.activeSessionTitle && ev.activeSessionId === meta.sessionId && !meta.title) meta.title = ev.activeSessionTitle;
          touchMeta();
          return true;
        default:
          return false;
      }
    }

    /** Returns true when the event belongs to the conversation (even if it was ignored). */
    function handle(ev) {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return false;
      const handled = handleCore(ev);
      if (metaDirty) emitMeta();
      return handled;
    }

    return {
      meta,
      handle,
      removeLoading,
      endStream,
      addNotice,
      addUserMessage,
      submitApproval,
      applyActive,
      reset,
      isStreamingMessage: (msg) => Boolean(msg && msg.id && msg.id === activeStreamId),
      emitMeta,
    };
  }

  const api = { create, initialMeta };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.chatConversation = api;
  }
})();
