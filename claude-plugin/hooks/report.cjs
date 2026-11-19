#!/usr/bin/env node
/**
 * Claude Code hook -> DevTailor Bridge "what is Claude doing" reporter.
 *
 * Reads the hook JSON from stdin, builds a short, redacted human label and POSTs
 * it to the local Bridge at http://127.0.0.1:<port>/agent-status.
 *
 * Contract (fixed, see docs / bridge side):
 *   - Bridge writes a 32-hex token to <project>/.devtailor/agent-hook-token (0600)
 *   - POST /agent-status, port from DEVTAILOR_PORT (default 34781)
 *   - Authorization: Bearer <token>, Content-Type: application/json, no Origin
 *   - body {event, toolName?, label?, toolUseId?}
 *
 * Hard rules:
 *   - no token file  -> this project has no Bridge running: exit silently
 *   - never print anything to stdout (PreToolUse stdout is parsed by Claude Code)
 *     or stderr, never leak the token, always exit 0
 *   - request timeout 1.5s; every failure (throw / non-2xx / timeout) is swallowed
 *
 * Only Node built-ins (node:http, node:fs, node:path), Node >= 20, no node_modules.
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_PORT = 34781;
const REQUEST_TIMEOUT_MS = 1500;
// Safety valves: a hook must never hang. Claude Code closes stdin right after
// writing the payload; these only bite if it does not (or if a payload is
// larger than MAX_STDIN_BYTES, e.g. a huge Write).
const STDIN_IDLE_MS = 250;
const STDIN_DEADLINE_MS = 1200;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATTERN_TOOLS = new Set(['Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Replace newlines and control characters with a space, then trim. */
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
}

// `Bearer <value>` and `Authorization: Bearer <value>` are handled first: the
// key=value rule below would otherwise mask the word "Bearer" and leave the
// credential itself in the label.
const BEARER_VALUE = /\bbearer\s+[^\s"',;)]+/gi;
const KEY_VALUE = /(token|secret|password|passwd|api[_-]?key|authorization|bearer)\s*[=:]\s*\S+/gi;
const API_KEY_LITERAL = /sk-[A-Za-z0-9_-]{8,}/g;

/** Mask credential-looking fragments. Never widen this to log the original. */
function redact(value) {
  if (typeof value !== 'string') return '';
  let out = value;
  for (let i = 0; i < 4; i++) {
    const next = out
      .replace(BEARER_VALUE, '***')
      .replace(KEY_VALUE, '***')
      .replace(API_KEY_LITERAL, '***');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Truncate by code points (so CJK / emoji are not cut in half). */
function clip(value, max) {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/** clean -> redact -> truncate, the order used for every label fragment. */
function fmt(value, max) {
  return clip(redact(clean(value)), max);
}

/** First line of a possibly multi-line string, before any cleaning. */
function firstLine(value) {
  if (typeof value !== 'string') return '';
  const nl = value.indexOf('\n');
  const line = nl === -1 ? value : value.slice(0, nl);
  return line.replace(/\r$/, '');
}

function basenameOf(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return '';
  try {
    return path.basename(filePath);
  } catch {
    return '';
  }
}

function hostOf(url) {
  if (typeof url !== 'string' || url === '') return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname || '';
  } catch {
    return url;
  }
}

/** Drop the `mcp__<server>__` prefix; MCP tools never contribute arguments. */
function mcpToolSuffix(toolName) {
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  const suffix = sep === -1 ? rest : rest.slice(sep + 2);
  return suffix || rest;
}

function buildLabel(event, toolName, toolInput) {
  if (event === 'Notification') return '等待你的确认';
  if (typeof toolName !== 'string' || toolName === '') return undefined;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};

  if (toolName.startsWith('mcp__')) {
    const suffix = fmt(mcpToolSuffix(toolName), 120);
    return suffix || fmt(toolName, 120);
  }
  if (toolName === 'Bash') {
    const command = fmt(firstLine(input.command), 60);
    return command ? `Bash: ${command}` : 'Bash';
  }
  if (FILE_TOOLS.has(toolName)) {
    const filePath = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
    const base = fmt(basenameOf(filePath), 200);
    return base ? `${toolName} ${base}` : toolName;
  }
  if (PATTERN_TOOLS.has(toolName)) {
    const pattern = fmt(typeof input.pattern === 'string' ? input.pattern : '', 40);
    return pattern ? `${toolName} ${pattern}` : toolName;
  }
  if (WEB_TOOLS.has(toolName)) {
    const subject = toolName === 'WebFetch'
      ? hostOf(input.url)
      : (typeof input.query === 'string' ? input.query : '');
    const text = fmt(subject, 40);
    return text ? `${toolName} ${text}` : toolName;
  }
  if (SUBAGENT_TOOLS.has(toolName)) {
    const description = fmt(typeof input.description === 'string' ? input.description : '', 40);
    return description ? `子代理: ${description}` : '子代理';
  }
  return fmt(toolName, 120);
}

function resolveProjectDir(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  if (payload && typeof payload.cwd === 'string' && payload.cwd.trim() !== '') return payload.cwd;
  return process.cwd();
}

function readToken(projectDir) {
  try {
    const tokenPath = path.join(projectDir, '.devtailor', 'agent-hook-token');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    return token === '' ? null : token;
  } catch {
    // No token file: DevTailor Bridge is not running for this project.
    return null;
  }
}

function resolvePort() {
  const raw = process.env.DEVTAILOR_PORT;
  const port = Number.parseInt(typeof raw === 'string' ? raw : '', 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    let idleTimer = null;
    let deadlineTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(data);
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, STDIN_IDLE_MS);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };
    deadlineTimer = setTimeout(finish, STDIN_DEADLINE_MS);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    armIdle();
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        data += chunk;
        if (data.length >= MAX_STDIN_BYTES) {
          finish();
          return;
        }
        armIdle();
      });
      process.stdin.on('end', finish);
      process.stdin.on('close', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

function postStatus(port, token, body) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let req = null;
    try {
      req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/agent-status',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          },
        },
        res => {
          res.on('data', () => {});
          res.on('end', finish);
          res.on('error', finish);
          res.on('close', finish);
        },
      );
    } catch {
      finish();
      return;
    }
    timer = setTimeout(() => {
      finish();
      try {
        req.destroy();
      } catch {
        // ignored: the request is already gone
      }
    }, REQUEST_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    req.on('error', finish);
    req.on('timeout', finish);
    req.on('close', () => {
      // Only settle here when the socket closed without a response event.
      finish();
    });
    try {
      req.end(payload);
    } catch {
      finish();
    }
  });
}

async function main() {
  const raw = await readStdin();
  let hook = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') hook = parsed;
  } catch {
    hook = {};
  }

  const event = typeof hook.hook_event_name === 'string' ? hook.hook_event_name : '';
  if (event === '') return;

  const projectDir = resolveProjectDir(hook);
  const token = readToken(projectDir);
  if (!token) return; // no Bridge for this project: stay silent

  const toolName = typeof hook.tool_name === 'string' && hook.tool_name !== '' ? hook.tool_name : undefined;
  const body = { event };
  if (toolName) body.toolName = toolName;
  const label = buildLabel(event, toolName, hook.tool_input);
  if (typeof label === 'string' && label.trim() !== '') body.label = label;
  if (typeof hook.tool_use_id === 'string' && hook.tool_use_id !== '') body.toolUseId = hook.tool_use_id;

  await postStatus(resolvePort(), token, body);
}

// Nothing may ever escape: no stdout (PreToolUse stdout is parsed by Claude
// Code), no stderr, no non-zero exit code.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
