# DevTailor 架构与时序分析

> **唯一后端是 Claude Code Channels**：Claude Code 以插件形式拉起 Bridge 的 stdio MCP server（`src/mcp-main.ts`，声明 `experimental['claude/channel']`），侧边栏经 HTTP/SSE `127.0.0.1:34781` 与 Bridge 通信，回复走 `reply` MCP 工具，浏览器工具走 MCP。下面的整体架构图和「发送消息流程」描述的就是当前 Channels 后端（Bridge 仍保存展示会话/消息，AI 上下文由 Claude Code 持有）；详见文末「Claude Code 通道（MCP stdio）」。历史备份分支：`backup/pre-channels-only`。

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
│  │  - 启用/禁用  │  │              │  │  - Chat Panel       │  │
│  │  - 站点管理   │  │  - 权限管理  │  │  - Element Saver    │  │
│  │  - 面板尺寸   │  │  - 注入脚本  │  │  - Selector Mode    │  │
│  └───────────────┘  └──────────────┘  │  - VisBug HitTest   │  │
│                                        └─────────────────────────┘  │
│                                                                   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ background service worker proxy
                                │ (SSE fetch stream + HTTP)
                                │
┌───────────────────────────────▼───────────────────────────────────┐
│                       Bridge Server (Node.js)                     │
│            http://127.0.0.1:34781 (loopback only)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  HTTP/SSE Routes                                         │   │
│  │  Guard first: Host check + chrome-extension:// Origin    │   │
│  │  - GET  /health        (minimal; details need Origin)    │   │
│  │  - GET  /events        (SSE Stream)                      │   │
│  │  - POST /review        (Send message)                    │   │
│  │  - POST /activate      (Take over active tab)            │   │
│  │  - POST /cancel        (Stop generation)                 │   │
│  │  - POST /new-session   (Create/reuse blank session)      │   │
│  │  - GET  /sessions      (List sessions)                   │   │
│  │  - GET  /sessions/active (Current display session)       │   │
│  │  - POST /sessions/load   (Switch session)                │   │
│  │  - POST /sessions/delete (Delete session)                │   │
│  │  - GET  /element-targets          (List all elements)    │   │
│  │  - POST /element-targets           (Save element)        │   │
│  │  - DELETE /element-targets/:id     (Delete element)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  State Management                                        │   │
│  │  - clients: Map<clientId, SSEConnection>                 │   │
│  │  - sessions: Map<sessionId, DisplaySession>              │   │
│  │  - elementTargets: Map<targetId, ElementTarget>          │   │
│  │  - store: SessionStore (SQLite persistence)              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ in-process runtime boundary
┌───────────────────────────────▼───────────────────────────────────┐
│                   Agent Runtime Boundary                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  - The bridge ships no AI runtime; the AI is Claude Code         │
│  - ClaudeChannelSession (MCP stdio server + claude/channel):     │
│    review -> notifications/claude/channel, Claude -> `reply` tool│
│  - index.ts debug mode: PlaceholderAgentSession                  │
│  - 20 MCP tools: 19 browser tools (BrowserActionRouter) + reply │
│  - Receives user messages + context (marks, intent, page URL)    │
│  - Browser tools: routed through BrowserActionRouter to active tab│
│  - Emits: stream (whole reply segments), tool_status, error;     │
│    handleReview emits the single `done` per turn                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 关键数据流

### 1. 初始化流程

```
┌────────────────────┐
│ Page Load          │
└─────────┬──────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ content-script.js (Orchestrator)           │
│ 1. Check extension enabled                 │
│ 2. ui.init() - Create Shadow DOM           │
│ 3. sidebar.render()                        │
│ 4. chatPanel.init()                        │
│ 5. elementSaver.init()                     │
│ 6. Wire Bridge proxy listeners             │
│ 7. badges.render()                         │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ chatPanel.init()                           │
│ 1. wsClient.connect()                      │
│ 2. Register listeners:                     │
│    - onProjectChange()                     │
│    - onSessionChange()                     │
│    - onStatusChange()                      │
│ 3. wsClient.onMessage(handleBridgeMessage) │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ wsClient.connect()                         │
│ 1. chrome.runtime.sendMessage(CONNECT)     │
│ 2. background fetches /events SSE stream   │
│ 3. tabs.sendMessage(open/message/error)    │
│ 4. content fetches /health through proxy   │
│ 5. startHeartbeat() - 30s interval         │
└────────────────────────────────────────────┘
```

### 2. 发送消息流程

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
│ 1. Mark requestInFlight = true             │
│ 2. Prepare payload:                        │
│    {                                        │
│      text,                                  │
│      marks: [],                             │
│      screenshot: base64?,                   │
│      clientId                               │
│    }                                        │
│ 3. POST /review                             │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ Bridge: handleReview()                     │
│ 1. Accept request into backend queue        │
│ 2. Get/Create AgentSession when dequeued    │
│ 3. session.sendReview(payload, context)     │
│    (channel: returns 'pending' once the     │
│    notification is written)                 │
│ 4. Pipe runtime events + processing state   │
│    → SSE clients                            │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ Agent Runtime Boundary                     │
│ 1. Claude Code receives <channel> event     │
│    (turn_id, page_url, image paths in       │
│    .devtailor/images) and answers via the   │
│    MCP `reply` tool (final:true -> done)    │
│ 2. Browser tool routing via                 │
│    BrowserActionRouter                      │
│ 4. Stream events:                          │
│    - stream { delta }                      │
│    - tool_status { canceled } (cancel)     │
│    - done { reason }                       │
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
│     - setRequestInFlight(false)            │
│     - flushQueue()                         │
│   case 'error':                            │
│     - endStream()                          │
│     - addMessage('error')                  │
│     - setRequestInFlight(false)            │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────┐
│ renderMessages()       │
│ followLatestIfPinned() │
│ schedulePersist()      │
└────────────────────────┘
```

### 3. 元素保存/查询流程

```
User clicks element in selector mode
       │
       ▼
┌────────────────────────────────────────────┐
│ elementSaver.handleClick()                 │
│ 1. Generate selector/xpath                 │
│ 2. Capture context (a11y, text, box, etc.) │
│ 3. showSaveCard(review, defaultName)       │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ elementSaver.submitSaveCard()              │
│ 1. Get name, description, pagePattern      │
│ 2. Build payload via elementTargets        │
│ 3. POST /element-targets                   │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ Bridge: handleElementTargetSave()          │
│ 1. Validate payload                        │
│ 2. Generate targetId (uuid)                │
│ 3. Store in memory: elementTargets.set()   │
│ 4. Persist to SQLite: store.save()         │
│ 5. Return { ok: true, target }             │
└────────────────────────────────────────────┘

─────────────────────────────────────────────

User opens element library
       │
       ▼
┌────────────────────────────────────────────┐
│ elementSaver.showLibraryCard()             │
│ 1. Create card DOM                         │
│ 2. loadElementLibrary()                    │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ elementSaver.loadElementLibrary()          │
│ 1. GET /element-targets                   │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────┐
│ Bridge: handleElementTargetsList()         │
│ 1. Return project-wide element targets     │
│ 2. Sort by updatedAt desc                  │
│ 3. Return { ok: true, targets: [...] }    │
└─────────┬──────────────────────────────────┘
          │
          ▼
┌────────────────────────┐
│ renderElementLibrary() │
│ Display list in card   │
└────────────────────────┘
```

### 4. 设计规范（DESIGN.md）流程

```
sidepanel/design-docs.js ──bridge proxy──▶ /design-docs (GET/POST/toggle/delete)
                                              │ ws-server.handleDesignDocs → design-docs.ts
                                              ▼
              <项目目录>/.devtailor/design/<uuid>.md  +  settings.design_docs (元数据)
                                              │
review → buildPrompt(payload,{designDocPaths}) ┘  末尾 "## Design Spec" 只列启用文件的绝对路径
        （ClaudeChannelHub.getDesignDocPaths）
```

模块边界：路径只由服务端 uuid 生成；扩展只管 UI，不持有文件内容；AI 自己读取文件。

### 5. AI 状态（hooks 上报 → 侧边栏状态标）

```
Claude Code hook 子进程 ──POST /agent-status (Authorization: Bearer <令牌>)──▶ WSServer.handleAgentStatus
      （<项目>/.devtailor/agent-hook-token，0600）                                │
                                                                                ▼
                                                          AgentStatus.apply(event, payload, now)   ← src/agent-status.ts
                                                                                │  （纯状态机，不持久化）
ClaudeChannelHub ──onAgentStatus('turn_start'|'turn_end')──▶ WSServer.notifyAgentTurn ─┤
   （review 通知写出成功 / 该轮 final·取消·超时·出错）                                      ▼
                          SSE `agent_status {state,label,toolName,activeTools,since}` → 所有已连接客户端
                                                                                │
                                   新客户端连上（connected 之后）单发当前快照 ──┤
                                   GET /health（扩展 Origin）附带 agentStatus ──┘
```

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

**当前设计**：
```javascript
// Bridge: ws-server.ts
private handleElementTargetsList(_url: URL, res: ServerResponse): void {
  const targets = [...this.elementTargets.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(target => this.publicElementTarget(target));
  this.sendJson(res, 200, { ok: true, targets });
}
```

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

### 2. **后端队列管理**

**位置**：`devtailor-bridge/src/ws-server.ts`、`content/modules/chat-send.js`

**状态**：
- 前端不再维护待发送消息队列、重试计数或退避定时器。
- active tab 连续调用 `/review` 时，Bridge 接收请求并进入后端 `Map<clientId, PendingReview[]>` 队列。
- `/review` 返回 `queued`、`queueDepth`、`isProcessing`，运行期 SSE 事件附带 `isProcessing`、`processingSessionId`、`activeSessionId`。
- `chat-send.js` 的 `flushQueue()` / `clearQueue()` 仅保留兼容空实现。

**当前要点**：
1. **权威状态在后端**：`processing`、`processingDisplaySessions` 和 `queues` 由 Bridge 维护。
2. **前端只提交当前输入**：未连接或未接管时提示用户，不缓存消息。
3. **连续发送可排队**：同一 active client 的第二条及之后 `/review` 会返回 `queued: true`。
4. **停止会清空后端队列**：`/cancel` 清理当前 client 的 pending queue，并取消当前 turn。

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

### ADR-003: 元素库数据存储在哪？

**决策**：Bridge 内存 + SQLite 持久化

**理由**：
1. 跨标签页共享数据
2. 页面刷新不丢失
3. 按项目隔离

**代价**：
- 需要 Bridge 运行
- 网络开销（虽然是本地）

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

### 3. 查看元素库
```javascript
await window.__domReview.elementTargets.listAllTargets()
```

### 4. 手动触发重连
```javascript
window.__domReview.wsClient.reconnect()
```

### 5. 查看 Bridge 日志
真实使用时日志直接打在启动 `scripts/claude-devtailor.sh` 的那个终端里（全部写 stderr）。只调试 Bridge 本身时：

```bash
cd devtailor-bridge
npm run dev -- --dir /path/to/project   # 占位会话，不调用真实 AI
```

---

## 📚 相关文档

- [STATE_ANALYSIS.md](./STATE_ANALYSIS.md) - 状态管理与时序问题详细分析
- [HANDOFF.md](./HANDOFF.md) - 交接文档，设计边界和防回归规则
- [devtailor-bridge/README.md](../devtailor-bridge/README.md) - Bridge 服务器文档

---

## 🔌 Claude Code 通道（MCP stdio，唯一后端）

```text
扩展(SW 代理) ──SSE/HTTP──▶ WSServer(34781，安全守卫) ◀──同进程── Claude Code(stdin/stdout)
                                  │                                       │
                                  │                                       └─ 插件 mcpServers.devtailor
                                  └─ BrowserActionRouter → SSE browser_action → 当前接管 tab
数据流：/review → sendReview → notifications/claude/channel → Claude Code → reply → SSE stream/done → 侧边栏
```

- `src/mcp-main.ts` 是 Claude Code 拉起的 stdio MCP server，同进程运行 `WSServer`（HTTP/SSE，`127.0.0.1:34781`）。`src/mcp-server.ts` 声明 `experimental['claude/channel']` + `experimental['claude/channel/permission']` + `tools` 与 `instructions`，提供 18 个浏览器工具和 `reply`，并把 `permission_request` 转发到侧边栏审批卡（见下方「审批」）。
- `ClaudeChannelHub`（进程级）持有 turn 表、超时/无响应计时器、取消通知和图片落盘；`ClaudeChannelSession`（每个展示会话一个）是 `AgentSession` 的薄封装。
- 数据流：`/review` → `sendReview` → `notifications/claude/channel`；Claude → `reply` → `onStream`/`onDone` → SSE `stream`/`done`。`done` 仍只由 `handleReview` 发送一次；异步会话（`sendReview` 返回 `'pending'`）下 `handleReview` 等待 `onDone`/`onError`/`/cancel`。
- 浏览器工具 → `BrowserActionRouter.run` → SSE `browser_action` → 当前接管 tab；元素库三工具本地处理。
- 细节、reply 语义、取消与超时见 `docs/HANDOFF.md`「Claude Code 通道」；协议依据见 `docs/CLAUDE_CHANNEL_PROTOCOL.md`。


## Claude Code 插件与扩展通信

- Bridge 打包成 Claude Code 插件（`claude-plugin/`，MCP server = esbuild 单文件 `server/mcp-main.cjs`），由 `scripts/claude-devtailor.sh` 以 `--plugin-dir` + `--dangerously-load-development-channels plugin:devtailor@inline` 启动 Claude Code 会话；Bridge 随会话启动/退出。详见 `docs/HANDOFF.md`「Claude Code 通道」。
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

- **一份归约器（只有侧边栏使用）**：把 SSE 事件写进注入的消息 store（`message-store.js` 同形接口），并维护 `meta`（`sessionId/title/mode/processing/attach`）；界面只订阅 store/meta 变化渲染。纯逻辑和归约器都有 Node 测试（`tests/extension/`，`npm run test:ext`）。
- **会话来源**：会话列表 `GET /sessions`，当前会话 `GET /sessions/active`（Bridge 持久化的展示会话与消息，没有独立的 transcript 回放接口）；刷新/重连后按 `active_session_sync` + `/sessions/active` 重同步（见 `docs/HANDOFF.md`「Transport」）。
- **审批**：`approval_request` / `approval_pending` / `approval_resolved` 进同一个状态机，`POST /approval-decision` 回传。Claude Code 的权限转发（permission relay）是唯一生产调用方：`permission_request` → 审批卡（没有选项列表时用默认「允许 / 拒绝」）→ `approved`/`rejected` → `notifications/claude/channel/permission`；无客户端/超时/取消不发裁决，交给终端对话框。`QuestionRouter` 仍只保留传输层。
- **侧边栏不开自己的 SSE**：它订阅 service worker 对所有扩展页的广播，所以会收到每个已连接标签页的流，靠 `tabId === 接管标签` 过滤去重。
- **样式**：共享组件样式模块只依赖 `--dt-*` 令牌 + 半透明灰，明暗两套主题通用；侧边栏专属在 `sidepanel.css`，页内工具条样式在 `toolbar.js` 的样式串里。
- **测试矩阵**：`tests/extension/*.test.js`（事件归约、会话按钮可用性、审批状态机、错误码映射、渲染转义）→ `devtailor-bridge npm test`（桥接服务）→ `scripts/e2e-extension.mjs`（真实 Chrome + 真实 Bridge + 假 MCP 客户端端到端）→ `docs/CLAUDE_PLUGIN_VERIFY.md`（真实 Claude 会话的人工验证，自动化不覆盖）。


## 标记工具条与标记同步

页内只有一条 Shadow DOM 标记工具条（`toolbar.js`，样式在同一 shadow root；沿用 `withDevTailorUiHidden`，不进快照/截图/元素选择）。内容脚本的 `review-store.js` 是标记数据源；聊天、会话、审批、模式、计划、用量只在侧边栏。

状态持久化：`chrome.storage.local` 键 `dt_toolbar:<origin>`，值 `{open, top}`（`toolbar-core.js` 序列化/容错解析，损坏数据回落默认；`top` 总会夹取到屏幕内）。

同步消息（`marks-core.js` 构造，大小上限在 `LIMITS`）：

- 内容脚本 → service worker：`{type:'DT_MARKS_CHANGED', url, marks, screenshots, truncated}`；service worker 补上发送者标签页并广播给扩展页：`{type:'DT_MARKS_UPDATED', tabId, url, marks, screenshots, truncated}`。
- `marks[]` 最小字段：`id, index, color, desc(tag#id.class,≤120), selector(≤300), text(≤120), comment(≤500), component(≤80), file(≤200), sent`；最多 200 条，超出置 `truncated`。
- `screenshots[]` 只含 `{id, w, h, bytes}`，最多 8 个；**base64 不走广播**，缩略图用 `DT_GET_SCREENSHOT_THUMBS` 按需取，完整图只在发送时随 `DT_BUILD_PAYLOAD` 返回。
- 侧边栏 → 内容脚本（`chrome.tabs.sendMessage`）：`DT_GET_MARKS`（打开/切换标签时拉取）、`DT_REMOVE_MARK`、`DT_CLEAR_MARKS`、`DT_LOCATE_MARK`、`DT_REMOVE_SCREENSHOT`、`DT_GET_SCREENSHOT_THUMBS`、`DT_BUILD_PAYLOAD`（返回 `{pageUrl, items, screenshots, markIds}`，复用 `prompt-builder.js` 的 `buildPayload`）、`DT_MARKS_SENT/UNSENT/CLEAR_SENT`。托盘从不修改自己的副本，只应用页面回的快照。
- 工具条 → service worker：`OPEN_SIDE_PANEL {focusInput}`（service worker 调 `chrome.sidePanel.open({tabId})`）；侧边栏加载后发 `DT_SIDEPANEL_READY` 询问是否需要聚焦输入框。

发送：侧边栏 `executeSend` 先 `DT_BUILD_PAYLOAD`，再 `POST /review {pageUrl, userIntent, items, screenshots}`。发送后标记标为“已发送”（保留显示，不会进入下一次 payload），本轮 `done` 后清除，`error` 后恢复为未发送。用户消息气泡带 `marks`（编号 chip + 简述 + 截图缩略图）；历史回放里 `marksCore.parseDevTailorPrompt` 识别 prompt-builder 的 Markdown（`## Current Page` / `## User Intent` / `### N \`selector\``）并紧凑渲染，识别失败显示原文。

取消接管：桥接没有显式释放接口，工具条断开本标签的事件流，桥接约 3 秒后释放；侧边栏打开时它自己的事件流也挂着同一个 clientId，释放可能不生效，工具条会提示“关闭侧边栏后可取消接管”。
