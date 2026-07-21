# DevTailor Handoff Notes

> 修改 chat、bridge、agent session、持久化、SSE、图片、Markdown、browser tool 或元素库逻辑前，先读本文。这里记录当前设计边界和防回归规则。

## 产品定位

DevTailor 是 **浏览器页面 ↔ 本地 AI 调试后端的前端开发桥接工具**，由两部分组成：

1. **Chrome 扩展**：在真实页面里提供悬浮 Chat 面板、元素标记、截图、元素库、browser tool 调用和消息流式展示。
2. **Local Bridge**：通过 SSE/HTTP 对接扩展，管理项目级展示会话和本地 agent session，并把浏览器操作指令路由到已接管 tab。

核心目标：用户在页面上指出问题，Agent 获得 DOM、截图、标记元素、控制台信息和浏览器操作能力，完成“理解页面 → 修改代码 → 回到页面验证”的闭环。

## 快速启动

在 `devtailor-bridge/` 目录运行：

```bash
npm run dev -- --dir ../../todo
```

常用命令：

```bash
npm run dev -- --dir /absolute/path/to/project
npm run build
npm test
```

注意：

- `--` 是 npm 参数分隔符，不能省。
- `--dir` 是项目目录，用于计算项目身份和 `.devtailor/` 存储目录。
- `--agent`、内置 agent 预设和 ACP 原始命令已移除；Bridge 现在启动本地后端 runtime。
- Bridge 固定监听 `34781`，这是扩展约定端口；当前 CLI 不暴露 `--port`。

## Agent runtime

Bridge 不再保留 ACP adapter，不再 spawn ACP 进程，也不暴露 Browser MCP JSON-RPC endpoint。

Bridge 通过 `AgentSession` + `BrowserToolRunner` + `WorkspaceToolRunner` 连接 AI runtime、browser tools 和项目 workspace tools。

### Scream runtime (Phase 1)

`ScreamAgentSession`（`devtailor-bridge/src/scream-agent-session.ts`）是新的 Scream-backed runtime，通过 `DEVTAILOR_RUNTIME=scream`（默认）环境变量启用；设置为其他值时退回 `RealAgentSession`（旧 OpenAI-compatible runtime）。

- 选择逻辑在 `ws-server.ts` 的 `createConfiguredSessionFactory()` 中，通过 `process.env.DEVTAILOR_RUNTIME` 判断。默认值是 `'scream'`。
- Scream SDK 以 ESM bundle 形式在 `scream-code-main/runtime/node-sdk/dist/index.mjs` 就地载入，通过 CommonJS `import()` 动态导入（Node 22+ 支持从 CJS 模块动态 import ESM）。bridge `tsc` 构建和 `tsx` dev 运行均通过。
- 配置映射：DevTailor `ModelConfig`（`baseUrl`, `apiKey`, `model`）→ Scream `ScreamConfigPatch`，provider type 设为 `'openai'`，provider 名称 `devtailor`，model alias `devtailor-model`，`maxContextSize` 默认 128000。
- Scream home 作用域在 `{projectDir}/.devtailor/scream-home`，不污染用户的 `~/.scream` 目录。
- Phase 1 限制：仅支持 text-only turn；`permission: 'yolo'` 自动批准所有工具；Scream 原生 workspace tools（bash/read/write/edit/grep）由 Scream 自身管理。
- 事件映射：`assistant.delta` → `onStream`，`thinking.delta` → `onThinking`，`tool.call.started` → `onToolCall`，`tool.progress` / `tool.result` → `onToolUpdate`，`turn.ended` → resolve/reject `sendReview` promise + `onDone`/`onError`，`session.meta.updated` → `onSessionInfoUpdate`。
- 此 runtime 在同一 `AgentSession` 边界后面，不破坏现有 SSE、display session、cancel、queue 和 browser tool 路由逻辑。

### Scream runtime（Phase 2：browser tools）

Phase 2 让模型在 Scream turn 内调用 DevTailor 的 browser tools（`click_page`/`fill_text`/`get_page_snapshot` 等），并把调用路由回扩展。

- Scream node-sdk 已 fork 扩展（改动仅限 `scream-code-main/runtime/node-sdk/src`，agent-core 未改）：`Session` 新增 `registerUserTool(decl)` / `unregisterUserTool(name)` / `setToolCallHandler(fn)`；`SDKRpcClient.toolCall` 的 stub 被替换为按 sessionId 分发的 handler map（镜像 `setApprovalHandler`/`requestApproval`）。改动后已重建 `runtime/node-sdk/dist/index.mjs`（bridge 就地导入的 bundle）。**修改 node-sdk 源码后必须重新 `pnpm --filter @scream-code/scream-code-sdk build`，否则 bridge 载入的 bundle 不会更新。**
- `ScreamAgentSession.start()` 在 `createSession()` 之后，若构造参数带 `runBrowserTool`，则为 `createBrowserToolDefinitions()` 的每个定义调用 `registerUserTool`，再 `setToolCallHandler`。workspace tools 不注册（Scream 原生管理），`runWorkspaceTool` 仍忽略。
- **toolCall 反向 RPC 不带 tool name**，只有 `toolCallId` + `args`。`ScreamAgentSession` 用实例字段 `toolNameById: Map<toolCallId, name>` 解决：在 `tool.call.started` 事件里写入映射（agent-core 保证该事件先于 `execute()`/toolCall handler 触发），在 `tool.result` 里清理。handler 用 `toolCallId` 反查 name，`isBrowserToolName` 校验后调用 `runBrowserTool(name, args)`。
- 结果格式与 `RealAgentSession` 一致：`{ output: JSON.stringify(ok ? result ?? null : error ?? null), isError: !ok }`；未知 name 或 handler 抛错返回 `{ output: JSON.stringify({ error }), isError: true }`。
- Phase 2 仍未做：截图等 image 类工具结果只按 JSON 字符串回传（不作为 image content part 供模型「看」）；approval/question 交互；history 迁移。
- 防回归：Scream 的 browser tool call 与 `RealAgentSession` 共用同一个 `BrowserActionRouter` 出口，不要在 Scream 侧另起浏览器路由；不要给 Scream 注册 workspace tool 定义（会与原生工具重名冲突）。

- 模型配置入口在扩展 popup 的「模型配置」区域，通过 Bridge `GET/POST /model-config` 读写当前项目 `.devtailor/sessions.db` 的 `settings.model_config`。配置完整时使用 `RealAgentSession` + `OpenAICompatibleProvider`（或 `ScreamAgentSession`，视 `DEVTAILOR_RUNTIME` 环境变量而定）。模型 browser tool call 会映射到 `BrowserActionRouter.run()`，再通过 SSE/HTTP 路由到当前已连接 tab；workspace tool call 会映射到 Bridge 进程内的 `WorkspaceToolService`（RealAgentSession）或 Scream 原生工具（ScreamAgentSession）。
- `OpenAICompatibleProvider` 请求仍走 `/v1/chat/completions` 和 OpenAI-compatible body，但 HTTP headers 模拟 Claude Code 客户端：包含 `User-Agent: claude-code/2.1.195`、`anthropic-version: 2023-06-01`、`anthropic-beta: claude-code-20250219`、`x-api-key`，同时保留 `Authorization: Bearer ...` 以兼容 OpenAI 风格代理。
- `OpenAICompatibleProvider` 的响应解析必须兼容常见 OpenAI-like 代理差异：`data: {...}`、`data:{...}`、非流式 JSON `choices[].message.content` 和 200 JSON error body；无法识别的 200 响应必须显式返回 error，不能静默 `done` 导致前端看不到回复也看不到异常。
- OpenAI-like tool_call 也不能假设严格流式格式：解析时要兼容缺失 `index` / `id`、`arguments` 为对象而非字符串、以及非流式 `choices[].message.tool_calls`；缺 id 时生成稳定 `call_N`，对象参数要 `JSON.stringify`，否则工具执行和 tool result 回填会卡住。
- runtime history 不能把完全空的 assistant turn 发给模型；`generate()` 不应把无文本且无 tool_calls 的 assistant 写入 history，`OpenAICompatibleProvider` 序列化时也要跳过旧 history 中的空 assistant，避免代理返回 `assistant must not be empty`。
- 环境变量 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL` / `DEVTAILOR_MODEL` 只作为迁移兜底：当项目尚无 UI 模型配置时，Bridge 启动会把它们写入项目配置；之后应通过 UI 修改，不再依赖环境变量注入。
- 模型配置缺失或被禁用时，Bridge fallback 到 `LocalAgentSession` 过渡 runtime；它会在 review turn 中收集页面快照、console 和元素库上下文，并以 `tool_call` / `tool_update` / `stream` 事件回传。
- workspace 边界对齐 scream-code：Bridge 启动时的 `--dir` / `--cwd` 是项目工作区根目录；workspace tools 的相对路径从该目录解析，绝对路径也必须落在该根目录内。
- 当前 workspace tools：`bash`、`read_file`、`write_file`、`edit_file`、`grep_files`、`glob_files`、`list_directory`。用于“检查页面 → 修改代码 → 构建/测试 → 浏览器验证”的闭环。

## Prompt 缓存策略

**核心原则：稳定内容放前面，动态用户输入放后面。缓存命中依赖前缀一致，不依赖某个 header。**

不要把缓存设计成统一的 `headers["cache"] = true`。不同厂商的缓存机制不同，按 provider 配置 `cacheStrategy`：

| 策略 | 适用厂商 | 行为 |
|------|---------|------|
| `automatic`（默认） | OpenAI GPT-4o+、DeepSeek、Gemini 2.5+、Grok、MiniMax | 不改请求结构，依赖厂商自动缓存 |
| `body_cache_control` | Anthropic Claude、Qwen 显式缓存、Bedrock Claude | 请求体 content block 添加 `cache_control: { type: "ephemeral" }` |
| `cached_content_object` | Gemini 显式缓存 | 先创建 cache，再引用 `cachedContent`（未实现） |
| `routing_hint` | OpenRouter、xAI Grok（可选） | 添加 `x-grok-conv-id` / `x-session-id` header，仅帮助粘性路由提高命中率，非缓存开关 |
| `none` | 无 | 不做任何缓存优化 |

### `body_cache_control` 的 cache_control 放置规则

`OpenAICompatibleProvider` 在 `body_cache_control` 策略下自动在请求体中添加 `cache_control` 标记：

1. **System prompt**：最后一块 content block 标记 `cache_control: { type: "ephemeral" }`（最稳定，总是缓存）
2. **最后一个用户消息之前的那条消息**：标记为缓存断点。断点之前（含断点）的所有内容被缓存，断点之后的当前用户消息不被缓存，每次重新计算

这就是 Anthropic 的"缓存前缀"模式：系统 prompt + 历史对话被缓存，只有最新用户输入不被缓存。

### 消息排序保证前缀一致

- `generate()` 始终将 system prompt 放在 messages 数组最前面
- messages 数组按时间顺序排列（旧 → 新），稳定内容在前，动态内容在后
- 这与所有厂商的"前缀匹配"缓存机制一致

### 配置方式

在模型配置中通过 `cacheStrategy` 字段指定：

```json
{
  "provider": "openai-compatible",
  "model": "claude-sonnet-4-20250514",
  "cacheStrategy": "body_cache_control"
}
```

默认 `automatic`，对 OpenAI、DeepSeek 等自动缓存的厂商无需配置。
- `read_file` 输出行号和 `<system>` 状态块，状态块包含 `Anchor`、截断信息和换行风格；`edit_file.anchor` 可防止基于过期读取结果改错位置，CRLF 文件按 LF 展示并在写回时保留 CRLF。
- `grep_files` 支持 `output_mode`、`glob`、`-i`、`-A/-B/-C`、`offset + head_limit` 分页和 `multiline`；`glob_files` 按 mtime 新到旧排序，返回可直接给 `read_file` / `edit_file` 使用的相对路径。
- `bash` 返回 stdout/stderr 原始字段和合并后的 `output` 字段；失败命令在 `output` 末尾追加 `Command failed with exit code: N`，便于模型判断。
- `RealAgentSession` 的上下文管理采用 **cache-first（缓存优先）** 策略，对齐 Claude Code 的 Session Memory 设计思路：
  - **主策略 — 缓存优先丢弃**：当上下文紧张时，直接丢弃旧消息，依赖已注入 system prompt 的 Session Memory 摘要作为缓存。模型通过摘要理解会话状态，无需看到完整历史。这替代了传统的压缩式上下文管理（不再逐个 compact tool result 来节省 token）。
  - **辅助策略 — micro-compaction**：每轮结束后仍对保留的消息执行 cache-aware micro-compaction（热/温/冷三区），清理大型 tool result 和图片，作为辅助优化。
  - **上下文溢出恢复**：API 返回 context overflow 时，激进丢弃旧消息（仅保留最近 4 条），依赖 Session Memory 摘要作为上下文缓存，然后重试（最多 2 次）。
- `RealAgentSession` 维护 `SessionMemory`（渐进式会话摘要缓存），每轮对话后增量更新，包含任务、关键文件、决策、错误和当前状态。系统 prompt 会注入此缓存摘要（`<session_memory>` 标签包裹），允许模型在上下文紧张时通过摘要理解会话状态，而非依赖完整历史。
- `SessionMemory` 支持文件持久化：保存到 `.devtailor/session-memory.md`（YAML front matter + Markdown），会话启动时加载恢复。文件即为缓存，跨 Bridge 重启后仍可恢复上下文。
- `RealAgentSession` 使用 `ContextBudgetTracker` 监控上下文 token 预算，支持多层阈值：warning（警告）→ auto_compact（触发缓存优先丢弃或压缩）→ error（返回错误）→ blocking（必须处理）。在 `generate()` 前主动检查预算，优先使用缓存丢弃策略。
- `generate()` 在每步循环前检查上下文字符预算（150K 字符阈值），超限时返回 `context_overflow` finishReason，供 `RealAgentSession` 执行恢复重试。
- `OpenAICompatibleProvider` 对上下文超限错误使用 `context_overflow` code；下游如果要自动压缩/重试，应基于该 code 增量接入，不要破坏现有 429/5xx 重试语义。
- 后续 runtime 改造必须复用同一 `AgentSession` + tool runner 边界，不要恢复 ACP adapter。

## 前端技术栈边界

保持扩展前端轻量原生：

- 使用 manifest 注入 vanilla JavaScript content scripts。
- UI 放在 Shadow DOM 内，由 `content/modules/shadow-ui.js` 和拆分后的 chat 模块组合。
- `chrome.sidePanel` 已承载真实 Chat 消息流、Markdown 和图片附件；content script 的 Shadow DOM 浮层仍负责页面标记、元素选择、overlay、browser action 命中辅助等贴近页面 DOM 的工具能力。
- 不引入 React、Vue、Angular 或 SPA 构建链，除非产品范围发生明显变化。
- DevTailor 自己的 UI 事件必须停在 Shadow DOM/自身浮层边界，不要触发页面外部点击导致页面弹窗关闭。
- DevTailor UI 必须遵守“卡片隔离”规范：
  - 宿主容器和全屏辅助层默认 `pointer-events: none`，只让真实可见、可操作的卡片/按钮恢复 `pointer-events: auto`。
  - DevTailor 卡片内事件必须 `stopPropagation`，不能触发宿主页面的外部点击、快捷键或焦点逻辑。
  - DevTailor 的透明区域、空白区域和定位容器必须让页面点击穿透。
  - browser tool 的坐标/网格点击和截图默认必须跳过或隐藏 DevTailor UI，不能把调试面板当成页面目标。
  - Shadow UI 面板和 FAB 必须允许四边贴边，clamp 边距为 `0`，不要为顶部预留默认安全距离。
  - 面板坐标里的 `0` 是有效值；读取 `left/top` 时不要使用 `parseFloat(...) || DEFAULT_POSITION.*`，避免把 `0px` 错当缺省值弹回默认位置。
  - Shadow DOM 不能阻止宿主页面更早注册的 document 捕获阶段监听器看到部分 composed 事件；如果要做到完全事件/焦点沙箱，chat UI 应迁移到 iframe 隔离层，而不是继续扩大页面级拦截。

当前 chat 拆分：

- `message-store.js`：消息数组的 reactive facade，提供 append/update/remove/clear/replaceAll/find/findLast/filter/subscribe 等 API，内部通过 RAF 批处理合并同一帧内的多次 mutation，避免流式输出时频繁重绘。
- `chat-markdown.js`：Markdown 渲染和 sanitizer。
- `chat-tools.js`：tool 标题、分组、状态、内容格式化。
- `chat-scroll.js`：滚动跟随、回到底部按钮。
- `chat-images.js`：截图/粘贴图片、待发送缩略图。
- `chat-persistence.js`：前端轻量 UI 状态缓存。
- `chat-preview-editor.js`：图片预览和标注编辑。
- `chat-bridge-events.js`：SSE / agent 事件映射到 UI 消息。
- `chat-send.js`：发送、新会话、取消、请求状态。
- `chat-panel.js`：状态组合、渲染和事件装配。

这些模块必须在 `chat-panel.js` 之前加载。

## Transport

浏览器 ↔ Bridge 使用 SSE + HTTP POST：

- `GET /events?clientId=...`：SSE 事件流。
- `POST /review`：发送当前用户请求。
- `POST /activate`：当前 tab 接管项目浏览器操作权。
- `POST /cancel`：取消当前 Agent turn。
- `POST /browser-tool`：Bridge 本地 browser tool endpoint，直接调用 `BrowserActionRouter.run()`。
- `GET /health`：项目、runtime、激活 tab、agent session 元数据和 Bridge 进程 PID（供 CLI 安全处理端口冲突）。
- `POST /new-session`：创建或复用空白展示会话。
- `GET /sessions` / `GET /sessions/active` / `POST /sessions/load` / `POST /sessions/delete`：展示会话管理。
- `GET /element-targets` / `POST /element-targets` / `DELETE /element-targets/:id`：元素库。
- `POST /browser-action-result`：扩展回传 browser action 执行结果。

`content/modules/ws-client.js` 名字保留是兼容历史调用点，但实现是 SSE，不是 WebSocket。不要因为文件名把传输层改回 WebSocket。

休眠/网络恢复边界：

- content script 不直接访问 Bridge，也不直接创建 `EventSource`；标准通道是 background service worker Bridge proxy。background 维护 SSE fetch stream 并通过 `chrome.tabs.sendMessage` 转发事件，普通 HTTP API 通过 `chrome.runtime.sendMessage` 代理，避免受宿主页面网络上下文限制。
- `online`、`pageshow`、窗口 focus 和页面重新可见时要主动做轻量恢复探测，必要时通知 background 关闭旧 SSE proxy 并重建连接。
- background proxy SSE 断开后，content 应快速重连，并在 proxy open 后主动拉 `/sessions/active` 发出 `session_snapshot(reason: "reconnect")`，用 Bridge 持久化消息补偿断线期间丢失的 stream/thinking/tool 事件；重连 snapshot 不应展示“会话已切换”提示。若重连 snapshot 尾部是 stream 消息，chat 层应把它恢复为 active stream，后续 delta 继续追加到同一条 assistant 消息。
- sidePanel 不能依赖 content script 在内存中 `emit` 的重连快照；侧边栏首次打开、SSE 重连、active client 或 active session 变化时，必须自行请求 `/sessions/active`，否则中途打开只会看到后续工具与 AI 增量事件，丢失已持久化的用户消息。定时 `/health` 检查只在 client/session 变化时触发快照，不应周期性覆盖正在流式追加的消息。Bridge 持久化用户消息后还必须发出 `display_message`，让已打开的侧边栏实时接收从悬浮窗发送的文本或标记；侧边栏自身的乐观用户消息应用持久化 id 对齐，不能重复显示。
- 刷新后的发送/停止按钮状态必须从 Bridge 的运行状态恢复：`/health` 和 `/sessions/active` 应暴露当前 client 是否正在处理请求，前端恢复 active session 或 reconnect snapshot 时同步 `requestInFlight`，不能只依赖 content script 内存或 `chrome.storage`。
- Bridge 从未启动到启动完成的场景，应靠前端恢复探测和指数退避共同恢复，不要求用户刷新页面。
- 刷新/重注入期间 `GET_TAB_ID` 可能短暂返回空；`clientId` 初始化必须 single-flight，优先保持真实 `tab_{id}`，临时 fallback id 只能兜底且要继续尝试升级回真实 tab id，避免刷新后 active tab 变成“待连接”。
- 手动或动态重注入 content scripts 前必须先调用旧 `window.__domReview.wsClient.disconnect()`（若存在），避免旧 background SSE proxy 残留，导致 Bridge 继续把 browser action 指令路由到旧 tab 连接。
- background 访问 Bridge 时应支持 `localhost:34781` 和 `127.0.0.1:34781` fallback；SSE 成功连接后，`review`、session、Browser action result、元素库等 HTTP API 应复用同一个当前可用 Bridge URL。fallback 初始连接要有短超时并优先尝试上次成功地址，避免页面刷新后卡在不可用 loopback hostname 上。

## 项目身份与 Tab 接管

Bridge 根据 `--dir` 计算项目身份：

```text
projectId = sha256(realpath(--dir)).slice(0, 12)
projectName = basename(realpath(--dir))
bridgeInstanceId = randomUUID() per bridge process start
```

规则：

- 会话展示数据按项目和 runtime key 隔离，不按端口隔离。
- `clientId = tab_{tabId}` 只用于 live routing 和 browser action 指令路由。
- 浏览器 tab 是可替换的调试页面，不是会话所有者。
- 新 tab 连接后默认只是在线，必须显式点击「接管」才会覆盖旧激活 tab。
- 刷新当前已接管 tab 不应丢失 active ownership。
- 已连接 tab 都可以发送 chat review；接管只决定 browser actions / browser tools 作用到哪个 tab。
- Browser actions 只能作用于当前项目已接管 tab。

## 会话与上下文规则

最重要的规则：

```text
前端消息 = UI 展示
Bridge display session = 本地展示会话
Agent session = 本地 AI runtime 的多轮上下文
```

发送新消息时，前端只发送当前请求：

- 当前输入文本
- 当前标记元素
- 当前截图/粘贴图片

不要把前端历史消息重新拼进 prompt。Agent session 应维护多轮上下文；只有 runtime 丢失上下文时才用展示历史兜底。

Bridge 拥有展示会话：

- 每个 display session 可绑定一个本地 agent session。
- 展示会话按 project + runtime key 隔离。
- 切换 display session 等于切换后续 prompt 进入哪个 agent session。
- stream/thinking/tool/done/error 等运行事件必须携带 display `sessionId`；前端只接收当前会话的运行事件，避免新建/切换后旧 turn 回流污染当前 UI。
- 用户主动新建会话的 `session_reset` 只清空当前展示，不插入“会话已重建”提示；Bridge 重启等异常 reset 才展示提示。
- 删除 display session 应删除对应展示消息，并停止/移除对应 agent session。
- 会话标题优先采用 agent runtime 的 `session_info` 更新，Bridge 持久化后通过 SSE `session_info` 同步给前端；首条用户消息截断标题只是 fallback。
- 前端发送只依赖 Bridge 连接状态，不依赖当前 tab 是否已接管；未接管时仍可发送消息，browser tools 如需页面操作会继续路由到当前已接管 tab，若没有 active tab 则返回结构化错误。

前端 `chrome.storage.local` 只适合缓存草稿、待发送图片、控件状态等轻量 UI 状态。不要让它成为聊天记录的权威来源，也不要把它当作 Agent 上下文。

## Bridge Session 管理

Bridge 维护：

```ts
Map<displaySessionId, AgentSession>
Map<clientId, PendingReview[]>
Set<clientId> processing
activeClientId
SessionStore(SQLite)
```

重要行为：

- 一个 display session 对应一个 agent session。
- 同一 client 的请求串行处理。
- `/review` 是后端队列入口：任意已连接 tab 连续发送时 Bridge 接收请求并返回 `queued/queueDepth/isProcessing`，前端不再维护待发送消息队列和重试队列。
- 运行期 SSE 事件（stream/thinking/tool/done/error/queue_status）必须由 Bridge 附带 `isProcessing`、`processingSessionId`、`activeSessionId`，前端发送按钮状态以后端状态为准。
- 前端进入异步 `/review` 前必须先设置发送中 single-flight 状态，不能在 `await wsClient.send()` 后才锁定，否则双击按钮或连按 Enter 会触发重复发送。
- 不要并发调用同一个 agent session 的 `sendReview()`。
- 底部「停止」只用于取消当前 turn。如果 runtime 不及时返回取消，需要强制停止该 agent session 兜底解锁 UI 和队列。
- 空闲 session 会清理。
- Browser action request/response 通过 requestId 匹配，超时要返回结构化错误。

## 持久化规则

项目级数据存储在：

```text
{projectRoot}/.devtailor/
```

当前持久化内容：

- display sessions
- display messages
- 图片引用
- element targets

SQLite schema 变更必须写迁移，不要假设用户已有 `.devtailor/sessions.db` 是最新结构。尤其 `element_targets` 这类新增表/列必须支持旧库启动。

修改 `devtailor-bridge/src/session-store.ts` 后，至少跑：

```bash
cd devtailor-bridge
npm test
npm run build
```

## Browser Tool 边界

当前工具：

```text
页面信息：get_page_snapshot、take_visible_screenshot、get_console_logs、get_console_message、get_element_targets
元素管理：save_element_target
页面控制：reload_page、wait_for_selector、wait_for_text
交互操作：click_page、type_text、fill_text、press_key、clear_state
代码执行：run_js
批量流程：run_actions
辅助能力：request_user_assistance
```

规则：

- `get_page_snapshot` 默认应保持轻量，优先返回可见交互元素，不要默认吐出超大 DOM。
- `take_visible_screenshot` 默认隐藏 DevTailor UI；支持网格截图用于坐标定位。
- `run_actions` 是轻量流程编排层，介于单步操作和完整 E2E 之间；临时执行，不落地测试文件。
- `run_actions` 对外 schema 必须与 content runner 保持一致：`actions[]` 是 action batch，每个 batch 包含 `steps[]`，每个 step 使用 `type` 和扁平参数；`{ action, params }` 只作为迁移兼容输入，不应作为模型主 schema。
- `run_actions` 截图不要内联大 base64；后续接入完整 runtime 时应继续外部化为 `filePath + dataOmitted: true`。
- `reload_page` 只调度刷新并立即返回，不跨 content-script reload 等待页面完成；刷新后需要重新 inspect。
- `run_js` schema 参数名是 `code`；content runner 可兼容历史 `function` 字段，但模型侧不要再生成 `function` 参数。`run_js` 是诊断兜底，不要把它当成所有交互的首选。React 键盘提交等真实输入优先用 `press_key`。
- selector 参数是原生 CSS selector，不是 Playwright selector；不要支持 `:has-text()` 这类 Playwright 私有语法，文本定位用 `text` / `role + label` / 元素库。
- 坐标和 grid 点击必须默认穿透 DevTailor 面板，不能点到调试面板自身。

## 元素库

元素库是“用户和 Agent 共管的可复用页面目标”，不是标记列表。

入口：

- 顶部「存元素」按钮打开元素库卡片。
- 卡片内可以查看、搜索、刷新、删除项目元素目标。
- 点击「选择元素」进入一次性元素保存流程。

数据：

- 存储在 Bridge 的 `element_targets` 表。
- 前端通过 `/element-targets` GET/POST/DELETE 管理；元素库卡片展示项目全量。
- Browser tools 可通过 `get_element_targets` 获取项目全量，通过 `targetId` / `targetName` 使用。

定位策略：

- 优先 `data-ai-id` / `data-testid`。
- 其次 role + label / aria / text。
- 再用 selector / xpath / locatorRecipes 兜底。
- 保存的是“这个元素为什么是它”，不是只保存单个 CSS selector。

**Label 匹配增强**：

- 支持中文标点自动转换（`”任务名称”` ≈ `”任务名称”`）
- 支持全角/半角空格统一（`任务　名称` ≈ `任务 名称`）
- 支持零宽字符自动清理
- 支持降级匹配（移除标点后重试）
- `fill_text` / `type_text` 的 `text` 是写入内容，不参与 locator 匹配；定位请使用 `label`、`role`、`testId`、`nearText`、`selector` 或 `elementId`。

## 图片处理

图片来源：

- 工具栏截图
- 输入框粘贴图片

规则：

- 前端可有多个待发送图片，发送后展示在用户消息里。
- 悬浮 Chat 和 sidePanel 必须共用 `chat-images.js` 的 data URL 校验与预览管理；sidePanel 的附件选择、粘贴、历史回显和 `/review` payload 不能分叉。
- sidePanel 的待发送图片预览放在 composer 顶部，位于文本输入和工具栏之前，不要回退到输入区底部。
- Bridge 转成 runtime content blocks 图片，不要把 base64 塞进 Markdown 文本。
- 持久化展示历史时保留有限数量图片引用，避免无限膨胀。
- `run_actions` 内截图默认外部化，避免 token 爆炸。

## 元素标记与页面交互

标记使用 `content/modules/visbug-hit-test.js` 的轻量 VisBug 风格 hit-test：

- 深度 `elementFromPoint`，穿过 Shadow DOM host。
- 收集命中元素、祖先、`elementsFromPoint` 层和 bounded descendants。
- 按深度、可见面积、叶子节点、文本/媒体/表单语义和鼠标距离评分。

状态：

- `idle`：未标记。
- `selecting`：正在选择页面元素。
- `describing`：标记卡片编辑中，selector hit-test 暂停但标记模式未取消。

规则：

- 标记后自动打开描述卡片并聚焦。
- 关闭/折叠/流程推进时保存描述，并恢复选择下一个元素。
- 恢复时短暂 suppress click，避免关闭卡片那一下被复用为新标记。
- 按住 Alt 时进入 pass-through：隐藏 hover overlay，不拦截页面点击，允许操作页面弹窗/输入框；松开 Alt 后恢复选择。
- Chat 输入、图片预览等 chat-only 状态不能取消页面标记流程。
- 发送前必须同步打开中的标记描述，避免用户刚输入的说明丢失。

## DevTailor UI 穿透规则

Agent 使用 browser tools 操作页面时，DevTailor 面板不能影响命中：

- 截图默认隐藏 DevTailor UI。
- point/grid hit-test 和点击派发期间要临时隐藏 DevTailor host/highlights/badges；不要只改 `pointer-events`，Shadow DOM 内部 `pointer-events: auto` 的面板节点仍可能参与 hit-test。
- 元素库选择和标记选择要忽略 DevTailor 自身 UI。
- DevTailor UI 内部点击要 stop propagation，避免触发页面外部点击关闭弹窗。

## Markdown 渲染

Assistant 消息使用 vendored `marked`：

- `lib/marked.umd.js` 必须在 `chat-markdown.js` 之前加载。
- `chat-markdown.js` 必须保留 sanitizer allowlist。
- 悬浮 Chat 和 sidePanel 必须共用 `chat-markdown.js`，不能在 sidePanel 里退化成 HTML 转义加 `<br>` 的独立实现。
- 允许段落、标题、列表、代码、表格、链接、引用、图片和基础强调。

Mermaid 当前未启用。若以后启用，只渲染明确的 `language-mermaid` fenced code block，不要把 Mermaid 设为默认 Markdown 渲染。

## 中文发布口径

当前先发布中文单语言版本：

- README、商店描述、隐私政策使用中文。
- 工具名、命令名、Agent 名、Credits 项目名保留原名。
- Credits 只保留项目名称、原仓库地址和 license，不写长感谢文。

## 重要文件

- `content/content-script.js`：模块装配、工具栏事件、标记/元素库入口。
- `content/modules/shadow-ui.js`：Shadow DOM 面板和样式。
- `content/modules/chat-panel.js`：Chat UI 总装。
- `content/modules/ws-client.js`：SSE 客户端、接管、会话切换、Browser action 处理。
- `content/modules/browser-actions.js`：browser action 分发。
- `content/modules/browser-action-dom.js`：DOM 查询、点击、填写、按键、断言、snapshot、run_js。
- `content/modules/element-targets.js`：元素库 HTTP API 和 target 解析。
- `content/modules/element-saver.js`：元素库卡片和选择保存流程。
- `devtailor-bridge/src/ws-server.ts`：HTTP/SSE server、display sessions、element targets。
- `devtailor-bridge/src/browser-action-router.ts`：Browser action request/response 路由。
- `devtailor-bridge/src/agent-session.ts`：本地 agent session 边界。
- `devtailor-bridge/src/real-agent-session.ts`：真实 AI runtime agent session，采用 cache-first 上下文管理策略（丢弃旧消息依赖 SessionMemory 摘要缓存），集成 SessionMemory 文件持久化、ContextBudgetTracker 预算监控和 overflow recovery。
- `devtailor-bridge/src/local-agent-session.ts`：移除 ACP 后的过渡 runtime，已打通 AgentSession 到 browser tools 的调用链路。
- `devtailor-bridge/src/session-memory.ts`：渐进式会话摘要缓存（cache-first 核心），支持 `.devtailor/session-memory.md` 文件持久化，跨重启恢复上下文。
- `devtailor-bridge/src/runtime/micro-compaction.ts`：cache-aware 微压缩（热/温/冷三区），作为 cache-first 的辅助策略。
- `devtailor-bridge/src/runtime/context-budget.ts`：多层上下文预算系统，触发缓存优先丢弃或压缩。
- `devtailor-bridge/src/runtime/generate.ts`：核心 generate 循环，含上下文预算检查。
- `devtailor-bridge/src/runtime/openai-compatible-provider.ts`：OpenAI 兼容 provider，含 `body_cache_control` cache_control 标记和 `routing_hint` 粘性路由 header。
- `devtailor-bridge/src/runtime/provider.ts`：Provider 类型定义，含 `CacheStrategy` 五分类策略。
- `devtailor-bridge/src/model-config.ts`：模型配置，含 `cacheStrategy` 字段。
- `devtailor-bridge/src/session-store.ts`：SQLite 持久化和迁移。
- `devtailor-bridge/src/prompt-builder.ts`：当前请求转 runtime content blocks。

## 常见错误

- 不要把 `ws-client.js` 当 WebSocket。
- 不要按 bridge port 持久化会话。
- 不要把浏览器 tab 当会话 owner。
- 不要把前端展示历史重新发给 Agent。
- 不要并发调用同一个 agent session 的 `sendReview()`。
- 不要让刷新页面清空项目会话或 active ownership。
- 不要把图片 base64 塞入 Markdown 文本。
- 不要移除 Markdown sanitizer。
- 不要让 DevTailor 面板拦截 Agent 的坐标/grid 点击。
- 不要让元素库退化成只保存 CSS selector。
- 不要恢复 `/element-targets?url=...` 当前页过滤；元素库查询统一项目全量。
