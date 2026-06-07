/**
 * DevTailor — Browser Console Cache
 *
 * Keeps a small cache of page console messages for Browser MCP tools.
 * Page messages are forwarded from browser-console-bridge.js running in MAIN world.
 *
 * Registers: window.__domReview.browserConsole
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const STORAGE_KEY = '__devtailor_console_messages_v1';
  const MAX_LOGS = 200;
  const MAX_PAGE_SIZE = 100;
  const PRESERVED_NAVIGATIONS = 3;
  const PAGE_CONSOLE_EVENT = '__devtailor_console_message__';
  const navigationId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let nextMsgId = 1;
  const logs = [];

  loadPersistedLogs();
  window.addEventListener(PAGE_CONSOLE_EVENT, handlePageConsoleEvent, true);

  function push(raw = {}) {
    const type = String(raw.type || 'log');
    const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
    const message = typeof raw.message === 'string' && raw.message
      ? raw.message
      : args.filter(Boolean).join(' ') || type;
    const entry = {
      msgid: nextMsgId++,
      type,
      level: normalizeLevel(type),
      message,
      args,
      stack: typeof raw.stack === 'string' ? raw.stack : '',
      timestamp: Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now(),
      navigationId,
      url: typeof raw.url === 'string' ? raw.url : location.href,
      source: typeof raw.source === 'string' ? raw.source : 'page-console',
      lineNumber: Number.isFinite(raw.lineNumber) ? raw.lineNumber : null,
      columnNumber: Number.isFinite(raw.columnNumber) ? raw.columnNumber : null,
      isCurrentNavigation: true,
    };
    logs.push(entry);
    trimLogs();
    persistLogs();
    return entry;
  }

  function handlePageConsoleEvent(event) {
    try {
      const raw = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
      if (!raw || typeof raw !== 'object') return;
      push(raw);
    } catch {
      // Ignore malformed page events.
    }
  }

  function normalizeLevel(type) {
    if (type === 'error' || type === 'assert') return 'error';
    if (type === 'warn') return 'warn';
    if (type === 'debug' || type === 'trace') return 'verbose';
    return 'info';
  }

  function loadPersistedLogs() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      const savedLogs = Array.isArray(saved?.logs) ? saved.logs : [];
      const retained = trimToNavigationWindow(savedLogs)
        .filter(item => item && typeof item.message === 'string')
        .map(item => ({ ...item, isCurrentNavigation: item.navigationId === navigationId }));
      logs.push(...retained);
      nextMsgId = Math.max(1, Number(saved?.nextMsgId) || 1, ...logs.map(item => Number(item.msgid) + 1 || 1));
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  function persistLogs() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        nextMsgId,
        logs,
      }));
    } catch {
      // Storage can fail on restricted pages; in-memory logs still work.
    }
  }

  function trimLogs() {
    const retained = trimToNavigationWindow(logs).slice(-MAX_LOGS);
    logs.splice(0, logs.length, ...retained);
  }

  function trimToNavigationWindow(items) {
    const navIds = [];
    for (const item of items) {
      if (item?.navigationId && !navIds.includes(item.navigationId)) navIds.push(item.navigationId);
    }
    const allowed = new Set(navIds.slice(-(PRESERVED_NAVIGATIONS + 1)));
    return items.filter(item => !item?.navigationId || allowed.has(item.navigationId));
  }

  function normalizeTypes(params = {}) {
    const rawTypes = Array.isArray(params.types)
      ? params.types
      : params.type
        ? [params.type]
        : params.level
          ? [params.level]
          : [];
    return new Set(rawTypes.map(type => {
      const value = String(type).toLowerCase();
      if (value === 'warning') return 'warn';
      if (value === 'verbose') return 'debug';
      return value;
    }));
  }

  function matchesTypes(item, types) {
    if (!types.size) return true;
    return types.has(item.type) || types.has(item.level);
  }

  function summarize(item) {
    return {
      msgid: item.msgid,
      type: item.type,
      level: item.level,
      message: item.message,
      timestamp: item.timestamp,
      url: item.url,
      source: item.source,
      lineNumber: item.lineNumber,
      columnNumber: item.columnNumber,
      repeatCount: item.repeatCount || 1,
      isCurrentNavigation: item.navigationId === navigationId,
    };
  }

  function groupConsecutive(items) {
    const grouped = [];
    for (const item of items) {
      const prev = grouped[grouped.length - 1];
      if (
        prev &&
        prev.type === item.type &&
        prev.level === item.level &&
        prev.message === item.message &&
        prev.source === item.source &&
        prev.url === item.url &&
        prev.lineNumber === item.lineNumber &&
        prev.columnNumber === item.columnNumber
      ) {
        prev.repeatCount = (prev.repeatCount || 1) + 1;
        prev.lastTimestamp = item.timestamp;
        continue;
      }
      grouped.push({ ...item, repeatCount: 1 });
    }
    return grouped;
  }

  function getLogs(params = {}) {
    const pageSize = Math.max(1, Math.min(Number(params.pageSize || params.limit) || 30, MAX_PAGE_SIZE));
    const pageIdx = Math.max(0, Number(params.pageIdx) || 0);
    const types = normalizeTypes(params);
    const includePreservedMessages = Boolean(params.includePreservedMessages);
    const filtered = logs
      .filter(item => includePreservedMessages || item.navigationId === navigationId)
      .filter(item => matchesTypes(item, types));
    const grouped = groupConsecutive(filtered).map(summarize);
    const newestFirst = grouped.slice().reverse();
    const start = pageIdx * pageSize;
    return {
      messages: newestFirst.slice(start, start + pageSize),
      pageIdx,
      pageSize,
      total: grouped.length,
      includePreservedMessages,
      preservedNavigationCount: new Set(logs.map(item => item.navigationId)).size,
    };
  }

  function getMessage({ msgid } = {}) {
    const id = Number(msgid);
    if (!Number.isFinite(id)) return null;
    const item = logs.find(entry => Number(entry.msgid) === id);
    return item ? { ...item, isCurrentNavigation: item.navigationId === navigationId } : null;
  }

  function countByType(type) {
    const expected = String(type || '').toLowerCase();
    return logs.filter(item => item.navigationId === navigationId && (item.type === expected || item.level === expected)).length;
  }

  window.__domReview.browserConsole = { getLogs, getMessage, countByType };
})();
