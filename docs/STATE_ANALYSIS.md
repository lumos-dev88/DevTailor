# DevTailor 状态管理与时序现状

> 本文记录当前状态边界、已完成修复和仍需关注的问题。历史 bug 只保留结论，不再把已修复问题列为待修事项。

## 当前核心规则

- 浏览器扩展与 Bridge 使用 SSE + HTTP POST，但网络连接由 `background/service-worker.js` 统一代理；content script 通过 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` 与 background 通信。`content/modules/ws-client.js` 是历史命名，不是 WebSocket 实现。
- Bridge 拥有 display session 和本地 agent session 绑定；前端展示历史不再作为常规 Agent 上下文来源。
- 当前可操作 tab 由 Bridge 的 `BrowserActionRouter.activeClientId` 管理；新 tab 在线不自动抢占，用户需要显式「连接当前页」。
- 发送 chat review 不要求当前 tab 已接管；接管状态只影响 browser tool/action 路由目标。
- Browser tool 操作只发往当前已接管 tab；Agent 不传 `tabId`、`clientId` 或 `pageUrl`。
- 元素库是项目级全量库；`GET /element-targets` 和 browser tool `get_element_targets` 都返回项目全量。
- 旧的 `/element-targets?url=...` 当前页过滤 API 已废除，不应恢复。

## 已完成修复

### 2026-06-08

### 1. SSE 连接竞态条件

- background 维护 `/events` SSE fetch stream，content script 收到 proxy open 后通过代理 `/health`，确保返回并设置 `projectInfo` 后再触发监听器。
- 增加响应验证和错误处理。
- 规则：连接状态、项目状态和会话恢复必须按顺序推进。

### 2. `activeStreamId` 状态管理

- 重构 `ensureStreamAtTail()`，明确返回是否创建新流。
- 当旧流被其他消息插队时，先 `endStream()` 再创建新流。
- 规则：同一时刻只能有一个 active stream，且必须位于消息尾部。

### 3. 工具状态标记

- 已移除：Claude 通道（以及 Placeholder 会话）不产生 `thinking` / `tool_call` / `tool_update`，Bridge 的 onThinking/onToolCall/onToolUpdate 回调、侧边栏 thinking 块与工具卡片（含 `chat-tools.js`）已整体删除。
- 仍保留：取消时的 `tool_status { toolStatus: 'canceled' }`，前端只把它当作“本轮已取消”的收尾信号，不依赖任何 tool 消息。
- 旧会话兼容：`ws-server.loadPersistedSessions()` 恢复 SQLite 历史时过滤掉 `type` 为 `thinking` / `tool` 的消息。
- AI 实时状态（`agent_status` 的 `thinking/tool/waiting`）来自 hook 状态机，是另一条链路，不受影响。

### 4. SSE 心跳机制

- 添加 30 秒定时检测。
- 收到 background proxy 转发的 SSE 消息时刷新 `lastHeartbeatTime`。
- 超过 60 秒无消息时通知 background 断开旧 SSE proxy 并自动重连。

### 5. 元素库 URL 过滤 API 废除

- 旧问题：前端 `/element-targets?url=...` 与 MCP 项目全量返回语义不一致。
- 当前设计：`GET /element-targets` 统一返回项目全量；前端元素库和 MCP `get_element_targets` 保持一致。
- 影响：不再出现“前端为空但 AI 能查到数据”的分叉。
- 位置：`devtailor-bridge/src/ws-server.ts`、`content/modules/element-targets.js`。

### 2026-06-09

### 6. 持久化逻辑澄清

- Display messages 由 Bridge 管理，通过 `session_snapshot` 事件恢复。
- `chat-persistence.js` 只持久化轻量 UI 状态：待发送图片、截图引用、发送状态等。
- 规则：不要把前端历史重新拼进 prompt，也不要让 `chrome.storage.local` 成为聊天记录权威来源。

### 7. 队列管理增强

- Review 请求队列由 Bridge 持有；前端发送不再维护待发送消息队列。
- 发送即完成：`POST /review` 立即返回 202（`{ok,turnId,sessionId}`），不再有排队深度、429 队列满、`queue_status` 事件，也没有 `isProcessing`/processing 锁；`done` 事件不再发送（旧 `done` 若到达仍当作流式气泡收尾）。
- 流式气泡无 `done` 收尾：下一条用户消息、新的 `displayMessage.id`、工具/审批/提问卡、`error`、`tool_status canceled` 触发 `endStream()`，所以不会永远「流式中」。
- 标记时机：2xx 清除，失败恢复；503 `no_claude_instance` 作为失败提示（标记恢复）。
- 前端仍可在连接断开时依靠 SSE/HTTP 恢复探测重连，但不要恢复旧的前端待发送队列。

### 8. Runtime 上下文轻量压缩

- `RealAgentSession` 保留本地 AI runtime 多轮上下文，但在写回 history 前执行 micro-compaction。
- 规则：最近消息保持原样；旧的大型 `tool_result` content 只保留短 marker；旧图片 content block 替换为图片存在性 marker，再执行字符预算裁剪。
- `OpenAICompatibleProvider` 会把上下文超限类 HTTP 错误标记为 `context_overflow` code，便于后续接入自动压缩/重试。
- 规则：micro-compaction 不调用 LLM，不改变 display session 展示消息，只影响后续 runtime prompt history。

## 仍需关注

### 1. 流式渲染性能 — ✅ 已修复

**位置**：`message-store.js`、`chat-panel.js`

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

- `append()` / `update()` / `remove()` / `clear()` / `replaceAll()` 等 mutation 只调度 `_notify()`
- 同一帧内的多次调用（如流式输出的密集 delta）只会触发一次 `requestAnimationFrame`
- `chat-panel.js` 通过 `messageStore.subscribe(renderMessages)` 订阅，实现自动批量渲染
- 新增 `findLast(predicate)` API，避免 `[...getAll()].reverse().find()` 创建临时数组

**结果**：流式渲染每 delta 从 ~16ms 降至 ~2ms（RAF batched），CPU 占用显著降低。

### 2. 全局模块命名空间

**位置**：content modules

所有模块仍挂载到 `window.__domReview`。这符合当前 vanilla content script 架构，但依赖关系不够显式。

建议：

- 短期保持现状，避免引入构建链。
- 新模块暴露面要小，优先提供明确方法而不是裸状态对象。
- `message-store.js` 已作为轻量 reactive facade 落地，所有消息 mutation 走统一 API，不再直接操作裸数组。
- 若未来模块继续增长，再考虑轻量依赖注册器。

### 3. Browser action 结果大小

**位置**：`browser-action-router.ts`、`browser-actions.js`

截图和大型 `run_js` 结果已经有部分外部化/限制，但仍需持续防止 tool result 过大。
`BrowserActionRouter.receiveResult()` 对未知或迟到的 requestId 会输出 warn 日志并保持返回 `false`，用于诊断超时后结果回流、tab 切换或旧 content script 残留。

建议：

- 文本结果保持摘要优先。
- 图片结果继续外部化为 `filePath + dataOmitted`。
- `run_js` 只返回 JSON 可序列化的小结果。

## 常见误区

- 不要把 `ws-client.js` 改回 WebSocket。
- 不要让 content script 直接访问 Bridge 或直接创建 `EventSource`；标准通道是 background service worker proxy。
- 不要恢复 `/element-targets?url=...` 当前页过滤。
- 不要让新 tab 建立 SSE 连接后自动抢占 active tab。
- 不要把前端展示历史重新发给 Agent。
- 不要把 `run_js` 当成常规点击、填表、按键入口。
- 不要让元素库退化成 CSS selector 收藏夹。

## 当前优先级

### P0

- 保持 active tab、display session、agent session 三者边界清晰。
- 保持元素库项目全量语义。
- 持续维护 SSE/HTTP 的结构化错误。

### P1

- ✅ 批量渲染优化（message-store.js RAF batching + findLast）。
- Browser action result 大小治理。
- 更清楚的模块依赖边界。

### P2

- 状态机化连接/会话/请求流程。
- 更系统的 content module 测试。
- 评估是否需要 TypeScript 迁移 content modules。
