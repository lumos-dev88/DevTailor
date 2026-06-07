/**
 * DevTailor — Chat Tool Helpers
 *
 * Pure formatting and normalization helpers for ACP tool messages.
 *
 * Registers: window.__domReview.chatTools
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const TOOL_KIND_ICONS = {
    read: '↗', edit: '✎', write: '+', delete: '−',
    search: '⌕', execute: '$', think: '✨', fetch: '↬',
    move: '⇄', switch_mode: '◈', browser: '◉', other: '·'
  };

  const BROWSER_TOOL_LABELS = {
    take_visible_screenshot: '截图',
    get_page_snapshot: '页面状态',
    get_element_targets: '元素库',
    save_element_target: '保存元素',
    get_console_logs: '控制台日志',
    get_console_message: '日志详情',
    reload_page: '刷新页面',
    click_page: '点击页面',
    type_text: '输入文本',
    fill_text: '填写文本',
    press_key: '按键',
    clear_state: '清理状态',
    wait_for_selector: '等待元素',
    wait_for_text: '等待文本',
    run_actions: '批量操作',
    request_user_assistance: '用户协助',
  };

  function toolFamily(kind) {
    if (!kind) return 'other';
    const k = String(kind).toLowerCase();
    if (k.startsWith('browser:') || BROWSER_TOOL_LABELS[k]) return 'browser';
    if (k === 'edit' || k === 'str_replace_edit') return 'edit';
    if (k === 'write' || k === 'create_file') return 'write';
    if (k === 'read' || k === 'read_file') return 'read';
    if (k === 'bash' || k === 'glob' || k === 'grep') return 'execute';
    if (k === 'webfetch' || k === 'web_search') return 'fetch';
    return k;
  }

  function toolIcon(kind) {
    return TOOL_KIND_ICONS[toolFamily(kind)] || '·';
  }

  function toolKindLabel(kind) {
    const map = {
      read: '读取',
      edit: '编辑',
      write: '写入',
      delete: '删除',
      search: '搜索',
      execute: '执行',
      think: '思考',
      fetch: '获取',
      move: '移动',
      switch_mode: '切换',
      browser: '浏览器',
      other: '调用'
    };
    return map[toolFamily(kind)] || '调用';
  }

  function toolStatusLabel(status) {
    const map = {
      pending: '准备中',
      in_progress: '运行中',
      completed: '已完成',
      failed: '失败',
      canceled: '已取消',
      running: '运行中'
    };
    return map[status] || status;
  }

  function toolStatusClass(status) {
    if (status === 'completed') return 'dt-tool-status-ok';
    if (status === 'failed' || status === 'canceled' || status === 'error') return 'dt-tool-status-error';
    if (status === 'in_progress' || status === 'running') return 'dt-tool-status-running';
    return 'dt-tool-status-pending';
  }

  function inferBrowserToolName(title, input, kind) {
    const values = [title, kind];
    const obj = parseMaybeJsonObject(input);
    if (obj) {
      values.push(obj.name, obj.tool, obj.action, obj.title);
    }
    if (input && typeof input === 'object') {
      values.push(input.name, input.tool, input.action, input.title);
    }
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const lower = value.toLowerCase();
      for (const name of Object.keys(BROWSER_TOOL_LABELS)) {
        if (lower === name || lower.endsWith(`:${name}`) || lower.includes(name)) {
          return name;
        }
      }
    }
    return null;
  }

  function browserTarget(input) {
    const obj = input && typeof input === 'object' ? input : parseMaybeJsonObject(input);
    if (!obj || typeof obj !== 'object') return '';
    if (typeof obj.elementId === 'string') return `元素 ${obj.elementId}`;
    if (typeof obj.selector === 'string') return obj.selector;
    if (typeof obj.markId === 'string') return `标记 ${obj.markId}`;
    if (typeof obj.label === 'string') return `标签 ${obj.label}`;
    if (typeof obj.role === 'string') return obj.text ? `${obj.role} ${obj.text}` : `角色 ${obj.role}`;
    if (typeof obj.text === 'string') return `文本 ${obj.text}`;
    if (obj.point && typeof obj.point === 'object') {
      const x = Math.round(Number(obj.point.x));
      const y = Math.round(Number(obj.point.y));
      if (Number.isFinite(x) && Number.isFinite(y)) return `坐标 ${x}, ${y}`;
    }
    return '';
  }

  function describeBrowserToolInput(name, input) {
    const obj = input && typeof input === 'object' ? input : parseMaybeJsonObject(input);
    switch (name) {
      case 'take_visible_screenshot':
        return '当前可见区域';
      case 'get_page_snapshot': {
        const count = Array.isArray(obj?.selectors) ? obj.selectors.length : 0;
        return count ? `${count} 个选择器` : 'URL / 标题 / 视口';
      }
      case 'get_element_targets':
        return '当前页面';
      case 'save_element_target':
        return obj?.name ? truncate(String(obj.name), 80) : '可复用元素';
      case 'get_console_logs':
        if (Array.isArray(obj?.types) && obj.types.length) return `${obj.types.join(', ')} 日志`;
        return obj?.level ? `${obj.level} 日志` : '最近日志';
      case 'get_console_message':
        return obj?.msgid != null ? `#${obj.msgid}` : '单条日志';
      case 'reload_page':
        return '当前页面';
      case 'click_page':
        return browserTarget(input) || '当前页面';
      case 'type_text':
        return browserTarget(input) || '当前焦点';
      case 'fill_text':
        return browserTarget(input) || '当前焦点';
      case 'press_key':
        return obj?.key ? String(obj.key) : '当前焦点';
      case 'clear_state':
        return obj?.pressEscape ? '交互状态 + Escape' : '页面交互状态';
      case 'wait_for_selector':
        return obj?.selector ? String(obj.selector) : '元素出现';
      case 'wait_for_text':
        return obj?.text ? truncate(String(obj.text), 80) : '文本出现';
      case 'run_actions': {
        const count = Array.isArray(obj?.actions) ? obj.actions.length : 0;
        return count ? `${count} 个流程` : '临时操作流程';
      }
      case 'request_user_assistance':
        return obj?.message ? truncate(String(obj.message), 80) : '等待用户操作';
      default:
        return '';
    }
  }

  function describeToolInput(input, title, kind) {
    const browserName = inferBrowserToolName(title, input, kind);
    if (browserName) return describeBrowserToolInput(browserName, input);
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (typeof input !== 'object') return String(input);
    const obj = input;
    for (const key of ['file_path', 'path', 'pattern', 'url', 'query', 'name', 'command']) {
      const v = obj[key];
      if (typeof v === 'string') return v;
    }
    try { return JSON.stringify(obj); } catch { return ''; }
  }

  function formatToolContent(content) {
    if (!content || typeof content !== 'object') return stringifyAny(content);
    if (content.type === 'content') {
      if (content.text === '[image]') return '截图已返回给 AI';
      return content.text || stringifyAny(content.content);
    }
    if (content.type === 'diff') {
      const path = content.path ? `diff ${content.path}\n` : 'diff\n';
      const oldText = content.oldText == null ? '' : String(content.oldText);
      const newText = content.newText == null ? '' : String(content.newText);
      return `${path}--- before\n${oldText}\n+++ after\n${newText}`;
    }
    if (content.type === 'terminal') {
      return content.text || `Terminal: ${content.terminalId || 'attached'}`;
    }
    return content.text || stringifyAny(content);
  }

  function truncate(s, n) {
    if (!s || s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }

  function stringifyAny(value, fallback = '') {
    if (typeof value === 'string') return value;
    if (value == null) return fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}' && json !== '[]') return json;
    } catch {}
    return fallback;
  }

  function parseMaybeJsonObject(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function normalizeToolTitle(value, fallback = 'Tool') {
    const browserName = inferBrowserToolName(value);
    if (browserName) return BROWSER_TOOL_LABELS[browserName];
    const obj = parseMaybeJsonObject(value);
    if (obj && typeof obj.title === 'string' && obj.title.trim()) {
      return obj.title;
    }
    return stringifyAny(value, fallback);
  }

  function normalizeToolKind(value, fallback = 'other') {
    const browserName = inferBrowserToolName(value);
    if (browserName) return `browser:${browserName}`;
    const obj = parseMaybeJsonObject(value);
    if (obj && typeof obj.kind === 'string') return obj.kind;
    return typeof value === 'string' && !value.trim().startsWith('{') ? value : fallback;
  }

  function normalizeToolId(primary, fallbackSource) {
    if (typeof primary === 'string' && primary) return primary;
    const obj = parseMaybeJsonObject(fallbackSource);
    if (obj && typeof obj.toolCallId === 'string') return obj.toolCallId;
    return String(Math.random()).slice(2, 8);
  }

  window.__domReview.chatTools = {
    toolFamily,
    toolIcon,
    toolKindLabel,
    toolStatusLabel,
    toolStatusClass,
    describeToolInput,
    formatToolContent,
    truncate,
    stringifyAny,
    parseMaybeJsonObject,
    inferBrowserToolName,
    normalizeToolTitle,
    normalizeToolKind,
    normalizeToolId,
  };
})();
