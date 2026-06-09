# DevTailor Handoff Notes

> 修改 chat、bridge、ACP session、持久化、SSE、图片、Markdown、Browser MCP 或元素库逻辑前，先读本文。这里记录当前设计边界和防回归规则。

## 产品定位

DevTailor 是 **浏览器页面 ↔ ACP Agent 前端开发桥接工具**，由两部分组成：

1. **Chrome 扩展**：在真实页面里提供悬浮 Chat 面板、元素标记、截图、元素库、Browser MCP 工具调用和消息流式展示。
2. **Local Bridge**：通过 SSE/HTTP 对接扩展，通过 ACP stdio 对接 Agent，管理项目级展示会话，并把 Agent 的浏览器操作指令路由到已接管 tab。

核心目标：用户在页面上指出问题，Agent 获得 DOM、截图、标记元素、控制台信息和浏览器操作能力，完成“理解页面 → 修改代码 → 回到页面验证”的闭环。

## 快速启动

在 `devtailor-bridge/` 目录运行：

```bash
npm run dev -- --dir ../../todo --agent claude
```

常用命令：

```bash
npm run dev -- --dir /absolute/path/to/project
npm run dev -- --dir . --agent gemini
npm run dev -- --dir . --agent codex
npm run dev -- agents
npm run build
npm test
```

注意：

- `--` 是 npm 参数分隔符，不能省。
- `--dir` 是项目目录，用于计算项目身份和 `.devtailor/` 存储目录。
- `--agent` 支持内置预设或原始 ACP 命令。
- Bridge 固定监听 `34781`，这是扩展约定端口；当前 CLI 不暴露 `--port`。

## Agent 预设

内置预设：

```text
claude、copilot、gemini、qwen、codex、opencode、kiro、kimi
```

也支持原始 ACP 命令：

```bash
npm run dev -- --dir . --agent "npx my-agent --acp"
```

不要把任何逻辑写死到 Claude Code。当前设计是 ACP Agent 中立的。

## 前端技术栈边界

保持扩展前端轻量原生：

- 使用 manifest 注入 vanilla JavaScript content scripts。
- UI 放在 Shadow DOM 内，由 `content/modules/shadow-ui.js` 和拆分后的 chat 模块组合。
- 不引入 React、Vue、Angular 或 SPA 构建链，除非产品范围发生明显变化。
- DevTailor 自己的 UI 事件必须停在 Shadow DOM/自身浮层边界，不要触发页面外部点击导致页面弹窗关闭。
- DevTailor UI 必须遵守“卡片隔离”规范：
  - 宿主容器和全屏辅助层默认 `pointer-events: none`，只让真实可见、可操作的卡片/按钮恢复 `pointer-events: auto`。
  - DevTailor 卡片内事件必须 `stopPropagation`，不能触发宿主页面的外部点击、快捷键或焦点逻辑。
  - DevTailor 的透明区域、空白区域和定位容器必须让页面点击穿透。
  - Browser MCP 的坐标/网格点击和截图默认必须跳过或隐藏 DevTailor UI，不能把调试面板当成页面目标。
  - Shadow DOM 不能阻止宿主页面更早注册的 document 捕获阶段监听器看到部分 composed 事件；如果要做到完全事件/焦点沙箱，chat UI 应迁移到 iframe 隔离层，而不是继续扩大页面级拦截。

当前 chat 拆分：

- `chat-markdown.js`：Markdown 渲染和 sanitizer。
- `chat-tools.js`：ACP tool 标题、分组、状态、内容格式化。
- `chat-scroll.js`：滚动跟随、回到底部按钮。
- `chat-images.js`：截图/粘贴图片、待发送缩略图。
- `chat-persistence.js`：前端轻量 UI 状态缓存。
- `chat-preview-editor.js`：图片预览和标注编辑。
- `chat-bridge-events.js`：SSE / ACP 事件映射到 UI 消息。
- `chat-send.js`：发送、新会话、取消、请求状态。
- `chat-panel.js`：状态组合、渲染和事件装配。

这些模块必须在 `chat-panel.js` 之前加载。

## Transport

浏览器 ↔ Bridge 使用 SSE + HTTP POST：

- `GET /events?clientId=...`：SSE 事件流。
- `POST /review`：发送当前用户请求。
- `POST /activate`：当前 tab 接管项目浏览器操作权。
- `POST /cancel`：取消当前 Agent turn。
- `POST /mcp`：Bridge 内嵌 Browser MCP JSON-RPC endpoint。
- `GET /health`：项目、Agent、激活 tab 和 ACP session 元数据。
- `POST /new-session`：创建或复用空白展示会话。
- `GET /sessions` / `GET /sessions/active` / `POST /sessions/load` / `POST /sessions/delete`：展示会话管理。
- `GET /element-targets` / `POST /element-targets` / `DELETE /element-targets/:id`：元素库。
- `POST /browser-action-result`：扩展回传 Browser MCP 执行结果。

`content/modules/ws-client.js` 名字保留是兼容历史调用点，但实现是 SSE，不是 WebSocket。不要因为文件名把传输层改回 WebSocket。

## 项目身份与 Tab 接管

Bridge 根据 `--dir` 计算项目身份：

```text
projectId = sha256(realpath(--dir)).slice(0, 12)
projectName = basename(realpath(--dir))
bridgeInstanceId = randomUUID() per bridge process start
```

规则：

- 会话展示数据按项目和 Agent 隔离，不按端口隔离。
- `clientId = tab_{tabId}` 只用于 live routing 和 Browser MCP 指令路由。
- 浏览器 tab 是可替换的调试页面，不是会话所有者。
- 新 tab 连接后默认只是在线，必须显式点击「接管」才会覆盖旧激活 tab。
- 刷新当前已接管 tab 不应丢失 active ownership。
- Browser actions 只能作用于当前项目已接管 tab。

## 会话与上下文规则

最重要的规则：

```text
前端消息 = UI 展示
Bridge display session = 本地展示会话与 ACP session 绑定
ACP session = Agent 真正多轮上下文
```

发送新消息时，前端只发送当前请求：

- 当前输入文本
- 当前标记元素
- 当前截图/粘贴图片

不要把前端历史消息重新拼进 prompt。ACP session 已经维护多轮上下文，重复发送历史会污染上下文。

Bridge 拥有展示会话：

- 每个 display session 绑定一个 ACP session。
- 展示会话按 project + agentKey 隔离。
- 切换 display session 等于切换后续 prompt 进入哪个 ACP session。
- 删除 display session 应删除对应展示消息，并停止/移除对应 ACP session。

前端 `chrome.storage.local` 只适合缓存草稿、待发送图片、控件状态等轻量 UI 状态。不要让它成为聊天记录的权威来源，也不要把它当作 Agent 上下文。

## Bridge Session 管理

Bridge 维护：

```ts
Map<displaySessionId, ACPSession>
Map<clientId, PendingReview[]>
Set<clientId> processing
activeClientId
SessionStore(SQLite)
```

重要行为：

- 一个 display session 对应一个 ACP session。
- 同一 client 的请求串行处理。
- 不要并发调用同一个 ACP session 的 `prompt()`。
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

## Browser MCP 工具边界

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
- `run_actions` 截图不要内联大 base64，Bridge 会外部化为 `filePath + dataOmitted: true`。
- `reload_page` 只调度刷新并立即返回，不跨 content-script reload 等待页面完成；刷新后需要重新 inspect。
- `run_js` 是诊断兜底，不要把它当成所有交互的首选。React 键盘提交等真实输入优先用 `press_key`。
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
- Browser MCP 可通过 `get_element_targets` 获取项目全量，通过 `targetId` / `targetName` 使用。

定位策略：

- 优先 `data-ai-id` / `data-testid`。
- 其次 role + label / aria / text。
- 再用 selector / xpath / locatorRecipes 兜底。
- 保存的是“这个元素为什么是它”，不是只保存单个 CSS selector。

## 图片处理

图片来源：

- 工具栏截图
- 输入框粘贴图片

规则：

- 前端可有多个待发送图片，发送后展示在用户消息里。
- Bridge 转成 ACP `ContentBlock` 图片，不要把 base64 塞进 Markdown 文本。
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

Agent 使用 Browser MCP 操作页面时，DevTailor 面板不能影响命中：

- 截图默认隐藏 DevTailor UI。
- point/grid hit-test 要临时绕过 DevTailor host/highlights/badges。
- 元素库选择和标记选择要忽略 DevTailor 自身 UI。
- DevTailor UI 内部点击要 stop propagation，避免触发页面外部点击关闭弹窗。

## Markdown 渲染

Assistant 消息使用 vendored `marked`：

- `lib/marked.umd.js` 必须在 `chat-markdown.js` 之前加载。
- `chat-markdown.js` 必须保留 sanitizer allowlist。
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
- `content/modules/browser-actions.js`：Browser MCP action 分发。
- `content/modules/browser-action-dom.js`：DOM 查询、点击、填写、按键、断言、snapshot、run_js。
- `content/modules/element-targets.js`：元素库 HTTP API 和 target 解析。
- `content/modules/element-saver.js`：元素库卡片和选择保存流程。
- `devtailor-bridge/src/ws-server.ts`：HTTP/SSE server、display sessions、element targets。
- `devtailor-bridge/src/browser-mcp-server.ts`：Browser MCP schema 和 JSON-RPC 响应。
- `devtailor-bridge/src/browser-action-router.ts`：Browser action request/response 路由。
- `devtailor-bridge/src/session-store.ts`：SQLite 持久化和迁移。
- `devtailor-bridge/src/prompt-builder.ts`：当前请求转 ACP content blocks。

## 常见错误

- 不要把 `ws-client.js` 当 WebSocket。
- 不要按 bridge port 持久化会话。
- 不要把浏览器 tab 当会话 owner。
- 不要把前端展示历史重新发给 Agent。
- 不要并发调用同一个 ACP session 的 `prompt()`。
- 不要让刷新页面清空项目会话或 active ownership。
- 不要把图片 base64 塞入 Markdown 文本。
- 不要移除 Markdown sanitizer。
- 不要让 DevTailor 面板拦截 Agent 的坐标/grid 点击。
- 不要让元素库退化成只保存 CSS selector。
- 不要恢复 `/element-targets?url=...` 当前页过滤；元素库查询统一项目全量。
