# DevTailor Handoff Notes

> **旧 Bridge 历史说明**：文中 `devtailor-bridge/`、`claude-plugin/` 路径指已删除的旧 Bridge（可在 git 历史中查看，提交 `0569936` 之前）；现行实现在 `devtailor-hub` 仓库（`/Users/liguangzhen/代码/devtailor-hub`）。服务端行为请在 Hub 仓库修改。现行链路为扩展 → Hub 的 devtailor 通道（`127.0.0.1:34781`）→ Claude Code 的 hub-channel；发送即完成：`/review` 立即返回 202，每次 `reply` 是独立消息，无 `done` / 队列。下文旧 Bridge 的启动、路径和生命周期描述仅供历史参考。

> 修改 chat、bridge、agent session、持久化、SSE、图片、Markdown、browser tool 或元素库逻辑前，先读本文。这里记录当前设计边界和防回归规则。
>
> **Claude Code Channels 为唯一后端；仓库备份分支 `backup/pre-channels-only`。**

## 产品定位

DevTailor 是 **浏览器页面 ↔ Claude Code 的前端开发桥接工具**（AI 由 Claude Code 担任，Bridge 只负责扩展 ↔ Claude 的通道）。**唯一后端是 Claude Code Channels**：Claude Code 以插件形式拉起 Bridge 的 stdio MCP server（`devtailor-bridge/src/mcp-main.ts`，声明 `experimental['claude/channel']`），用 `scripts/claude-devtailor.sh` 在项目目录启动；侧边栏经 HTTP/SSE `127.0.0.1:34781` 与 Bridge 通信，回复走 `reply` MCP 工具，浏览器工具走 MCP。由两部分组成：

1. **Chrome 扩展**：在真实页面里提供页内“标记工具条”（选取/标记/搜索/截图/接管状态）、元素标记、截图、元素库、browser tool 调用；聊天、会话、审批、模式、计划、用量只在侧边栏。
2. **Local Bridge**：随 Claude Code 会话启动的 stdio MCP server（同进程跑 HTTP/SSE `WSServer`），管理项目级展示会话和 agent session 边界（`AgentSession`），并把浏览器操作指令路由到已接管 tab。

核心目标：用户在页面上指出问题，Agent 获得 DOM、截图、标记元素、控制台信息和浏览器操作能力，完成“理解页面 → 修改代码 → 回到页面验证”的闭环。

## 旧 Bridge 快速启动（历史参考）

**真实使用**：在目标项目目录运行 `scripts/claude-devtailor.sh`（Claude Code 以插件形式拉起 `src/mcp-main.ts`）。

调试 Bridge 本身时，在 `devtailor-bridge/` 目录运行：

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
- `--dir` 是项目目录，用于计算项目身份和 `.devtailor/` 存储目录（真实使用走 `scripts/claude-devtailor.sh` 时由 `DEVTAILOR_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` / cwd 决定）。
- `--agent` 与内置 agent 预设已移除；Bridge 自身不带 AI runtime（AI 由 Claude Code 通过 Channels 担任）。独立运行 `devtailor --dir` 只跑占位调试会话，真实使用请走 `scripts/claude-devtailor.sh`。
- Bridge 固定监听 `127.0.0.1:34781`（只绑回环地址），这是扩展约定端口；当前 CLI 不暴露 `--port`。
- 端口已被占用时 Bridge **不会杀掉**占用者：向 stderr 打印提示（占用者 PID 可得则附带）并以退出码 1 退出。同一端口同一时刻只允许一个 Bridge。
- Bridge 所有日志/CLI 输出都写 stderr（统一走 `src/log.ts` 的 `log()`/`logError()`），stdout 只给 MCP stdio 协议。
- 入口：真实使用由 Claude Code 以插件形式拉起 `src/mcp-main.ts`（stdio MCP server，声明 `experimental['claude/channel']`，见「Claude Code 通道」），用 `scripts/claude-devtailor.sh` 在项目目录启动；`npm run mcp:dev` / `npm run mcp` 手工跑同一入口。独立运行 `npm run dev` / `npm start`（`src/index.ts`）只跑占位调试会话（`PlaceholderAgentSession`，不发真实 AI 请求），用于调试 SSE/队列/展示会话。`package.json` 的 `bin` 提供 `devtailor` 与 `devtailor-mcp`。`npm test` 会先 `npm run build`（stdio 冒烟测试跑 `dist/mcp-main.js`）。`src/` 中除 `log.ts` 外不允许出现 `console.*` 或 `process.stdout`。

## Agent runtime（已移除，AI 由 Claude Code 担任）

Bridge 不再带任何自有 AI runtime：`ScreamAgentSession`、`RealAgentSession`、`LocalAgentSession`、`runtime/**`（OpenAI-compatible provider、generate 循环、micro-compaction、context budget）、workspace tools（bash/read/write/edit/grep/glob/list）、`session-memory`、`image-handler`（`sharp`）、`model-config` 以及 `scream-code-main/` 都已删除。AI 由 Claude Code 担任：唯一后端是 Claude Code 通道（`ClaudeChannelSession`，MCP stdio server + channel，见下文）。**「Claude Code 通道」一节描述的展示会话/`/review` 队列/`reply` 语义就是当前唯一后端的行为；独立运行 `devtailor --dir` 时同一套逻辑跑在占位会话上。**

当前状态：

- `AgentSession`（`src/agent-session.ts`）仍是 Bridge 与 AI 之间的边界；`sendReview(payload, context?)` 不再接收 history（Claude 自持上下文，不要把展示历史拼进 prompt）。`context` 带 `clientId`/`displaySessionId`。`sendReview` 可返回 `'pending'`（`STOP_REASON_PENDING`）表示请求已交出、轮次稍后经 `onDone`/`onError` 结束。`AgentCallbacks.onNotice` 是只展示、不入库的瞬态提示。
- `src/placeholder-agent-session.ts` 只用于 `index.ts` 调试模式（没有 Claude 时跑 SSE/队列/展示会话）：`sendReview` 立即 `onError('Claude Code 通道尚未连接（第二步实现）')` 并返回 `'error'`。不要在占位上加功能。
- 默认 `agentKey = 'claude'`、`agentLabel = 'Claude Code'`（展示会话按 `agentKey` 隔离，旧 `local` / `openai-compatible:*` 会话不再出现在列表里，数据仍在 SQLite）。
- `/model-config` 路由、popup 的「模型配置」UI、`DEVTAILOR_RUNTIME`、`OPENAI_*` 环境变量兜底都已删除。`SessionStore` 启动时会清掉遗留的 `settings.model_config`（含明文 apiKey）、`.devtailor/scream-home/` 和 `.devtailor/session-memory.md`。
- thinking / 工具卡片链路已删除（Claude 通道从不产生 `thinking`/`tool_call`/`tool_update`）：Bridge 侧 `onThinking`/`onToolCall`/`onToolUpdate`、`ToolCallInfo`/`ToolUpdateInfo`，侧边栏 `renderThinkingBlock`、旧工具卡片渲染、`bridge-core` 的 tool 归约函数和整个 `chat-tools.js` 都已移除。取消时的 `tool_status canceled` 仍保留，只作“本轮已取消”信号。`loadPersistedSessions()` 恢复旧会话时过滤 `thinking`/`tool` 类型消息。不要再为这两类事件加回渲染分支。
- `prompt-builder.ts` 只保留 `buildPrompt(payload)`：页面 URL、用户意图、标记元素（selector/annotation/组件/样式/outerHTML/bbox）。系统提示、history、image block 都已删除；截图由 `ClaudeChannelSession` 落盘后以路径形式交给 Claude（见「Claude Code 通道」）。
- `/review` 的 turn 生命周期：`handleReview` 是 `done` 的**唯一发送点**。同步会话：`sendReview` resolve 后发一次。异步会话（`'pending'`）：`handleReview` 等 `turn.completion`（由 `onDone`/`onError`/`/cancel` 触发）后发一次；`AgentCallbacks.onDone` 只记录 summary、解除等待，不直接发 `done`。`stopReason === 'error'` 或 `turn.errored` 时只发 `error`，不发 `done`；session 已经通过 `onError` 报过的失败，`handleReview` 的 catch 不再重复发 `error`。
- `/cancel`（扩展侧约定）：返回 `{ok:true,canceled:true}` 或 `{ok:true,canceled:false,reason:'nothing_to_cancel'}`（后者不是错误，侧边栏只提示「当前没有正在执行的任务」）；不再发 `done(cancelled)`，仍发 `tool_status canceled`。以下为旧 Bridge 行为（保留作历史参考）：标记当前展示轮次已取消——发 `tool_status canceled` + `done(reason: cancelled)`，清空排队，丢弃该轮次之后 agent 的迟到输出，解除 `turn.completion`（串行队列释放），并调用该 display session 的 `cancelCurrentTurn()`（Claude 通道会推 `kind=cancel` 通知）。**不** stop/delete agent session。
- **发送即完成（像聊天，Hub 侧新契约）**：`POST /review` 立即返回 `202 {ok:true,turnId,sessionId}`，不再有 `queued/queueDepth/isProcessing`、不再有 429 队列满；无在线 Claude 实例 → `503 {ok:false,error:'no_claude_instance',message}`（扩展用 `bridge-core` 的 `errorInfo('no_claude_instance')` 提示，`parseProxyResponse` 把形如 `error:'snake_case'` 的值当作 code），SSE client 未连接 → 409。Hub 不再发 `done`、`queue_status`，SSE/health/sessions 不再带 `isProcessing/processingSessionId`。每条 reply 是一条独立 assistant 消息（SSE `stream` 带 `displayMessage.id`，每条不同），按 id 渲染成独立气泡。**扩展侧不再有任何「处理中」锁**：不要恢复 `sendInProgress`-until-done / `requestInFlight` / `meta.processing` / 加载点 / 发送按钮变「取消」。
- SSE 断开：若断开的是 `activeClient`，宽限期（`WSServer.activeClientGraceMs`，默认 3s，覆盖页面刷新/SW 重启时同 clientId 的重连）后调用 `browserRouter.deactivate`，避免向已断开的客户端下发动作。宽限期内同 clientId 重连则保持接管。

## Claude Code 通道（唯一后端，`mcp-main`）

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

启动脚本 `scripts/claude-devtailor.sh`（在目标项目目录里运行）：检查 `claude`、Node ≥ 20、插件已构建，`MCP_PROTOCOL_NEGOTIATION=legacy`，然后 `exec claude --plugin-dir <repo>/claude-plugin --dangerously-load-development-channels plugin:devtailor@inline "$@"`（`--plugin-dir` 加载的会话级插件 id 是 `devtailor@inline`，由 `claude --plugin-dir … plugin list` 实测得到；官方文档未明说“`--plugin-dir` + `plugin:` 开发 flag”这一组合，当时的实机验证清单可在提交 `0569936` 之前的 git 历史中查看；另一种入口是 `DEVTAILOR_CHANNEL_ENTRY=server:<name>` + 项目 `.mcp.json`）。`scripts/make-local-marketplace.sh` 生成本地 marketplace（`devtailor-local`）供“安装形态”使用。开发时也可不打包：`.mcp.json` 直接指向 `devtailor-bridge/dist/mcp-main.js`，用 `server:<名字>`。

**通知**：`kind: 'review'`，meta 键 `kind/turn_id/page_url/client_id/has_images/image_count/image_paths`（键只含字母数字下划线，值都是字符串）；`turn_id` 为 12 位十六进制（uuid 去横线截断），避免 Bridge 重启后复用旧 id。content 为 `buildPrompt` 文本 + `## Screenshots` 路径清单。`sendReview` 在通知写出后立即 resolve `'pending'`；写出失败 → `onError` + reject。

**`reply` 工具语义**（schema `{turn_id?: string, text: string, final?: boolean}`）：
- 每次调用把 `text` 作为增量送入该轮的 `onStream`；非首段前面补分隔（保证段间有空行：前文已以 `\n\n` 结尾则不补，以 `\n` 结尾补 `\n`，否则补 `\n\n`），避免 `appendAssistantDelta` 把多段拼成一行。
- `final: true` 才触发该轮 `onDone`（`ws-server` 随后发唯一一次 `done`，`reason: end_turn`）；`text` 可为空。`text` 与 `final` 都缺失 → 错误。
- `turn_id` 缺省为最近一个**进行中**的轮次；显式 `turn_id` 已结束/被取消/超时/未知 → 返回 `isError` 文本（“Turn x is not active … Do not reply to it.”）；没有进行中轮次 → `isError` 文本。从不抛异常。
- 多轮同时进行时，hub 在 `sendReview` 时快照该轮的 `AgentCallbacks`，所以回复按 `turn_id` 路由到正确的展示会话，不会串。

**取消**：`/cancel` 本地先标记取消并发 `done(cancelled)`，再调 `cancelCurrentTurn()` → 推 `kind=cancel`、`turn_id`、`content='用户在浏览器里取消了上一条请求，请停止相关操作，不要继续回复。'`；该轮随即被置为已结束，之后 Claude 对它的 `reply` 返回错误。无进行中轮次时返回 `false` 且不推通知。

**超时与无响应**：Bridge 已移除“10 分钟无回复超时”和“30 秒等待响应提示”（原 `replyTimeoutMs` / `noResponseHintMs` / `DEVTAILOR_REPLY_TIMEOUT_MS`）。发出通知后不再计时；一轮只在 `reply(final)`、取消、会话停止时结束。审批/提问的 300 秒超时是独立定时器，保持不变。
- MCP `initialize` 之后 stderr 记录 client 名称/版本/capabilities，并提醒 channel 通知在没用开发参数启动时会被静默丢弃。

**图片**：`.devtailor/images/<turn_id>-<n>.<ext>`，单张 ≤ 8MB（超限、非 png/jpeg/webp/gif、非 base64 的跳过并在 content 文本里说明），文件名只含 `[A-Za-z0-9_-]` 并校验解析后路径在目录内。不使用入站 MCP image content。工具返回的截图（`take_visible_screenshot`、`run_actions` 里的截图等 `data:image/...` 字符串）会被替换成短提示，作为 MCP `image` content 返回，并落盘 `shot-<ts>-<n>.<ext>` 备用；一次结果最多返回 8 张。

**浏览器工具**：`createBrowserToolDefinitions()` 的 19 个工具原样暴露（`parameters` → `inputSchema`），加 `reply` 共 20 个，列表不随运行状态变化。结果统一为文本 JSON `{ok, result|error}`，失败 `isError: true`；`NO_ACTIVE_TAB` 带 `error.hint: '请先在浏览器扩展里点击“接管”当前页面'`。元素库三工具走 `BrowserActionRouter` 的本地 handler（无需接管 tab）。`request_user_assistance` 保持 5 分钟语义（stdio 工具调用默认超时约 28 小时、idle 30 分钟，不需要额外配 `timeout`）。

**权限转发（permission relay，要求 Claude Code ≥ 2.1.81）**：Claude Code 想执行需要授权的工具（Bash/Write/Edit/MCP 工具）时，授权请求会转到侧边栏审批卡，用户在侧边栏点允许/拒绝，裁决再回给 Claude Code。

```text
Claude Code → notifications/claude/channel/permission_request {request_id, tool_name, description, input_preview}
  → mcp-server.ts onPermissionRequest → WSServer.requestChannelPermission
  → ApprovalRouter（SSE approval_request {approvalId, toolCallId: request_id, toolName, action: description, risk, detail: input_preview}）
  → 侧边栏「允许 / 拒绝」→ POST /approval-decision
  → WSServer 映射：approved → 'allow'；rejected（无 cancelled/reason）→ 'deny'
Claude Code ← notifications/claude/channel/permission {request_id, behavior: 'allow' | 'deny'}
```

- capabilities 同时声明 `experimental['claude/channel']` 与 `experimental['claude/channel/permission']`。
- **只有用户明确点了允许/拒绝才发裁决**；侧边栏没有在线客户端、审批超时（`ApprovalRouter` 默认 5 分钟，`reason: 'timeout'`）、被取消或 Bridge 停止 → **什么都不发**，让终端本地对话框接管。处理异常 → 发 `deny`。权限请求针对的是工具调用而不是页面：只要**有** SSE 客户端就投递卡片（没有接管任何标签时投给第一个已连接 UI）。
- 同一个 `request_id` 正在处理中重复到来 → 忽略（去重）。
- 终端对话框与侧边栏谁先答复谁生效（终端先批准时 Claude Code 丢弃迟到的裁决）。

**已知限制**：
- channel 是研究预览，必须用 `--dangerously-load-development-channels` 且交互式会话；协议可能变化。
- 会话必须保持打开；终端里 Claude 在等权限确认时，侧边栏会弹出审批卡（见下「权限转发」），谁先答复谁生效。
- 同时到达的多条通知会被 Claude 合并处理；`turn_id` 用来区分。
- Claude 上下文不能被 Bridge 清空：`/new-session` 只重置展示层。
- 多个 Claude Code 会话各自启动 MCP 时会争 34781，后来者退出（不再互相 kill）。
- permission relay 没有「终端已答复」的撤销信号：终端先批准后，侧边栏那张卡片会留到 5 分钟超时才变成「已超时」。relay 只覆盖工具使用审批，项目信任/MCP server consent 对话框不参与。
- 旧 Bridge 未实机验证项（当时的清单可在提交 `0569936` 之前的 git 历史中查看；现行验证请按 Hub 仓库文档执行）：`--plugin-dir` + `plugin:devtailor@inline` 是否注册为 channel、空闲会话是否被通知唤醒、`reply` 是否触发权限提示、image content 是否被渲染。

**真实 Chrome 端到端**：`node scripts/e2e-extension.mjs`（不在 `npm test` 内；需本机 Chrome + playwright-core）。品牌版 Chrome 137+ 不再支持 `--load-extension`，脚本改用 `--remote-debugging-port` + `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`。页内工具条是 **closed** Shadow DOM，Playwright 选择器无法穿透，脚本用 CDP `DOM.getDocument({pierce:true})` 取 closed root 再点击/输入。覆盖：SW→守卫、网页反例（CORS/no-cors GET、text/plain POST）、页内接管+发送+流式回复、sidepanel 页发送/回复、cancel、MCP 浏览器工具（snapshot/click/screenshot）、退出后端口释放。这次实测发现并修复了三个缺陷：SW GET 无 Origin（上面守卫的客户端头）、`prompt-builder.js` 导出了已删除的 `build`（ReferenceError 使整个页内发送不可用）、`click_page` 因 `dispatchMouseSequence` 已派发 `click` 又调用 `el.click()` 而触发两次点击。

**等待/故障提示（侧边栏）**：Bridge 未连接 → 提示“Bridge 未连接，请确认 Claude Code 已用 scripts/claude-devtailor.sh 启动”；未接管 → “尚未接管标签页：请先在页面中点击‘接管’（连接当前页）”；Claude 未响应时不再有自动提示或超时报错（已移除），用户可在侧边栏取消。

## 安全守卫

任何网页都能向 `localhost:34781` 发请求（简单请求免预检且响应可读，DNS rebinding 同样可行），所以 `ws-server.ts` 在路由分发最前面有统一守卫（`guardRequest`）：

- 监听只绑 `127.0.0.1`。
- **Host 校验**：Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，否则 403（防 DNS rebinding）。
- **Origin 校验**：除 `GET|OPTIONS /health` 外所有路由要求 `Origin` 以 `chrome-extension://` 开头（网页无法伪造此 Origin）；环境变量 `DEVTAILOR_EXTENSION_ID` 设置后只放行该扩展 ID。
- **扩展客户端头（真实 Chrome 实测后补充）**：Chrome 里 service worker 对已授权 host 的 **GET 不带 `Origin`**（和网页 no-cors GET 一样，`scripts/e2e-extension.mjs` 里的 “finding” 断言实测 403 `missing_origin`；POST 才带 Origin）。所以扩展的所有 Bridge 请求在 `service-worker.js` 的 `fetchBridgeUrl` 里统一加 `X-DevTailor-Client: <chrome.runtime.id>`；守卫对「无 Origin 但带合法该头」的请求视为受信（等同扩展 Origin，`/health` 也返回完整路由信息）。安全性依据：网页发自定义头必须先预检，而预检 OPTIONS 带网页 Origin 会被守卫拒绝；`no-cors` 请求不允许带自定义头。带网页 Origin 的请求不会因为带这个头而放行。`DEVTAILOR_EXTENSION_ID` 对该头的值同样生效（注意：其他扩展可以伪造这个头，Origin 则不能；威胁模型是“恶意网页”，不是“恶意扩展”）。不要删除这个头，也不要让 content script 直接 fetch。
- **CORS**：不再返回 `Access-Control-Allow-Origin: *`；仅当 Origin 通过校验时回显该 Origin 并带 `Vary: Origin`。OPTIONS 预检同样先过守卫。被拒请求不带任何 CORS 头。
- 被拒请求在 stderr 记一行：`[Guard] <时间> denied <METHOD> <path> reason=<原因> origin=<scheme://host>`，不记录 body/token。
- `GET /health`：无 Origin（或 Origin 不合法）只返回 `{ ok, protocolVersion }`；带合法扩展 Origin 才额外返回 `projectId/projectName/bridgeInstanceId/agentKey/agentLabel/activeClientId/activeSessionId/isProcessing/processingSessionId/agentStatus`。**不再返回 pid、会话标题、agentSessionId。**
- `POST /browser-tool` 已删除（它是无审批的 `run_js` 通道）。浏览器动作只能经 `BrowserActionRouter`（扩展 SSE `browser_action` → `POST /browser-action-result`）。
- **MCP 走 stdio，不经 HTTP 守卫**：Claude Code 是 Bridge 的父进程，MCP 协议在 stdio 上，没有 MCP 的 HTTP 端点，也没有 Bearer 令牌。守卫只保护扩展用的 HTTP/SSE 路由。
- **唯一例外：`/agent-status`**（Claude Code hook 上报，见「AI 状态（hooks 上报）」）。只有「Origin 为空 + 合法令牌」的 `POST /agent-status` 能过守卫；带任何浏览器 Origin（含 `null`）一律 403，Host 校验与「响应不带 CORS 头」不变，其它方法回 405。不要把这个例外扩展到别的路由。
- 防回归：不要为了调试放开 Origin/Host 校验，不要恢复 `ACAO: *`，不要在 `/health` 里加回 pid 或会话标题，不要让新增路由绕过守卫（守卫在 `handleRequest` 最前面，新路由自动受保护）。扩展侧所有 Bridge 请求必须继续走 service worker 代理（`bridgeProxyRequest` / `fetchBridgeUrl`），不要让 content script 页面上下文直接 fetch。

## AI 状态（hooks 上报）

侧边栏「AI 当前在做什么」状态标的数据源。**只进状态标，不进聊天**：这些事件不写入 `displaySessions` 消息、不持久化、不返回给 Claude，也不参与 `/review` 队列。

```text
Claude Code hook 子进程 ──POST /agent-status(Bearer 令牌)──▶ WSServer.handleAgentStatus
                                                             └─ AgentStatus.apply(event, payload, now)
ClaudeChannelHub（review 写出成功 / 该轮结束） ──onAgentStatus 回调──▶ WSServer.notifyAgentTurn('turn_start'|'turn_end')
                                                             ▼
                          SSE `agent_status {state,label,toolName,activeTools,since}` → 所有已连接客户端
                          GET /health（扩展 Origin）→ `agentStatus` 快照
```

**令牌**（契约一）：`WSServer.start()` 里生成 32 位十六进制随机令牌（`randomBytes(16).toString('hex')`），**每次启动覆盖写** `<dataDir>/agent-hook-token`（= `<项目目录>/.devtailor/agent-hook-token`），权限 `0600`（覆盖写会保留旧 mode，所以写完再 `chmodSync`）。令牌只在内存和这个文件里，**禁止写日志**（日志只记文件路径，不记内容）。`WSServer.stop()` 里尽力删除该文件；没有 `dataDir` 时令牌只在内存中。注意 `.devtailor/` 已被 `.gitignore` 忽略，不要把令牌文件提交上去。

**上报路由**（契约二）：`POST /agent-status`，请求头 `Authorization: Bearer <令牌>`（`crypto.timingSafeEqual` 比较，长度不等先拒绝），`Content-Type: application/json`，body ≤ 8KB（超出 413），字段 `{event, toolName?, label?, toolUseId?}`。成功 `{ok:true}`；令牌缺失/错误 401；body 非 JSON、缺 `event`、未知 `event` 400；非 POST 405。响应**不加任何 CORS 头**。

**守卫例外的理由与边界**：调用方是 Claude Code 的 hook 子进程（`curl`/`node`），不是浏览器，拿不到也伪造不了 `chrome-extension://` Origin，加 `X-DevTailor-Client` 又等于把扩展身份当密码用，所以 `/agent-status` 是唯一允许「无 Origin」的路由。安全性靠三件事叠加：① 只有 Origin **为空**才走令牌校验（网页发起的请求永远带自己的 Origin，`fetch` 的 `no-cors`/`text/plain` 也一样，`null` Origin 也会被 `validateExtensionOrigin` 拒绝 → 403）；② Host 校验保留（防 DNS rebinding）；③ 令牌是 32 位随机数，只在 `0600` 文件里。没有 CORS 头 → 就算网页能发请求也读不到响应。**边界**：这个例外只对 `/agent-status` 生效，其它路由守卫一字不改（`test/security.test.ts` 的断言与 `test/agent-status-route.test.ts` 的「仍然需要 Origin」用例一起守着）。

**事件与状态机**（契约三、四，`src/agent-status.ts`）：

- event 枚举：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`UserPromptSubmit`、`Notification`、`Stop`、`SubagentStop`，加 Bridge 内部触发的 `turn_start` / `turn_end`。未知 event → 400。
- `label` 由 hook 脚本生成（已脱敏已截断），Bridge 再 `sanitizeAgentLabel()`：去掉控制字符/换行（`\u0000-\u001f`、`\u007f-\u009f`、U+2028/U+2029）并折叠空白，按码点截断到 120 字符。
- `UserPromptSubmit` / `turn_start` → `thinking`（新一轮边界，清掉上一轮残留的在飞工具）；`PreToolUse` → `tool`（`toolUseId` 进在飞集合，没有 id 时用计数器）；`PostToolUse` / `PostToolUseFailure` → 在飞数减一，减到 0 回 `thinking`，否则仍 `tool` 并保留最近 label（未知/重复 id 不减、不会变负数）；`Notification` → `waiting`（label 缺省 `等待你的确认`）；`Stop` / `turn_end` → 清空在飞集合 → `idle`；`SubagentStop` → 只有在没有其它在飞工具时才回 `thinking`（有在飞工具则仍是 `tool`），**不会直接 idle**。
- `since` 是进入当前 state 的时间戳，同一 state 内换 label 不重置；`updatedAt` 是最后一次事件时间。
- 10 分钟（`AGENT_STATUS_STALE_MS`）没有任何事件时，`snapshot()` 按 `idle` 返回（内部状态保留，迟到的 `PostToolUse` 仍能收尾），防止 hook 没上报导致状态标卡在 `tool`。
- 状态**不持久化**，Bridge 重启即 `idle`；新 SSE 客户端连上时（`connected` 之后）立刻单发当前快照。

**接线**（契约五）：`ClaudeChannelHubOptions.onAgentStatus(kind)` 在 `dispatchReview` 的通知**写出成功之后**发 `turn_start`，在该轮 `endTurn()`（final / 取消 / 超时 / 出错 / stop）发 `turn_end`；`mcp-main.ts` 把它接到 `web.notifyAgentTurn`，hub 仍然不认识 HTTP/SSE。`ws-server` 的 `applyAgentStatus()` 在状态变化时向所有 SSE 客户端广播 `agent_status`（`types.ts` 的 `WSMessage.type` 里加了这个成员）。`GET /health`（带扩展 Origin）多返回一个 `agentStatus` 字段。

**防回归**：不要把令牌打进日志/错误信息/SSE，不要放宽成「`/agent-status` 也接受网页 Origin」，不要让它读写展示会话或持久化，不要把状态标内容拼进 prompt，不要给这个路由加 CORS 头，不要让 hook 事件唤醒 `turn_start`（只有 review 写出成功才算一轮开始）。

## 审批与提问通道

高风险操作审批与 Agent 提问的**传输层**：

- `ApprovalRouter`（`src/approval-router.ts`）：「SSE 请求 → HTTP 回传」模式。向 active client 发 `approval_request`（`toolName`/`action`/`risk`/`detail`），向其他 client 广播 `approval_pending`；只接受第一个有效决定（未知/已处理 id → HTTP 409），随后广播 `approval_resolved`。**无 UI 时不自动批准**，超时（默认 300s）→ `rejected`。client 重新 active 时 `resendPending()` 补发。HTTP：`POST /approval-decision`（`{ approvalId, decision: 'approved'|'rejected', feedback? }`）。
- `QuestionRouter`（`src/question-router.ts`）：同构，`question_request`/`question_pending`/`question_resolved`，`POST /question-answer`（`{ questionId, answers | null }`）。**问题不会「拒绝」**：超时/无 UI → `null`（dismissed），不要伪造答案。答案格式 `Record<question 文本, string | true>`。
- **`approval_request` 现在有生产调用方**：Claude Code 的 permission relay（见「Claude Code 通道 → 权限转发」）。`WSServer.requestChannelPermission` 把 `permission_request` 变成审批卡，`approved → 'allow'`、`rejected → 'deny'`、无客户端/超时/取消 → `null`（不发裁决）。`QuestionRouter` 仍无生产调用；不要删除这两个 router。
- 扩展 UI：只有侧边栏渲染 `approval` 卡片（侧边栏的渲染与事件归约模块）；`question` 卡片仍只在 `sidepanel.js`。卡片瞬态，不持久化。
- 审批卡固定显示「允许 / 拒绝」，提交 `decision`（`approved` / `rejected`）。`detail` 可以是字符串（permission relay 的 `input_preview`），会被包成 `{preview}` 并在渲染时截断到 600 字符；`risk` 是等级词（`low|medium|high`）时渲染成「风险：低/中/高」，其他文本原样显示。

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

- `message-store.js`：消息数组的 reactive facade，提供 append/update/remove/clear/replaceAll/find/findLast/filter/subscribe 等 API，内部通过 RAF 批处理合并同一帧内的多次 mutation。
- `chat-markdown.js`：Markdown 渲染和 sanitizer。
- `chat-scroll.js`：滚动跟随、回到底部按钮。
- `chat-images.js`：截图/粘贴图片、待发送缩略图。
- 侧边栏的纯逻辑、渲染、事件归约器、共享样式、meta 控件绑定这五个模块（`content/modules/` 下的侧边栏专用文件），只由侧边栏使用（页内聊天已删除）。

侧边栏在 `sidepanel.html` 里按序加载这些模块；内容脚本只加载工具条相关模块（`manifest.json` 的 content_scripts 列表）。

## Transport

浏览器 ↔ Bridge 使用 SSE + HTTP POST：

- `GET /events?clientId=...`：SSE 事件流。

所有路由先过「安全守卫」（Host + `chrome-extension://` Origin 校验）。
- `POST /review`：发送当前用户请求。
- `POST /activate`：当前 tab 接管项目浏览器操作权。
- `POST /cancel`：取消当前展示轮次（第一步语义见「Agent runtime」）。
- `GET /health`：存活检查；无 Origin 只返回 `{ ok, protocolVersion }`，带扩展 Origin 才返回项目/激活 tab 元数据（见「安全守卫」）。
- `POST /new-session`：创建或复用空白展示会话。
- `GET /sessions` / `GET /sessions/active` / `POST /sessions/load` / `POST /sessions/delete`：展示会话管理（`/sessions/load` 已下线，返回 410）。
- `GET /element-targets` / `POST /element-targets` / `DELETE /element-targets/:id`：元素库。
- `POST /browser-action-result`：扩展回传 browser action 执行结果。
- `POST /agent-status`：Claude Code hook 上报「AI 当前在做什么」（Bearer 令牌，唯一不需要扩展 Origin 的路由，见「AI 状态（hooks 上报）」）。

浏览器工具不在这里：它们是 stdio MCP 工具，由 Claude Code 直接调用（不经 HTTP）。

`content/modules/ws-client.js` 名字保留是兼容历史调用点，但实现是 SSE，不是 WebSocket。不要因为文件名把传输层改回 WebSocket。

休眠/网络恢复边界：

- content script 不直接访问 Bridge，也不直接创建 `EventSource`；标准通道是 background service worker Bridge proxy。background 维护 SSE fetch stream 并通过 `chrome.tabs.sendMessage` 转发事件，普通 HTTP API 通过 `chrome.runtime.sendMessage` 代理，避免受宿主页面网络上下文限制。
- `online`、`pageshow`、窗口 focus 和页面重新可见时要主动做轻量恢复探测，必要时通知 background 关闭旧 SSE proxy 并重建连接。
- background proxy SSE 断开后，content 应快速重连，并在 proxy open 后拉 `/sessions/active` 发出 `active_session_sync`（Bridge 不存 transcript，展示会话消息由 Bridge 持久化；当前会话状态以 `/sessions/active` 为准）。sidePanel 不依赖 content script 内存里的事件：首次打开、SSE 重连、Bridge 实例、active client 或 active session 变化时自行 `GET /sessions/active` 恢复当前展示会话和消息；没有接管标签页时也要请求（省略 `clientId`）。同一会话的快照和 SSE 使用持久化消息 ID 合并，避免重复或回退；定时 `/health` 仅在状态变化或尚未同步成功时拉快照。用户消息靠 `display_message` 广播实时同步，本地乐观消息与持久化 id 对齐，不能重复显示。
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

> 当前只有 Claude Code 通道一种后端：Bridge 的展示会话只是本地 UI 镜像，AI 的上下文在 Claude Code 那边（语义见「Claude Code 通道」「Bridge Session 管理」）。

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
- stream/tool_status/done/error 等运行事件必须携带 display `sessionId`；前端只接收当前会话的运行事件，避免新建/切换后旧 turn 回流污染当前 UI。
- 用户主动新建会话的 `session_reset` 只清空当前展示，不插入“会话已重建”提示；Bridge 重启等异常 reset 才展示提示。
- 删除 display session 应删除对应展示消息，并停止/移除对应 agent session。
- 会话标题优先采用 agent runtime 的 `session_info` 更新，Bridge 持久化后通过 SSE `session_info` 同步给前端；首条用户消息截断标题只是 fallback。
- 前端发送只依赖 Bridge 连接状态，不依赖当前 tab 是否已接管；未接管时仍可发送消息，browser tools 如需页面操作会继续路由到当前已接管 tab，若没有 active tab 则返回结构化错误。

前端 `chrome.storage.local` 只适合缓存草稿、待发送图片、控件状态等轻量 UI 状态。不要让它成为聊天记录的权威来源，也不要把它当作 Agent 上下文。

## Bridge Session 管理

> `WSServer` 的展示会话管理就是当前唯一后端的行为（每展会话一个 `AgentSession`，`/review` 串行队列）。

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
- 发送即完成：`/review` 返回 202 即视为已受理，前端不维护待发送队列/重试队列，也不依赖 `isProcessing`/`queue_status`/`done`；可连续发送多条。
- 前端 `sendInProgress` 只覆盖 `POST /review` 在途的短暂窗口（防双击 / 连按 Enter 重复提交，必须在 `await` 之前置位），请求一返回立刻放开；它不是「处理中」锁。
- 流式气泡收尾（无 `done`）：下一条用户消息、新的 `displayMessage.id`、工具/审批/提问卡、`error`、`tool_status canceled` 都会 `endStream()`；旧 `done`/`queue_status` 事件仍被容忍（`done` 当作收尾、`queue_status` 忽略）。
- 不要并发调用同一个 agent session 的 `sendReview()`。
- 「取消」是输入框旁独立的条件按钮（`#cancel-btn`，仅在有未决审批/提问卡或工具 `running` 时显示），不占用发送按钮、不阻塞发送；`/cancel` 不 stop agent session，仅通知 Claude 停止当前轮次。`canceled:false`（`nothing_to_cancel`）不报错。
- 空闲 session 会清理。
- Browser action request/response 通过 requestId 匹配，超时要返回结构化错误。

## 持久化规则

> Bridge 持久化展示会话、展示消息、图片引用与元素目标（`SessionStore`）；AI 的对话上下文不在 Bridge 里。

项目级数据存储在：

```text
{projectRoot}/.devtailor/
```

当前持久化内容：

- display sessions
- display messages
- 图片引用
- element targets

不持久化、只管一次进程生命周期的文件：`.devtailor/agent-hook-token`（hook 令牌，权限 0600，每次启动重写、停止时删除，见「AI 状态（hooks 上报）」）；`.devtailor/images/`（截图，按需清理）；`.devtailor/design/`（设计规范原文）。AI 状态（`AgentStatus`）只在内存里。

SQLite schema 变更必须写迁移，不要假设用户已有 `.devtailor/sessions.db` 是最新结构。尤其 `element_targets` 这类新增表/列必须支持旧库启动。旧 `sessions.acp_session_id` 列启动时迁移为 `agent_session_id`，保留会话 ID 和聊天记录。迁移后，仍依赖旧列名的 Bridge 构建不能直接使用新库；如需回退，请先备份 `sessions.db`。

现行持久化和 SQLite schema 变更请在 `devtailor-hub` 仓库修改，并按该仓库文档运行相关迁移与持久化测试；`devtailor-bridge/src/session-store.ts` 已删除。

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
- 被接管 tab 在后台（`visibilityState === 'hidden'`）时 rAF 暂停、不渲染：`get_page_snapshot` / `run_js` 返回 `page.visibilityState` 和 `hasFocus`，hidden 时带 `warning`。做动画/闪烁/布局采样前先看这个字段；`run_js` 的 `code` 必须是函数表达式（`() => {...}`），不是函数体。
- `run_js` schema 参数名是 `code`；content runner 可兼容历史 `function` 字段，但模型侧不要再生成 `function` 参数。`run_js` 是诊断兜底，不要把它当成所有交互的首选。React 键盘提交等真实输入优先用 `press_key`。
- selector 参数是原生 CSS selector，不是 Playwright selector；不要支持 `:has-text()` 这类 Playwright 私有语法，文本定位用 `text` / `role + label` / 元素库。
- 坐标和 grid 点击必须默认穿透 DevTailor 面板，不能点到调试面板自身。

## 提示带入的上下文（侧边栏顶部）

- 会话栏里「上下文 N%」（Claude Code 的 `usage` 事件，已用/窗口大小）左侧有一个「带入 标记 N · 截图 N · 规范 N」标签，说的是**上一条提示**除文字外带了什么，悬停看全称；全为 0 时隐藏，切会话后不显示别的会话的数字。
- 数字来自 `sidepanel.js` 的 `executeSend`：标记数（`markIds`）、图片数（页面截图 + 粘贴图）、已启用的设计规范数（`designDocs.getState().docs`）。纯格式化在侧边栏的纯逻辑模块（`promptContextModel`，有单测）。它只是扩展侧对「刚发出去的 payload」的摘要，不是 Bridge 回传的；Claude Code 没有「命中了哪些上下文」的接口。
- 为了能数到已启用规范，`design-docs.js` 的 `setConnected(true)` 现在无论面板是否展开都会 `refresh()` 一次。

## 设计规范（DESIGN.md）

- 侧边栏「设计规范」折叠区（`sidepanel/design-docs.js`，纯逻辑 `tests/extension/design-docs.test.js`）可上传 .md/.markdown/.txt（多选）、逐个启用/停用/删除；Bridge 未连接时禁用并提示。
- Bridge（`src/design-docs.ts`，路由在 `ws-server.ts` 的 `handleDesignDocs`）把文件写到 `<项目目录>/.devtailor/design/<uuid>.md`，元数据在 settings 表 `design_docs`。**路径只用服务端生成并校验过格式的 uuid**，客户端文件名只是展示名；不要改成拼接文件名。限额：单文件 256KB、最多 10 个、UTF-8 文本。
- Prompt 只注入启用文件的**绝对路径**（`buildPrompt(payload, {designDocPaths})`，经 `ClaudeChannelHubOptions.getDesignDocPaths`），不内联内容；多个启用时按启用顺序列出，靠后者优先。无启用文件时不加该段。提示语里带一句「项目自有前端规范与 spec 冲突时以项目规范为准，并说明采用了哪条」，因为设计规范可能来自别的项目（曾导致按错规范改了两轮）。
- `/design-docs` 路由（`GET`，以及 `POST /design-docs`、`POST /design-docs/toggle`、`POST /design-docs/delete`）的实现见 `ws-server.ts` 的 `handleDesignDocs`。

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
- sidePanel 使用 `chat-images.js` 的 data URL 校验与预览管理；sidePanel 的附件选择、粘贴、历史回显和 `/review` payload 不能分叉。
- sidePanel 的待发送图片预览放在 composer 顶部，位于文本输入和工具栏之前，不要回退到输入区底部。
- 图片 base64 不要塞进 Markdown 文本；当前由 `ClaudeChannelSession` 把截图落盘成路径交给 Claude（content 里的 `## Screenshots` 清单），`buildPrompt` 不再构造 image block。
- 持久化展示历史时保留有限数量图片引用，避免无限膨胀。
- `run_actions` 内截图默认外部化，避免 token 爆炸。

## 元素标记与页面交互

标记使用 `content/modules/visbug-hit-test.js` 的轻量 VisBug 风格 hit-test：

- 深度 `elementFromPoint`，穿过 Shadow DOM host。
- 收集命中元素、祖先、`elementsFromPoint` 层和 bounded descendants。
- 按深度、可见面积、叶子节点、文本/媒体/表单语义和鼠标距离评分。

- 标注抓的计算样式如果元素当时处于 `:hover` / `:focus-visible` / `:active`，`context-capture.js` 会多写一个 `capturedWhile` 字段，提醒颜色可能是交互态而非静止态。
- `browser-action-dom.js` 的 `findByLocator` 先查语义可交互元素，没命中再回退到 `cursor: pointer` 的元素（只留最深一层），所以 div/span 做的侧栏项、标签页也能被 `click_page` 的 text/label 定位。
- 页面模态层（Radix/Headless UI/MUI Dialog、Popover）下标记卡片的备注框曾无法输入：卡片和工具栏在弹窗 DOM 之外，被焦点陷阱（document `focusin`/`focusout`）抢回焦点、被「点击外部关闭」关掉弹窗，Escape 还会连弹窗一起关。现在 `badges.js` 的 `wireModalGuard` 在卡片容器上拦 pointer/mouse/click/focus/key 事件，并在 window 捕获阶段拦 relatedTarget 是卡片的 `focusout` 和卡片内的 Escape；`shadow-ui.js` 的边界事件列表加了 `focusin`/`focusout`。不要把这些拦截删掉，也别改成只在 document 上监听。

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
- sidePanel 使用 `chat-markdown.js`，不能退化成 HTML 转义加 `<br>` 的独立实现。
- 允许段落、标题、列表、代码、表格、链接、引用、图片和基础强调。

Mermaid 当前未启用。若以后启用，只渲染明确的 `language-mermaid` fenced code block，不要把 Mermaid 设为默认 Markdown 渲染。

## 中文发布口径

当前先发布中文单语言版本：

- README、商店描述、隐私政策使用中文。
- 工具名、命令名、Agent 名、Credits 项目名保留原名。
- Credits 只保留项目名称、原仓库地址和 license，不写长感谢文。

## 重要文件

以下 `devtailor-bridge/` 文件列表仅为历史索引，均已删除；涉及这些服务端职责的改动请在 `devtailor-hub` 仓库定位并修改现行实现。

- `content/content-script.js`：模块装配、工具栏事件、标记/元素库入口。
- `content/modules/shadow-ui.js`：Shadow DOM 面板和样式。
- `content/modules/toolbar.js` / `toolbar-core.js`：页内标记工具条（DOM 接线 / 纯逻辑）。
- `content/modules/marks-core.js` / `marks-sync.js`：标记搜索、广播载荷、DevTailor prompt 解析（纯逻辑）/ 内容脚本侧同步。
- `sidepanel/mark-tray.js`：侧边栏标记托盘。- `sidepanel/design-docs.js`：侧边栏设计规范（DESIGN.md）管理。
- `devtailor-bridge/src/design-docs.ts`：设计规范存储、路径安全与限额。
- `devtailor-bridge/src/agent-status.ts`：AI 状态机（hook 事件 → `idle/thinking/tool/waiting` 快照），纯逻辑、无 I/O、状态不持久化。

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
- `devtailor-bridge/src/mcp-server.ts`：MCP server 定义（capabilities、instructions、20 个工具、`reply`）。
- `devtailor-bridge/src/claude-channel-session.ts`：`ClaudeChannelHub`（turn/超时/取消/图片）+ `ClaudeChannelSession`。
- `devtailor-bridge/src/mcp-browser-tools.ts`：browser tool → MCP 工具（19 个），截图转 image content。
- `devtailor-bridge/src/image-store.ts`：图片落盘 `.devtailor/images/`（8MB 上限、受控文件名）。
- `docs/CLAUDE_CHANNEL_PROTOCOL.md`：实际依赖的官方协议点与来源。
- `devtailor-bridge/src/log.ts`：唯一允许写进程流的模块，所有日志写 stderr。
- `devtailor-bridge/src/approval-router.ts` / `question-router.ts`：审批/提问的 SSE ↔ HTTP 传输。
- `devtailor-bridge/src/session-store.ts`：SQLite 持久化和迁移。
- `devtailor-bridge/src/prompt-builder.ts`：当前请求（页面/意图/标记元素）转文本 prompt，无 system prompt、无 history。

## 常见错误

- 不要恢复 `/sessions/load`、`session_snapshot` 或已删除的路由；不要把 prompt/会话内容写日志。
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

## 标记与截图的刷新保留

- 标记（`review-store.js`）和待发送截图（`marks-sync.js` 的 `shots`）原来只在页面内存里，刷新页面或开发服务器整页重载后全部丢失。现在 `marks-sync.js` 在每次变化后 400ms 防抖写入 `chrome.storage.session`（key `dt_state_<tabId>`，纯函数在 `marks-core.js` 的 `buildPersisted` / `restorePersisted`，有单测），内容脚本启动时 `init()` → `restore()` 取回。
- 约束：只在**同源**时恢复；恢复时 `sent` 一律清为 false（发送它们的那一轮已经不存在）；用户在恢复完成前已经新增的内容优先，不合并；恢复完成前不写入，避免空状态覆盖。
- 已发送标记的防重复（`marks-core.js` 的 `createSentTracker`，侧边栏 `executeSend` / `settleSentMarks` / `reconcileSentMarks`）：标记在 `POST /review` **之前**就乐观 `markSent`（只标 sent，不清截图），并登记进 tracker，防止并发 BUILD 重复带上。**时机（发送即完成）**：`/review` 返回 2xx 即 `settleSentMarks('done')` 清除标记（并消耗截图）；非 2xx / 网络错误则 tracker 回滚并 `markUnsent`，标记恢复可发送。不再等 `done`；旧 `done`/`error` 事件仍会调用 `settleSentMarks`，但此时 tracker 已空，是无副作用的容错。请求在途期间页面重载：内容脚本恢复的标记 `sent` 仍为 false（持久化语义不变，id 不变），侧边栏每次收到快照时对 tracker 里 `sent=false` 的 id 重新 `markSent`，2xx 后被清掉。不要把「标记已发送」挪回 `/review` 成功之后。
- 容量：`storage.session` 配额约 10MB，持久化上限 7MB，超出按“最旧截图先丢”，仍写入失败则只保留标记；丢了截图会弹提示。关闭标签页时 service worker 删除该 tab 的存档；关闭浏览器即清空（session 语义，不跨浏览器会话）。
- service worker 启动时必须 `chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')`，否则内容脚本读写 `storage.session` 会被拒。
