# Scream Code × DevTailor 合并产品用户故事

> 状态：产品与迁移设计草案，尚未代表当前实现。
>
> 目标：以 Scream Agent Core 作为唯一后端运行时，同时服务 Web 和 TUI；将 DevTailor 的浏览器上下文、元素标记和页面验证合并为后端内置能力，不通过外置 MCP 安装链路接入。

## 1. 产品定位

合并后的产品是一个本地优先的 AI 开发后端，用户可以从两种界面进入同一个工作流：

- Web/DevTailor：面向用户的完整界面，可发起工程任务、绑定当前页面、标记元素、执行浏览器操作并查看验证结果。
- TUI/Scream：同样是面向用户的完整界面，可进行长任务、文件修改、命令执行，也可绑定已连接页面、请求用户标记元素并使用同一套浏览器工具。
- Backend Daemon：统一管理 session、agent turn、模型、内置工具、页面绑定、用户标记、权限、压缩、记忆和持久化。
- Browser Runtime：作为 Chrome 扩展中的薄执行端，只执行必须在浏览器内完成的 DOM、console、截图、选择器 overlay 和页面交互；工具 schema、调度、权限、事件和持久化属于 Backend。

核心原则：

- **Web 和 TUI 不各自拥有一套 agent runtime；它们是同一后端的两个完整交互界面。**
- **Browser tools 是产品内置工具，不是用户需要安装、注册或维护的 MCP server。**
- **用户标记是 session 下的一等上下文数据，不是 Web 界面中的临时状态。**
- **Backend session store 是历史会话的唯一存储，不再保留 display session 数据库或 Web/TUI 历史副本。**

### 1.1 合并后边界

```text
Web UI ──┐
         ├── Client Protocol ──> Backend Daemon
TUI UI ──┘                              ├── Agent / Session / Persistence
                                           ├── Built-in Workspace Tools
                                           └── Built-in Browser Tools
                                                         │ Browser Execution Channel
                                                         ▼
                                                 Chrome Extension Runtime
```

- Backend 在启动时直接注册 browser tool definitions 和 handler，不做 MCP discovery、MCP 连接或额外安装。
- Browser Runtime 通过产品自有的双向通道与 Backend 保持连接，上报 pageId、tab 元数据与可用能力。
- Web 可将当前页面直接绑定到 session；TUI 可从已连接页面中选择并绑定，不通过 URL 猜测。
- Agent、Web 用户操作和 TUI 用户操作共用同一 browser command/result 边界和事件流。

### 1.2 “内置 Browser Tools”的含义

| 职责 | 归属 |
|---|---|
| Tool schema、描述、参数验证 | Backend 内置工具模块 |
| Tool 可用性、权限、审批、取消 | Backend |
| session 与 page/tab 绑定 | Backend |
| 用户标记、targetId、批注和持久化 | Backend |
| Agent/Web/TUI 的调用调度和统一事件 | Backend |
| DOM 读取、overlay、点击、输入、截图 | Chrome Extension Runtime |
| 工具请求和结果的传输 | 产品内部 Browser Execution Channel |

这条内部通道是合并产品的运行时协议，不是可选扩展协议。对用户来说，安装后端和 Chrome 扩展后即应自动打通，不应再出现“安装 MCP 包”、“填写 MCP 配置”或“手动重连 browser server”步骤。

## 2. 角色

| 角色 | 主要目标 |
|---|---|
| Web 开发者 | 携带页面可视上下文发起任务，并在页面中验证结果 |
| TUI 开发者 | 在终端中处理工程任务，并绑定已连接页面进行标记和浏览器验证 |
| 跨端用户 | 在 Web 和 TUI 之间切换，不丢失会话和当前任务状态 |
| AI Agent | 在统一的权限和工具边界下读代码、修改文件、执行命令并验证页面 |
| 本地环境管理者 | 配置模型、密钥、工作区、权限和后端运行状态 |

## 3. P0 用户故事：必须完成

### Story 1：一次启动，Web 和 TUI 共用后端

> 作为开发者，我希望只启动一个本地后端，Web 和 TUI 都能连接它，而不是各自启动一套 Agent。

**验收标准：**

- Backend Daemon 拥有唯一的 session registry 和 agent runtime。
- Backend Daemon 启动时同时加载工作区工具和浏览器内置工具，不要求用户安装 browser MCP。
- Web 和 TUI 连接时先完成协议版本与能力握手。
- 两个客户端看到的会话 ID、模型、状态和更新时间一致。
- 后端未启动或版本不兼容时，客户端显示可执行的错误信息。

### Story 2：在任意界面创建和恢复会话

> 作为开发者，我希望在 Web 或 TUI 创建会话，也能从另一个界面打开它继续工作。

**验收标准：**

- 会话包含稳定 ID、标题、工作目录、模型、权限模式和时间信息。
- Web 和 TUI 使用同一个会话列表，支持新建、打开、重命名、归档和删除。
- 会话列表、消息和工具记录直接来自 Backend session store，不存在 displaySessionId 与 agentSessionId 映射。
- 恢复后能重建消息、tool call、当前状态和已完成 turn。
- Web localStorage 或 TUI 本地文件只能保存草稿、展开状态等客户端偏好，不保存历史会话副本。

### Story 3：发送文本、Markdown 和图片消息

> 作为开发者，我希望同一条消息可以包含文本、Markdown、截图和普通图片，并保留我组织它们的顺序。

**验收标准：**

- 后端使用结构化 content parts 保存 text、image 和其它媒体，不把图片降级为文本占位符。
- Web 编辑器在输入区上方显示待发送图片，可预览、删除和调整顺序。
- TUI 支持通过本地路径附加图片，并明确显示附件状态。
- Web 安全渲染 Markdown 中的标题、列表、表格、引用、链接、行内代码和代码块。
- TUI 用终端可表达的形式呈现同一份 Markdown，不改写后端保存的原始内容。
- 会话恢复后，Markdown 结构、图片顺序和图片尺寸信息不丢失。

### Story 4：实时看到 Agent 执行过程

> 作为开发者，我希望在 Web 或 TUI 中实时看到回答、思考、工具调用和任务结果，而不是等到整个任务结束。

**验收标准：**

- 统一事件至少覆盖 turn start/end、text delta、thinking delta、tool start/update/result、warning 和 error。
- 每个事件带有 sessionId、turnId、eventId/序号和时间。
- Web 和 TUI 可以不同形式渲染事件，但不各自推断另一套任务状态。
- 工具失败不能被显示为已完成；turn 结束时不能遗留无状态的工具卡片。

### Story 5：断线重连后继续当前任务

> 作为开发者，我希望刷新 Web、重开 TUI 或短暂断线后，能恢复当前任务，不重复显示事件，也不重复执行工具。

**验收标准：**

- 客户端可以带 lastEventId 订阅会话。
- 后端重放缺失事件，客户端按 eventId 去重。
- UI 关闭不默认取消后端 turn。
- 后端重启后，未完成 turn 被明确标记为 interrupted，不伪装成仍在执行。

### Story 6：在任意界面取消任务

> 作为开发者，我希望可以从当前使用的 Web 或 TUI 取消正在执行的任务。

**验收标准：**

- cancel 按 sessionId + turnId 定位，并传递到模型流、工具和子进程。
- cancel 是幂等操作，重复请求不产生额外副作用。
- 所有已连接界面都收到一致的 cancelled/turn ended 结果。

### Story 7：完成工作区代码任务

> 作为开发者，我希望 Agent 无论从 Web 还是 TUI 收到任务，都能在同一工作区中读写文件、搜索代码、执行命令和运行验证。

**验收标准：**

- workDir 由后端 session 固定，客户端不能在单次工具调用中绕过边界。
- 文件、命令和搜索工具只保留一套实现。
- 工具的输入、输出、错误、耗时和取消状态都作为统一事件记录。
- 高风险写操作和命令遵守 session 权限模式。

### Story 8：对高风险操作进行审批

> 作为开发者，我希望 Agent 遇到需要确认的操作时，Web 和 TUI 都能显示清晰的审批请求，且只执行一次我的决定。

**验收标准：**

- 审批包含工具名、操作摘要、风险说明、关键参数和可选决定。
- 优先通知发起 turn 的界面，其它已连接界面可观察等待状态。
- 后端只接受第一个有效决定，并向所有界面广播结果。
- 无可用界面时任务暂停等待，不默认批准。

### Story 9：通过内置浏览器工具操作和验证页面

> 作为 Web 或 TUI 开发者，我希望在绑定页面后，我和 Agent 都能直接使用产品内置的浏览器工具，而不需要安装或配置 MCP。

**验收标准：**

- 浏览器工具由 Backend 内置注册，与文件、命令工具使用同一调度、权限、事件和取消机制。
- 安装产品所需的后端和 Chrome 扩展后，浏览器执行通道自动连接；不存在额外的 MCP package、server config 或重连管理界面。
- Web 可绑定当前页面；TUI 可列出 Backend 已连接的页面并由用户选择绑定。
- 浏览器工具只操作已显式绑定到 session 的 tab。
- Agent 不通过 URL 猜测 tab，也不在 tool arguments 中自由传入 tabId/clientId。
- 支持页面 snapshot、可见区截图、console、reload、click、fill/type、press key、wait、assert 和 `run_actions`。
- 截图不把大块 base64 直接塞入工具文本结果，而是作为可引用的媒体资源传递。
- Browser Runtime 不在线、tab 关闭或页面权限不足时，Web、TUI 和 Agent 收到同一结构化错误，Agent 可降级继续。

### Story 10：从 Web 或 TUI 发起元素标记

> 作为 Web 或 TUI 开发者，我希望进入页面选择模式，在浏览器中点选元素，再把标记、批注和截图作为统一上下文发给 Agent。

**验收标准：**

- Web 可从当前页面直接开启选择模式；TUI 可向已绑定页面发送“开始选择元素”请求。
- Browser Runtime 在已绑定 tab 中显示选择 overlay，用户点选后，结果回到发起请求的 session 和界面。
- 用户标记由 Backend 生成稳定 targetId，并按 session/page 归属和持久化；Web 和 TUI 使用同一标记列表。
- 消息可包含标记元素的 selector、可访问性信息、文本、bounding box、computed style 摘要和用户批注。
- 标记和截图与用户消息原子绑定，不会错配到下一条消息。
- 发送成功后清空待发送上下文；发送失败时保留，便于重试。
- 恢复会话时可重建当时发送的上下文，但不将历史标记误当作当前 tab 中仍然有效的元素。

### Story 11：集中管理模型和密钥

> 作为开发者，我希望只在后端配置一次模型和密钥，Web 和 TUI 使用相同的可用模型列表。

**验收标准：**

- API key 仅保存在后端本地安全存储中，不返回 Web 或 TUI。
- 客户端只获取脱敏后的 provider/model 能力信息。
- 会话可切换模型和 thinking level，切换结果向所有界面同步。
- 配置变更失败时保留上一份可用配置。

### Story 12：后端直接承载历史会话与媒体资源

> 作为开发者，我希望退出 Web、TUI 甚至重启电脑后，仍能找回会话、图片和执行记录。

**验收标准：**

- Backend session store 同时是会话列表、上下文、消息、tool call、turn 和执行记录的唯一真源。
- Backend 直接扩展原生 session schema，使其承载 content parts、Markdown 原文、媒体引用、页面绑定、用户标记和工具状态，不在 UI 侧另建存储补字段。
- Web 和 TUI 通过 Backend API 直接查询和恢复历史，不在运行时合并两个数据库的记录。
- 图片、截图和工具产物使用稳定的 resource ID 与元数据存储。
- 删除会话时明确处理关联资源，不留下不可见的孤儿数据。
- 如果需要保留已有 DevTailor 历史，首次启动时使用幂等迁移器将旧记录转换为 Backend 原生 session records；成功后不再读写旧存储。
- 历史迁移保留会话 ID（可兼容时）、标题、时间、消息顺序、Markdown、图片引用和工具结果，并产生可检查的迁移报告。

## 4. P1 用户故事：完整体验

### Story 13：在 Web 和 TUI 之间无缝接力

> 作为跨端用户，我希望在 Web 发起任务后打开 TUI 继续，或在 TUI 中修改代码后回到 Web 验证页面。

**验收标准：**

- 另一界面打开会话时，立即看到当前 turn 和最新事件。
- 同一 session 同一时刻只有一个主动 turn；新输入被明确排队、steer 或拒绝。
- 后端记录 turn 的发起界面，但不把会话永久锁定给某个界面。
- 任一界面的只读观察不影响任务执行。

### Story 14：Agent 在缺少信息时向用户提问

> 作为开发者，我希望 Agent 遇到会改变实现方向的缺失信息时暂停并提问，我可以在 Web 或 TUI 回答。

**验收标准：**

- 问题支持单选、多选和自由输入。
- 问题、选项、说明和答案使用统一结构传输。
- 只有第一份有效回答能恢复 Agent。
- 问题在断线重连后仍保持 pending，除非 turn 已取消或超时。

### Story 15：管理会话分支与导出

> 作为开发者，我希望在保留原会话的前提下尝试另一种方案，并能导出会话用于调试或分享。

**验收标准：**

- 支持从指定会话创建 fork，两者之后独立持久化。
- 支持导出消息、工具记录、会话元数据和可选诊断日志。
- 导出默认对密钥、token 和敏感参数脱敏。

### Story 16：在两种界面中查看后台任务

> 作为开发者，我希望查看 Agent 启动的长时间命令或子任务，读取最新输出并在必要时停止它。

**验收标准：**

- Web 和 TUI 显示同一份后台任务列表与状态。
- 支持读取输出 tail、查看输出文件路径和请求停止。
- 后端重启后不能将已丢失的进程继续标记为 running。

### Story 17：选择和管理可选扩展能力

> 作为高级用户，我希望 Web 和 TUI 看到相同的可选 Skills、Plugins 和第三方 MCP 服务器，并了解它们对当前 session 是否可用。

**验收标准：**

- 能力列表由后端返回，客户端不自行扫描本地目录。
- 内置 Browser Tools 不归入扩展能力，不依赖 Plugin 或 MCP 启用状态。
- 启用、禁用、重连和重载结果向所有界面同步。
- 能力不可用时显示原因，不向 Agent 广告无法执行的工具。

## 5. P2 用户故事：后续增强

### Story 18：远程访问本地后端

> 作为开发者，我希望在另一台设备的 Web 界面中查看或接管本地任务。

**验收标准：**

- 远程监听默认关闭，用户需要显式开启。
- 开启后必须有身份验证、TLS 或受信代理，且有可见的连接客户端列表。
- 远程界面的文件、命令和浏览器操作权限可独立限制。

### Story 19：会话搜索与任务汇总

> 作为开发者，我希望按项目、时间、标题和关键字找到历史会话，并快速了解完成了什么。

**验收标准：**

- 搜索基于后端持久化数据，Web 和 TUI 结果一致。
- 搜索摘要不泄露已脱敏或受限内容。
- 会话汇总与原始消息分开存储，不覆盖完整历史。

## 6. 合并后功能全景

| 功能域 | Backend | Web | TUI | Browser Runtime |
|---|:---:|:---:|:---:|:---:|
| 会话创建、恢复、分支、导出 | 真源 | 操作/展示 | 操作/展示 | — |
| 历史消息、turn、tool call | 唯一存储 | 查询/渲染 | 查询/渲染 | — |
| Agent loop、compaction、memory | 唯一实现 | — | — | — |
| 流式回答与工具事件 | 生成/持久化 | 渲染 | 渲染 | 回传执行结果 |
| Markdown | 保存原文 | 安全 HTML 渲染 | 终端渲染 | — |
| 图片/截图 | 资源存储 | 预览/上传 | 路径附加/查看 | 页面截图 |
| 工作区文件和命令 | 执行/审计 | 状态展示 | 状态展示 | — |
| 权限审批/用户提问 | 仲裁/暂停 | 交互 | 交互 | — |
| 模型和凭据 | 配置/脱敏 | 选择 | 选择 | — |
| 页面绑定与用户标记 | 真源/关联 session | 绑定/选择/展示 | 绑定/发起选择/展示 | 上报页面/执行 overlay |
| DOM、console、截图 | 内置工具/路由 | 调用/展示 | 调用/展示 | 执行 |
| click/fill/reload/run_actions | 内置工具/调度 | 调用/进度展示 | 调用/进度展示 | 执行 |
| 断线重连/事件重放 | 序列化/去重 | 恢复 | 恢复 | 重连后重新声明 tab |

## 7. 首版非目标

- 不把 Web 和 TUI 做成两个独立 Agent 产品。
- 不同时保留 DevTailor Runtime 和 Scream Runtime 两套模型循环。
- 不保留 DevTailor display session store 与 Backend agent session store 的双写、双读或长期映射层。
- 不默认开放局域网或公网访问。
- 不以 URL 猜测需要操作的浏览器 tab。
- 不把内置 Browser Tools 包装成需要用户额外安装、配置或保活的 MCP server。
- 不将 Chrome Browser Runtime 变成会话、工具定义、权限或持久化的第二真源。
- 不在首版实现多用户云端协作、计费或跨租户隔离。

## 8. P0 发布验收场景

P0 完成需要同时通过以下端到端场景：

1. Backend 首次启动时将已有 DevTailor 历史会话迁移为原生 session records，Web 和 TUI 直接看到同一份结果。
2. 用户在 Web 选中元素，附加图片和 Markdown 描述后发送任务。
3. Backend 创建 turn，Web 实时显示文本、思考和工具调用。
4. Agent 修改工作区文件，完成必要的权限审批。
5. 用户打开 TUI 恢复同一 session，能看到已有消息和当前 turn，也能看到已绑定页面与用户标记。
6. 用户从 TUI 发起元素选择，Chrome 中的已绑定页面进入选择模式，选中结果回到同一 session。
7. Agent 使用 Backend 内置 Browser Tools 刷新已绑定 tab，执行页面断言并返回截图；过程中无 MCP 安装或配置步骤。
8. 用户刷新 Web，客户端通过 eventId 恢复，无重复消息和工具卡片。
9. 任务结束后，Web 和 TUI 显示一致的最终状态；重启 Backend 后仍能恢复会话和媒体资源。
