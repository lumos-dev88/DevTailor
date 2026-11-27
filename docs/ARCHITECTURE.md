# DevTailor 架构与时序分析

## 📐 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser Extension                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌───────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Popup        │  │  Background  │  │  Content Script     │  │
│  │  (popup.js)   │  │  (service-   │  │  (Shadow DOM UI)    │  │
│  │               │  │   worker.js) │  │                     │  │
│  │  - 接管当前页 │  │              │  │  - Marks Toolbar    │  │
│  │  - 打开侧栏   │  │  - 按需注入  │  │  - Badges / 备注    │  │
│  │               │  │  - Hub 代理  │  │  - Selector Mode    │  │
│  └───────────────┘  └──────────────┘  │  - VisBug HitTest   │  │
│                                        └─────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 🔄 关键数据流

### 1. 按需注入与初始化流程

```text
普通网页加载（无 DevTailor 脚本）
  → 用户从 popup / sidePanel / 快捷键触发“接管当前页”
  → service worker 校验 http/https，并按顺序注入 MAIN console bridge、MAIN framework bridge、CSS、isolated modules
  → content-script.js 初始化 Shadow DOM 标记工具条、标记同步与 SSE client
  → worker 等页面 SSE 连接 Hub 后调用 /activate
  → storage.session 记录曾注入 tab 与 active tab
  → 刷新/跳转 complete：曾注入 tab 自动补注入；仅 active tab 重新 activate
```

`chrome://`、扩展商店等受限页面不进入注入流程。console bridge 在接管后才生效，无法恢复接管前日志。

### 2. 实例路由

侧边栏从 `GET /health` 读取按活跃度排序的 `instances` 与 `defaultInstanceId`。选择“自动”时 worker 不附加实例头；选择具体实例时，worker 对 HTTP 和 SSE 统一附加 `X-DevTailor-Instance`。选择存于 `chrome.storage.local`，MV3 worker 启动后的第一条 Hub 请求必须等待恢复完成。离线选择不会改变 Hub 连接状态，只让 `/review` 返回 `instance_offline`。

### 3. 发送消息流程

```
User types message
       │
       ▼
┌────────────────────────┐
│ chatPanel.sendMessage()│
│ 1. Validate input      │
│ 2. Check connection    │
│ 3. Add user message    │
│ 4. renderMessages()    │
└─────────┬──────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ chatSend.executeSend()                     │
│ 1. Prepare payload:                        │
│    {                                        │
│      text,                                  │
│      marks: [],                             │
│      screenshot: base64?,                   │
│      clientId                               │
│    }                                        │
│ 2. POST /review                             │
└─────────┬──────────────────────────────────┘
          │
          ▼ (SSE)
┌────────────────────────────────────────────┐
│ wsClient.onmessage()                       │
│ 1. Parse event.data                        │
│ 2. Update lastHeartbeatTime                │
│ 3. Trigger messageListeners                │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ chatConversation.handle()                  │
│ switch (msg.type):                         │
│   case 'stream':                           │
│     - ensureStreamAtTail()                 │  ⚠️ Stream state fixed
│     - appendStream(delta)                  │
│   case 'done':                             │
│     - endStream()                          │
│   case 'error':                            │
│     - endStream()                          │
│     - addMessage('error')                  │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────┐
│ renderMessages()       │
│ followLatestIfPinned() │
│ schedulePersist()      │
└────────────────────────┘
```

### 3. 元素库使用流程

页内工具条和侧边栏都没有元素库浏览器 UI（原 `element-saver.js` 已删除）。元素库只由 browser tool 经本地链路使用：

```
Agent / browser tool
       │
       ▼
┌────────────────────────────────────────────┐
│ content/modules/browser-actions.js          │
│  get_element_targets / save_element_target  │
│  / delete_element_target                    │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ content/modules/element-targets.js          │
│  resolveParams / savePayload / list / del   │
└─────────┬──────────────────────────────────┘
          │
          ▼
   Bridge  /element-targets  (GET/POST/DELETE)
```

`content` 仍持有 review 的 selector/xpath/context，`buildTargetPayload` 可把一个 mark 转成元素目标供 browser tool 使用。

### 4. 设计规范（DESIGN.md）流程

模块边界：路径只由服务端 uuid 生成；扩展只管 UI，不持有文件内容；AI 自己读取文件。

### 5. AI 状态（hooks 上报 → 侧边栏状态标）

- 唯一不需要扩展 Origin 的路由是 `/agent-status`（调用方是 hook 子进程而不是浏览器）：只有「Origin 为空 + 令牌正确」的 POST 放行，Host 校验保留、响应不加 CORS 头、带浏览器 Origin 一律 403、非 POST 405。其余路由守卫不变。
- 状态模型：`UserPromptSubmit`/`turn_start` → `thinking`，`PreToolUse` → `tool`（在飞 `toolUseId` 集合），`PostToolUse`/`PostToolUseFailure` → 在飞数减一（到 0 回 `thinking`），`Notification` → `waiting`，`Stop`/`turn_end` → `idle`，`SubagentStop` → 没有在飞工具时才回 `thinking`；10 分钟无事件按 `idle` 读。
- 状态不进聊天：不写展示会话、不进 prompt、不持久化，Bridge 重启即 `idle`。细节见 `docs/HANDOFF.md`「AI 状态（hooks 上报）」。

---

## ⚠️ 已知时序问题

### 1. ✅ **已修复：Bridge proxy 连接竞态条件**

**问题**：
```javascript
// OLD (错误)
events.onopen = () => {
  setStatus('connected');
  fetch(`${BRIDGE_URL}/health`)  // 异步，但没等待
    .then(info => {
      setProjectInfo(info);  // 可能晚于监听器触发
      projectListeners.forEach(fn => fn(info));
    });
};
```

**修复**：
```javascript
// NEW (正确)
onBridgeProxyOpen = async () => {
  setStatus('connected');
  try {
    const response = await bridgeFetch('/health');
    const info = await response.json();
    setProjectInfo(info);  // 同步完成后再触发
    projectListeners.forEach(fn => fn(info));
  } catch (err) {
    console.error('[DevTailor] Health check failed:', err);
  }
};
```

### 2. ✅ **已修复：activeStreamId 状态混乱**

**问题**：
- 同一个流可能创建多次
- 流不在尾部时，旧流没有结束就创建新流
- `activeStreamId` 指向错误的消息

**修复**：
```javascript
function ensureStreamAtTail() {
  if (!activeStreamId) {
    startStream();
    return true;  // 新流
  }
  
  const idx = messageStore.findIndex(m => m.id === activeStreamId);
  
  if (idx === -1) {
    activeStreamId = null;
    startStream();
    return true;  // 新流
  }
  
  if (idx < messageStore.size - 1) {
    endStream();      // ⚠️ 正确结束旧流
    startStream();
    return true;      // 新流
  }
  
  return false;  // 继续使用现有流
}
```

### 3. ✅ **已修复：工具状态标记错误**

**问题**：
- 工具实际失败但显示为完成
- 没有验证工具是否真的成功

**修复**：
```javascript
function markLastPendingToolCompleted() {
  const lastTool = messageStore.findLast(m => m.type === 'tool' &&
    (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running'));
  
  if (!lastTool) return false;
  
  // ⚠️ 只在流输出时才标记完成（说明工具确实成功了）
  if (activeStreamId) {
    lastTool.status = 'completed';
    return true;
  }
  
  return false;
}

// 在 done 事件中统一标记所有剩余工具
case 'done':
  endStream();
  markLastPendingToolCompleted();
  if (msg.reason !== 'cancelled') {
    // ⚠️ 成功完成时，批量标记所有挂起的工具
    const pendingTools = messageStore.filter(m =>
      m.type === 'tool' &&
      (m.status === 'pending' || m.status === 'in_progress' || m.status === 'running')
    );
    pendingTools.forEach(tool => {
      tool.status = 'completed';
    });
  }
  break;
```

### 4. ✅ **已修复：SSE 心跳机制缺失**

**问题**：
- 长时间无消息时连接可能"僵死"
- 没有心跳检测，无法及时发现连接断开

**修复**：
```javascript
const HEARTBEAT_INTERVAL = 30000;  // 30 秒
const HEARTBEAT_TIMEOUT = 60000;   // 60 秒
let heartbeatTimer = null;
let lastHeartbeatTime = 0;

function startHeartbeat() {
  stopHeartbeat();
  lastHeartbeatTime = Date.now();
  heartbeatTimer = setInterval(() => {
    const elapsed = Date.now() - lastHeartbeatTime;
    if (elapsed > HEARTBEAT_TIMEOUT) {
      console.warn('[DevTailor] Heartbeat timeout, reconnecting...');
      reconnect();
    }
  }, HEARTBEAT_INTERVAL);
}

events.onmessage = (event) => {
  lastHeartbeatTime = Date.now();  // ⚠️ 收到消息时更新
  // ... handle message
};
```

### 5. ✅ **已废除：元素库 URL 过滤 API**

**旧问题**：
- 前端曾通过 `/element-targets?url=...` 请求当前页目标。
- 路径、query、hash 的匹配规则容易让 UI 和 MCP 返回结果不一致。

---

## ✅ 已修复

### 1. **批量渲染性能**

**位置**：`message-store.js`, `sidepanel/sidepanel.js`

**问题**：每次 delta 都触发 `renderMessages()` 完整渲染，流式输出时频繁重绘，CPU 占用高。

**修复**：引入 `message-store.js` 作为消息数组的 reactive facade，内部通过 RAF 批处理合并同一帧内的多次 mutation：

```javascript
function _notify() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    subscribers.forEach((fn) => {
      try { fn(); } catch (e) { console.error('MessageStore subscriber error:', e); }
    });
  });
}
```

- 同一帧内的多次 mutation（如流式输出的密集 delta）只会触发一次 `requestAnimationFrame`
- `sidepanel.js` 通过 `messageStore.subscribe(renderMessages)` 订阅，实现自动批量渲染
- 新增 `findLast(predicate)` API，避免 `[...getAll()].reverse().find()` 创建临时数组
- 流式渲染每 delta 从 ~16ms 降至 ~2ms（RAF batched）

---

## ✅ 已修复的潜在问题（2026-06-09）

### 1. **持久化逻辑澄清**

**位置**：`chat-persistence.js:82-96`

**问题**：
- `messages: []` 看起来像 bug，但实际是设计决策
- 缺少注释说明，容易引起误解

**澄清**：
- Display messages 由 Bridge 的 DisplaySession 管理
- 通过 `session_snapshot` 事件恢复消息历史
- 本地只持久化 UI 状态：images, screenshot, sendState
- 这是正确的架构分层

**修复**：
```javascript
function persistNow() {
  if (!sessionKey) return;
  clearTimeout(persistTimer);
  const images = getImages();
  const payload = {
    version: 1,
    pageKey: `${location.hostname}${location.pathname}`,
    bridgeInstanceId: currentBridgeInstanceId,
    // NOTE: messages are NOT persisted here - they are managed by Bridge sessions
    // and restored via session_snapshot events. Only UI state (images, sendState) is saved.
    images,
    screenshot: images[0] || null,
    sendState: getSendState?.() || null,
    updatedAt: Date.now(),
  };
  chrome.storage.local.set({ [sessionKey]: payload });
}
```

### 2. **发送与取消**

**位置**：`content/modules/chat-send.js`

**状态**：
- 前端不再维护待发送消息队列、重试计数或退避定时器。
- 发送即完成（Hub 新契约）：`/review` 立即返回 `202 {ok,turnId,sessionId}`，没有 `queued/queueDepth/isProcessing`，没有 429；无在线 Claude → 503 `no_claude_instance`。SSE 不再发 `done`/`queue_status`，也不再附带 `isProcessing`。
- `chat-send.js` 的 `flushQueue()` / `clearQueue()` 仅保留兼容空实现。

**当前要点**：
1. **没有「处理中」状态**：扩展不维护 processing 锁，发送按钮只受输入内容、连接状态和 `/review` 在途窗口影响。
2. **前端只提交当前输入**：未连接或未接管时提示用户，不缓存消息。
3. **连续发送**：可以连续发多条，每条都是独立的 202；每条 reply 是独立 assistant 气泡（按 `displayMessage.id`）。
4. **取消**：`/cancel` 取消当前 turn；返回 `canceled:false`（`nothing_to_cancel`）不是错误。侧边栏的取消按钮仅在有未决审批/提问或工具运行时出现，不阻塞发送。

---

## 🟡 剩余潜在问题

### 1. **全局状态污染**

**位置**：所有模块

**问题**：
- 所有模块挂载到 `window.__domReview`
- 难以追踪依赖
- 不利于测试

**建议**：使用依赖注入或模块化加载器

---

## 📊 性能指标

| 操作 | 当前性能 | 优化目标 |
|------|----------|----------|
| 初始化 | ~200ms | <100ms |
| 发送消息 | ~50ms | <30ms |
| 流式渲染（每 delta） | ~16ms → ~2ms (RAF batched) | <8ms (已完成) |
| 元素库查询 | ~100ms | <50ms |
| 持久化 | 400ms (debounced) | 保持 |

---

## 🛠️ 优化建议优先级

### P0 - 关键（已完成）
- ✅ 修复 SSE 连接竞态条件
- ✅ 修复 activeStreamId 状态混乱
- ✅ 添加 SSE 心跳机制
- ✅ 废除元素库 URL 过滤 API，统一项目全量

### P1 - 重要
- [x] 批量渲染优化（message-store.js RAF batching）

### P2 - 改进
- [ ] 状态机重构（连接/会话/请求）
- [ ] 依赖注入替换全局变量
- [ ] TypeScript 迁移

---

## 📝 架构决策记录

### ADR-001: 为什么使用 SSE 而不是 WebSocket？

**决策**：使用 Server-Sent Events (SSE) 而非 WebSocket

**理由**：
1. 单向流（Server → Client）足够，不需要双向通信
2. 自动重连机制
3. HTTP 协议，更容易穿透代理
4. 更简单的实现

**代价**：
- 需要额外的 HTTP POST 发送消息
- 浏览器限制每个域最多 6 个 SSE 连接

### ADR-002: 为什么使用 Shadow DOM？

**决策**：使用 Shadow DOM 隔离 UI

**理由**：
1. 样式隔离，不受页面 CSS 影响
2. DOM 隔离，不污染页面结构
3. 事件隔离

**代价**：
- 无法使用页面的 CSS 变量
- 调试稍复杂
- 某些第三方工具可能无法检测

---

## 🔍 调试技巧

### 1. 查看 SSE 连接状态
```javascript
// 在浏览器控制台
window.__domReview.wsClient.getStatus()
// 'connecting' | 'connected' | 'disconnected'
```

### 2. 查看当前消息列表
```javascript
window.__domReview.chatPanel.getMessages()
// 或在控制台直接访问
window.__domReview.createMessageStore().getAll()  // 仅查看结构，不要直接操作
```

### 3. 查看页内工具条与标记状态
```javascript
window.__domReview.toolbar?.isHidden?.()
window.__domReview.store.getAll()          // 页面标记（单一事实来源）
```

### 4. 手动触发重连
```javascript
window.__domReview.wsClient.reconnect()
```

---

## 📚 相关文档

- [STATE_ANALYSIS.md](./STATE_ANALYSIS.md) - 状态管理与时序问题详细分析
- [HANDOFF.md](./HANDOFF.md) - 交接文档，设计边界和防回归规则

---

## 扩展通信

- 扩展 → Bridge 的所有 HTTP/SSE 请求仍然只经 service worker（`fetchBridgeUrl`），并带 `X-DevTailor-Client: <extension id>`：真实 Chrome 里 SW 的 GET 不带 `Origin`，守卫靠这个头识别扩展（网页发该头需要预检，预检被守卫拒绝）。
- `scripts/e2e-extension.mjs` 用真实 Chrome + 假 Claude（MCP 客户端）覆盖整条链路。

## 🧩 扩展侧：事件归约与渲染（侧边栏）

```text
SSE(每个标签页一条, 经 service worker) ─┬─▶ 页内 ws-client（接管 / browser_action）
                                        └─▶ chrome.runtime 广播 ─▶ 侧边栏 sidepanel.js ─┤
                                                                                      ▼
                                 一份归约器（事件 → 消息 store + meta）
                                    ├─ 纯逻辑层：错误文案 / 审批状态机 / 工具归约 / 状态栏
                                    └─ 渲染层：纯 HTML 字符串：审批卡片 / 提问卡片 / 通知 / 横幅（thinking、工具卡片已删除：Claude 通道不产生这些事件）
                                                   ▼
                        侧边栏（keyed 增量渲染, 不限条数；页内不再有聊天）
```

- **一份归约器（只有侧边栏使用）**：把 SSE 事件写进注入的消息 store（`message-store.js` 同形接口），并维护 `meta`（`sessionId/title/cwd/origin/authRequired` 等；没有 processing）；界面只订阅 store/meta 变化渲染。纯逻辑和归约器都有 Node 测试（`tests/extension/`，`npm run test:ext`）。
- **会话来源**：会话列表 `GET /sessions`，当前会话 `GET /sessions/active`（Bridge 持久化的展示会话与消息，没有独立的 transcript 回放接口）；刷新/重连后按 `active_session_sync` + `/sessions/active` 重同步（见 `docs/HANDOFF.md`「Transport」）。
- **审批**：`approval_request` / `approval_pending` / `approval_resolved` 进同一个状态机，`POST /approval-decision` 回传。Claude Code 的权限转发（permission relay）是唯一生产调用方：`permission_request` → 审批卡（没有选项列表时用默认「允许 / 拒绝」）→ `approved`/`rejected` → `notifications/claude/channel/permission`；无客户端/超时/取消不发裁决，交给终端对话框。`QuestionRouter` 仍只保留传输层。
- **侧边栏通常不开自己的 SSE**：有接管标签时它订阅 service worker 对该 tab 流的广播，靠 `tabId === 接管标签` 过滤去重。没有接管时它用合成 clientId（`panel_<tabId>`）单独开一条代理流收回复和卡片事件，发消息也用它当 `clientId`（纯聊天不带页面上下文）。worker 给每个已知 panel id 发一份广播副本（带接收者 `panelClientId`），但副本的 `clientId` 是流源；面板只接受 `clientId === panelClientId` 的副本，避免把页面 tab 自己的流当成面板流。面板关闭时发 `DT_SIDEPANEL_CLOSED` + `DEVTAILOR_SIDEPANEL_PROXY_DISCONNECT`，worker 据此清掉合成 id 和代理流（`beforeunload` 是 best-effort，CLOSED 里也会兜底清理）。
- **样式**：共享组件样式模块只依赖 `--dt-*` 令牌 + 半透明灰，明暗两套主题通用；侧边栏专属在 `sidepanel.css`，页内工具条样式在 `toolbar.js` 的样式串里。
- **测试矩阵**：`npm run test:ext`（扩展纯逻辑测试）→ `npm run e2e:ext`（真实 Chrome + 临时 Hub + 假 MCP 客户端，需 Hub 仓库已装依赖且 34781 空闲）；服务端测试与真实 Claude 通道验证请按 `devtailor-hub` 仓库文档执行。

## 标记工具条与标记同步

页内只有一条 Shadow DOM 标记工具条（`toolbar.js`，样式在同一 shadow root；沿用 `withDevTailorUiHidden`，不进快照/截图/元素选择）。内容脚本的 `review-store.js` 是标记数据源；聊天、会话、审批、模式、计划、用量只在侧边栏。

状态持久化：`chrome.storage.local` 键 `dt_toolbar:<origin>`，值 `{open, top}`（`toolbar-core.js` 序列化/容错解析，损坏数据回落默认；`top` 总会夹取到屏幕内）。

同步消息（`marks-core.js` 构造，大小上限在 `LIMITS`）：

- 内容脚本 → service worker：`{type:'DT_MARKS_CHANGED', url, marks, screenshots, truncated}`；service worker 补上发送者标签页并广播给扩展页：`{type:'DT_MARKS_UPDATED', tabId, url, marks, screenshots, truncated}`。
- `marks[]` 最小字段：`id, index, color, desc(tag#id.class,≤120), selector(≤300), text(≤120), comment(≤500), component(≤80), file(≤200), sent`；最多 200 条，超出置 `truncated`。
- `screenshots[]` 只含 `{id, w, h, bytes}`，最多 8 个；**base64 不走广播**，缩略图用 `DT_GET_SCREENSHOT_THUMBS` 按需取，完整图只在发送时随 `DT_BUILD_PAYLOAD` 返回。
- 侧边栏 → 内容脚本（`chrome.tabs.sendMessage`）：`DT_GET_MARKS`（打开/切换标签时拉取）、`DT_REMOVE_MARK`、`DT_CLEAR_MARKS`、`DT_LOCATE_MARK`、`DT_REMOVE_SCREENSHOT`、`DT_GET_SCREENSHOT_THUMBS`、`DT_BUILD_PAYLOAD`（返回 `{pageUrl, items, screenshots, markIds}`，复用 `prompt-builder.js` 的 `buildPayload`）、`DT_MARKS_SENT/UNSENT/CLEAR_SENT`。托盘从不修改自己的副本，只应用页面回的快照。
- 工具条 → service worker：`OPEN_SIDE_PANEL {focusInput}`（service worker 调 `chrome.sidePanel.open({tabId})`；**侧边栏是窗口级的**，所以「已打开」按窗口记录：这个窗口的面板已开时，再点工具条按钮（无论点在哪个标签）就是收起——回 `opened:false` 并推 `DT_SIDEPANEL_CLOSE_REQUEST {tabId, windowId}`，面板收到同窗口的请求后自己 `window.close()`（Chrome 没有 `sidePanel.close()`）。面板还在加载、听不到推送时由 `DT_SIDEPANEL_READY` 的 `closePanel` 兜底：按 `windowId` 匹配且 5s 内有效。面板关闭时发 `DT_SIDEPANEL_CLOSED` 清掉「已打开」窗口记录。**「已打开」窗口列表持久化在 `chrome.storage.session`（key `dt_side_panel_open_windows`）**：MV3 worker 空闲约 30s 会被杀掉，纯内存 Set 重启即蒸发、点击被判「没打开」从而没反应（时好时坏的根因）；storage.session 跨 worker 重启存活、浏览器关闭/扩展 reload 自动清空，内存 Set 只是它的镜像，开/关/READY 消费三条路径都写回。`open()` 受用户手势门槛限制，必须在任何 `await` 前无条件调用（面板已开时是 no-op）；关闭请求带 `notBefore` 点击时间戳，本次点击刚创建的新面板会忽略它；`READY` 携带 `loadedAt` 并使用同样的时间门，且不关闭时会把窗口重新标记为已打开，以自愈过期状态；`READY`/`CLOSED` 均携带 `panelToken`（面板每次加载生成的实例标识）：快速连点时旧实例的 beforeunload `CLOSED` 可能晚于新实例的 `READY` 到达，worker 按 token 区分——token 已被更新实例替换的迟到 `CLOSED` 整个忽略（不动「已打开」状态、不清流），token 一致才清理；打开路径在等待 `open()` 完成前先把窗口乐观记入「已打开」，让加载期间的下一次点击仍能判为收起；每次切换有 **500ms 合并窗口**（`sidePanelToggleBusy`）：收敛期（面板文档加载、beforeunload 通知晚到）内同窗口的连点被直接吞掉（回 `throttled:true`），保证快速连点不可能与在途的开/关决策交叉、也就不可能踩坏状态）；侧边栏加载后发 `DT_SIDEPANEL_READY` 询问是否需要聚焦输入框或关闭自己。

发送：侧边栏 `executeSend` 先 `DT_BUILD_PAYLOAD`，再 `POST /review {pageUrl, userIntent, items, screenshots, references?}`。发送前标记乐观标为“已发送”（不会进入并发 BUILD），`POST /review` 返回 2xx 即清除，非 2xx/网络错误则恢复为未发送（不再等 `done`）。用户消息气泡带 `marks`（编号 chip + 简述 + 截图缩略图）；历史回放里 `marksCore.parseDevTailorPrompt` 识别 prompt-builder 的 Markdown（`## Current Page` / `## User Intent` / `### N \`selector\``）并紧凑渲染，识别失败显示原文。

**参考元素（references）**：请求体的 `payload.references` 是独立数组（`id/url/title/selector/note/styles/html/screenshot?`），与 `items`（标记）和 `screenshots`（页面截图附件）互不重叠；采集在页内完成脱敏（见 `docs/HANDOFF.md`「参考元素」），列表由 service worker 存 `chrome.storage.session`（`dt_references`，全局、上限 8）并广播 `DT_REFERENCES_UPDATED` 给页内工具条与侧边栏分区。Hub 在 2xx body 回 `referencesAccepted: <number>`，仅当等于本次条数时扩展才移除这些 id（`DT_REFERENCES_ACCEPTED`）；无该字段＝旧 Hub 不支持，保留待发并提示；失败全部保留。

取消接管：桥接没有显式释放接口，工具条断开本标签的事件流，桥接约 3 秒后释放；侧边栏打开时它自己的事件流也挂着同一个 clientId，释放可能不生效，工具条会提示“关闭侧边栏后可取消接管”。
