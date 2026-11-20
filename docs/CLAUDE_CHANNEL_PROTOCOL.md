# Claude Code Channel 协议摘录

> **旧 Bridge 历史说明**：文中 `devtailor-bridge/`、`claude-plugin/` 路径指已删除的旧 Bridge（可在 git 历史中查看，提交 `0569936` 之前）；现行实现在 `devtailor-hub` 仓库（`/Users/liguangzhen/代码/devtailor-hub`）。服务端行为请在 Hub 仓库修改。现行链路为扩展 → Hub 的 devtailor 通道（`127.0.0.1:34781`）→ Claude Code 的 hub-channel；发送即完成：`/review` 立即返回 202，每次 `reply` 是独立消息，无 `done` / 队列。下文旧 Bridge 的启动、路径和生命周期描述仅供历史参考。

本文只记录 DevTailor Bridge **实际依赖**的协议点，以官方文档为准；官方文档变化时先改这里再改代码。抓取日期：2026-11-07；本机 Claude Code 2.1.319，Node v26.3，`@modelcontextprotocol/sdk` 1.32.2（`LATEST_PROTOCOL_VERSION = 2025-11-25`）。

来源：

- Channels reference — https://code.claude.com/docs/en/channels-reference.md
- Channels — https://code.claude.com/docs/en/channels.md
- MCP — https://code.claude.com/docs/en/mcp.md
- Environment variables — https://code.claude.com/docs/en/env-vars.md
- 官方参考实现 fakechat — https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/external_plugins/fakechat/server.ts

Channel 目前是 **research preview**，flag 语法和协议契约可能变化。

## 1. Capability 声明

```ts
new Server({ name, version }, {
  capabilities: {
    experimental: { 'claude/channel': {} },   // 必需，注册通知监听
    tools: {},                                 // 双向 channel（有 reply 工具）才需要
  },
  instructions: '...',                         // 连接时作为上下文交给 Claude
})
```

- `experimental['claude/channel/permission']` 是 permission relay 的可选 capability（`{}` 声明；`false`/省略 = 不声明；v2.1.234 之前 `false` 也算声明）。**DevTailor 现在声明它**（见第 7 节），要求 Claude Code ≥ 2.1.81。
- fakechat 的写法一致：`capabilities: { tools: {}, experimental: { 'claude/channel': {} } }`。

## 2. 推送通知

- 方法：`notifications/claude/channel`；调用方式 `await mcp.notification({ method, params: { content, meta } })`。
- `params.content: string`：成为 `<channel>` 标签正文。
- `params.meta: Record<string, string>`：每个条目成为标签属性。**value 必须是字符串；key 只能含字母、数字、下划线**，含连字符等的 key 会被静默丢弃。`source` 属性由 Claude Code 按 server 配置名自动加（plugin 形式是 `plugin:<plugin>:<server>`）。
- `await mcp.notification()` 只代表写入 transport，**不代表 Claude 处理了**；Claude Code 不确认。若会话没把本 server 加载为 channel（没传 flag / 组织策略禁用），事件**被静默丢弃**，不返回错误。
- 事件进入会话队列按序处理；Claude 忙时到达的多条通知会在下一轮**合并**一起交给 Claude。
- fakechat 把文件路径只放在 `meta.file_path`，不信任 content 里的 “[attached — Read: PATH]” 字样（可被用户输入伪造）。DevTailor 同时在 content 与 `meta.image_paths` 里给出路径，但 content 部分由页面数据拼出，仍应视为不可信。

## 3. 回复工具

标准 MCP 工具，没有 channel 专属约定：

1. `capabilities.tools = {}`；
2. `ListToolsRequestSchema` / `CallToolRequestSchema` 处理器；
3. `instructions` 告诉 Claude 何时、如何调用，以及回传哪个 meta 属性（fakechat 用 `chat_id`；DevTailor 用 `turn_id`）。

fakechat 的 `reply` 返回 `{ content: [{ type: 'text', text: 'sent' }] }`，出错返回 `isError: true`。fakechat 的 instructions 开头强调：“发送方看的是 UI，不是这个会话；想让他看到的内容必须走 reply 工具，终端输出到不了 UI”——DevTailor 沿用这一点。

首次调用 reply 时 Claude Code 可能弹工具权限确认（官方文档在 fakechat 示例里提到 “If Claude Code asks for permission for the first reply, approve it”）。

## 4. 启动与加载方式

- Claude Code 以子进程方式拉起 channel server，stdio 通信；所以 **stdout 只能是 MCP 协议**，日志走 stderr。
- 在 `.mcp.json` 里配置，但“在 `.mcp.json` 里”不够：必须在会话启动时用 flag 选入。
- research preview 期间自建 channel 不在白名单，使用：`claude --dangerously-load-development-channels server:<name>`（plugin 形式 `plugin:<name>@<marketplace>`）。启动时有全屏警告确认；首次使用 `.mcp.json` 里的 server 还会有“New MCP server found in this project”确认。
- **只能交互式会话**：`-p` / Agent SDK 下该 flag 被忽略，channel 不注册。
- 该 flag 不在 `claude --help` 里列出，但可用。该 flag 只绕过白名单，`channelsEnabled` 组织策略仍然生效（Team/Enterprise 需管理员启用；个人 Pro/Max 无组织的用户不受此限）。
- 事件只在**会话保持打开**时到达；空闲但未退出的会话是否被通知唤醒，官方文档称“Claude reads the event and replies back”，**未明确写空闲唤醒细节，需要实机验证**。

## 5. MCP 客户端运行时与协议版本

- Claude Code 有 v1（MCP TS SDK 1.x）和 v2（SDK 2.0，新增协议版本 2026-07-28）两个 MCP 客户端运行时。v2 在有 feature flag 拉取的会话里从 v2.1.232 起使用，在不拉取 flag 的会话里（Bedrock/Vertex/Foundry、Claude apps gateway、关闭 telemetry 等）从 v2.1.274 起默认使用。
- v2 运行时**不会把协商到 2026-07-28 的 channel server 注册为 channel**（该版本无法承载 channel 消息）。stdio server 默认被询问是否支持该版本。不支持该版本的 server 仍走旧握手，“registers as before”。
- 环境变量（设在**启动 `claude` 的环境**里，不是 server 的 `env`）：
  - `MCP_PROTOCOL_NEGOTIATION=legacy`：让所有 server 保持旧握手（仅 v2 运行时有效，要求 Claude Code v2.1.221+）。
  - `MCP_SDK_GENERATION=v1`：直接固定 v1 运行时（v2.1.218+）。
- DevTailor 现用 SDK 1.32.2，最高只支持 2025-11-25，不会协商 2026-07-28，所以理论上无需环境变量；仍建议启动脚本带 `MCP_PROTOCOL_NEGOTIATION=legacy` 作保险（尤其将来升级 SDK 后）。

## 6. 超时、输出限制、项目目录

- 每个 server 的工具调用超时：`.mcp.json` 条目里的 `timeout`（毫秒，≥1000 才生效），是**硬性墙钟限制**，progress 通知不延长；未设时落到 `MCP_TOOL_TIMEOUT`，默认约 28 小时。
- stdio server 另有 idle 超时：工具调用在 idle 窗口内既无响应也无 progress 通知就中止，stdio 默认 30 分钟（`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` 可改；server 的 `timeout` ≥1000 会把 idle 窗口抬到至少该值）。stdio 没有 per-request timer。
- DevTailor 最长的工具调用是 `request_user_assistance`（默认 5 分钟、上限 10 分钟），在默认值内，**不需要**额外配置 `timeout`；第三步写 `.mcp.json` 时不必设置，若设置请 ≥ 11 分钟（660000）。
- MCP 输出：超过 10,000 token 警告、默认上限 25,000 token（`MAX_MCP_OUTPUT_TOKENS`）；成功的纯文本结果超过 50,000 字符会被存成文件；**返回图片的工具仍受 token 上限限制**。`get_page_snapshot` 等应保持轻量。
- Claude Code 给 stdio server 的环境里设置 `CLAUDE_PROJECT_DIR`（项目根）。官方文档**没有**写 stdio server 的 cwd 一定是项目目录（只有 headersHelper 等的工作目录有说明：项目 `.mcp.json` 声明的 server 在项目目录）。所以项目目录解析顺序：`DEVTAILOR_PROJECT_DIR` → `CLAUDE_PROJECT_DIR` → `process.cwd()`。
- 工具在 Claude 里的名字带 `mcp__<server>__` 前缀，工具描述里不要硬写。

## 7. Permission relay（已实现）

要求 Claude Code **≥ 2.1.81**（更低版本不认这个 capability，通知被忽略）。

**声明**：`capabilities.experimental` 同时写 `'claude/channel': {}` 与 `'claude/channel/permission': {}`（`tools: {}` 不变）。声明前必须能认证发送方——这里只有本机 Browser 侧边栏能答复（HTTP 守卫 + 本机 SSE），任何能通过 channel 回复的人也能批准工具调用。

**事件流**：

1. Claude Code → server（notification）：`notifications/claude/channel/permission_request`，params `{ request_id, tool_name, description, input_preview }`。`request_id` 是 5 个小写字母、不含 `l`。server 用 `server.setNotificationHandler(z.object({ method: z.literal(...), params: z.object({...}) }), handler)` 接收（zod 见 `devtailor-bridge/src/mcp-server.ts`）。
2. Bridge → 侧边栏（SSE `approval_request`）：`{ approvalId, toolCallId: request_id, toolName: tool_name, action: description, risk: 'medium', detail: input_preview }`。卡片用默认的「允许 / 拒绝」两个按钮（request 没有选项列表）。其他已连接 UI 收到 `approval_pending`。权限请求针对的是工具调用而不是页面，所以没有接管任何标签时也会投递给某个已连接 UI（优先 active client）。
3. 用户在侧边栏点按钮 → `POST /approval-decision { approvalId, decision: 'approved'|'rejected' }` → `approval_resolved` 广播。
4. server → Claude Code（notification）：`notifications/claude/channel/permission`，params `{ request_id, behavior: 'allow'|'deny' }`，用 `server.notification({ method, params })` 发送。

**语义（关键）**：

- 只有用户**明确点了**允许/拒绝才发裁决。
- 侧边栏**没有在线客户端**（没有任何 SSE 连接）→ **不发任何裁决，也不自动拒绝**，直接返回，让终端本地对话框接管。
- 审批**超时**（`ApprovalRouter` 默认 5 分钟，`reason: 'timeout'`）→ **不发裁决**（终端对话框可能还开着）。被取消 / Bridge 停止同理不发裁决。
- 处理过程**异常** → 发 `deny`。
- 同一个 `request_id` 正在处理中重复到来 → 忽略（去重），不重复弹卡、不重复裁决。
- 终端对话框与侧边栏**先到先得**：终端先批准时 Claude Code 会丢弃迟到的裁决。但协议**没有「终端已答复」的撤销信号**，所以侧边栏上那张卡片会一直留到 5 分钟超时才变「已超时」。
- relay 只覆盖 Bash/Write/Edit 等**工具使用审批**；项目信任与 MCP server consent 对话框不会 relay。

**代码位置**：`src/mcp-server.ts`（`onPermissionRequest` 回调 + 裁决通知）、`src/ws-server.ts`（`requestChannelPermission`）、`src/mcp-main.ts`（接线）、扩展 `content/modules/bridge-core.js`（审批状态机）与 `content/modules/chat-render.js`（允许 / 拒绝按钮）。

## 8. 已知限制（对 DevTailor 的影响）

1. channel 是 research preview，需要开发 flag + 交互式会话；协议可能变化。
2. 通知无确认；没加载为 channel 时静默丢弃 → Bridge 已不再提供“等待响应”提示和无回复兜底，需要用开发参数启动并自行确认终端状态（见 `HANDOFF.md`）。
3. 同时到达的多条通知会合并成一次处理，所以 Bridge 用 `turn_id` 标识每条，reply 显式回传。
4. 没有 cancel/clear 能力：取消只能再推一条 `kind=cancel` 通知“请求”Claude 停止；`/new-session` 只能重置展示层。
5. 图片：channel `content` 是文本，**不使用 MCP image content 作入站**。DevTailor 的决定：入站截图落盘到 `<project>/.devtailor/images/<turn_id>-<n>.<ext>`（单张 ≤ 8MB，仅 png/jpeg/webp/gif，文件名只含 `[A-Za-z0-9_-]`），在 content 与 `meta.image_paths` 里写绝对路径并提示用 Read 查看——Read 看图是 Claude Code 里最稳妥的方式。出站（工具返回的截图）既返回 MCP image content，也落盘一份并在文本里附路径作备用。
6. 单会话单 channel 流：并发独立事件流需要多会话。
7. permission relay（第 7 节）：协议没有「终端已答复」的撤销信号，侧边栏卡片在终端先批准后仍会留到 5 分钟超时才消失；relay 只覆盖工具使用审批，项目信任/MCP consent 对话框不参与。

## 9. 插件打包（第三步依赖的结论）

抓取日期 2026-11-07，Claude Code 2.1.319。来源：

- Plugins reference — https://code.claude.com/docs/en/plugins-reference.md
- Plugin components — https://code.claude.com/docs/en/plugins/components.md
- Plugin CLI reference（`validate`、`--plugin-dir`）— https://code.claude.com/docs/en/plugins/cli-reference.md
- Create a plugin — https://code.claude.com/docs/en/plugins/create.md
- CLI reference — https://code.claude.com/docs/en/cli-reference.md
- Channels reference（Package as a plugin、Test during the research preview）— https://code.claude.com/docs/en/channels-reference.md
- MCP（plugin-provided servers、工具命名）— https://code.claude.com/docs/en/mcp.md
- 注：`/docs/en/plugins/create-marketplace.md` 在抓取时是 404 页面，marketplace 结构以 `marketplace-reference.md` 和 `claude plugin validate` 的实测校验为准。

结论：

1. **清单**：`<plugin>/.claude-plugin/plugin.json`；`mcpServers` 可内联 map（key 是 server 名）；`channels` 是数组，每项严格对象，`server` 必须是该插件 `mcpServers` 的 key，可选 `displayName`、`userConfig`（未知字段会让插件加载失败）。DevTailor 用 `[{ "server": "devtailor", "displayName": "DevTailor" }]`，不需要 userConfig。
2. **路径变量**：`${CLAUDE_PLUGIN_ROOT}` 是已安装版本的绝对路径，在 MCP `command`/`args`/`env` 里会被替换；marketplace 安装会把插件复制到缓存，所以必须用它且不能引用插件目录之外的相对路径。`CLAUDE_PROJECT_DIR` 由 Claude Code 注入 server 环境，无需在 `env` 里重复。
3. **命名**：插件内 MCP server 在 `/mcp` 里叫 `plugin:<plugin>:<server>`（这里是 `plugin:devtailor:devtailor`）；工具全名 `mcp__plugin_<plugin>_<server>__<tool>`，名字里 `A-Za-z0-9_-` 以外的字符变 `_`。权限规则、hook matcher、skill `allowed-tools` 都要用这个全名（`mcp__plugin_devtailor_devtailor__reply`）。channel 事件的 `source` 属性是 `plugin:devtailor:devtailor`。
4. **开发 flag**：`claude --dangerously-load-development-channels plugin:<name>@<marketplace>` 或 `server:<name>`；交互式会话才生效（`-p` 会忽略）；绕过的是白名单，不绕过 `channelsEnabled` 组织策略；flag 不在 `claude --help` 里但可用。官方写“marketplace 里发布的 channel 插件仍需开发 flag，之后用 `--channels plugin:<name>@<marketplace>`”。
5. **`--plugin-dir`**：加载目录或 `.zip`，仅本会话，可重复；`claude --plugin-dir ./claude-plugin plugin list` 实测显示 `devtailor@inline`（Session-only plugins 段），所以组合形式是 `--plugin-dir ./claude-plugin --dangerously-load-development-channels plugin:devtailor@inline`。**官方文档没有明确写这个组合**，是否真注册为 channel 需实机验证（旧 Bridge 的验证清单可在提交 `0569936` 之前的 git 历史中查看，现行通道配置与验证以 Hub 仓库文档为准）；备选是项目 `.mcp.json` + `server:<name>`。
6. **校验**：`claude plugin validate <path>` 可校验插件目录或 marketplace（非交互，退出码 0/1/2）；会检查 `plugin.json`、`.mcp.json`/内联 MCP 条目（v2.1.281+）、skills/commands。`claude-plugin` 唯一的警告是缺少 icon（可选，不影响结果）。
7. **超时**：`mcpServers.<name>.timeout`（毫秒）是硬性墙钟；DevTailor 设 `660000`（≥ `request_user_assistance` 的 10 分钟上限）。
8. **认证/平台**：channels 需要 claude.ai 账号或 Console API key 认证，Bedrock/Vertex/Foundry 不可用；Team/Enterprise 需管理员启用 `channelsEnabled`。官方文档没有写“Claude Code ≥ 2.1.80”这个最低版本（来自任务要求，未被文档佐证）；permission relay 相关行为提到 v2.1.234，MCP v2 运行时提到 v2.1.221/232/274。
9. **权限规则写法**（permissions.md，2026-11-07）：整台 server 用 `mcp__plugin_devtailor_devtailor__*`（或 `mcp__plugin_devtailor_devtailor`），单个工具用全名；allow 规则的通配符只能出现在字面 `mcp__<server>__` 前缀之后；带括号的 `mcp__` 规则会被跳过。
