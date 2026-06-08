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
    read: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
    edit: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    write: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" x2="12" y1="11" y2="17"/><line x1="9" x2="15" y1="14" y2="14"/></svg>',
    delete: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
    search: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    execute: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>',
    think: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="0"><path d="M8.00192 6.64454C8.75026 6.64454 9.35732 7.25169 9.35739 8.00001C9.35739 8.74838 8.7503 9.35548 8.00192 9.35548C7.25367 9.35533 6.64743 8.74829 6.64743 8.00001C6.6475 7.25178 7.25371 6.64468 8.00192 6.64454Z" fill="currentColor"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M9.97165 1.29981C11.5853 0.718916 13.271 0.642197 14.3144 1.68555C15.3577 2.72902 15.2811 4.41466 14.7002 6.02833C14.4707 6.66561 14.1504 7.32937 13.75 8.00001C14.1504 8.67062 14.4707 9.33444 14.7002 9.97169C15.2811 11.5854 15.3578 13.271 14.3144 14.3145C13.271 15.3579 11.5854 15.2811 9.97165 14.7002C9.3344 14.4708 8.67059 14.1505 7.99997 13.75C7.32933 14.1505 6.66558 14.4708 6.02829 14.7002C4.41461 15.2811 2.72899 15.3578 1.68552 14.3145C0.642155 13.271 0.71887 11.5854 1.29977 9.97169C1.52915 9.33454 1.84865 8.67049 2.24899 8.00001C1.84866 7.32953 1.52915 6.66544 1.29977 6.02833C0.718852 4.41459 0.64207 2.729 1.68552 1.68555C2.72897 0.642112 4.41456 0.718887 6.02829 1.29981C6.66541 1.52918 7.32949 1.8487 7.99997 2.24903C8.67045 1.84869 9.33451 1.52919 9.97165 1.29981ZM12.9404 9.2129C12.4391 9.893 11.8616 10.5681 11.2148 11.2149C10.568 11.8616 9.89296 12.4391 9.21286 12.9404C9.62532 13.1579 10.0271 13.338 10.4121 13.4766C11.9146 14.0174 12.9172 13.8738 13.3955 13.3955C13.8737 12.9173 14.0174 11.9146 13.4765 10.4121C13.3379 10.0271 13.1578 9.62535 12.9404 9.2129ZM3.05856 9.2129C2.84121 9.62523 2.66197 10.0272 2.52341 10.4121C1.98252 11.9146 2.12627 12.9172 2.60446 13.3955C3.08278 13.8737 4.08544 14.0174 5.58786 13.4766C5.97264 13.338 6.37389 13.1577 6.7861 12.9404C6.10624 12.4393 5.43168 11.8614 4.78513 11.2149C4.13823 10.5679 3.55992 9.89313 3.05856 9.2129ZM7.99899 3.792C7.23179 4.31419 6.45306 4.95512 5.70407 5.70411C4.95509 6.45309 4.31415 7.23184 3.79196 7.99903C4.3143 8.76666 4.95471 9.54653 5.70407 10.2959C6.45309 11.0449 7.23271 11.6848 7.99997 12.207C8.76725 11.6848 9.54683 11.0449 10.2959 10.2959C11.0449 9.54686 11.6848 8.76729 12.207 8.00001C11.6848 7.23275 11.0449 6.45312 10.2959 5.70411C9.5465 4.95475 8.76662 4.31434 7.99899 3.792ZM5.58786 2.52344C4.08533 1.98255 3.08272 2.12625 2.60446 2.6045C2.12621 3.08275 1.98252 4.08536 2.52341 5.5879C2.66189 5.97253 2.8414 6.37409 3.05856 6.78614C3.55983 6.10611 4.1384 5.43189 4.78513 4.78516C5.43186 4.13843 6.10606 3.55987 6.7861 3.0586C6.37405 2.84144 5.97249 2.66192 5.58786 2.52344ZM13.3955 2.6045C12.9172 2.12631 11.9146 1.98257 10.4121 2.52344C10.0272 2.66201 9.62519 2.84125 9.21286 3.0586C9.8931 3.55996 10.5679 4.13827 11.2148 4.78516C11.8614 5.43172 12.4392 6.10627 12.9404 6.78614C13.1577 6.37393 13.338 5.97267 13.4765 5.5879C14.0174 4.08549 13.8736 3.08281 13.3955 2.6045Z" fill="currentColor"></path></svg>',
    fetch: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
    move: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0-4.4-3.6-8-8-8s-8 3.6-8 8 3.6 8 8 8h8"/><polyline points="16 14 20 18 16 22"/></svg>',
    switch_mode: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
    browser: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/></svg>',
    other: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'
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
        return '项目全量';
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
