#!/usr/bin/env node
/**
 * Real-Chrome end-to-end check: extension <-> guarded bridge <-> fake Claude Code.
 *
 * NOT part of `npm test` (needs a local Chrome and playwright-core).
 *
 *   node scripts/e2e-extension.mjs
 *
 * Env:
 *   DEVTAILOR_PLAYWRIGHT_CORE  path to playwright-core  (default: ~/代码/todo/node_modules/playwright-core)
 *   DEVTAILOR_CHROME           Chrome/Chromium executable (default: macOS Google Chrome)
 *   DEVTAILOR_E2E_PROFILE_DIR  parent dir for the temp user-data-dir (default: os.tmpdir())
 *   DEVTAILOR_E2E_HEADLESS     "0" for a headed window (default headless=new)
 *   DEVTAILOR_E2E_BUNDLE       bridge entry (default claude-plugin/server/mcp-main.cjs, else devtailor-bridge/dist/mcp-main.js)
 *
 * The extension is fixed to port 34781, so that port must be free.
 * The fake MCP client plays Claude Code: it receives `notifications/claude/channel`
 * and answers with the `reply` tool and browser tools. No real Claude session is used.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDir = join(repo, 'devtailor-bridge');
const require = createRequire(join(bridgeDir, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { chromium } = createRequire(import.meta.url)(
  process.env.DEVTAILOR_PLAYWRIGHT_CORE || join(homedir(), '代码/todo/node_modules/playwright-core'),
);

const CHROME = process.env.DEVTAILOR_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.DEVTAILOR_E2E_HEADLESS !== '0';
const BRIDGE_PORT = 34781;
const bundleCandidates = [
  process.env.DEVTAILOR_E2E_BUNDLE,
  join(repo, 'claude-plugin/server/mcp-main.cjs'),
  join(bridgeDir, 'dist/mcp-main.js'),
].filter(Boolean);
const BUNDLE = bundleCandidates.find(p => existsSync(p));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
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

function portFree(port) {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
  });
}

// ---- static test page ------------------------------------------------------
function startTestServer() {
  const html = readFileSync(join(repo, 'scripts/e2e-fixtures/test-page.html'), 'utf8');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(server)));
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
  async html(selector) {
    const nodeId = await this.node(selector);
    if (!nodeId) return '';
    const { outerHTML } = await this.cdp.send('DOM.getOuterHTML', { nodeId });
    return outerHTML;
  }
  async text(selector) {
    return (await this.html(selector)).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  async type(selector, text) {
    await this.click(selector);
    await this.cdp.send('Input.insertText', { text });
  }
}

/**
 * Branded Chrome (137+) no longer honours --load-extension, so start Chrome with
 * a CDP port, then load the unpacked extension via the browser-level
 * `Extensions.loadUnpacked` command (needs --enable-unsafe-extension-debugging).
 */
async function launchChrome(userDataDir, extensionPath) {
  const port = await new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
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
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  const browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`), { timeout: 20000, what: 'Chrome CDP endpoint' });
  const session = await browser.newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  const context = browser.contexts()[0];
  return { proc, browser, context, extensionId: id };
}

async function main() {
  if (!BUNDLE) throw new Error('no bridge entry found: run `npm run build:plugin` (or `npm run build`) in devtailor-bridge');
  if (!(await portFree(BRIDGE_PORT))) {
    throw new Error(`port ${BRIDGE_PORT} is in use (a live DevTailor bridge?). Stop it first; the extension is fixed to this port.`);
  }
  console.log(`bridge entry: ${BUNDLE}`);
  console.log(`chrome: ${CHROME} (${HEADLESS ? 'headless=new' : 'headed'})`);

  const scratch = mkdtempSync(join(process.env.DEVTAILOR_E2E_PROFILE_DIR || tmpdir(), 'devtailor-e2e-'));
  const projectDir = join(scratch, 'project');
  mkdirSync(projectDir, { recursive: true });
  const profileDir = join(scratch, 'profile');

  const testServer = await startTestServer();
  const testUrl = `http://127.0.0.1:${testServer.address().port}/`;

  // fake Claude Code
  const channelEvents = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    env: { ...process.env, DEVTAILOR_PROJECT_DIR: projectDir },
    stderr: 'pipe',
  });
  let bridgeStderr = '';
  transport.stderr?.on('data', d => (bridgeStderr += d));
  const mcp = new Client({ name: 'fake-claude-code', version: '0' }, { capabilities: {} });
  mcp.fallbackNotificationHandler = async n => {
    if (n.method === 'notifications/claude/channel') channelEvents.push(n.params);
  };
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools;
  record('mcp: tools/list = 19 incl. reply', tools.length === 19 && tools.some(t => t.name === 'reply'), `${tools.length} tools`);

  let context;
  let chrome;
  try {
    chrome = await launchChrome(profileDir, repo);
    context = chrome.context;
    const extId = chrome.extensionId;
    const isOurs = w => w.url().startsWith(`chrome-extension://${extId}/`);
    let sw = context.serviceWorkers().find(isOurs);
    if (!sw) {
      sw = await waitFor(() => context.serviceWorkers().find(isOurs), { timeout: 15000, what: 'extension service worker' });
    }
    record('chrome: extension loaded, service worker up', /^[a-p]{32}$/.test(extId), `id=${extId}`);

    // 1. service worker -> guarded bridge
    // Through the extension's own proxy (adds the X-DevTailor-Client header).
    const swFetch = path =>
      sw.evaluate(async p => {
        const r = await bridgeProxyRequest({ path: p, method: 'GET' });
        return { status: r.status, body: r.body || '' };
      }, path);
    // Raw service-worker fetch without the header: documents that Chrome sends no Origin on SW GETs.
    const rawSw = await sw.evaluate(async () => {
      const r = await fetch('http://127.0.0.1:34781/sessions');
      return r.status;
    });
    record('finding: raw SW GET carries no Origin, so the guard refuses it without the client header', rawSw === 403, `status=${rawSw}`);
    const health = await swFetch('/health');
    const healthBody = JSON.parse(health.body || '{}');
    record('extension proxy -> GET /health 200 with extension-only fields', health.status === 200 && !!healthBody.projectId, health.body.slice(0, 120));
    const sessions = await swFetch('/sessions');
    record('extension proxy -> GET /sessions 200 (client header accepted)', sessions.status === 200, `status=${sessions.status}`);

    // 2. open test page; content script loads
    const page = await context.newPage();
    page.on('pageerror', e => console.log('[page error]', e.message));
    await page.goto(testUrl);
    await page.bringToFront();

    // 3. guard negative cases from the web page itself
    const guardStderrBefore = bridgeStderr.length;
    const neg = await page.evaluate(async () => {
      const out = {};
      try {
        const r = await fetch('http://127.0.0.1:34781/sessions');
        out.corsGet = `readable status=${r.status}`;
      } catch (e) {
        out.corsGet = 'rejected';
      }
      try {
        const r = await fetch('http://127.0.0.1:34781/sessions', { mode: 'no-cors' });
        out.noCorsGet = r.type === 'opaque' ? `opaque status=${r.status}` : `readable type=${r.type}`;
        out.noCorsGetText = await r.text();
      } catch (e) {
        out.noCorsGet = 'rejected';
      }
      try {
        const r = await fetch('http://127.0.0.1:34781/review', {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ clientId: 'evil', payload: { message: 'EVIL-NO-CORS' } }),
        });
        out.noCorsPost = `type=${r.type}`;
      } catch (e) {
        out.noCorsPost = 'rejected';
      }
      try {
        const r = await fetch('http://127.0.0.1:34781/health');
        out.healthBody = await r.text();
      } catch (e) {
        out.healthBody = 'rejected';
      }
      return out;
    });
    await sleep(500);
    const guardLog = bridgeStderr.slice(guardStderrBefore);
    record('guard: page CORS GET /sessions not readable', neg.corsGet === 'rejected', neg.corsGet);
    record(
      'guard: page no-cors GET /sessions opaque + denied by server',
      /opaque/.test(neg.noCorsGet) && neg.noCorsGetText === '' && /denied GET \/sessions/.test(guardLog),
      `${neg.noCorsGet}; log=${/denied GET \/sessions/.test(guardLog)}`,
    );
    record(
      'guard: page text/plain no-cors POST /review denied, nothing dispatched',
      /denied POST \/review/.test(guardLog) && !channelEvents.some(e => /EVIL-NO-CORS/.test(e.content)),
      `log=${/denied POST \/review/.test(guardLog)} events=${channelEvents.length}`,
    );
    record(
      'guard: page-visible /health is minimal (no project info)',
      !/projectId|projectName|pid/.test(neg.healthBody) || neg.healthBody === 'rejected',
      neg.healthBody.slice(0, 80),
    );

    // 4. in-page panel: connect + takeover (closed shadow root, via CDP)
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable');
    const panel = new ShadowPanel(cdp);
    await waitFor(() => panel.node('#dt-sidebar'), { what: 'in-page panel injected' });
    record('content script: in-page panel injected on 127.0.0.1 page', true);
    if (!(await panel.center('#dt-chat-input'))) await panel.click('#dt-fab');
    await waitFor(() => panel.center('#dt-chat-input'), { what: 'panel visible' });

    await waitFor(async () => /已连接|已接管/.test(await panel.text('#dt-status-text')), { what: 'panel connected', timeout: 20000 });
    record('in-page panel: shows connected to bridge', true, await panel.text('#dt-status-text'));
    await panel.click('#dt-btn-activate-tab');
    await waitFor(async () => /已接管/.test(await panel.text('#dt-status-text')), { what: 'takeover', timeout: 10000 });
    const h2 = JSON.parse((await swFetch('/health')).body);
    record('takeover: bridge reports an active client', !!h2.activeClientId, `activeClientId=${h2.activeClientId}`);

    // 5. send a message from the in-page panel -> channel notification
    const msg1 = 'E2E ping from the in-page panel';
    await panel.type('#dt-chat-input', msg1);
    await sleep(300);
    if (process.env.E2E_DEBUG) console.log('send btn:', (await panel.html('#dt-btn-send')).slice(0, 300), '| hint:', await panel.text('#dt-chat-hint'), '| input:', (await panel.html('#dt-chat-input')).slice(0,200));
    await panel.click('#dt-btn-send');
    await sleep(500);
    if (process.env.E2E_DEBUG) console.log('after send; msgs:', (await panel.text('#dt-chat-messages')).slice(0, 300), '| hint:', await panel.text('#dt-chat-hint'));
    const ev1 = await waitFor(() => channelEvents.find(e => e.content.includes(msg1)), { what: 'channel notification (in-page)', timeout: 15000 });
    record(
      'channel: in-page message arrived as notifications/claude/channel',
      ev1.meta?.kind === 'review' && !!ev1.meta.turn_id && /^https?:/.test(ev1.meta.page_url || ''),
      `kind=${ev1.meta?.kind} turn_id=${ev1.meta?.turn_id}`,
    );

    // 6. fake Claude: browser tools, then streamed reply
    const snap = await mcp.callTool({ name: 'get_page_snapshot', arguments: {} });
    const snapText = JSON.stringify(snap.content);
    record('tool: get_page_snapshot returns the test page', !snap.isError && snapText.includes('DevTailor E2E'), snap.isError ? snapText.slice(0, 200) : 'ok');

    const click = await mcp.callTool({ name: 'click_page', arguments: { selector: '#btn' } });
    const counter = await page.textContent('#count');
    record('tool: click_page took effect in the page', !click.isError && counter === '1', `count=${counter}${click.isError ? ' ' + JSON.stringify(click.content).slice(0, 200) : ''}`);

    await mcp.callTool({ name: 'reply', arguments: { turn_id: ev1.meta.turn_id, text: 'E2E reply part one.' } });
    await mcp.callTool({ name: 'reply', arguments: { turn_id: ev1.meta.turn_id, text: 'Part two done.', final: true } });
    await waitFor(async () => (await panel.text('#dt-chat-messages')).includes('Part two done'), { what: 'streamed reply in in-page panel', timeout: 10000 });
    const shown = await panel.text('#dt-chat-messages');
    record('stream: reply text rendered in the in-page panel', shown.includes('E2E reply part one') && shown.includes('Part two done'));

    // 7. side panel page (regular extension page opened as a tab)
    const sp = await context.newPage();
    await sp.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
    await waitFor(async () => /已连接|SSE/.test(await sp.textContent('#bridge-status')), { what: 'sidepanel connected', timeout: 15000 });
    record('sidepanel page: bridge status connected', true, await sp.textContent('#bridge-status'));
    const spTab = await sp.textContent('#active-tab');
    record('sidepanel page: sees the taken-over tab', spTab && spTab !== '-' && spTab !== '未接管', `active=${spTab}`);
    const msg2 = 'E2E ping from the side panel';
    await sp.fill('#prompt', msg2).catch(async () => {
      // fall back to whatever the composer is called
      const ta = await sp.$('textarea');
      await ta.fill(msg2);
    });
    await sp.keyboard.press('Enter');
    const ev2 = await waitFor(() => channelEvents.find(e => e.content.includes(msg2)), { what: 'channel notification (sidepanel)', timeout: 15000 });
    record('channel: side panel message arrived', !!ev2.meta?.turn_id, `turn_id=${ev2.meta?.turn_id}`);
    await mcp.callTool({ name: 'reply', arguments: { turn_id: ev2.meta.turn_id, text: 'Side panel reply OK.', final: true } });
    await waitFor(async () => (await sp.textContent('#messages')).includes('Side panel reply OK'), { what: 'reply in sidepanel', timeout: 10000 });
    record('stream: reply text rendered in the side panel page', true);

    // 8. cancel path: message -> cancel -> channel gets kind=cancel
    const msg3 = 'E2E message to be cancelled';
    await sp.fill('#prompt', msg3);
    await sp.keyboard.press('Enter');
    const ev3 = await waitFor(() => channelEvents.find(e => e.content.includes(msg3)), { what: 'channel notification (cancel case)', timeout: 15000 });
    const cancelRes = await sw.evaluate(
      async clientId =>
        (await bridgeProxyRequest({ path: '/cancel', method: 'POST', body: { clientId, tabId: clientId } })).status,
      h2.activeClientId,
    );
    const cancelEv = await waitFor(() => channelEvents.find(e => e.meta?.kind === 'cancel' && e.meta.turn_id === ev3.meta.turn_id), { what: 'cancel notification', timeout: 8000 }).catch(() => null);
    record('cancel: /cancel pushes kind=cancel for the same turn_id', !!cancelEv, `status=${cancelRes}`);
    const late = await mcp.callTool({ name: 'reply', arguments: { turn_id: ev3.meta.turn_id, text: 'late', final: true } });
    record('cancel: reply to a cancelled turn is rejected', !!late.isError);

    // 9. screenshot (best effort in automation)
    const shot = await mcp.callTool({ name: 'take_visible_screenshot', arguments: {} });
    const hasImage = (shot.content || []).some(c => c.type === 'image');
    record('tool: take_visible_screenshot returns image content (best effort)', !shot.isError && hasImage, shot.isError ? JSON.stringify(shot.content).slice(0, 200) : `image=${hasImage}`);
  } finally {
    await chrome?.browser.close().catch(() => {});
    chrome?.proc.kill();
    await mcp.close().catch(() => {});
    testServer.close();
    await sleep(500);
    console.log(bridgeStderr.split('\n').filter(l => /\[Guard\]/.test(l)).map(l => '  bridge: ' + l).join('\n'));
    record('shutdown: bridge port released after MCP client closes', await portFree(BRIDGE_PORT));
    rmSync(scratch, { recursive: true, force: true });
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
