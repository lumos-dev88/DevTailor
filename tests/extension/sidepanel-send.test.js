'use strict';
// 侧边栏两个修复的契约测试：
// 1) updateSendState / executeSend / handleSend：无接管也能发纯聊天，payload 不带页面上下文；
// 2) 面板独立 clientId（panel_<tabId>）订阅 SSE，worker 按该 id 路由广播。
// sidepanel.js 是 IIFE + DOM，这里对真实源码做契约断言，并用「同源真值表」验证门槛逻辑。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const js = read('sidepanel/sidepanel.js');
const sw = read('background/service-worker.js');

/* ── updateSendState：发送门槛 ─────────────────────────────────── */

function extractFn(name) {
  const m = new RegExp(`function ${name}\\((\\{[\\s\\S]*?|)[\\s\\S]*?\\n  \\}`).exec(js);
  assert.ok(m, `${name} not found`);
  return m[0];
}

function extractUpdateSendState() {
  return extractFn('updateSendState');
}

/** 从 updateSendState 真实源码推出「输入 -> 是否可发」的判断函数（与实现同源）。 */
function buildSendGate() {
  const body = extractUpdateSendState();
  const canSendExpr = /const canSend = ([^;]+);/.exec(body)[1];
  const sendExpr = /sendBtn\.disabled = ([^;]+);/.exec(body)[1];
  return ({ clientId, hasText, hasImages, marks, references }) => {
    // hasReferences / hasPageContext 由实现自身计算；这里复刻同样的依赖关系。
    const refs = clientId ? Number(references) || 0 : 0;
    const scope = {
      hasText: Boolean(hasText),
      hasImages: Boolean(hasImages),
      hasPageContext: Boolean(clientId) && ((Number(marks) || 0) > 0 || refs > 0),
    };
    scope.canSend = new Function(
      'hasText', 'hasImages', 'hasPageContext',
      `return (${canSendExpr});`
    )(scope.hasText, scope.hasImages, scope.hasPageContext);
    const disabled = new Function(
      'sendInProgress', 'canSend',
      `return (${sendExpr});`
    )(false, scope.canSend);
    return { canSend: scope.canSend, disabled };
  };
}

test('updateSendState: 不再用 Boolean(clientId) 作总开关，canSend 只看内容', () => {
  const src = extractUpdateSendState();
  assert.doesNotMatch(src, /const connected = Boolean\(clientId\)/);
  assert.match(src, /const canSend = hasText \|\| hasImages \|\| hasPageContext;/);
  assert.match(src, /sendBtn\.disabled = sendInProgress \|\| !canSend;/);
});

test('updateSendState: 标记 / 参考仍要求已接管', () => {
  const src = extractUpdateSendState();
  assert.match(src, /const hasReferences = clientId && referencesTray\.count\(\) > 0;/);
  assert.match(src, /const hasPageContext = Boolean\(clientId\) && \(markTray\.hasContent\(\) \|\| hasReferences\);/);
  assert.match(src, /const cancellable = \(Boolean\(clientId\) \|\| Boolean\(panelClientId\)\) && hasCancellable\(\);/);
});

test('发送门槛真值表：只有文字/图片可发、只有标记需接管、皆空禁用', () => {
  const gate = buildSendGate();
  // 无接管 + 文字 -> 可发
  assert.deepStrictEqual(gate({ clientId: null, hasText: true }), { canSend: true, disabled: false });
  // 无接管 + 图片 -> 可发
  assert.deepStrictEqual(gate({ clientId: null, hasImages: true }), { canSend: true, disabled: false });
  // 无接管 + 仅标记 -> 不可发
  assert.deepStrictEqual(gate({ clientId: null, marks: 1 }), { canSend: false, disabled: true });
  // 无接管 + 仅参考 -> 不可发
  assert.deepStrictEqual(gate({ clientId: null, references: 1 }), { canSend: false, disabled: true });
  // 有接管 + 仅标记 -> 可发
  assert.deepStrictEqual(gate({ clientId: 'tab_7', marks: 1 }), { canSend: true, disabled: false });
  // 有接管 + 仅参考 -> 可发
  assert.deepStrictEqual(gate({ clientId: 'tab_7', references: 1 }), { canSend: true, disabled: false });
  // 两者皆无 -> 禁用（无论是否接管）
  assert.deepStrictEqual(gate({ clientId: null }), { canSend: false, disabled: true });
  assert.deepStrictEqual(gate({ clientId: 'tab_7' }), { canSend: false, disabled: true });
});

test('发送门槛：在途 POST（sendInProgress）一律禁用', () => {
  const body = extractUpdateSendState();
  const sendExpr = /sendBtn\.disabled = ([^;]+);/.exec(body)[1];
  const disabledDuringPost = new Function('sendInProgress', `return (${sendExpr});`)(true, true);
  assert.strictEqual(disabledDuringPost, true);
});

/* ── 发送 payload：无 clientId 时不带页面上下文 ─────────────────── */

function extractExecuteSend() {
  const m = /async function executeSend\(text, images\) \{[\s\S]*?\n  \}/.exec(js);
  assert.ok(m, 'executeSend not found');
  return m[0];
}

test('executeSend: 无 clientId 时跳过 buildPayload / 参考，pageUrl 为空，clientId 回退 panelClientId', () => {
  const src = extractExecuteSend();
  // 不再是开头的 `if (!clientId) return` guard
  assert.doesNotMatch(src.slice(0, 200), /if \(!clientId\)/);
  assert.match(src, /const parts = clientId \? await markTray\.controller\.buildPayload\(\) : null;/);
  assert.match(src, /pageUrl: parts \? parts\.pageUrl : '',/);
  assert.match(src, /const referenceList = clientId\s*\n\s*\? await runtimeMessage\(\{ type: referencesCore\.MSG\.GET \}\)/);
  assert.match(src, /const sendClientId = clientId \|\| panelClientId \|\| \(await ensurePanelClientId\(\)\);/);
  assert.match(src, /clientId: sendClientId,\n\s*tabId: sendClientId,/);
});

test('取消 / 新会话也不再把 clientId 当前置条件（回退 panelClientId）', () => {
  assert.match(js, /const targetClientId = clientId \|\| \(await ensurePanelClientId\(\)\);/);
  assert.match(js, /const res = await call\('\/new-session', \{ method: 'POST', body: \{ clientId: targetClientId, tabId: targetClientId \} \}\)/);
  const stop = /async function handleStop\(\) \{[\s\S]*?\n  \}/.exec(js);
  assert.ok(stop, 'handleStop not found');
  assert.match(stop[0], /const targetClientId = clientId \|\| panelClientId \|\| \(await ensurePanelClientId\(\)\);/);
});

test('payload 形状：无接管时 pageUrl/items/references 为空，clientId=panelClientId', () => {
  const src = extractExecuteSend();
  const payloadBlock = /const payload = \{[\s\S]*?\n    \};/.exec(src);
  assert.ok(payloadBlock, 'payload literal not found');
  assert.match(payloadBlock[0], /pageUrl: parts \? parts\.pageUrl : '',/);
  assert.match(payloadBlock[0], /items: parts \? parts\.items : \[\],/);
  // parts 只在 clientId 时构造 -> 无接管时三者都是空值
  assert.match(src, /const parts = clientId \? await markTray\.controller\.buildPayload\(\) : null;/);
});

test('handleSend: 空内容判断不把 clientId 当前置条件，未接管也能发', () => {
  const m = /async function handleSend\(\) \{[\s\S]*?\n  \}/.exec(js);
  assert.ok(m, 'handleSend not found');
  const src = m[0];
  assert.match(src, /const hasPageContext = Boolean\(clientId\) && \(markTray\.hasContent\(\) \|\| referencesTray\.count\(\) > 0\);/);
  assert.match(src, /if \(!bridgeReachable\) \{/);
  assert.doesNotMatch(src, /未接管当前标签/);
});

/** Hub buildPrompt 的最小等价实现（channels/devtailor/prompt-builder.ts）：验证空 pageUrl 仍可用。 */
function hubPrompt(payload) {
  const pageUrl = typeof payload.pageUrl === 'string' ? payload.pageUrl : '';
  const intent = payload.userIntent || '(No additional description provided)';
  const items = Array.isArray(payload.items) ? payload.items : [];
  let text = `## Current Page\nURL: ${pageUrl}\n\n## User Intent\n${intent}\n\n`;
  text += items.length
    ? `## Marked Elements (${items.length} total)\n\n`
    : '## Marked Elements\nNo elements were marked. Use the user\'s request as the primary context.\n\n';
  return text;
}

test('Hub 契约：pageUrl 为空的 review 仍能生成可用的 prompt（纯聊天）', () => {
  const chatOnly = hubPrompt({ pageUrl: '', userIntent: '看看这个组件', items: [] });
  assert.match(chatOnly, /## Current Page\nURL: \n/);
  assert.match(chatOnly, /## User Intent\n看看这个组件\n/);
  assert.match(chatOnly, /No elements were marked/);
  // 带页面的消息照旧
  const withPage = hubPrompt({ pageUrl: 'http://x/', userIntent: '改颜色', items: [{ index: 1 }] });
  assert.match(withPage, /URL: http:\/\/x\//);
  assert.match(withPage, /## Marked Elements \(1 total\)/);
});

/* ── 侧边栏独立 clientId / SSE ──────────────────────────────────── */

test('sidepanel 用自己的 panel_<tabId> clientId 订阅 SSE', () => {
  assert.match(js, /let panelClientId = null;/);
  assert.match(js, /const next = tabId == null \? 'panel_panel' : `panel_\$\{tabId\}`;/);
  assert.match(js, /type: 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT_STREAM',\n\s*clientId: panelClientId,\n\s*tabId: panelTabId,/);
  assert.match(js, /runtimeMessage\(\{ type: 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT', clientId: panelClientId \}\)/);
  // 只在没接管时开自己的流；接管后跟随该 tab 的流
  assert.match(js, /if \(!clientId\) connectPanelSse\(\);/);
  assert.match(js, /type: 'DT_SIDEPANEL_READY',\s*\n\s*tabId: panelTabId, windowId: panelWindowId, loadedAt: panelLoadedAt, panelToken,/);
});

test('面板只处理自己跟随的那条流的 open/error/message', () => {
  const listener = /chrome\.runtime\.onMessage\.addListener\(\(message\) => \{[\s\S]*?\n  \}\);/.exec(js);
  assert.ok(listener, 'runtime onMessage listener not found');
  const src = listener[0];
  assert.match(src, /const followsPanelStream = !clientId && isPanelEvent\(message\);/);
  assert.match(src, /const isTabStream = Boolean\(clientId && message\.clientId === clientId\);/);
  assert.match(src, /if \(!followsPanelStream && !isTabStream\) return;/);
});

test('isPanelEvent 只认源 clientId 也是 panelClientId 的副本（页面 tab 的流不算）', () => {
  // sendBridgeProxyEvent 给每个 panelClientId 发副本，页面 tab 的流事件也会被 tag 成 panel_<tabId>；
  // 只有 payload.clientId（流源）等于 panelClientId 时才是面板自己的流。
  const fn = /function isPanelEvent\(message\) \{[\s\S]*?\n  \}/.exec(js);
  assert.ok(fn, 'isPanelEvent not found');
  assert.match(fn[0], /message\.panelClientId === panelClientId/);
  assert.match(fn[0], /message\.clientId === panelClientId/);
});

test('worker 为 panel 合成 clientId 建流并按它路由广播', () => {
  assert.match(sw, /const sidePanelClientIds = new Set\(\);/);
  assert.match(sw, /message\.type === 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT'[\s\S]{0,240}sidePanelClientIds\.add\(message\.clientId\)/);
  assert.match(sw, /for \(const panelClientId of sidePanelClientIds\) \{[\s\S]{0,300}panelClientId,\n\s*\.\.\.payload,/);
  assert.match(sw, /message\.type === 'DEVTAILOR_SIDEPANEL_PROXY_CONNECT_STREAM'[\s\S]{0,260}startBridgeSseProxy\(message\.tabId \?\? null, message\.clientId\)/);
});

test('面板 SSE 生命周期：open 恢复会话，error 断开并重连自己的流', () => {
  const listener = /chrome\.runtime\.onMessage\.addListener\(\(message\) => \{[\s\S]*?\n  \}\);/.exec(js);
  assert.ok(listener, 'runtime onMessage listener not found');
  const src = listener[0];
  assert.match(src, /if \(message\.event === 'open'\) \{[\s\S]{0,260}sseConnected = true;/);
  assert.match(src, /refreshStatus\(\{ forceSessionSync: true, syncReason: 'reconnect' \}\)/);
  assert.match(src, /if \(followsPanelStream\) setTimeout\(connectPanelSse, 1000\);/);
});

/* ── 侧边栏开合（问题 1） ───────────────────────────────────────── */

test('OPEN_SIDE_PANEL 按窗口记住已打开；再次点击推关闭请求并清掉记录', () => {
  const m = /if \(message\.type === 'OPEN_SIDE_PANEL'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'OPEN_SIDE_PANEL handler not found');
  const src = m[0];
  // 侧边栏是窗口级的：跨标签点按钮也必须能收起同一个窗口的面板。
  assert.match(src, /const openKey = windowId \?\? tabId \?\? '';/);
  assert.match(src, /const wasOpen = sidePanelOpenWindows\.has\(openKey\);/);
  assert.match(src, /sidePanelOpenWindows\.delete\(openKey\);/);
  assert.match(src, /sidePanelCloseRequestedAt = clickAt;/);
  assert.match(src, /sidePanelCloseRequestedWindowId = windowId \?\? null;/);
  // 已打开的面板不会重新加载，必须主动推消息，否则 closePanel 永远不被消费。
  assert.match(src, /type: 'DT_SIDEPANEL_CLOSE_REQUEST', tabId, windowId, notBefore: clickAt,/);
  assert.match(src, /sendResponse\(\{ ok: true, opened: false \}\);/);
  // open() 必须在任何 await 前同步调用，保留 Chrome 的用户手势。
  const openIndex = src.indexOf('const openPromise = chrome.sidePanel.open(target);');
  const hydrationIndex = src.indexOf('await sidePanelWindowsHydrated;');
  assert.ok(openIndex >= 0 && hydrationIndex >= 0 && openIndex < hydrationIndex);
  assert.match(src, /sidePanelOpenWindows\.add\(openKey\);/);
  assert.match(src, /sendResponse\(\{ ok: true, opened: true \}\);/);
});

test('「已打开」窗口落在 storage.session：SW 空闲被杀后重启不丢', () => {
  // MV3 worker 空闲 ~30s 被 Chrome 杀掉，内存 Set 会随之蒸发 → 再点按钮被判「没打开」→
  // sidePanel.open 对已开面板是 no-op → 点击看起来没反应（时好时坏的根因）。
  // storage.session 跨 worker 重启存活、浏览器关闭/扩展 reload 自动清空，语义正好。
  assert.match(sw, /SIDE_PANEL_OPEN_WINDOWS_KEY = 'dt_side_panel_open_windows'/);
  assert.match(sw, /chrome\.storage\.session\.get\(SIDE_PANEL_OPEN_WINDOWS_KEY\)/);
  assert.match(sw, /chrome\.storage\.session\.set\(\{ \[SIDE_PANEL_OPEN_WINDOWS_KEY\]: \[\.\.\.sidePanelOpenWindows\] \}\)/);
  // 开/关/READY 消费三条路径都要写回存储
  const m = /if \(message\.type === 'OPEN_SIDE_PANEL'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'OPEN_SIDE_PANEL handler not found');
  assert.match(m[0], /persistSidePanelWindows\(\);/);
  assert.match(m[0], /await sidePanelWindowsHydrated;/);
  const ready = /if \(message\.type === 'DT_SIDEPANEL_READY'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(ready, 'DT_SIDEPANEL_READY handler not found');
  assert.match(ready[0], /persistSidePanelWindows\(\);/);
  const closed = /if \(message\.type === 'DT_SIDEPANEL_CLOSED'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(closed, 'DT_SIDEPANEL_CLOSED handler not found');
  assert.match(closed[0], /persistSidePanelWindows\(\);/);
  // CLOSED 消息可能在 hydration 完成前到达（beforeunload 唤醒冷启动的 worker）：
  // 删除必须排在 hydration 之后，否则过期条目会被重新加回来。
  assert.match(closed[0], /sidePanelWindowsHydrated\.then\(\(\) => \{/);
});

test('状态过期时：手势内先 open，新面板按时间门忽略关闭并由 READY 自愈状态', () => {
  const m = /if \(message\.type === 'OPEN_SIDE_PANEL'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'OPEN_SIDE_PANEL handler not found');
  const src = m[0];
  assert.match(src, /notBefore: clickAt/);
  assert.ok(src.indexOf('const openPromise = chrome.sidePanel.open(target);') < src.indexOf('await sidePanelWindowsHydrated;'));
  const ready = /if \(message\.type === 'DT_SIDEPANEL_READY'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(ready, 'DT_SIDEPANEL_READY handler not found');
  assert.match(ready[0], /sidePanelWindowsHydrated\.then\(\(\) => \{[\s\S]*?sidePanelOpenWindows\.add\(winKey\)/);
  assert.match(src, /sendResponse\(\{ ok: true, opened: false \}\);/);
});

test('DT_SIDEPANEL_READY 只在同窗口时把「请关闭」回给面板，面板据此 window.close()', () => {
  const ready = /if \(message\.type === 'DT_SIDEPANEL_READY'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(ready, 'DT_SIDEPANEL_READY handler not found');
  assert.match(ready[0], /sidePanelCloseRequestedWindowId === message\.windowId/);
  assert.match(ready[0], /message\.loadedAt < sidePanelCloseRequestedAt/);
  assert.match(ready[0], /closePanel: closeRequested/);
  assert.match(ready[0], /sidePanelCloseRequestedAt = 0;/);
  assert.match(ready[0], /sidePanelCloseRequestedWindowId = null;/);
  assert.match(ready[0], /sidePanelOpenWindows\.delete\(winKey\)/);
  // READY 必须在 ensurePanelClientId 之后发，否则 windowId 还没解析出来
  assert.match(js, /const panelLoadedAt = Date\.now\(\);/);
  assert.match(js, /type: 'DT_SIDEPANEL_READY',\s*\n\s*tabId: panelTabId, windowId: panelWindowId, loadedAt: panelLoadedAt, panelToken,/);
  assert.match(js, /if \(res && res\.closePanel\) window\.close\(\);/);
});

test('面板只响应同窗口且早于本次加载的 DT_SIDEPANEL_CLOSE_REQUEST', () => {
  const listener = /chrome\.runtime\.onMessage\.addListener\(\(message\) => \{[\s\S]*?\n  \}\);/.exec(js);
  assert.ok(listener, 'runtime onMessage listener not found');
  assert.match(listener[0], /message\.type === 'DT_SIDEPANEL_CLOSE_REQUEST'/);
  assert.match(listener[0], /const sameWindow = message\.windowId == null \|\| message\.windowId === panelWindowId;/);
  assert.match(listener[0], /const preExisting = message\.notBefore == null \|\| panelLoadedAt < message\.notBefore;/);
  assert.match(listener[0], /if \(sameWindow && preExisting\) window\.close\(\);/);
});

test('快速连点：旧面板实例的迟到 CLOSED 不清除新实例的「已打开」状态', () => {
  // 连点场景：click N 关闭面板 A → click N+1 重新打开（新实例 B 的 READY 已把窗口记回 Set）
  // → 面板 A 的 beforeunload CLOSED 晚到，若按窗口匹配就抹掉 B 的状态 → 之后每次点击都被
  // 误判「没打开」，open() no-op，按钮看起来失效。靠实例 token 区分新旧。
  assert.match(js, /const panelToken = `\$\{Date\.now\(\)\.toString\(36\)\}-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 8\)\}`;/);
  assert.match(js, /type: 'DT_SIDEPANEL_CLOSED', tabId: panelTabId, windowId: panelWindowId, panelToken/);
  const ready = /if \(message\.type === 'DT_SIDEPANEL_READY'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(ready, 'DT_SIDEPANEL_READY handler not found');
  assert.match(ready[0], /sidePanelWindowTokens\.set\(winKey, message\.panelToken\)/);
  const closed = /if \(message\.type === 'DT_SIDEPANEL_CLOSED'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(closed, 'DT_SIDEPANEL_CLOSED handler not found');
  // token 不一致（已有更新实例的 READY）→ 整个忽略，不动 Set 也不清流
  assert.match(closed[0], /knownToken !== message\.panelToken/);
  assert.match(closed[0], /sendResponse\(\{ ok: true, stale: true \}\);/);
  // token 一致才走删除，并且把 token 一并清掉
  assert.match(closed[0], /sidePanelOpenWindows\.delete\(winKey\);\s*\n\s*sidePanelWindowTokens\.delete\(winKey\)/);
});

test('打开路径先乐观记账再等 open()：连点时面板加载期间也能被下一次点击收起', () => {
  const m = /if \(message\.type === 'OPEN_SIDE_PANEL'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'OPEN_SIDE_PANEL handler not found');
  const src = m[0];
  assert.ok(src.indexOf('sidePanelOpenWindows.add(openKey);') < src.indexOf('await openPromise;'));
  assert.match(src, /catch \(err\) \{[\s\S]*?sidePanelOpenWindows\.delete\(openKey\);[\s\S]*?throw err;/);
});

test('切换合并窗口：收敛期内的连点被吞掉，绝不与在途的开/关决策交叉', () => {
  // 一次切换要几百毫秒才收敛（面板文档加载 + 迟到的 beforeunload），连点若与在途决策交叉
  // 就会互相踩状态。500ms 内同窗口的点击直接忽略（throttled），检查在 open() 之前且同步，
  // 手势路径不受影响。
  assert.match(sw, /sidePanelToggleBusy = new Map\(\)/);
  assert.match(sw, /SIDE_PANEL_TOGGLE_COALESCE_MS = 500/);
  const m = /if \(message\.type === 'OPEN_SIDE_PANEL'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'OPEN_SIDE_PANEL handler not found');
  const src = m[0];
  assert.match(src, /const busyUntil = sidePanelToggleBusy\.get\(openKey\) \?\? 0;/);
  assert.match(src, /if \(now < busyUntil\) \{\s*\n\s*sendResponse\(\{ ok: true, throttled: true \}\);/);
  assert.ok(src.indexOf('sidePanelToggleBusy.set(openKey') < src.indexOf('chrome.sidePanel.open(target)'));
});

test('面板关闭时通知 worker 清理「已打开」窗口和它自己的流', () => {
  assert.match(js, /type: 'DT_SIDEPANEL_CLOSED', tabId: panelTabId, windowId: panelWindowId/);
  assert.match(js, /type: 'DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT', clientId: panelClientId/);
  const closed = /if \(message\.type === 'DT_SIDEPANEL_CLOSED'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(closed, 'DT_SIDEPANEL_CLOSED handler not found');
  assert.match(closed[0], /const winKey = message\.windowId/);
  assert.match(closed[0], /sidePanelOpenWindows\.delete\(winKey\)/);
  assert.match(closed[0], /closedPanelId/);
  assert.match(closed[0], /sidePanelClientIds\.delete\(id\)/);
  assert.match(closed[0], /stopBridgeSseProxy\(proxy\.tabId, proxy\.clientId\)/);
});

test('DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT 按 clientId 停流（不依赖 tabId）', () => {
  // 流是用真实 tabId 建的（key `<tabId>:panel_<tabId>`），断开时只知道自己，按 clientId 遍历才删得掉。
  const m = /if \(message\.type === 'DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT'\) \{[\s\S]*?\n  \}/.exec(sw);
  assert.ok(m, 'DISCONNECT handler not found');
  assert.match(m[0], /sidePanelClientIds\.delete\(clientId\)/);
  assert.match(m[0], /filter\(\(proxy\) => proxy\.clientId === clientId\)/);
  assert.match(m[0], /stopBridgeSseProxy\(proxy\.tabId, proxy\.clientId\)/);
  assert.doesNotMatch(m[0], /stopBridgeSseProxy\(null, clientId\)/);
});
