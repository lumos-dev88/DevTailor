#!/usr/bin/env node
/**
 * Real-Chrome end-to-end check: extension <-> temporary Hub <-> fake Claude Code (MCP stdio).
 * Run with `npm run e2e:ext`. Requires Bun, Chrome, playwright-core, and installed Hub dependencies.
 * The extension's fixed port 34781 must be free. Hub state and the Chrome profile are temporary.
 *
 * Env:
 *   DEVTAILOR_HUB_DIR          Hub checkout (default: ~/代码/devtailor-hub)
 *   DEVTAILOR_PLAYWRIGHT_CORE  path to playwright-core (default: ~/代码/todo/node_modules/playwright-core)
 *   DEVTAILOR_CHROME           Chrome/Chromium executable (default: macOS Google Chrome)
 *   DEVTAILOR_E2E_PROFILE_DIR  parent directory for temporary state (default: os.tmpdir())
 *   DEVTAILOR_E2E_HEADLESS     "0" for a headed window (default: headless=new)
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HUB_DIR = resolve(process.env.DEVTAILOR_HUB_DIR || join(homedir(), '代码/devtailor-hub'));
const CHROME = process.env.DEVTAILOR_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.DEVTAILOR_E2E_HEADLESS !== '0';
const DEVTAILOR_PORT = 34781;
const DEVTAILOR_URL = `http://127.0.0.1:${DEVTAILOR_PORT}`;
const PORT_IN_USE = '当前有 Hub/旧 Bridge 占用 34781，请先停掉再跑';

function loadMcpSdk() {
  const clientDir = join(HUB_DIR, 'hub-client');
  const require = createRequire(join(clientDir, 'package.json'));
  const sdkDir = join(clientDir, 'node_modules', '@modelcontextprotocol', 'sdk');
  try {
    const clientPath = require.resolve('@modelcontextprotocol/sdk/client/index.js');
    const transportPath = require.resolve('@modelcontextprotocol/sdk/client/stdio.js');
    const sdkRoot = realpathSync(sdkDir);
    if (![clientPath, transportPath].every(path => path.startsWith(`${sdkRoot}/`))) {
      throw new Error('SDK resolved outside hub-client/node_modules');
    }
    return { ...require(clientPath), ...require(transportPath) };
  } catch (err) {
    throw new Error(`Cannot load MCP SDK from ${sdkDir}. Run bun install in ${clientDir}. ${err.message}`);
  }
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
async function waitFor(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

async function probePort(port = 0) {
  const server = await listen(net.createServer(), port);
  const boundPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return boundPort;
}

async function portFree(port) {
  try {
    await probePort(port);
    return true;
  } catch (err) {
    if (err.code === 'EADDRINUSE') return false;
    throw err;
  }
}

function startTestServer() {
  const html = readFileSync(join(repo, 'scripts/e2e-fixtures/test-page.html'), 'utf8');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  return listen(server, 0);
}

function startChild(command, args, options) {
  const proc = spawn(command, args, options);
  const child = { proc, exited: false, error: null };
  proc.on('error', err => { child.error = err; });
  child.closed = new Promise(resolve => proc.once('close', () => {
    child.exited = true;
    resolve();
  }));
  return child;
}

async function stopChild(child) {
  if (!child || child.exited) return;
  child.proc.kill('SIGTERM');
  await Promise.race([child.closed, sleep(3000, undefined, { ref: false })]);
  if (!child.exited) {
    child.proc.kill('SIGKILL');
    await child.closed;
  }
}

function jsonFetch(url) {
  return fetch(url, { signal: AbortSignal.timeout(2000) }).then(async res => ({
    status: res.status, data: await res.json(),
  }));
}

function hasKeys(data, keys) {
  return data && Object.keys(data).sort().join(',') === [...keys].sort().join(',');
}

// ---- closed shadow DOM access through CDP (Playwright cannot pierce closed roots) ----
function findHostShadow(node) {
  if (node.attributes && node.attributes.includes('dom-review-host') && node.shadowRoots?.length) {
    return node.shadowRoots[0].nodeId;
  }
  for (const key of ['children', 'shadowRoots']) {
    for (const child of node[key] || []) {
      const hit = findHostShadow(child);
      if (hit) return hit;
    }
  }
  if (node.contentDocument) return findHostShadow(node.contentDocument);
  return null;
}

class ShadowPanel {
  constructor(cdp) {
    this.cdp = cdp;
  }
  async root() {
    const { root } = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const id = findHostShadow(root);
    if (!id) throw new Error('DevTailor shadow host not found');
    return id;
  }
  async node(selector) {
    const rootId = await this.root();
    const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: rootId, selector });
    return nodeId || null;
  }
  async center(selector) {
    const nodeId = await this.node(selector);
    if (!nodeId) return null;
    try {
      const { model } = await this.cdp.send('DOM.getBoxModel', { nodeId });
      const q = model.content;
      if (!model.width || !model.height) return null;
      return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
    } catch {
      return null;
    }
  }
  async click(selector) {
    const c = await waitFor(() => this.center(selector), { timeout: 8000, what: `visible ${selector}` });
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    }
  }
}

/**
 * Branded Chrome (137+) no longer honours --load-extension, so start Chrome with
 * a CDP port, then load the unpacked extension via the browser-level
 * `Extensions.loadUnpacked` command (needs --enable-unsafe-extension-debugging).
 */
async function launchChrome(chromium, userDataDir, resources) {
  const port = await probePort();
  const args = [
    `--remote-debugging-port=${port}`,
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,800',
  ];
  if (HEADLESS) args.push('--headless=new');
  args.push('about:blank');
  resources.chrome = startChild(CHROME, args, { stdio: 'ignore' });
  resources.browser = await waitFor(() => {
    if (resources.chrome.error || resources.chrome.exited) {
      throw resources.chrome.error || new Error('Chrome exited before CDP was ready');
    }
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
  }, { timeout: 20000, what: 'Chrome CDP endpoint' });
  const session = await resources.browser.newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: repo });
  await session.detach();
  return { context: resources.browser.contexts()[0], extensionId: id };
}

async function startHub(scratch, resources) {
  let port;
  do {
    port = await probePort();
  } while (port === 9900 || port === DEVTAILOR_PORT);
  const hubUrl = `http://127.0.0.1:${port}`;
  const isolatedHome = join(scratch, 'home');
  const channelsDir = join(scratch, 'channels');
  mkdirSync(isolatedHome);
  mkdirSync(channelsDir);
  // Load the repository's DevTailor plugin through the normal loader, with only this plugin available.
  const plugin = join(HUB_DIR, 'hub-server', 'channels', 'devtailor.ts');
  writeFileSync(join(channelsDir, 'devtailor.ts'), `export { default } from ${JSON.stringify(plugin)};\n`);
  writeFileSync(join(scratch, 'hub-config.json'), JSON.stringify({ host: '127.0.0.1', port }));
  const env = {
    ...process.env,
    HOME: isolatedHome,
    FORGE_HUB_DIR: scratch,
    FORGE_HUB_URL: hubUrl,
    FORGE_HUB_CHANNELS_DIR: channelsDir,
    FORGE_HUB_DEV: '0',
    HUB_API_TOKEN: randomBytes(32).toString('hex'),
    DEVTAILOR_PORT: String(DEVTAILOR_PORT),
    DEVTAILOR_EXTENSION_ID: '',
    NO_PROXY: '127.0.0.1,localhost',
  };
  const child = startChild('bun', [join(HUB_DIR, 'hub-server', 'hub.ts')], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  resources.hub = child;
  resources.hubLog = '';
  for (const output of [child.proc.stdout, child.proc.stderr]) {
    output.setEncoding('utf8');
    output.on('data', text => { resources.hubLog += text; });
  }
  const ready = await waitFor(async () => {
    if (child.error || child.exited) return 'exited';
    if (/EADDRINUSE|port .*already in use|端口 .* 已被占用/i.test(resources.hubLog)) return 'port collision';
    if (!resources.hubLog.includes(`listening on 127.0.0.1:${DEVTAILOR_PORT}`)) return false;
    return (await jsonFetch(`${hubUrl}/health`)).status === 200
      && (await jsonFetch(`${DEVTAILOR_URL}/health`)).status === 200
      && 'ready';
  }, { what: 'temporary Hub and DevTailor listener' });
  if (resources.hubLog.includes(`端口 ${DEVTAILOR_PORT} 已被占用`)) throw new Error(PORT_IN_USE);
  if (ready !== 'ready') throw child.error || new Error(`Temporary Hub startup failed (${ready})`);
  return env;
}

async function startFakeClaude({ Client, StdioClientTransport }, env, projectDir, resources, channelEvents) {
  writeFileSync(join(env.FORGE_HUB_DIR, 'next-session.json'), JSON.stringify({
    isChannel: true, channels: ['devtailor'], history: { devtailor: 0 },
  }));
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [join(HUB_DIR, 'hub-client', 'hub-channel.ts')],
    cwd: projectDir,
    env: { ...env, DEVTAILOR_PROJECT_DIR: projectDir },
    stderr: 'pipe',
  });
  // SDK initialization can start closing the transport asynchronously when it fails.
  const closeTransport = transport.close.bind(transport);
  let closing;
  transport.close = () => closing ??= closeTransport();
  resources.transport = transport;
  resources.clientLog = '';
  transport.stderr?.setEncoding('utf8');
  transport.stderr?.on('data', text => { resources.clientLog += text; });
  const mcp = new Client({ name: 'fake-claude-code', version: '0' }, { capabilities: {} });
  mcp.fallbackNotificationHandler = async notification => {
    if (notification.method === 'notifications/claude/channel') channelEvents.push(notification.params);
  };
  await mcp.connect(transport, { timeout: 10000 });
  if (process.platform === 'darwin') {
    // hub-channel checks Claude Code's recent registration log before announcing WebSocket readiness.
    // Match getClaudeMcpLogDirs, including its shortened name for long project paths.
    let logProject = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    if (logProject.length > 200) {
      let hash = 5381;
      for (let i = 0; i < projectDir.length; i++) hash = (hash * 33) ^ projectDir.charCodeAt(i);
      logProject = `${logProject.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
    }
    const logDir = join(env.HOME, 'Library', 'Caches', 'claude-cli-nodejs', logProject, 'mcp-logs-hub');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, 'fake-claude.jsonl'), JSON.stringify({
      debug: 'Channel notifications registered', timestamp: new Date().toISOString(), cwd: projectDir,
    }) + '\n');
  }
  return mcp;
}

async function observeExtension(sw) {
  // Observe requests and parsed SSE at the real service worker, before the UI interprets them.
  await sw.evaluate(() => {
    globalThis.e2eHubTraffic = { reviews: [], events: [] };
    const request = bridgeProxyRequest;
    bridgeProxyRequest = async message => {
      const response = await request(message);
      if (message.path === '/review') {
        const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
        globalThis.e2eHubTraffic.reviews.push({ text: body?.payload?.userIntent, response });
      }
      return response;
    };
    const forward = sendBridgeProxyEvent;
    sendBridgeProxyEvent = (tabId, event) => {
      if (event.event === 'message') globalThis.e2eHubTraffic.events.push({ tabId, ...JSON.parse(event.data) });
      forward(tabId, event);
    };
  });
}

async function checkGuard(page, channelEvents, resources) {
  const before = resources.hubLog.length;
  const neg = await page.evaluate(async base => {
    const read = async (path, options) => {
      try {
        const res = await fetch(`${base}${path}`, options);
        return { type: res.type, status: res.status, body: await res.text() };
      } catch {
        return { rejected: true };
      }
    };
    return {
      corsGet: await read('/sessions'),
      noCorsGet: await read('/sessions', { mode: 'no-cors' }),
      noCorsPost: await read('/review', {
        method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ type: 'review', clientId: 'guard-probe', payload: { userIntent: 'E2E-GUARD-PROBE' } }),
      }),
      health: await read('/health'),
    };
  }, DEVTAILOR_URL);
  const guardLog = resources.hubLog.slice(before);
  record('guard: page CORS GET /sessions is unreadable', neg.corsGet.rejected, JSON.stringify(neg.corsGet));
  record('guard: page no-cors GET /sessions is opaque and denied',
    neg.noCorsGet.type === 'opaque' && neg.noCorsGet.status === 0 && neg.noCorsGet.body === ''
      && /denied GET \/sessions reason=missing_origin/.test(guardLog), JSON.stringify(neg.noCorsGet));
  record('guard: page text/plain no-cors POST /review is denied without dispatch',
    neg.noCorsPost.type === 'opaque' && /denied POST \/review /.test(guardLog)
      && !channelEvents.some(event => event.content?.includes('E2E-GUARD-PROBE')), JSON.stringify(neg.noCorsPost));
  const health = await jsonFetch(`${DEVTAILOR_URL}/health`);
  record('guard: public /health exposes only liveness and protocol version',
    health.status === 200 && health.data.ok === true && hasKeys(health.data, ['ok', 'protocolVersion'])
      && (neg.health.rejected || neg.health.body === JSON.stringify(health.data)), JSON.stringify(health.data));
}

async function checkExtension({ chromium, scratch, projectId, resources, mcp, channelEvents, testUrl }) {
  const { context, extensionId } = await launchChrome(chromium, join(scratch, 'profile'), resources);
  const sw = await waitFor(() => context.serviceWorkers().find(worker =>
    worker.url().startsWith(`chrome-extension://${extensionId}/`)), { what: 'extension service worker' });
  record('chrome: unpacked extension and service worker are running', /^[a-p]{32}$/.test(extensionId));
  const swRequest = async (path, method = 'GET', body) => {
    const res = await sw.evaluate(message => bridgeProxyRequest(message), { path, method, body });
    return { status: res.status, data: JSON.parse(res.body || '{}') };
  };
  const rawSw = await sw.evaluate(async base => (await fetch(`${base}/sessions`)).status, DEVTAILOR_URL);
  record('guard: raw service-worker GET /sessions without client header returns 403', rawSw === 403, `status=${rawSw}`);
  const health = await waitFor(async () => {
    const res = await swRequest('/health');
    return res.data.projects?.some(project => project.projectId === projectId) && res;
  }, { what: 'fake Claude project registration in /health' });
  record('extension proxy: trusted /health exposes Hub and registered project',
    health.status === 200 && health.data.ok === true && !!health.data.hubInstanceId
      && health.data.projectId === projectId && health.data.projectName === 'project');
  const sessions = await swRequest('/sessions');
  record('extension proxy: trusted GET /sessions returns 200',
    sessions.status === 200 && sessions.data.ok === true && Array.isArray(sessions.data.sessions));
  await observeExtension(sw);
  const traffic = () => sw.evaluate(() => globalThis.e2eHubTraffic);

  const page = await context.newPage();
  page.on('pageerror', err => console.log('[page error]', err.message));
  await page.goto(testUrl);
  await page.bringToFront();
  await checkGuard(page, channelEvents, resources);

  const callTool = (name, args = {}) => mcp.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const beforeTakeover = await callTool('get_page_snapshot');
  record('tool: get_page_snapshot without takeover reports NO_ACTIVE_TAB',
    beforeTakeover.isError === true && JSON.stringify(beforeTakeover.content).includes('NO_ACTIVE_TAB'));
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  const panel = new ShadowPanel(cdp);
  await waitFor(() => panel.node('#dt-tb'), { what: 'in-page toolbar' });
  record('content script: in-page toolbar injected', true);
  await waitFor(() => panel.node('#dt-status[data-state="idle"]'), { what: 'toolbar connected to Hub' });
  record('in-page toolbar: connected to Hub before takeover', true);
  await panel.click('#dt-status');
  await waitFor(() => panel.node('#dt-status[data-state="taken"]'), { what: 'tab takeover' });
  const { data: taken } = await swRequest('/health');
  const clientId = taken.activeClientId;
  record('takeover: Hub reports the active Chrome tab', /^tab_\d+$/.test(clientId), `clientId=${clientId}`);

  const snap = await callTool('get_page_snapshot');
  record('tool: get_page_snapshot returns the fixture page',
    !snap.isError && JSON.stringify(snap.content).includes('DevTailor E2E'), JSON.stringify(snap.content).slice(0, 160));
  const click = await callTool('click_page', { selector: '#btn' });
  record('tool: click_page increments the fixture counter',
    !click.isError && await page.textContent('#count') === '1', JSON.stringify(click.content).slice(0, 160));
  const shot = await callTool('take_visible_screenshot');
  const shotBody = JSON.parse(shot.isError ? '{}' : shot.content[0].text);
  const savedPath = shotBody.result?.data?.match(/; saved to (.+)\]$/)?.[1];
  const imageDir = join(scratch, 'devtailor', 'images');
  const jpeg = savedPath && dirname(savedPath) === imageDir && existsSync(savedPath) && readFileSync(savedPath);
  record('tool: take_visible_screenshot saves a JPEG in the temporary Hub',
    !shot.isError && shotBody.ok === true && jpeg?.[0] === 0xff && jpeg?.[1] === 0xd8,
    JSON.stringify(shot.content).slice(0, 260));

  // Open the production side panel page as an extension tab so Playwright can drive its composer.
  const sp = await context.newPage();
  await sp.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await waitFor(async () => (await sp.textContent('#bridge-status'))?.includes('已连接'), { what: 'side panel connected' });
  record('side panel: connected to Hub', true, await sp.textContent('#bridge-status'));
  await waitFor(async () => (await sp.textContent('#active-tab')) === clientId, { what: 'side panel follows taken-over tab' });
  record('side panel: follows the taken-over tab', true, clientId);

  const messages = sp.locator('#messages');
  const send = async (text, { accepted = true } = {}) => {
    await sp.fill('#prompt', text);
    await sp.locator('#send-btn').click();
    const hit = await waitFor(async () => (await traffic()).reviews.find(entry =>
      entry.text === text), { what: `HTTP response to ${text}` });
    if (accepted) await waitFor(async () => await sp.inputValue('#prompt') === '', { what: 'composer ready after acceptance' });
    return { status: hit.response.status, data: JSON.parse(hit.response.body || '{}') };
  };
  const notification = text => waitFor(() => channelEvents.find(event =>
    event.meta?.hub_channel === 'devtailor' && event.meta.kind === 'review' && event.content?.includes(text)),
  { what: `Claude channel notification for ${text}` });
  const accepted = res => res.status === 202 && res.data.ok === true && !!res.data.turnId
    && !!res.data.sessionId && hasKeys(res.data, ['ok', 'turnId', 'sessionId']);
  const reply = (turnId, text, args = {}) => callTool('reply', { turn_id: turnId, text, ...args });
  const waitForStream = text => waitFor(async () => (await traffic()).events.find(event =>
    event.type === 'stream' && event.delta === text), { what: `SSE stream for ${text}` });

  const msg1 = 'E2E first sidebar message';
  const msg2 = 'E2E second sidebar message';
  const first = await send(msg1);
  const second = await send(msg2);
  record('/review: both sidebar sends return 202 with exactly ok, turnId and sessionId', accepted(first) && accepted(second),
    `${first.status} ${JSON.stringify(first.data)} | ${second.status} ${JSON.stringify(second.data)}`);
  const [ev1, ev2] = await Promise.all([notification(msg1), notification(msg2)]);
  record('channel: both reviews reach fake Claude before any reply, with distinct turns in the same session',
    ev1.meta.turn_id === first.data.turnId && ev2.meta.turn_id === second.data.turnId
      && ev1.meta.turn_id !== ev2.meta.turn_id && first.data.sessionId === second.data.sessionId
      && [ev1, ev2].every(event => event.meta.page_url === testUrl && event.meta.client_id === clientId));

  const replyTexts = ['E2E first assistant message.', 'E2E second assistant message.', 'E2E reply after final.'];
  const replies = [
    await reply(ev1.meta.turn_id, replyTexts[0], { final: false }),
    await reply(ev1.meta.turn_id, replyTexts[1], { final: true }),
    await reply(ev1.meta.turn_id, replyTexts[2]),
  ];
  const streams = await Promise.all(replyTexts.map(waitForStream));
  record('stream: each reply is an independent assistant message, including a reply after final:true',
    replies.every(result => !result.isError) && streams.every((event, index) =>
      event.turnId === first.data.turnId && event.sessionId === first.data.sessionId
      && event.appendAssistantDelta === true && event.displayMessage?.role === 'assistant'
      && event.displayMessage?.id && event.displayMessage.content === replyTexts[index])
      && new Set(streams.map(event => event.displayMessage?.id)).size === replyTexts.length);
  const assistantBubbles = messages.locator('.dt-chat-md');
  for (const text of replyTexts) await assistantBubbles.filter({ hasText: text }).waitFor({ timeout: 10000 });
  const bubbleTexts = (await assistantBubbles.allTextContents()).map(text => text.trim());
  record('side panel: renders three separate assistant bubbles',
    JSON.stringify(bubbleTexts) === JSON.stringify(replyTexts), JSON.stringify(bubbleTexts));

  await sp.locator('#btn-new-session').click();
  const newSession = await waitFor(async () => {
    const res = await swRequest(`/sessions/active?clientId=${encodeURIComponent(clientId)}`);
    return res.status === 200 && res.data.activeSessionId !== first.data.sessionId && res.data;
  }, { what: 'new active session' });
  const sessionList = await swRequest('/sessions');
  await waitFor(async () => await assistantBubbles.count() === 0, { what: 'new empty sidebar conversation' });
  record('sessions: new session is empty and the previous session remains listed',
    !!newSession.activeSessionId && newSession.messages?.length === 0
      && sessionList.data.activeSessionId === newSession.activeSessionId
      && sessionList.data.sessions?.some(session => session.sessionId === first.data.sessionId));

  const msg3 = 'E2E review in the new session';
  const third = await send(msg3);
  const ev3 = await notification(msg3);
  const oldText = 'E2E reply routed to the old session.';
  const oldReply = await reply(ev1.meta.turn_id, oldText);
  const oldStream = await waitForStream(oldText);
  const latestText = 'E2E reply routed to the latest review.';
  const latestReply = await callTool('reply', { text: latestText });
  const latestStream = await waitForStream(latestText);
  await assistantBubbles.filter({ hasText: latestText }).waitFor({ timeout: 10000 });
  record('sessions: explicit turn replies route to the old session and omitted turn replies route to the latest review',
    accepted(third) && third.data.sessionId === newSession.activeSessionId && third.data.turnId === ev3.meta.turn_id
      && !oldReply.isError && oldStream.turnId === first.data.turnId && oldStream.sessionId === first.data.sessionId
      && oldStream.activeSessionId === newSession.activeSessionId && !latestReply.isError
      && latestStream.turnId === third.data.turnId && latestStream.sessionId === newSession.activeSessionId
      && !(await messages.textContent()).includes(oldText));

  const cancel = await swRequest('/cancel', 'POST', { clientId });
  const cancelEvent = await waitFor(() => channelEvents.find(event =>
    event.meta?.hub_channel === 'devtailor' && event.meta.kind === 'cancel' && event.meta.turn_id === ev3.meta.turn_id),
  { what: 'Claude cancel notification' });
  const cancelStatus = await waitFor(async () => (await traffic()).events.find(event =>
    event.type === 'tool_status' && event.toolStatus === 'canceled' && event.sessionId === third.data.sessionId),
  { what: 'SSE canceled tool status' });
  record('cancel: /cancel signals the latest turn and emits canceled tool_status',
    cancel.status === 200 && cancel.data.canceled === true && cancelEvent.meta.client_id === clientId
      && cancelStatus.sessionId === third.data.sessionId);
  const lateText = 'E2E reply after cancellation.';
  const late = await reply(ev3.meta.turn_id, lateText, { final: true });
  const lateStream = await waitForStream(lateText);
  record('cancel: explicit reply after cancellation still routes to its session',
    !late.isError && lateStream.turnId === third.data.turnId && lateStream.sessionId === third.data.sessionId);

  await mcp.close();
  await waitFor(async () => (await swRequest('/health')).data.projects?.length === 0,
    { what: 'Hub sees fake Claude disconnect' });
  const offlineText = 'E2E review with no online Claude';
  const offline = await send(offlineText, { accepted: false });
  await waitFor(async () => (await traffic()).events.find(event =>
    event.type === 'error' && event.code === 'no_claude_instance'), { what: 'offline Claude SSE error' });
  await sp.locator('#sidepanel-hint.show').filter({ hasText: '没有在线的 Claude Code 实例' }).waitFor({ timeout: 10000 });
  record('/review: offline Claude returns 503 no_claude_instance and the side panel shows the error',
    offline.status === 503 && offline.data.ok === false && offline.data.error === 'no_claude_instance'
      && offline.data.message?.includes('没有在线的 Claude Code 实例')
      && hasKeys(offline.data, ['ok', 'error', 'message']) && await sp.inputValue('#prompt') === offlineText,
    JSON.stringify(offline.data));
  const legacyEvents = (await traffic()).events.filter(event =>
    ['done', 'isProcessing', 'queue_status'].includes(event.type) || Object.hasOwn(event, 'isProcessing'));
  record('SSE: no done, isProcessing or queue_status during the scenario', legacyEvents.length === 0,
    legacyEvents.map(event => event.type).join(', '));
}

async function main() {
  if (!(await portFree(DEVTAILOR_PORT))) throw new Error(PORT_IN_USE);
  const sdk = loadMcpSdk();
  const { chromium } = createRequire(import.meta.url)(
    process.env.DEVTAILOR_PLAYWRIGHT_CORE || join(homedir(), '代码/todo/node_modules/playwright-core'),
  );
  const scratchDir = mkdtempSync(join(process.env.DEVTAILOR_E2E_PROFILE_DIR || tmpdir(), 'devtailor-e2e-'));
  const resources = {};
  try {
    const scratch = realpathSync(scratchDir);
    const projectDir = join(scratch, 'project');
    mkdirSync(projectDir);
    const projectId = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
    const env = await startHub(scratch, resources);
    console.log(`temporary Hub: ${env.FORGE_HUB_URL}, DevTailor: ${DEVTAILOR_URL}`);
    console.log(`chrome: ${CHROME} (${HEADLESS ? 'headless=new' : 'headed'})`);
    const channelEvents = [];
    const mcp = await startFakeClaude(sdk, env, projectDir, resources, channelEvents);
    const tools = (await mcp.listTools(undefined, { timeout: 10000 })).tools;
    const required = ['reply', 'get_page_snapshot', 'click_page', 'take_visible_screenshot'];
    const missing = required.filter(name => !tools.some(tool => tool.name === name));
    record('mcp: tools/list includes reply and all three browser tools', missing.length === 0, missing.join(', '));
    resources.testServer = await startTestServer();
    const testUrl = `http://127.0.0.1:${resources.testServer.address().port}/`;
    await checkExtension({ chromium, scratch, projectId, resources, mcp, channelEvents, testUrl });
  } catch (err) {
    if (resources.hubLog) console.error(resources.hubLog.trimEnd());
    if (resources.clientLog) console.error(resources.clientLog.trimEnd());
    throw err;
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        try {
          await resources.browser?.close();
        } finally {
          await stopChild(resources.chrome);
        }
      })(),
      resources.transport?.close(),
    ]);
    cleanup.push(...await Promise.allSettled([
      stopChild(resources.hub),
      new Promise(resolve => {
        if (!resources.testServer) return resolve();
        resources.testServer.close(resolve);
        resources.testServer.closeAllConnections();
      }),
    ]));
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 3 });
    for (const result of cleanup) {
      if (result.status === 'rejected') record('shutdown: cleanup error', false, String(result.reason));
    }
    if (resources.hub) record('shutdown: temporary Hub released port 34781', await portFree(DEVTAILOR_PORT));
  }
}

try {
  await main();
} catch (err) {
  record('e2e aborted', false, err instanceof Error ? err.message : String(err));
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
