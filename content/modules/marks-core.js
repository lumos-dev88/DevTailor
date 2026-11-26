/**
 * DevTailor — Marks core (pure logic, no DOM)
 *
 * Everything about page marks that does not touch the DOM:
 *   - how a mark is described (`tag#id.class`);
 *   - the minimal mark/screenshot snapshot the content script broadcasts to the side panel
 *     (`DT_MARKS_CHANGED` -> service worker -> `DT_MARKS_UPDATED`), see docs/ARCHITECTURE.md;
 *   - the command handler the content script runs for the side panel (`DT_*` messages);
 *   - the side panel's "mark tray" model, which only ever mirrors snapshots coming from the page
 *     (the content-script store is the single source of truth).
 *
 * Browser: window.__domReview.marksCore. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const MARK_COLORS = [
    '#3b82f6', '#ef4444', '#f59e0b', '#22c55e', '#a855f7',
    '#06b6d4', '#f97316', '#ec4899', '#84cc16',
  ];

  /** Size caps for the broadcast snapshot (no screenshot pixels ever travel in it). */
  const LIMITS = {
    MAX_MARKS: 200,
    MAX_SCREENSHOTS: 8,
    SELECTOR: 300,
    DESC: 120,
    TEXT: 120,
    COMMENT: 500,
    COMPONENT: 80,
    FILE: 200,
  };

  const MSG = {
    CHANGED: 'DT_MARKS_CHANGED', // content script -> service worker
    UPDATED: 'DT_MARKS_UPDATED', // service worker -> extension pages (adds tabId)
    GET: 'DT_GET_MARKS',
    REMOVE: 'DT_REMOVE_MARK',
    UPDATE: 'DT_UPDATE_MARK',
    CLEAR: 'DT_CLEAR_MARKS',
    LOCATE: 'DT_LOCATE_MARK',
    REMOVE_SHOT: 'DT_REMOVE_SCREENSHOT',
    THUMBS: 'DT_GET_SCREENSHOT_THUMBS',
    BUILD: 'DT_BUILD_PAYLOAD',
    SENT: 'DT_MARKS_SENT',
    UNSENT: 'DT_MARKS_UNSENT',
    CLEAR_SENT: 'DT_MARKS_CLEAR_SENT',
  };

  // ------------------------------------------------------------ helpers

  function colorFor(index) {
    const n = Number(index);
    const i = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    return MARK_COLORS[(i - 1) % MARK_COLORS.length];
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function truncate(value, max) {
    const text = String(value == null ? '' : value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    ));
  }

  // ----------------------------------------------------------- describing

  /** Parse the opening tag of an outerHTML string: { tag, id, classes }. */
  function parseOpenTag(html) {
    const m = /^\s*<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(str(html));
    if (!m) return null;
    const attrs = m[2] || '';
    const id = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const classText = cls ? (cls[1] != null ? cls[1] : cls[2]) : '';
    return {
      tag: m[1].toLowerCase(),
      id: id ? (id[1] != null ? id[1] : id[2]) : '',
      classes: classText.split(/\s+/).filter(Boolean),
    };
  }

  /** Last compound of a CSS selector: `main > ul li.item#x:nth-child(2)` -> { tag:'li', id:'x', classes:['item'] }. */
  function parseSelectorTail(selector) {
    const parts = str(selector).split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    const tail = (parts[parts.length - 1] || '').replace(/\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, '');
    const tag = /^[a-zA-Z][\w-]*/.exec(tail);
    const id = /#([\w-]+)/.exec(tail);
    const classes = [];
    const re = /\.([\w-]+)/g;
    let m;
    while ((m = re.exec(tail))) classes.push(m[1]);
    return { tag: tag ? tag[0].toLowerCase() : '', id: id ? id[1] : '', classes };
  }

  /** `tag#id.class1.class2` (at most 3 classes), from the stored context, then the selector. */
  function describeMark(mark) {
    const ctx = (mark && mark.context) || {};
    const open = parseOpenTag(ctx.outerHTML);
    const tail = parseSelectorTail(mark && mark.selector);
    const tag = str(ctx.tagName) || (open && open.tag) || tail.tag || 'element';
    const id = open ? open.id : tail.id;
    const classes = (open ? open.classes : tail.classes).slice(0, 3);
    const desc = `${tag}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
    return { tag, id, classes, desc };
  }

  function frameworkOf(mark) {
    const fw = mark && mark.context && mark.context.framework;
    return {
      component: fw && typeof fw === 'object' ? str(fw.componentName) : '',
      file: fw && typeof fw === 'object' ? str(fw.filePath) : '',
    };
  }

  /** The broadcastable facts about a mark. */
  function markFields(mark) {
    const d = describeMark(mark);
    const fw = frameworkOf(mark);
    const ctx = (mark && mark.context) || {};
    return {
      index: String(mark && mark.index != null ? mark.index : ''),
      desc: d.desc,
      tag: d.tag,
      id: d.id,
      classes: d.classes.join(' '),
      selector: str(mark && mark.selector),
      text: str(ctx.text),
      comment: str(mark && mark.comment),
      component: fw.component,
      file: fw.file,
    };
  }

  // ------------------------------------------------------------ snapshot

  /** Minimal, bounded view of one mark for the side panel. */
  function toBroadcastMark(mark, position) {
    const f = markFields(mark);
    const index = Number(mark.index) || position + 1;
    return {
      id: str(mark.id),
      index,
      color: colorFor(index),
      desc: truncate(f.desc, LIMITS.DESC),
      selector: truncate(f.selector, LIMITS.SELECTOR),
      text: truncate(f.text, LIMITS.TEXT),
      comment: truncate(f.comment, LIMITS.COMMENT),
      component: truncate(f.component, LIMITS.COMPONENT),
      file: truncate(f.file, LIMITS.FILE),
      sent: Boolean(mark.sent),
    };
  }

  function approxBytes(dataUrl) {
    const text = str(dataUrl);
    const comma = text.indexOf(',');
    const b64 = comma >= 0 ? text.length - comma - 1 : text.length;
    return Math.floor((b64 * 3) / 4);
  }

  /** Screenshot facts that are safe to broadcast: id + size, never pixels. */
  function toBroadcastShot(shot) {
    return {
      id: str(shot.id),
      w: Number(shot.w) || 0,
      h: Number(shot.h) || 0,
      bytes: Number(shot.bytes) || approxBytes(shot.dataUrl),
    };
  }

  function buildSnapshot({ url, marks, screenshots }) {
    const list = Array.isArray(marks) ? marks : [];
    const shots = Array.isArray(screenshots) ? screenshots : [];
    return {
      url: str(url),
      marks: list.slice(0, LIMITS.MAX_MARKS).map(toBroadcastMark),
      screenshots: shots.slice(0, LIMITS.MAX_SCREENSHOTS).map(toBroadcastShot),
      truncated: list.length > LIMITS.MAX_MARKS,
    };
  }

  /** The message the content script sends to the service worker. */
  function buildChangedMessage(args) {
    return { type: MSG.CHANGED, ...buildSnapshot(args) };
  }

  // ------------------------------------------------- content-side commands

  /**
   * Run one side-panel command against the page. `ctx`:
   *   store        review store (getAll / remove / clear / setSent / removeSent)
   *   screenshots  { list(), remove(id), clear(), thumbs(ids) }
   *   url()        current page URL
   *   buildParts(marks, images) -> { pageUrl, items, screenshots }
   *   locate(id)   scroll to + flash the marked element, returns boolean
   * Returns a response object, or undefined for a message that is not ours.
   */
  function handleCommand(msg, ctx) {
    if (!msg || typeof msg !== 'object') return undefined;
    const snapshot = () => buildSnapshot({ url: ctx.url(), marks: ctx.store.getAll(), screenshots: ctx.screenshots.list() });
    const ids = () => (Array.isArray(msg.ids) ? msg.ids.filter((id) => typeof id === 'string') : []);

    switch (msg.type) {
      case MSG.GET:
        return { ok: true, snapshot: snapshot() };
      case MSG.REMOVE: {
        const exists = Boolean(ctx.store.get ? ctx.store.get(msg.id) : ctx.store.getAll().some((m) => m.id === msg.id));
        if (exists) ctx.store.remove(msg.id);
        return { ok: true, removed: exists, snapshot: snapshot() };
      }
      case MSG.UPDATE: {
        const exists = Boolean(ctx.store.get ? ctx.store.get(msg.id) : ctx.store.getAll().some((m) => m.id === msg.id));
        if (exists && typeof msg.changes === 'object' && msg.changes) ctx.store.update(msg.id, msg.changes);
        return { ok: true, updated: exists, snapshot: snapshot() };
      }
      case MSG.CLEAR:
        ctx.store.clear();
        return { ok: true, snapshot: snapshot() };
      case MSG.LOCATE:
        return { ok: true, located: Boolean(ctx.locate && ctx.locate(msg.id)) };
      case MSG.REMOVE_SHOT:
        ctx.screenshots.remove(msg.id);
        return { ok: true, snapshot: snapshot() };
      case MSG.THUMBS:
        return { ok: true, thumbs: ctx.screenshots.thumbs(Array.isArray(msg.ids) ? msg.ids : []) };
      case MSG.BUILD: {
        const marks = ctx.store.getAll().filter((m) => !m.sent);
        const images = ctx.screenshots.images();
        const parts = ctx.buildParts(marks, images);
        return { ok: true, ...parts, markIds: marks.map((m) => m.id) };
      }
      case MSG.SENT:
        ctx.store.setSent(ids(), true);
        if (msg.clearScreenshots) ctx.screenshots.clear();
        return { ok: true, snapshot: snapshot() };
      case MSG.UNSENT:
        ctx.store.setSent(ids(), false);
        return { ok: true, snapshot: snapshot() };
      case MSG.CLEAR_SENT:
        ctx.store.removeSent();
        return { ok: true, snapshot: snapshot() };
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------- side-panel tray

  /**
   * What the side panel's tray shows for one tab. `status`:
   *   idle         no tab followed
   *   loading      waiting for the first snapshot
   *   ready        mirrors the page's store
   *   unavailable  the tab has no DevTailor content script (non-allowed page, disabled, not reloaded)
   */
  function createTrayModel() {
    let state = { tabId: null, url: '', marks: [], screenshots: [], truncated: false, status: 'idle' };
    let listeners = [];
    const emit = () => { const s = state; listeners.forEach((fn) => { try { fn(s); } catch { /* ignore */ } }); };

    return {
      getState: () => state,
      subscribe(fn) {
        listeners.push(fn);
        return () => { listeners = listeners.filter((f) => f !== fn); };
      },
      follow(tabId) {
        const id = tabId == null ? null : tabId;
        if (state.tabId === id && state.status !== 'idle') return;
        state = { tabId: id, url: '', marks: [], screenshots: [], truncated: false, status: id == null ? 'idle' : 'loading' };
        emit();
      },
      /** A `DT_MARKS_UPDATED` broadcast. Ignored when it is about another tab. */
      applyUpdate(msg) {
        if (!msg || msg.type !== MSG.UPDATED || msg.tabId !== state.tabId || state.tabId == null) return false;
        state = {
          tabId: state.tabId,
          url: str(msg.url),
          marks: Array.isArray(msg.marks) ? msg.marks : [],
          screenshots: Array.isArray(msg.screenshots) ? msg.screenshots : [],
          truncated: Boolean(msg.truncated),
          status: 'ready',
        };
        emit();
        return true;
      },
      /** A response carrying `snapshot` from a command sent to the followed tab. */
      applyResponse(tabId, res) {
        if (tabId !== state.tabId || state.tabId == null) return false;
        if (res && res.ok && res.snapshot) {
          return this.applyUpdate({ type: MSG.UPDATED, tabId, ...res.snapshot });
        }
        state = { ...state, marks: [], screenshots: [], truncated: false, status: 'unavailable' };
        emit();
        return false;
      },
      markUnavailable() {
        if (state.tabId == null) return;
        state = { ...state, marks: [], screenshots: [], truncated: false, status: 'unavailable' };
        emit();
      },
      unsentCount: () => state.marks.filter((m) => !m.sent).length,
    };
  }

  /**
   * Tray actions that write back to the page. `sendToTab(tabId, message)` resolves with the page's
   * response (or rejects when the tab has no content script). The tray never edits its own copy: it
   * applies the snapshot the page answers with.
   */
  function createTrayController({ model, sendToTab }) {
    async function run(message) {
      const tabId = model.getState().tabId;
      if (tabId == null) return { ok: false, error: 'no tab' };
      try {
        const res = await sendToTab(tabId, message);
        model.applyResponse(tabId, res);
        return res || { ok: false };
      } catch (err) {
        model.applyResponse(tabId, { ok: false, error: String((err && err.message) || err) });
        return { ok: false, error: String((err && err.message) || err) };
      }
    }
    return {
      refresh: () => run({ type: MSG.GET }),
      updateMark: (id, changes) => run({ type: MSG.UPDATE, id, changes }),
      removeMark: (id) => run({ type: MSG.REMOVE, id }),
      clearMarks: () => run({ type: MSG.CLEAR }),
      removeScreenshot: (id) => run({ type: MSG.REMOVE_SHOT, id }),
      locate: (id) => run({ type: MSG.LOCATE, id }),
      markSent: (ids, clearScreenshots) => run({ type: MSG.SENT, ids, clearScreenshots: Boolean(clearScreenshots) }),
      markUnsent: (ids) => run({ type: MSG.UNSENT, ids }),
      clearSent: () => run({ type: MSG.CLEAR_SENT }),
      /** Payload parts for the next send, or null when the page cannot provide them. */
      async buildPayload() {
        const tabId = model.getState().tabId;
        if (tabId == null) return null;
        try {
          const res = await sendToTab(tabId, { type: MSG.BUILD });
          return res && res.ok ? res : null;
        } catch {
          return null;
        }
      },
      async thumbs(ids) {
        const tabId = model.getState().tabId;
        if (tabId == null || !ids.length) return {};
        try {
          const res = await sendToTab(tabId, { type: MSG.THUMBS, ids });
          return res && res.ok ? res.thumbs || {} : {};
        } catch {
          return {};
        }
      },
    };
  }


  /**
   * Side-panel bookkeeping of the marks carried by in-flight turn(s). Ids accumulate across sends,
   * are registered BEFORE the request (a `done` may beat the HTTP response), and survive page
   * reloads: the page restores marks with sent=false, so `staleIds` names the ones to re-mark.
   */
  function createSentTracker() {
    let set = new Set();
    return {
      begin(ids) { (ids || []).forEach((id) => set.add(id)); },
      /** The request failed before the turn started: forget these ids (caller then marks them unsent). */
      rollback(ids) { (ids || []).forEach((id) => set.delete(id)); },
      /** The turn ended. `done` -> drop all sent marks; `error` -> make the carried ids sendable again. */
      settle(outcome) {
        const ids = [...set];
        set = new Set();
        if (!ids.length) return { clear: false, unsend: [] };
        return outcome === 'done' ? { clear: true, unsend: [] } : { clear: false, unsend: ids };
      },
      /** Tracked ids that exist in `marks` but are flagged unsent (e.g. restored after a reload). */
      staleIds(marks) {
        if (!set.size) return [];
        return (marks || []).filter((m) => set.has(m.id) && !m.sent).map((m) => m.id);
      },
      ids: () => [...set],
    };
  }

  // ---------------------------------------------------------------- DevTailor prompt parsing

  const PROMPT_MAX_CHARS = 400000;
  const NO_INTENT = '(No additional description provided)';

  /**
   * Recognise the Markdown the bridge's prompt-builder produces (`## Current Page`,
   * `## User Intent`, `## Marked Elements`, `### N \`selector\``) so history replay can render a
   * user turn compactly. Returns { pageUrl, intent, marks:[{index,selector,comment,file,component}] }
   * or null when the text is not in that format (callers then show the original text).
   */
  function parseDevTailorPrompt(text) {
    if (typeof text !== 'string') return null;
    const src = text.replace(/\r\n/g, '\n');
    if (!src || src.length > PROMPT_MAX_CHARS) return null;
    const head = /^\s*## Current Page\nURL: ([^\n]*)\n\n## User Intent\n/.exec(src);
    if (!head) return null;
    const pageUrl = head[1].trim();
    const rest = src.slice(head[0].length);
    const m = /\n\n## Marked Elements(?: \((\d+) total\))?\n/.exec(rest);
    let intent = (m ? rest.slice(0, m.index) : rest).trim();
    if (intent === NO_INTENT) intent = '';
    const marks = [];
    if (m) {
      const body = rest.slice(m.index + m[0].length);
      const re = /^### (\d+) `([^\n]*)`$/gm;
      const heads = [];
      let h;
      while ((h = re.exec(body)) && heads.length < LIMITS.MAX_MARKS) heads.push({ at: h.index, end: re.lastIndex, index: Number(h[1]), selector: h[2] });
      heads.forEach((cur, i) => {
        const block = body.slice(cur.end, i + 1 < heads.length ? heads[i + 1].at : body.length);
        const field = (label) => {
          const f = new RegExp(`^- \\*\\*${label}\\*\\*: ([^\\n]*)$`, 'm').exec(block);
          return f ? f[1].trim() : '';
        };
        marks.push({
          index: cur.index,
          selector: truncate(cur.selector, LIMITS.SELECTOR),
          comment: truncate(field('User annotation'), LIMITS.COMMENT),
          file: truncate(field('Component file'), LIMITS.FILE),
          component: truncate(field('Component name'), LIMITS.COMPONENT),
        });
      });
    }
    return { pageUrl, intent, marks };
  }

  /**
   * What a user bubble shows: the typed text (or the parsed intent), the chips of the marks it
   * carried, and whether the text was a DevTailor prompt that got compacted.
   */
  function userBubbleModel(msg) {
    const raw = msg && typeof msg.content === 'string' ? msg.content : '';
    const carried = Array.isArray(msg && msg.marks) ? msg.marks.slice(0, LIMITS.MAX_MARKS) : [];
    const parsed = carried.length ? null : parseDevTailorPrompt(raw);
    if (parsed) {
      return { text: parsed.intent, marks: parsed.marks.map((x) => ({ ...x, desc: describeMark({ selector: x.selector }).desc, color: colorFor(x.index) })), parsed: true, pageUrl: parsed.pageUrl };
    }
    return { text: raw, marks: carried, parsed: false, pageUrl: '' };
  }

  // ------------------------------------------------------------ persistence
  // Marks and pending screenshots live in the page, so a reload (or a dev-server full reload) used to
  // wipe them. They are mirrored into chrome.storage.session (per browser session, keyed by tab id,
  // ~10 MB quota) and restored when the content script starts again on the same origin.

  const PERSIST_VERSION = 1;
  /** Stay well under the 10 MB chrome.storage.session quota (base64 data URLs are the bulk). */
  const PERSIST_MAX_CHARS = 7 * 1024 * 1024;

  function persistKey(tabId) { return `dt_state_${tabId}`; }

  /** Serialisable state, or null when there is nothing worth keeping. Oldest screenshots are dropped to fit. */
  function buildPersisted({ origin, marks, shots, maxChars = PERSIST_MAX_CHARS }) {
    const markList = (Array.isArray(marks) ? marks : []).slice(0, LIMITS.MAX_MARKS);
    let shotList = (Array.isArray(shots) ? shots : []).slice(-LIMITS.MAX_SCREENSHOTS)
      .map((s) => ({ id: s.id, dataUrl: s.dataUrl, thumb: s.thumb || '', w: s.w, h: s.h, bytes: s.bytes || 0 }));
    if (!markList.length && !shotList.length) return null;
    const size = (list) => list.reduce((n, s) => n + (s.dataUrl ? s.dataUrl.length : 0) + (s.thumb ? s.thumb.length : 0), 0);
    let dropped = 0;
    while (shotList.length && size(shotList) > maxChars) { shotList = shotList.slice(1); dropped += 1; }
    return { v: PERSIST_VERSION, origin: String(origin || ''), savedAt: Date.now(), marks: markList, shots: shotList, droppedShots: dropped };
  }

  /** What to put back after a reload. Sent flags are cleared: the turn that carried them is gone. */
  function restorePersisted(saved, origin) {
    if (!saved || saved.v !== PERSIST_VERSION || saved.origin !== String(origin || '')) return null;
    const marks = (Array.isArray(saved.marks) ? saved.marks : []).map((m) => ({ ...m, sent: false }));
    const shots = (Array.isArray(saved.shots) ? saved.shots : [])
      .filter((s) => s && typeof s.dataUrl === 'string' && /^data:image\//i.test(s.dataUrl.slice(0, 20)));
    if (!marks.length && !shots.length) return null;
    return { marks, shots, droppedShots: saved.droppedShots || 0 };
  }

  const api = {
    PERSIST_MAX_CHARS,
    persistKey,
    buildPersisted,
    restorePersisted,
    MARK_COLORS,
    LIMITS,
    MSG,
    colorFor,
    truncate,
    escapeHtml,
    parseOpenTag,
    parseSelectorTail,
    describeMark,
    markFields,
    toBroadcastMark,
    toBroadcastShot,
    buildSnapshot,
    buildChangedMessage,
    handleCommand,
    createTrayModel,
    createSentTracker,
    parseDevTailorPrompt,
    userBubbleModel,
    createTrayController,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.marksCore = api;
  }
})();
