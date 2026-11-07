# DevTailor Handoff Notes

> 修改 chat、bridge、agent session、持久化、SSE、图片、Markdown、browser tool 或元素库逻辑前，先读本文。这里记录当前设计边界和防回归规则。

## 产品定位

DevTailor 是 **浏览器页面 ↔ Claude Code 的前端开发桥接工具**（正在改造成 Claude Code 插件；AI 由 Claude Code 担任，Bridge 只负责扩展 ↔ Claude 的通道），由两部分组成：

1. **Chrome 扩展**：在真实页面里提供悬浮 Chat 面板、元素标记、截图、元素库、browser tool 调用和消息流式展示。
2. **Local Bridge**：通过 SSE/HTTP 对接扩展，管理项目级展示会话和 agent session 边界（`AgentSession`），并把浏览器操作指令路由到已接管 tab。

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
- `--agent`、内置 agent 预设和 ACP 原始命令已移除；Bridge 自身不再带 AI runtime。
- Bridge 固定监听 `127.0.0.1:34781`（只绑回环地址），这是扩展约定端口；当前 CLI 不暴露 `--port`。
- 端口已被占用时 Bridge **不会杀掉**占用者：向 stderr 打印提示（占用者 PID 可得则附带）并以退出码 1 退出。同一端口同一时刻只允许一个 Bridge。
- Bridge 所有日志/CLI 输出都写 stderr（统一走 `src/log.ts` 的 `log()`/`logError()`），stdout 只给 MCP stdio 协议。
- 两种入口：`npm run dev` / `npm start`（`src/index.ts`，无 Claude 的调试模式，仍用占位会话）；`npm run mcp:dev` / `npm run mcp`（`src/mcp-main.ts`，Claude Code 通道，见下文「Claude Code 通道」）。`package.json` 的 `bin` 增加 `devtailor-mcp`。`npm test` 会先 `npm run build`（stdio 冒烟测试跑 `dist/mcp-main.js`）。`src/` 中除 `log.ts` 外不允许出现 `console.*` 或 `process.stdout`。

## Agent runtime（已移除，AI 由 Claude Code 担任）

Bridge 不再带任何自有 AI runtime：`ScreamAgentSession`、`RealAgentSession`、`LocalAgentSession`、`runtime/**`（OpenAI-compatible provider、generate 循环、micro-compaction、context budget）、workspace tools（bash/read/write/edit/grep/glob/list）、`session-memory`、`image-handler`（`sharp`）、`model-config` 以及 `scream-code-main/` 都已删除。AI 由 Claude Code 担任，`ClaudeChannelSession`（MCP stdio server + channel，见下文）是生产会话实现。

当前状态：

- `AgentSession`（`src/agent-session.ts`）仍是 Bridge 与 AI 之间的边界；`sendReview(payload, context?)` 不再接收 history（Claude 自持上下文，不要把展示历史拼进 prompt）。`context` 带 `clientId`/`displaySessionId`。`sendReview` 可返回 `'pending'`（`STOP_REASON_PENDING`）表示请求已交出、轮次稍后经 `onDone`/`onError` 结束。`AgentCallbacks.onNotice` 是只展示、不入库的瞬态提示。
- `src/placeholder-agent-session.ts` 只用于 `index.ts` 调试模式（没有 Claude 时跑 SSE/队列/展示会话）：`sendReview` 立即 `onError('Claude Code 通道尚未连接（第二步实现）')` 并返回 `'error'`。不要在占位上加功能。
- 默认 `agentKey = 'claude'`、`agentLabel = 'Claude Code'`（展示会话按 `agentKey` 隔离，旧 `local` / `openai-compatible:*` 会话不再出现在列表里，数据仍在 SQLite）。
- `/model-config` 路由、popup 的「模型配置」UI、`DEVTAILOR_RUNTIME`、`OPENAI_*` 环境变量兜底都已删除。`SessionStore` 启动时会清掉遗留的 `settings.model_config`（含明文 apiKey）、`.devtailor/scream-home/` 和 `.devtailor/session-memory.md`。
- `prompt-builder.ts` 只保留 `buildPrompt(payload)`：页面 URL、用户意图、标记元素（selector/annotation/组件/样式/outerHTML/bbox）。系统提示、history、image block 都已删除；截图由 `ClaudeChannelSession` 落盘后以路径形式交给 Claude（见「Claude Code 通道」）。
- `/review` 的 turn 生命周期：`handleReview` 是 `done` 的**唯一发送点**。同步会话：`sendReview` resolve 后发一次。异步会话（`'pending'`）：`handleReview` 等 `turn.completion`（由 `onDone`/`onError`/`/cancel` 触发）后发一次；`AgentCallbacks.onDone` 只记录 summary、收尾 thinking、解除等待，不直接发 `done`。`stopReason === 'error'` 或 `turn.errored` 时只发 `error`，不发 `done`；session 已经通过 `onError` 报过的失败，`handleReview` 的 catch 不再重复发 `error`。
- `/cancel`：标记当前展示轮次已取消——发 `tool_status canceled` + `done(reason: cancelled)`，清空排队，丢弃该轮次之后 agent 的迟到输出，解除 `turn.completion`（串行队列释放），并调用该 display session 的 `cancelCurrentTurn()`（Claude 通道会推 `kind=cancel` 通知）。**不** stop/delete agent session。
- `/review` 在异步会话下保持串行：`/review` 的上一轮在 Claude `final` / 超时 / 取消之前，同一 client 的下一条排队等待（受 10 分钟无回复兜底约束，不会永久卡死）。
- SSE 断开：若断开的是 `activeClient`，宽限期（`WSServer.activeClientGraceMs`，默认 3s，覆盖页面刷新/SW 重启时同 clientId 的重连）后调用 `browserRouter.deactivate`，避免向已断开的客户端下发动作。宽限期内同 clientId 重连则保持接管。

## Claude Code 通道

协议依据见 `docs/CLAUDE_CHANNEL_PROTOCOL.md`（以官方文档为准）。

**架构**：Claude Code 以子进程拉起 `node dist/mcp-main.js`（stdio MCP server，声明 `experimental['claude/channel']` + `tools`），进程内同时跑原有 HTTP/SSE `WSServer`（`127.0.0.1:34781`，安全守卫不变，MCP 走 stdio 不经 HTTP 守卫）。

```text
侧边栏 → POST /review → 队列 → ClaudeChannelSession.sendReview
  → notifications/claude/channel {content, meta}  → Claude Code（<channel source=… turn_id=…>）
Claude → reply(turn_id?, text, final?) → ClaudeChannelHub.handleReply → onStream/onDone → SSE stream/done → 侧边栏
Claude → 浏览器工具(mcp) → BrowserActionRouter.run → SSE browser_action → 当前接管 tab
```

**启动**：项目目录取 `DEVTAILOR_PROJECT_DIR` → `CLAUDE_PROJECT_DIR`（Claude Code 给 stdio server 设置）→ `process.cwd()`。`DEVTAILOR_PORT` 只用于测试/调试（扩展固定 34781）。端口被占用时不杀别人，打印提示并退出 1。stdin 关闭（Claude 会话结束）或 SIGINT/SIGTERM 时关闭 HTTP server 并退出 0。

**Claude Code 插件**（`claude-plugin/`，`.claude-plugin/plugin.json` 声明 `mcpServers.devtailor` + `channels:[{server:'devtailor'}]`，另含 `skills/devtailor-browser`、`commands/status.md`）：MCP server 指向 `${CLAUDE_PLUGIN_ROOT}/server/mcp-main.cjs`——由 `devtailor-bridge` 的 `npm run build:plugin`（esbuild，`scripts/build-plugin.mjs`）把 `mcp-main.ts` 打成单文件并把 `sql-wasm.wasm` 复制到旁边（sql.js 在运行时按 `__dirname` 找 wasm）。**选这个方案的原因**：marketplace 安装会把插件复制到缓存目录，指向仓库 `dist` 的相对路径会失效；单文件 + wasm 自包含，装到哪都能跑。产物 `claude-plugin/server/` 与 `claude-plugin-marketplace/` 在 `.gitignore`。工具名为 `mcp__plugin_devtailor_devtailor__<tool>`，server 在 `/mcp` 里叫 `plugin:devtailor:devtailor`。`timeout: 660000`（≥ `request_user_assistance` 的 10 分钟上限）。

启动脚本 `scripts/claude-devtailor.sh`（在目标项目目录里运行）：检查 `claude`、Node ≥ 20、插件已构建，`MCP_PROTOCOL_NEGOTIATION=legacy`，然后 `exec claude --plugin-dir <repo>/claude-plugin --dangerously-load-development-channels plugin:devtailor@inline "$@"`（`--plugin-dir` 加载的会话级插件 id 是 `devtailor@inline`，由 `claude --plugin-dir … plugin list` 实测得到；官方文档未明说“`--plugin-dir` + `plugin:` 开发 flag”这一组合，实机是否注册为 channel 见 `docs/CLAUDE_PLUGIN_VERIFY.md` 第 0 步，备选 `DEVTAILOR_CHANNEL_ENTRY=server:<name>` + 项目 `.mcp.json`）。`scripts/make-local-marketplace.sh` 生成本地 marketplace（`devtailor-local`）供“安装形态”使用。开发时也可不打包：`.mcp.json` 直接指向 `devtailor-bridge/dist/mcp-main.js`，用 `server:<名字>`。

**通知**：`kind: 'review'`，meta 键 `kind/turn_id/page_url/client_id/has_images/image_count/image_paths`（键只含字母数字下划线，值都是字符串）；`turn_id` 为 12 位十六进制（uuid 去横线截断），避免 Bridge 重启后复用旧 id。content 为 `buildPrompt` 文本 + `## Screenshots` 路径清单。`sendReview` 在通知写出后立即 resolve `'pending'`；写出失败 → `onError` + reject。

**`reply` 工具语义**（schema `{turn_id?: string, text: string, final?: boolean}`）：
- 每次调用把 `text` 作为增量送入该轮的 `onStream`；非首段前面补分隔（保证段间有空行：前文已以 `\n\n` 结尾则不补，以 `\n` 结尾补 `\n`，否则补 `\n\n`），避免 `appendAssistantDelta` 把多段拼成一行。
- `final: true` 才触发该轮 `onDone`（`ws-server` 随后发唯一一次 `done`，`reason: end_turn`）；`text` 可为空。`text` 与 `final` 都缺失 → 错误。
- `turn_id` 缺省为最近一个**进行中**的轮次；显式 `turn_id` 已结束/被取消/超时/未知 → 返回 `isError` 文本（“Turn x is not active … Do not reply to it.”）；没有进行中轮次 → `isError` 文本。从不抛异常。
- 多轮同时进行时，hub 在 `sendReview` 时快照该轮的 `AgentCallbacks`，所以回复按 `turn_id` 路由到正确的展示会话，不会串。

**取消**：`/cancel` 本地先标记取消并发 `done(cancelled)`，再调 `cancelCurrentTurn()` → 推 `kind=cancel`、`turn_id`、`content='用户在浏览器里取消了上一条请求，请停止相关操作，不要继续回复。'`；该轮随即被置为已结束，之后 Claude 对它的 `reply` 返回错误。无进行中轮次时返回 `false` 且不推通知。

**超时与无响应兜底**：
- 每轮从通知写出开始计时；每次 `reply` 或任何浏览器工具调用都会刷新所有进行中轮次的计时（证明 Claude 还活着）。10 分钟（`DEVTAILOR_REPLY_TIMEOUT_MS` 可覆盖）内没有 `final` → `onError('Claude 长时间没有回复，请检查终端里的 Claude Code 会话是否仍在运行/是否在等待你确认权限')` 并结束该轮（串行队列随之释放）。计时器 `unref()`。
- 通知发出 30 秒内没有任何 `reply`/工具调用迹象 → 经 `onNotice` 向侧边栏发**一次**（每个 Bridge 进程一次）瞬态提示：`⏳ 已发送给 Claude Code，等待响应…（若终端里没有反应，请确认是否用 --dangerously-load-development-channels 启动）`。实现为不带 `appendAssistantDelta` 的 `stream` SSE 事件，因此不入持久化消息；但 UI 会把它显示在当前流式气泡里，刷新后消失。
- MCP `initialize` 之后 stderr 记录 client 名称/版本/capabilities，并提醒 channel 通知在没用开发参数启动时会被静默丢弃。

**图片**：`.devtailor/images/<turn_id>-<n>.<ext>`，单张 ≤ 8MB（超限、非 png/jpeg/webp/gif、非 base64 的跳过并在 content 文本里说明），文件名只含 `[A-Za-z0-9_-]` 并校验解析后路径在目录内。不使用入站 MCP image content。工具返回的截图（`take_visible_screenshot`、`run_actions` 里的截图等 `data:image/...` 字符串）会被替换成短提示，作为 MCP `image` content 返回，并落盘 `shot-<ts>-<n>.<ext>` 备用；一次结果最多返回 8 张。

**浏览器工具**：`createBrowserToolDefinitions()` 的 18 个工具原样暴露（`parameters` → `inputSchema`），加 `reply` 共 19 个，列表不随运行状态变化。结果统一为文本 JSON `{ok, result|error}`，失败 `isError: true`；`NO_ACTIVE_TAB` 带 `error.hint: '请先在浏览器扩展里点击“接管”当前页面'`。元素库三工具走 `BrowserActionRouter` 的本地 handler（无需接管 tab）。`request_user_assistance` 保持 5 分钟语义（stdio 工具调用默认超时约 28 小时、idle 30 分钟，不需要额外配 `timeout`）。

**已知限制**：
- channel 是研究预览，必须用 `--dangerously-load-development-channels` 且交互式会话；协议可能变化。
- 会话必须保持打开；终端里 Claude 在等权限确认时，浏览器侧只会看到“等待”，直到 10 分钟兜底。本步没做 permission relay。
- 同时到达的多条通知会被 Claude 合并处理；`turn_id` 用来区分。
- Claude 上下文不能被 Bridge 清空：`/new-session` 只重置展示层。
- 多个 Claude Code 会话各自启动 MCP 时会争 34781，后来者退出（不再互相 kill）。
- 未实机验证项（清单见 `docs/CLAUDE_PLUGIN_VERIFY.md`）：`--plugin-dir` + `plugin:devtailor@inline` 是否注册为 channel、空闲会话是否被通知唤醒、`reply` 是否触发权限提示、image content 是否被渲染。

**真实 Chrome 端到端**：`node scripts/e2e-extension.mjs`（不在 `npm test` 内；需本机 Chrome + playwright-core）。品牌版 Chrome 137+ 不再支持 `--load-extension`，脚本改用 `--remote-debugging-port` + `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`。页内面板是 **closed** Shadow DOM，Playwright 选择器无法穿透，脚本用 CDP `DOM.getDocument({pierce:true})` 取 closed root 再点击/输入。覆盖：SW→守卫、网页反例（CORS/no-cors GET、text/plain POST）、页内接管+发送+流式回复、sidepanel 页发送/回复、cancel、MCP 浏览器工具（snapshot/click/screenshot）、退出后端口释放。这次实测发现并修复了三个缺陷：SW GET 无 Origin（上面守卫的客户端头）、`prompt-builder.js` 导出了已删除的 `build`（ReferenceError 使整个页内发送不可用）、`click_page` 因 `dispatchMouseSequence` 已派发 `click` 又调用 `el.click()` 而触发两次点击。

**等待/故障提示（侧边栏与页内面板）**：Bridge 未连接 → 提示“Bridge 未连接，请确认 Claude Code 已用 scripts/claude-devtailor.sh 启动”；未接管 → “尚未接管标签页：请先在页面中点击‘接管’（连接当前页）”；Claude 未响应 → 30 秒的“⏳ 已发送给 Claude Code，等待响应…”stream 提示（含开发参数提醒）+ 10 分钟 error（`Error: Claude 长时间没有回复…`）。两处 UI 对 stream/error 的渲染无需特殊处理（error 文本不含 session/agent 关键字，走普通 `Error:` 气泡）。

## 安全守卫

任何网页都能向 `localhost:34781` 发请求（简单请求免预检且响应可读，DNS rebinding 同样可行），所以 `ws-server.ts` 在路由分发最前面有统一守卫（`guardRequest`）：

- 监听只绑 `127.0.0.1`。
- **Host 校验**：Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403（防 DNS rebinding）。
- **Origin 校验**：除 `GET|OPTIONS /health` 外所有路由要求 `Origin` 以 `chrome-extension://` 开头（网页无法伪造此 Origin）；环境变量 `DEVTAILOR_EXTENSION_ID` 设置后只放行该扩展 ID。
- **扩展客户端头（真实 Chrome 实测后补充）**：Chrome 里 service worker 对已授权 host 的 **GET 不带 `Origin`**（和网页 no-cors GET 一样，`scripts/e2e-extension.mjs` 里的 “finding” 断言实测 403 `missing_origin`；POST 才带 Origin）。所以扩展的所有 Bridge 请求在 `service-worker.js` 的 `fetchBridgeUrl` 里统一加 `X-DevTailor-Client: <chrome.runtime.id>`；守卫对「无 Origin 但带合法该头」的请求视为受信（等同扩展 Origin，`/health` 也返回完整路由信息）。安全性依据：网页发自定义头必须先预检，而预检 OPTIONS 带网页 Origin 会被守卫拒绝；`no-cors` 请求不允许带自定义头。带网页 Origin 的请求不会因为带这个头而放行。`DEVTAILOR_EXTENSION_ID` 对该头的值同样生效（注意：其他扩展可以伪造这个头，Origin 则不能；威胁模型是“恶意网页”，不是“恶意扩展”）。不要删除这个头，也不要让 content script 直接 fetch。
- **CORS**：不再返回 `Access-Control-Allow-Origin: *`；仅当 Origin 通过校验时回显该 Origin 并带 `Vary: Origin`。OPTIONS 预检同样先过守卫。被拒请求不带任何 CORS 头。
- 被拒请求在 stderr 记一行：`[Guard] <时间> denied <METHOD> <path> reason=<原因> origin=<scheme://host>`，不记录 body/token。
- `GET /health`：无 Origin（或 Origin 不合法）只返回 `{ ok, protocolVersion }`；带合法扩展 Origin 才额外返回 `projectId/projectName/bridgeInstanceId/agentKey/agentLabel/activeClientId/activeSessionId/isProcessing/processingSessionId`。**不再返回 pid、会话标题、agentSessionId。**
- `POST /browser-tool` 已删除（它是无审批的 `run_js` 通道）。浏览器动作只能经 `BrowserActionRouter`（扩展 SSE `browser_action` → `POST /browser-action-result`）。
- 防回归：不要为了调试放开 Origin/Host 校验，不要恢复 `ACAO: *`，不要在 `/health` 里加回 pid 或会话标题，不要让新增路由绕过守卫（守卫在 `handleRequest` 最前面，新路由自动受保护）。扩展侧所有 Bridge 请求必须继续走 service worker 代理（`bridgeProxyRequest` / `fetchBridgeUrl`），不要让 content script 页面上下文直接 fetch。

## 审批与提问通道

高风险操作审批与 Agent 提问的**传输层**保留（供第二步的 permission relay / ask 工具复用）：

- `ApprovalRouter`（`src/approval-router.ts`）：「SSE 请求 → HTTP 回传」模式。向 active client 发 `approval_request`（`toolName`/`action`/`risk`/`detail`），向其他 client 广播 `approval_pending`；只接受第一个有效决定（未知/已处理 id → HTTP 409），随后广播 `approval_resolved`。**无 UI 时不自动批准**，超时（默认 300s）→ `rejected`。client 重新 active 时 `resendPending()` 补发。HTTP：`POST /approval-decision`（`{ approvalId, decision: 'approved'|'rejected', feedback? }`）。
- `QuestionRouter`（`src/question-router.ts`）：同构，`question_request`/`question_pending`/`question_resolved`，`POST /question-answer`（`{ questionId, answers | null }`）。**问题不会「拒绝」**：超时/无 UI → `null`（dismissed），不要伪造答案。答案格式 `Record<question 文本, string | true>`。
- 扩展 UI 只在 sidepanel：`sidepanel.js` 的 `handleSseMessage` 渲染 `approval` / `question` 卡片（瞬态，不持久化）。页内侧边栏尚无此分支。**这套审批/提问 UI 与两个 router 目前生产路径无调用，保留代码不动，预留给第二版 permission relay。**
- 当前没有任何生产代码调用这两个 router（旧 Scream 路径已删）；Claude permission relay 未做（第三步/第二版再接线），不要删除这两个 router。

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

所有路由先过「安全守卫」（Host + `chrome-extension://` Origin 校验）。
- `POST /review`：发送当前用户请求。
- `POST /activate`：当前 tab 接管项目浏览器操作权。
- `POST /cancel`：取消当前展示轮次（第一步语义见「Agent runtime」）。
- `GET /health`：存活检查；无 Origin 只返回 `{ ok, protocolVersion }`，带扩展 Origin 才返回项目/激活 tab 元数据（见「安全守卫」）。
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
Agent session = Claude Code 的多轮上下文（Bridge 不持有）
```

发送新消息时，前端只发送当前请求：

- 当前输入文本
- 当前标记元素
- 当前截图/粘贴图片

不要把前端历史消息重新拼进 prompt。Claude Code 自持多轮上下文，Bridge 不做 history 注入。

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
- 底部「停止」只用于取消当前展示轮次：`/cancel` 立即给 UI 发 `done(cancelled)` 解锁，不 stop agent session，并通过 `cancelCurrentTurn()` 通知 Claude。
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
- 图片 base64 不要塞进 Markdown 文本；图片如何传给 Claude 由第二步决定（当前 `buildPrompt` 不再构造 image block）。
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
- `devtailor-bridge/src/placeholder-agent-session.ts`：调试模式（`index.ts`）使用的占位会话（见「Agent runtime」）。
- `devtailor-bridge/src/mcp-main.ts`：Claude Code MCP/channel 入口（stdio + 同进程 HTTP/SSE）。
- `devtailor-bridge/src/mcp-server.ts`：MCP server 定义（capabilities、instructions、19 个工具、`reply`）。
- `devtailor-bridge/src/claude-channel-session.ts`：`ClaudeChannelHub`（turn/超时/取消/图片）+ `ClaudeChannelSession`。
- `devtailor-bridge/src/mcp-browser-tools.ts`：browser tool → MCP 工具（18 个），截图转 image content。
- `devtailor-bridge/src/image-store.ts`：图片落盘 `.devtailor/images/`（8MB 上限、受控文件名）。
- `docs/CLAUDE_CHANNEL_PROTOCOL.md`：实际依赖的官方协议点与来源。
- `devtailor-bridge/src/log.ts`：唯一允许写进程流的模块，所有日志写 stderr。
- `devtailor-bridge/src/approval-router.ts` / `question-router.ts`：审批/提问的 SSE ↔ HTTP 传输。
- `devtailor-bridge/src/session-store.ts`：SQLite 持久化和迁移。
- `devtailor-bridge/src/prompt-builder.ts`：当前请求（页面/意图/标记元素）转文本 prompt，无 system prompt、无 history。

## 常见错误

- 不要把 `ws-client.js` 当 WebSocket。
- 不要按 bridge port 持久化会话。
- 不要把浏览器 tab 当会话 owner。
- 不要把前端展示历史重新发给 Agent。
- 不要恢复 `POST /browser-tool`、`ACAO: *` 或放宽 Origin/Host 守卫；不要向 stdout 打印（stdout 留给 MCP 协议）。
- 不要并发调用同一个 agent session 的 `sendReview()`。
- 不要让 `reply` 工具之外的终端输出被当成给用户的回复；不要在 `mcp-main` 路径里 `console.log`（stdout 是协议通道）。
- 不要让刷新页面清空项目会话或 active ownership。
- 不要把图片 base64 塞入 Markdown 文本。
- 不要移除 Markdown sanitizer。
- 不要让 DevTailor 面板拦截 Agent 的坐标/grid 点击。
- 不要让元素库退化成只保存 CSS selector。
- 不要恢复 `/element-targets?url=...` 当前页过滤；元素库查询统一项目全量。
