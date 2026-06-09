# DevTailor 状态管理与时序现状

> 本文记录当前状态边界、已完成修复和仍需关注的问题。历史 bug 只保留结论，不再把已修复问题列为待修事项。

## 当前核心规则

- 浏览器与 Bridge 使用 SSE + HTTP POST；`content/modules/ws-client.js` 是历史命名，不是 WebSocket 实现。
- Bridge 拥有 display session 和 ACP session 绑定；前端展示历史不再作为 Agent 上下文来源。
- 当前可操作 tab 由 Bridge 的 `BrowserActionRouter.activeClientId` 管理；新 tab 在线不自动抢占，用户需要显式「连接当前页」。
- Browser MCP 操作只发往当前已接管 tab；Agent 不传 `tabId`、`clientId` 或 `pageUrl`。
- 元素库是项目级全量库；`GET /element-targets` 和 MCP `get_element_targets` 都返回项目全量。
- 旧的 `/element-targets?url=...` 当前页过滤 API 已废除，不应恢复。

## 已完成修复

### 2026-06-08

### 1. SSE 连接竞态条件

- 使用 async/await 确保 `/health` 返回并设置 `projectInfo` 后再触发监听器。
- 增加响应验证和错误处理。
- 规则：连接状态、项目状态和会话恢复必须按顺序推进。

### 2. `activeStreamId` 状态管理

- 重构 `ensureStreamAtTail()`，明确返回是否创建新流。
- 当旧流被其他消息插队时，先 `endStream()` 再创建新流。
- 规则：同一时刻只能有一个 active stream，且必须位于消息尾部。

### 3. 工具状态标记

- 工具状态不再无条件标记完成。
- 只在有活跃流输出或 done 收尾时按当前事件语义统一清理剩余工具状态。
- 规则：工具卡片 UI 是展示状态，不等同于工具真实业务断言；业务成功仍应看 tool result 或后续断言。

### 4. SSE 心跳机制

- 添加 30 秒定时检测。
- 收到 SSE 消息时刷新 `lastHeartbeatTime`。
- 超过 60 秒无消息时自动重连。

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

- 发送队列支持渐进退避：`100ms -> 500ms -> 2000ms`。
- 失败时使用 peek 模式保留消息，成功后才移除。
- 连接断开时等待重连，避免直接丢弃。
- 新增 `clearQueue()`，用于取消和清理待发送任务。

## 仍需关注

### 1. 流式渲染性能

**位置**：`chat-bridge-events.js`、`shadow-ui.js`

当前消息渲染仍然偏全量，流式 delta 较密时可能增加 CPU 和滚动计算压力。

建议：

```javascript
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderMessages();
    followLatestIfPinned();
    renderScheduled = false;
  });
}
```

### 2. 全局模块命名空间

**位置**：content modules

所有模块仍挂载到 `window.__domReview`。这符合当前 vanilla content script 架构，但依赖关系不够显式。

建议：

- 短期保持现状，避免引入构建链。
- 新模块暴露面要小，优先提供明确方法而不是裸状态对象。
- 若未来模块继续增长，再考虑轻量依赖注册器。

### 3. Browser action 结果大小

**位置**：`browser-action-router.ts`、`browser-actions.js`

截图和大型 `run_js` 结果已经有部分外部化/限制，但仍需持续防止 tool result 过大。

建议：

- 文本结果保持摘要优先。
- 图片结果继续外部化为 `filePath + dataOmitted`。
- `run_js` 只返回 JSON 可序列化的小结果。

## 常见误区

- 不要把 `ws-client.js` 改回 WebSocket。
- 不要恢复 `/element-targets?url=...` 当前页过滤。
- 不要让新 tab 建立 SSE 连接后自动抢占 active tab。
- 不要把前端展示历史重新发给 Agent。
- 不要把 `run_js` 当成常规点击、填表、按键入口。
- 不要让元素库退化成 CSS selector 收藏夹。

## 当前优先级

### P0

- 保持 active tab、display session、ACP session 三者边界清晰。
- 保持元素库项目全量语义。
- 持续维护 SSE/HTTP 的结构化错误。

### P1

- 批量渲染优化。
- Browser action result 大小治理。
- 更清楚的模块依赖边界。

### P2

- 状态机化连接/会话/请求流程。
- 更系统的 content module 测试。
- 评估是否需要 TypeScript 迁移 content modules。
