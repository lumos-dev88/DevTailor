/**
 * DevTailor — Reference elements core (pure logic, no DOM)
 *
 * Everything about "参考元素" that does not touch the DOM or storage:
 *   - the global list model: add / update / remove / clear with a hard cap of 8;
 *   - URL sanitising (userinfo, hash and sensitive query values) and the send payload field list;
 *   - message validation (what the service worker accepts from content scripts / the side panel).
 *
 * Storage (chrome.storage.session, single writer = the service worker, changes broadcast to
 * extension pages) lives in background/service-worker.js; the side panel's tray lives in
 * sidepanel/references-tray.js; capture + cropping live in content/modules/references.js.
 *
 * Browser: window.__domReview.referencesCore. Node (tests): module.exports.
 */
(() => {
  'use strict';

  const MAX_REFERENCES = 8;

  const LIMITS = {
    ID: 64,
    URL: 2000,
    TITLE: 300,
    SELECTOR: 1000,
    NOTE: 1000,
    HTML: 8000,
    STYLE_VALUE: 200,
    SCREENSHOT_BYTES: 2 * 1024 * 1024,
  };
  /** base64 inflates decoded bytes by 4/3 (plus a small prefix allowance). */
  const SCREENSHOT_PREFIX_ALLOWANCE = 64;
  const SCREENSHOT_MAX_CHARS = Math.ceil((LIMITS.SCREENSHOT_BYTES + SCREENSHOT_PREFIX_ALLOWANCE) * 4 / 3);

  /** Field shape of one reference inside the /review request body (screenshot is optional). */
  const SEND_FIELDS = ['id', 'url', 'title', 'selector', 'note', 'styles', 'html', 'screenshot'];
  /** Full record as stored in chrome.storage.session (adds createdAt). */
  const STORED_FIELDS = [...SEND_FIELDS, 'createdAt'];

  const MSG = {
    UPDATED: 'DT_REFERENCES_UPDATED',
    GET: 'DT_GET_REFERENCES',
    ADD: 'DT_REFERENCE_ADD',
    UPDATE_NOTE: 'DT_REFERENCE_UPDATE_NOTE',
    REMOVE: 'DT_REFERENCE_REMOVE',
    CLEAR: 'DT_REFERENCES_CLEAR',
    ACCEPTED: 'DT_REFERENCES_ACCEPTED',
  };

  // ---------------------------------------------------------------- helpers

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  /** Hard cut (no ellipsis): caps are size guards, the UI already shows short previews. */
  function clampText(value, max) {
    const text = String(value == null ? '' : value);
    if (max == null || !Number.isFinite(max)) return text;
    return text.length > max ? text.slice(0, max) : text;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // ------------------------------------------------------------------- list

  /**
   * Append `entry` (already sanitized by sanitizeReference). Returns:
   *   { ok: true, list }                    — appended (older entries evicted when over the cap)
   *   { ok: false, full: true, list }       — the list was already at the cap
   *   { ok: false, error, list }            — nothing usable in `entry`
   * `list` is always the current list (newest last), never mutated.
   */
  function addReference(list, entry) {
    const current = Array.isArray(list) ? list.filter(isPlainObject) : [];
    const base = sanitizeReference(entry);
    // The cap is about not silently dropping what is already waiting: only ids are reserved.
    if (!base.id || !base.selector) return { ok: false, error: 'invalid_reference', list: current };
    if (current.some((item) => item.id === base.id)) return { ok: false, error: 'duplicate', list: current };
    if (current.length >= MAX_REFERENCES) return { ok: false, full: true, error: 'full', list: current };
    return { ok: true, list: [...current, base] };
  }

  /** Edit the note of one reference; unknown ids change nothing. */
  function updateNote(list, id, note) {
    const current = Array.isArray(list) ? list.filter(isPlainObject) : [];
    if (!str(id)) return { ok: false, error: 'invalid_id', list: current };
    let changed = false;
    const next = current.map((item) => {
      if (item.id !== id) return item;
      const nextNote = clampText(note, LIMITS.NOTE);
      if ((item.note || '') === nextNote) return item;
      changed = true;
      return { ...item, note: nextNote };
    });
    return { ok: changed, list: next };
  }

  function removeReference(list, id) {
    const current = Array.isArray(list) ? list.filter(isPlainObject) : [];
    const next = current.filter((item) => item.id !== id);
    return { ok: next.length !== current.length, list: next };
  }

  function clearReferences() {
    return [];
  }

  /**
   * Drop the given ids from the pending list (after a successful send). Ids added while the
   * request was in flight simply are not in the snapshot it carried, so they survive untouched.
   */
  function acceptSent(list, sentIds) {
    const current = Array.isArray(list) ? list.filter(isPlainObject) : [];
    const drop = new Set((Array.isArray(sentIds) ? sentIds : []).map(String));
    return current.filter((item) => !drop.has(item.id));
  }

  // -------------------------------------------------------------- sanitize

  /**
   * Drop everything that is not a known field, clamp sizes and force an id/createdAt shape.
   * Never throws: anything odd becomes an empty/default value.
   */
  function sanitizeReference(raw) {
    if (!isPlainObject(raw)) return {};
    const styles = sanitizeStyles(raw.styles);
    // Keep the screenshot length in check *before* validating its decoded size (a huge payload must
    // not be re-parsed just to be rejected).
    const screenshotRaw = typeof raw.screenshot === 'string' ? raw.screenshot : '';
    const screenshot = sanitizeScreenshot(
      screenshotRaw.length > SCREENSHOT_MAX_CHARS ? '' : screenshotRaw
    );
    const html = typeof raw.html === 'string' ? raw.html.slice(0, LIMITS.HTML) : '';
    const id = clampText(str(raw.id).trim(), LIMITS.ID);
    const out = {
      id,
      url: clampText(str(raw.url), LIMITS.URL),
      title: clampText(str(raw.title), LIMITS.TITLE),
      selector: clampText(str(raw.selector), LIMITS.SELECTOR),
      note: clampText(str(raw.note), LIMITS.NOTE),
      styles,
      html,
      screenshot,
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    };
    if (!out.selector) return {}; // without a selector the Hub cannot locate the element
    if (Object.keys(out.styles).length === 0 && !out.html && !out.url) return {};
    return out;
  }

  function sanitizeStyles(styles) {
    const out = {};
    if (!isPlainObject(styles)) return out;
    for (const [key, value] of Object.entries(styles)) {
      if (typeof key !== 'string' || !key || typeof value !== 'string') continue;
      const v = value.trim();
      if (!v) continue;
      out[key.slice(0, 80)] = v.slice(0, LIMITS.STYLE_VALUE);
    }
    return out;
  }

  function sanitizeScreenshot(screenshot) {
    if (typeof screenshot !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(screenshot.slice(0, 40))) return '';
    return screenshot;
  }

  /** What travels inside the /review payload: the send fields only, never createdAt. */
  function toSendReference(reference) {
    const ref = sanitizeReference(reference);
    if (!ref.id) return null;
    const out = {};
    for (const field of SEND_FIELDS) out[field] = ref[field];
    if (!out.screenshot) delete out.screenshot;
    return out;
  }

  function toSendReferences(list) {
    return (Array.isArray(list) ? list : []).map(toSendReference).filter(Boolean);
  }

  // ------------------------------------------------------------ URL privacy

  // Matches the bare names plus prefixed/suffixed ones (`access_token`, `api_key`, `session_id`…).
  // Deliberately not anchored to a substring of ordinary words: `user_id`, `keyword` stay intact.
  const SENSITIVE_QUERY = /^(?:[a-z0-9_-]*(?:token|secret|password|passwd|session|auth(?:orization)?|sig(?:nature)?|code)[a-z0-9_-]*|key|[a-z0-9_-]*_key)$/i;

  /**
   * Public-ish form of a page URL: drop user:password@, drop the hash, and replace the value of
   * query keys whose name looks like a credential (`token`, `key`, `secret`, `auth`, `sig`,
   * `session`, `code`, `password`) with REDACTED. The path and everything else stay intact.
   */
  function sanitizeUrl(raw) {
    const text = str(raw).trim();
    // A record that came from the page already carries a clean URL. Anything else is parsed; only
    // http(s) survives, so a reference never keeps an unusable source.
    let url = null;
    try { url = new URL(text); } catch { url = null; }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '';
    url.hash = '';
    url.username = '';
    url.password = '';
    for (const [name, value] of [...url.searchParams.entries()]) {
      if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, 'REDACTED');
      else if (/^data:/i.test(value)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  }

  /** Host + pathname (+ the sanitized query string): the short label shown in the tray. */
  function shortUrl(sanitizedUrl) {
    const url = str(sanitizedUrl);
    if (!url) return '';
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, '');
      const query = parsed.searchParams.toString();
      return `${parsed.host}${path}${query ? `?${query}` : ''}`;
    } catch {
      return url;
    }
  }

  // --------------------------------------------------------------- messages

  /** Only ids exist in storage: a note edit must not smuggle a rewritten reference in. */
  function isValidUpdateMessage(message) {
    if (!isPlainObject(message)) return false;
    if (message.type !== MSG.UPDATE_NOTE) return false;
    if (typeof message.id !== 'string' || !message.id) return false;
    if (message.note !== undefined && typeof message.note !== 'string') return false;
    return true;
  }

  // ------------------------------------------------------- capture sanitising

  /**
   * Computed style fields a reference keeps; everything else is dropped before storage. Values are
   * clamped again by `sanitizeStyles` (unknown keys would be ignored there anyway).
   */
  const STYLE_KEYS = [
    'color', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'letterSpacing', 'padding', 'margin', 'gap', 'display', 'border',
    'borderRadius', 'boxShadow', 'width', 'height',
  ];

  function pickStyles(computedStyle) {
    const out = {};
    if (!computedStyle || typeof computedStyle !== 'object') return out;
    for (const key of STYLE_KEYS) {
      let value = '';
      try { value = computedStyle[key]; } catch { /* ignore */ }
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
  }

  /** Text inside `<script>` / `<style>` / `<iframe srcdoc>` and other raw-text blocks. */
  const RAW_TEXT_BLOCK_RE = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  const SRC_DOC_RE = /\ssrcdoc\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s>]*)/gi;
  // attribute value: quoted (escapes allowed) or bare. Written out so the escapes stay readable.
  const ON_ATTR_RE = /\son[a-z][\w:-]*\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'=<>`]+)/gi;
  const LONG_DATA_URI_RE = /\b(data:[^"'\\\s<>]{300,})[^"'\\\s<>]*/g;
  const VALUE_ATTR_RE = /\svalue\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s>]+)/gi;
  const CHECKED_ATTR_RE = /\s(checked|selected|readonly|disabled|autofocus|required|multiple|open)\b(?=[\s/>]|$)/gi;

  /** `el.outerHTML`, stripped of anything that can carry code or user-entered text. */
  function sanitizeElementHtml(rawHtml) {
    let html = typeof rawHtml === 'string' ? rawHtml : '';
    // Every raw-text element's *content* is dropped: scripts/styles can carry code, and a huge
    // blob inside `<pre>`/`<textarea>` is exactly what the Hub does not need. The surrounding tags
    // stay, so the markup shape (and `data-*`/class hooks) survives.
    html = html.replace(RAW_TEXT_BLOCK_RE, (_m, tag) => `<${tag.toLowerCase()}></${tag.toLowerCase()}>`);
    html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
    html = html.replace(/<iframe\b[^>]*\/>/gi, '');
    html = html.replace(SRC_DOC_RE, '');
    html = html.replace(ON_ATTR_RE, '');
    // Any `data:` URI in an attribute/value is a placeholder: 长串直接替换，短串也不外发。
    html = html.replace(LONG_DATA_URI_RE, 'data:[REDACTED]');
    html = html.replace(/data:[^"'\\\s<>]{1,300}/g, 'data:[REDACTED]');
    // form values: input `value="…"` + its `type` (password/hidden carry nothing useful), and the
    // checked/selected state of any control.
    html = html.replace(/<input\b[^>]*>/gi, (tag) => (
      tag.replace(VALUE_ATTR_RE, '')
        .replace(CHECKED_ATTR_RE, '')
        .replace(/\stype\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s>]+)/i, ' type="[REDACTED]"')
    ));
    // a select/option keeps no user-chosen value either (selected is dropped above)
    html = html.replace(/<(select|option|textarea|button)\b[^>]*>/gi, (tag) => tag.replace(CHECKED_ATTR_RE, ''));
    // A password/hidden value is already gone with the attribute; the *typed* text of a textarea
    // is user content. Button/option labels stay: they are the element's visible copy (already in
    // the screenshot), and without them the reference no longer identifies what to look at.
    html = html.replace(/<textarea\b[^>]*>[\s\S]*?(<\/textarea\s*>|$)/gi, (m) => m.replace(/^([^>]*)>[\s\S]*/, '$1></textarea>'));
    html = html.replace(CHECKED_ATTR_RE, '');
    // The typed text inside a contenteditable region is user content, not markup.
    html = html.replace(/<([a-z][\w:-]*)\b[^>]*\bcontenteditable(?:=(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/\1\s*>/gi,
      (_m, tag) => `<${tag}></${tag}>`);
    return clampText(html, LIMITS.HTML);
  }

  /**
   * A data URL is only an image preview when it is a small base64 raster. Anything else
   * (`javascript:`, `http:`, an SVG payload, a huge blob) is rejected here so it never reaches
   * storage or an `<img src>`.
   */
  function isSafeImageDataUrl(value) {
    return typeof value === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
  }

  /** Message size guard for the service worker (it stores whatever passes). */
  function isValidAddMessage(message) {
    if (!isPlainObject(message)) return false;
    if (message.type !== MSG.ADD) return false;
    if (!isPlainObject(message.reference)) return false;
    try {
      if (JSON.stringify(message.reference).length > 200 * 1024) return false;
    } catch {
      return false;
    }
    return true;
  }

  /** Reject a message whose reference breaks the size caps before it reaches storage. */
  function validateIncomingReference(raw) {
    // Size checks run on the incoming value first: sanitising clamps, so a clamped field would
    // otherwise look fine even though the sender exceeded the cap.
    if (!isPlainObject(raw)) return { ok: false, error: 'invalid_reference', reference: null };
    if (typeof raw.url === 'string' && raw.url.length > LIMITS.URL) return { ok: false, error: 'reference_too_large', reference: null };
    if (typeof raw.note === 'string' && raw.note.length > LIMITS.NOTE) return { ok: false, error: 'reference_too_large', reference: null };
    if (typeof raw.html === 'string' && raw.html.length > LIMITS.HTML) return { ok: false, error: 'reference_too_large', reference: null };
    if (typeof raw.screenshot === 'string' && raw.screenshot.startsWith('data:image/')) {
      // only an image payload can pass sanitizeScreenshot, so anything else is dropped there; here
      // a real-looking image over the byte cap is "too large" rather than silently losing its shot.
      const comma = raw.screenshot.indexOf(',');
      const decoded = comma >= 0 ? Math.floor((raw.screenshot.length - comma - 1) * 3 / 4) : 0;
      if (decoded > LIMITS.SCREENSHOT_BYTES) return { ok: false, error: 'reference_too_large', reference: null };
    }
    const ref = sanitizeReference(raw);
    if (!ref.id) return { ok: false, error: 'invalid_reference', reference: null };
    return { ok: true, reference: ref };
  }

  /**
   * Only a successful response with a numeric `referencesAccepted` equal to what we sent means
   * the Hub understood (and kept) the references; anything else keeps them pending.
   */
  function resolveSentReferences(response, sentIds) {
    const count = Array.isArray(sentIds) ? sentIds.length : 0;
    if (!response || typeof response !== 'object') return { keep: true, accepted: false, reason: 'error' };
    if (response.ok === false) return { keep: true, accepted: false, reason: 'error' };
    const data = isPlainObject(response.data) ? response.data : {};
    const acceptedRaw = data.referencesAccepted;
    if (typeof acceptedRaw === 'number' && Number.isFinite(acceptedRaw)) {
      if (acceptedRaw === count) return { keep: false, accepted: true, count: acceptedRaw };
      return { keep: true, accepted: false, reason: 'count_mismatch', count: acceptedRaw };
    }
    return { keep: true, accepted: false, reason: 'unsupported', count: 0 };
  }

  const api = {
    MAX_REFERENCES,
    LIMITS,
    SEND_FIELDS,
    STORED_FIELDS,
    STYLE_KEYS,
    MSG,
    clampText,
    addReference,
    updateNote,
    removeReference,
    clearReferences,
    acceptSent,
    sanitizeReference,
    sanitizeStyles,
    sanitizeScreenshot,
    toSendReference,
    toSendReferences,
    sanitizeUrl,
    shortUrl,
    pickStyles,
    sanitizeElementHtml,
    isSafeImageDataUrl,
    isValidUpdateMessage,
    isValidAddMessage,
    validateIncomingReference,
    resolveSentReferences,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.__domReview = window.__domReview || {};
    window.__domReview.referencesCore = api;
  }
})();