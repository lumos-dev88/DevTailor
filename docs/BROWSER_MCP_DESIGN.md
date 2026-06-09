# DevTailor Browser MCP — 用户故事与技术选型

## 一、定位

Browser MCP 不是把 DevTailor 做成通用浏览器自动化平台，但也不应该把页面操作限制得过死。

它的主轴是：

- 用户仍然通过 DevTailor 面板标记元素、截图、描述问题。
- Bridge 仍然负责把当前这一次请求转给 ACP agent。
- Browser 能力补齐一个短板：AI 修改代码后，可以在用户当前开发页面里查看状态、刷新、点击、输入少量文本，并截图确认，而不是完全依赖用户手动操作和描述渲染结果。

换句话说，它是"当前 DevTailor 工作流的浏览器操作层"。它可以参考 Nanobrowser 这类本地浏览器 agent 的实用取向：操作在用户本机浏览器中发生，默认面向开发环境，权限边界主要放在当前会话 tab 上，而不是把每个点击都设计成重审批。

---

## 二、用户故事

### Story 1: 发送上下文后，AI 能看当前可见区域

> 作为前端开发者，我已经在页面上标记了问题区域，并发送给 AI。AI 改完代码后，我希望它能获取当前 tab 的可见区域截图，确认页面大体是否变成预期，而不是让我再手动截图发一次。

**Acceptance Criteria:**
- 只截图当前 DevTailor 会话绑定的 tab。
- 默认只截可见区域，不做 full page。
- 截图时隐藏 DevTailor 面板，避免把调试 UI 带进上下文。
- 截图失败时返回明确错误，不影响正常聊天流程。

### Story 2: AI 能读取当前页面的基础状态

> 作为前端开发者，我让 AI 修复一个交互问题。AI 修改后，我希望它能读取当前 URL、标题、viewport、选中元素的 bounding box 等基础信息，辅助判断问题是否还存在。

**Acceptance Criteria:**
- 能读取当前 tab 的 URL、title、viewport。
- 能基于已有标记 selector 读取元素是否存在、尺寸、位置、可见性。
- 只读页面状态，不默认执行会改变业务状态的脚本。

### Story 3: 控制台错误作为调试线索

> 作为前端开发者，AI 修改后页面报错。我希望 DevTailor 能把最近的 console error/warn 提供给 AI，减少我复制粘贴错误的次数。

**Acceptance Criteria:**
- 能返回最近的 error/warn 日志和时间。
- 日志数量有上限，避免把大量噪声塞进上下文。
- 扩展刷新或页面重载后，日志丢失是可接受的。

### Story 4: 刷新后允许页面操作恢复状态

> 作为前端开发者，我让 AI 修改代码后，经常需要刷新页面，再点击登录、继续、展开面板、切换 Tab，或者输入测试账号，页面才回到我要验证的状态。这个页面本来就是开发调试环境，我希望 AI 能直接操作当前页面完成恢复，而不是因为过细的限制导致工具难用。

**Acceptance Criteria:**
- P0 仍以只读和截图为主。
- P1 支持 `reload_page`、`click_page`、`fill_text`、`type_text`，用于刷新后的状态恢复。
- 点击可以使用 selector、文本、role/label/nearText locator、坐标或已有标记元素，降低工具调用和实现复杂度。
- 输入文本可以用于开发环境登录、搜索、筛选、表单触发等轻量验证场景。
- 硬边界：页面动作必须作用于当前 DevTailor 会话绑定的 tab，不能跨 tab 或猜 tab。
- 页面动作失败时只反馈错误，不自动重试一串不可见操作。

### Story 5: 不增加用户安装负担

> 作为 DevTailor 用户，我已经安装扩展并启动 Bridge，不希望再研究 chrome-devtools-mcp、远程调试端口、targetId 匹配这些额外配置。

**Acceptance Criteria:**
- 不要求用户额外安装 MCP 包。
- 不要求用户用远程调试模式启动 Chrome。
- 如果扩展或 bridge 不在线，给出清晰的降级提示。

### Story 6: AI 在当前页面执行一批操作并确认结果

> 作为 AI，我在帮用户完成任务时，如果需要在当前页面执行多个操作并验证结果——例如验证四个优先级、测试表单边界——我可以调用 run_actions，把操作步骤和断言一次性执行完，失败时得到精确的失败原因，而不是重复单步调用或依赖截图判断。

**Acceptance Criteria:**
- 操作只作用于当前 DevTailor 会话绑定的 tab。
- 支持 click、fill、type、press_key、clear_state、reload、wait、wait_for_selector、wait_for_text、screenshot、assert 步骤自由组合。
- 断言失败时立即抛出，记录失败步骤、期望值、实际值。
- action 内部按 steps 顺序执行；某个 step 失败时当前 action 立即停止。
- 某个 action 失败后继续执行剩余 actions，不中断整体。
- 执行结束后返回摘要：每个 action 的执行结果、失败详情、截图。
- 临时执行，不持久化为项目文件。
- 不是测试框架，不替代 Playwright/Cypress。

---

## 三、需求提炼

| 需求 | Story | 优先级 | 说明 |
|---|---|:---:|---|
| 截图当前 tab 可见区域 | 1 | P0 | 复用现有截图能力，默认隐藏 DevTailor UI |
| 读取当前页面基础信息 | 2 | P0 | URL、title、viewport、标记元素状态 |
| 读取最近 console error/warn | 3 | P1 | 作为调试辅助，不追求完整 DevTools 能力 |
| reload 当前页面 | 4 | P1 | 用于修改后刷新验证 |
| 点击当前页面 | 4 | P1 | 支持 selector、文本、坐标、标记元素，用于恢复验证状态 |
| 输入文本 | 4 | P1 | 支持当前页面轻量输入，用于开发登录、搜索、筛选 |
| 请求用户协助 | 4 | P1 | 工具无法恢复状态时弹出对话框，让用户操作后继续任务 |
| 批量执行页面操作并确认结果 | 6 | P1 | click/fill/type/reload/wait/screenshot/assert 自由组合，失败不中断 |
| hover 当前页面 | 4 | P2 | 用于验证 tooltip、菜单、浮层等 hover 交互 |
| navigate / 长链路动作 | 4 | P2 | 可做但不作为首轮主线 |
| 零额外 MCP 依赖 | 5 | P0 | 保持扩展 + Bridge 的轻量使用路径 |

非功能性需求：

- **当前 tab 优先**：所有 browser tool 都绑定到当前 DevTailor 会话的 `clientId`，不做全局"找一个相似 URL 的 tab"。
- **操作可用，权限分层**：P0 能力以读取和截图为主；P1 允许点击、输入、批量操作当前开发页面；P2 才考虑导航、长链路动作。
- **可降级**：扩展刷新、页面未注入、权限不足时，返回结构化错误，让 AI 回到普通文本协作。
- **不扩大上下文**：tool 结果要短，图片按需返回，console 日志有数量限制。

---

## 四、技术方案对比

### 方案 A: Bridge 内嵌 Browser MCP（推荐）

Bridge 暴露一个偏实用的 browser tool 集合。Claude Code 通过 MCP 调用 Bridge，Bridge 通过现有 SSE 通道请求当前 DevTailor tab 执行截图、读取、点击或输入，扩展再把结果 POST 回 Bridge。

```text
Claude Code ──MCP──> Bridge ──SSE──> Extension ──> 当前 tab
     ^                                      |
     └──────────── tool result POST ───────┘
```

**Pros:**
- 不需要额外 MCP 包或 Chrome 远程调试端口。
- 直接使用用户正在看的 tab，符合 DevTailor 的"当前页面标记"模型。
- 复用现有 `clientId -> ACP session` 绑定，不需要重新设计页面身份。
- 能力足够覆盖开发调试常见闭环，不需要用户反复手动恢复页面状态。

**Cons:**
- Bridge 需要维护 MCP tool call 与扩展回包的 requestId。
- 扩展刷新、页面关闭、权限不足都需要明确错误处理。
- 不能获得完整 DevTools 能力，这是有意取舍。

### 方案 B: 使用 chrome-devtools-mcp

Bridge 在 ACP session 中注册外部 `chrome-devtools-mcp`，让 agent 通过 CDP 操作浏览器。

**Pros:**
- DevTools 能力完整，console/network/storage/performance 都可读。
- 不依赖内容脚本是否注入。

**Cons:**
- 用户安装和启动成本高。
- 需要远程调试端口，和扩展的轻量路线冲突。
- target/tab 归属容易偏离当前 DevTailor 会话。
- 能力过宽，容易把产品带向通用浏览器 agent。

### 方案 C: 扩展作为独立 MCP Server

扩展自己提供 MCP server，Claude Code 直接连接扩展。

**Pros:**
- 概念上最直接。

**Cons:**
- content script 不能监听 TCP 端口。
- 需要 native messaging 或额外宿主程序，复杂度高于收益。

---

## 五、技术选型决策

**选择方案 A：Bridge 内嵌 Browser MCP，按能力分层放权**

决策理由：

1. **贴合当前主轴**：DevTailor 的核心仍是"标记/截图/描述 -> AI 修改代码"，browser tool 负责把当前开发页面恢复到可验证状态并反馈结果。
2. **最少用户负担**：不引入远程调试端口、额外 MCP 包、额外浏览器启动方式。
3. **会话边界清晰**：沿用现有 `clientId` 和 ACP session 绑定，避免操作错 tab。
4. **渐进增强**：先做截图和只读状态，再加入点击、输入、console、reload 等开发调试高频能力。

---

## 六、项目骨架

核心原则：**Browser tools 永远操作当前 DevTailor 会话 tab，AI 不传 tabId、clientId、pageUrl。**

这点参考 Nanobrowser 的使用感：用户在当前浏览器上下文里发起任务，agent 专注页面本身，不需要在每次工具调用里携带浏览器目标信息。DevTailor 的差异是它不做全局网页任务，而是绑定到"当前打开 DevTailor 面板的开发页面"。

### 目录规划

```text
devtailor-bridge/src/
  index.ts
  ws-server.ts
  acp-session.ts
  prompt-builder.ts
  types.ts
  browser-mcp-server.ts       # MCP tool 定义、initialize/list/call
  browser-action-router.ts    # tool call -> 当前 client SSE action
  browser-action-types.ts     # browser action request/result 类型

content/modules/
  ws-client.js                # 继续负责 SSE 接收和 POST 回传
  browser-actions.js          # 执行 screenshot/snapshot/reload/click/type/fill/run_actions
  browser-action-dom.js       # DOM 定位、轻量 locator、文本匹配、坐标点击、输入辅助
  browser-console.js          # P1: 缓存 console error/warn
  screenshot.js               # 现有截图能力，可被 browser-actions 复用
```

### 运行时数据流

```text
用户当前 tab 打开 DevTailor
  -> content script 建立 SSE: /events?clientId=tab_xxx
  -> 用户点击「连接当前页」或已接管 tab 刷新重连
  -> Bridge 记录 activeClientId = tab_xxx
  -> Claude Code 调 browser tool，例如 get_page_snapshot({})
  -> Claude Code 使用 snapshot 和 locator，例如 click_page({ role: "button", text: "登录" })
  -> Browser MCP Server 不要求 tab 参数
  -> Bridge Action Router 发 SSE browser_action 到 activeClientId
  -> content/modules/browser-actions.js 操作当前页面
  -> ws-client.js POST browser_action_result 回 Bridge
  -> Bridge resolve MCP tool result
```

### 当前 Tab 上下文

Bridge 维护一个当前 browser context：

```ts
interface BrowserContextState {
  activeClientId: string | null
  activeProjectId: string | null
  activeSessionId: string | null
  lastSeenAt: number
}
```

更新规则：

- `/events?clientId=...` 建立连接只表示 tab 在线；新 tab 不自动抢占 active。
- `/activate` 是显式接管入口，成功后设置 `activeClientId` 并广播状态。
- `/review` 要求请求来自当前 active tab；不活跃 tab 会收到 409，提示点击「连接当前页」。
- 当前已接管 tab 刷新重连时保持 active ownership。
- 会话加载/删除后，Bridge 会把操作发起 tab 与新的 display session 状态同步。
- Browser tool 调用不接收 `clientId`、`tabId`、`pageUrl`。
- 如果没有 active client，tool 返回 `NO_ACTIVE_TAB`。

这样 AI 的调用面保持干净：

```ts
get_page_snapshot({})
click_page({ elementId: "e_3" })
fill_text({ role: "textbox", label: "邮箱", text: "demo@example.com" }) // 稳定填表，默认替换字段值
type_text({ elementId: "e_5", text: " - extra", mode: "append" }) // 需要追加时显式声明
take_visible_screenshot({})
```

而不是：

```ts
click_page({ clientId: "tab_123", pageUrl: "http://localhost:5173", text: "登录" })
```

### Bridge 模块职责

| 模块 | 职责 |
|---|---|
| `browser-mcp-server.ts` | 对 ACP/Claude Code 暴露 browser tools，做参数校验、超时、结果包装 |
| `browser-action-router.ts` | 找到当前 active client，通过 SSE 下发 `browser_action`，等待 result |
| `browser-action-types.ts` | 共享 action/result 类型，避免散落字符串 |
| `ws-server.ts` | 复用现有 SSE 连接，增加 `browser_action_result` 接收入口 |
| `acp-session.ts` | session 创建时注册 Browser MCP；不把 frontend history 当上下文 |
| `background/service-worker.js` | 通过 `chrome.scripting.executeScript` 在当前 sender tab 执行 `run_js`，保持 Claude in Chrome 式真实浏览器执行路径 |

### Extension 模块职责

| 模块 | 职责 |
|---|---|
| `ws-client.js` | 接收 `browser_action`，调用 `browserActions.handle(action)`，POST result |
| `browser-actions.js` | action 分发：截图、快照、reload、click、type/fill、console、run_actions |
| `browser-action-dom.js` | 页面元素定位和交互实现，支持 selector/text/role/label/nearText/elementId/point/markId |
| `browser-console.js` | 缓存最近 console message，供 `get_console_logs` / `get_console_message` 使用 |
| `screenshot.js` | 保持现有手动截图入口，同时提供可复用 capture visible tab 能力 |

### Action 消息格式

SSE 下行：

```ts
type BrowserActionEvent = {
  type: 'browser_action'
  requestId: string
  action: 'take_visible_screenshot' | 'get_page_snapshot' | 'reload_page' | 'click_page' | 'type_text' | 'fill_text' | 'press_key' | 'clear_state' | 'wait_for_selector' | 'wait_for_text' | 'get_console_logs' | 'get_console_message' | 'request_user_assistance' | 'run_actions' | 'run_js'
  params: Record<string, unknown>
}
```

Bridge-local actions 不走 SSE 往返：

```ts
type BridgeLocalBrowserAction =
  | 'get_element_targets'
  | 'save_element_target'
  | 'delete_element_target'
```

元素库是项目级全量库，`get_element_targets` 默认返回项目全量，不做当前页路径过滤。

HTTP 回传：

```ts
type BrowserActionResult = {
  requestId: string
  ok: boolean
  result?: unknown
  error?: {
    code: 'NO_ACTIVE_TAB' | 'EXTENSION_CONTEXT_INVALIDATED' | 'ACTION_TIMEOUT' | 'ELEMENT_NOT_FOUND' | 'ACTION_FAILED'
    message: string
  }
}
```

### DOM 操作策略

`get_page_snapshot` 是后续页面操作的入口。它应该尽量返回 AI 需要的元素摘要：

- 当前 URL、title、viewport。
- 最近 console 状态，至少包含 error/warn 计数。
- 可交互元素列表：`elementId`、locator recipes、role、accessible name、label、placeholder、testId、text、selector、rect、visible、disabled。
- 可见 portal surface：dialog、menu、listbox、tooltip、popover、Radix/Headless UI portal wrapper 等摘要，帮助 AI 在打开弹层后发现浮层上下文。
- 表单关系：label -> input、button type、form action/method、必填字段。
- 元素数量有上限，优先返回视口内、带 testId、具备 role/label 的可交互元素。
- 扫描范围覆盖当前 document、open shadow root，以及可访问的 same-origin iframe；跨域 iframe 只作为未来 CDP/权限增强项。

定位参数分两类：

- `selector` / `markId` 是精确定位，匹配失败必须报错。
- `elementId` 是 snapshot 产生的稳定 locator 句柄。它不绑定旧 DOM node，而是保存 locator recipes（testId、role/name、label、text、selector、path signature）和旧指纹；执行前必须重新解析当前 DOM 并校验旧指纹，不能因为列表重排而点到相似但错误的元素。
- `role`、`label`、`text`、`nearText`、`index` 是轻量 Locator 字段，类似 Playwright 的 locator 思路，但只在当前页面临时解析，不保存为测试文件。

`click_page` 的定位优先级：

1. `selector`
2. `markId`
3. `role/label/text/nearText/index` locator
4. `elementId`（通过指纹校验后才可用）
5. `text`
6. `point`

`type_text` / `fill_text` 的定位优先级：

1. `selector`
2. `markId`
3. `role/label/text/nearText/index` locator
4. `elementId`（通过指纹校验后才可用）
5. `point`
6. 当前 `document.activeElement`

实现上保持直接：

- selector 使用 `document.querySelector`。
- elementId 来自最近一次 `get_page_snapshot` 的 `interactiveElements`，刷新、重排或重渲染后只在指纹仍然匹配时复用；否则显式失败，提示重新 snapshot 或使用稳定 locator。
- text 使用可见文本近似匹配，优先 button、a、input、textarea、select、role=button、tab。
- point 使用 `document.elementFromPoint(x, y)`。
- click 会先 `scrollIntoView`，再用中心点和边缘候选点做 hit-test；如果命中点不在目标元素内，直接失败，避免 silent fallback。
- click 的可靠性参考 Playwright 的 actionability 模型：执行前等待元素可见、启用、布局稳定、点击点可接收事件；失败时返回 target、hit element、viewport、URL 等诊断信息，帮助 AI 改用更稳定的 locator。
- click 返回 `clicked: true` 只代表动作已派发，不代表业务结果已满足；需要用 `wait_for_text`、`wait_for_selector` 或 assert 步骤验证预期结果。若点击后短时间内没有 URL、focus、文本长度或 DOM mutation 变化，会返回 warning。
- `fill_text` 用于稳定填表：设置 input/textarea/contenteditable/role=textbox 的值并派发 input/change，默认 blur。
- `run_actions` 的 `fill` step 默认不 blur，方便后续 `press_key` 继续作用在同一个输入框；需要结束编辑态、清理输入选区/文本选区、触发 blur 校验、保存 on-blur 或关闭临时浮层时，显式 `blurAfter: true` 或追加 `clear_state` step。
- `type_text` 用于需要键盘行为的场景：支持 submitKey，默认替换，必要时可 blurAfter。

### `run_js` 执行策略

`run_js` 采用 Claude in Chrome 式扩展注入路径，而不是 content script 动态插入 inline script：

```text
AI -> Browser MCP run_js -> Bridge -> 当前 tab content script
   -> chrome.runtime.sendMessage(EXECUTE_RUN_JS)
   -> background/service-worker.js
   -> chrome.scripting.executeScript({ target: sender.tab, world })
```

设计约束：

- AI 不传 tabId、clientId、pageUrl；background 使用 `sender.tab.id`，始终作用于当前 DevTailor 会话 tab。
- 默认 `world: "MAIN"`，用于读取页面运行时全局变量、框架 store、页面侧函数等。
- 可选 `world: "ISOLATED"`，更适合只读 DOM、localStorage、sessionStorage、computed style 这类不需要页面 JS globals 的场景。
- `run_js` 仍然不是 DevTools Protocol。严格 CSP / unsafe-eval 页面可能影响 MAIN world 下的动态函数执行；如果要获得 DevTools console 等级的任意 JS 能力，应作为未来可选 CDP 后端，而不是默认架构。
- 结构化页面验证优先使用 `get_page_snapshot`、`click_page`、`fill_text`、`type_text`、`press_key`、`wait_for_selector`、`wait_for_text`、`get_console_logs` 和 `run_actions`，`run_js` 只作为调试兜底。

### Prompt 规则

Browser tools 对 AI 暴露时，需要明确：

- Browser tools 是按需使用的辅助能力，不是固定 checklist。提示词应引导 AI 使用能消除当前不确定性的最小工具集，避免为了流程完整而额外调用 snapshot、run_actions、run_js 或截图。
- 需要浏览器验证时，平衡节奏是：页面结构未知才用 `get_page_snapshot`；多步骤流程或边界验证才用 `run_actions`；复杂 DOM / Portal / 内部状态才用 `run_js`；只有视觉布局确实需要确认或用户要求时才用 `take_visible_screenshot`。
- `get_page_snapshot` 是优先级排序后的页面摘要，不是完整 DOM dump；它尽量覆盖 document、open shadow root、同源 iframe 和可见 portal surface，但不保证 closed shadow root 或跨域 iframe。
- 你正在操作当前 DevTailor 页面，不需要传 tab、URL、clientId。
- 需要点击或输入且页面结构不明确时，用 `get_page_snapshot` 获取页面结构；如果已有稳定 selector、testId、role/label 或明确 mark，就不必为了例行流程先 snapshot。动态列表重排后重新 snapshot，或者使用 testId、role/label、nearText、fresh elementId 这类稳定 locator。
- `elementId` 是 snapshot 产生的稳定 locator handle，不是永久 DOM id；reload 或大规模 DOM 变化后应重新 snapshot。
- 当需要在当前页面执行多个操作（恢复状态、验证表单、批量验证）时，可以使用 `run_actions` 一次性执行；简单单步操作或即时检查不要硬凑批量流程。
- `run_actions` 中 `click`、`type`、`fill`、`assert_element` step 必须显式传 locator（selector、elementId、markId、text、role、label、testId、nearText 或 point）；某个 step 失败会停止当前 action，但后续 action 继续。
- 动态弹窗、延迟渲染、异步校验出现前，优先使用 `wait_for_selector` 或 `wait_for_text`，避免盲点坐标或复用过期 elementId。
- Radix UI / Portal / Popover 内容可能挂到 `document.body` 下，初始 snapshot 可能看不到；打开弹层后先 `wait_for_text` / `wait_for_selector`，必要时用 `run_js` 查询 `document.body`。
- 文本点击是便利 fallback，复杂列表或重复文案优先使用 testId、role/label、nearText、fresh elementId 或稳定 selector；不要假设 text 一定命中文本叶子节点。
- 表单填值优先 `fill_text`；需要验证 Enter、Tab、快捷键或真实键盘提交时再用 `type_text` / `press_key`。
- 键盘交互优先使用 `press_key` 或 `run_actions` 的 `press_key` step；不要在 `run_js` 里手写 KeyboardEvent 来模拟 React 提交。
- `run_js` 是诊断兜底，不是常规交互入口；可用于读 store/localStorage/sessionStorage、computed style、Portal DOM 或自定义异步条件，不要用它替代普通 click/fill/type/press_key。
- 修改代码后，只有运行时行为或 UI 状态需要验证时才调用 browser tools。优先用文本、URL、元素存在性、console 等结构化断言确认；只有需要视觉检查时才调用 `take_visible_screenshot`，避免图片结果挤占上下文。
- 如果工具在少量清晰尝试后仍无法恢复或验证页面状态，调用 `request_user_assistance` 弹出对话框，请用户协作到具体状态，例如登录、打开某个路由、点击某个控件或确认当前屏幕；用户点"已完成"后继续验证。
- 这是开发环境工具，可以点击和输入当前页面以恢复验证状态。

---

## 七、Tool 设计

### P0 Tool 设计

```typescript
interface DevTailorBrowserTools {
  take_visible_screenshot: {
    params: {
      hideDevTailor?: boolean
      grid?: boolean
      gridSize?: number
      gridLabels?: boolean
    }
    returns: { mimeType: 'image/png'; data: string }
  }

  get_page_snapshot: {
    params: {
      selectors?: string[]
      level?: 'summary' | 'interactive-only' | 'full'
      maxElements?: number
      roles?: string[]
      visibleOnly?: boolean
    }
    returns: {
      url: string
      title: string
      viewport: { width: number; height: number; devicePixelRatio: number }
      console: { errors: number; warnings: number }
      elements: Array<{
        selector: string
        exists: boolean
        visible?: boolean
        rect?: { x: number; y: number; width: number; height: number }
      }>
      interactiveElements: Array<{
        elementId: string
        role?: string
        name?: string
        label?: string
        placeholder?: string
        text?: string
        selector: string
        visible: boolean
        disabled: boolean
        rect: { x: number; y: number; width: number; height: number }
      }>
    }
  }

  get_element_targets: {
    params: {}
    returns: {
      targets: Array<{
        id: string
        targetId: string
        name: string
        description?: string
        pagePattern?: string
        pageUrl?: string
        selector?: string
        xpath?: string
        locatorRecipes?: Array<Record<string, unknown>>
        semantic?: Record<string, unknown>
        context?: Record<string, unknown>
        structure?: Record<string, unknown>
        visual?: Record<string, unknown>
        createdAt: string
        updatedAt: string
      }>
    }
  }

  save_element_target: {
    params: {
      name: string
      description?: string
      pagePattern?: string
      selector?: string
      xpath?: string
      locatorRecipes?: Array<Record<string, unknown>>
      semantic?: Record<string, unknown>
      context?: Record<string, unknown>
      structure?: Record<string, unknown>
      visual?: Record<string, unknown>
    }
    returns: { target: Record<string, unknown> }
  }

  delete_element_target: {
    params: { targetId?: string; targetName?: string }
    returns: { deleted: string }
  }
}
```

### P1 Tool 设计

```typescript
interface DevTailorBrowserToolsP1 {
  get_console_logs: {
    params: {
      types?: Array<'error' | 'warn' | 'log' | 'info' | 'debug' | 'verbose'>
      pageIdx?: number
      pageSize?: number
      includePreservedMessages?: boolean
      level?: 'error' | 'warn' | 'log' // backward-compatible alias
      limit?: number // backward-compatible alias for pageSize
    }
    returns: {
      messages: Array<{
        msgid: number
        type: string
        level: string
        message: string
        timestamp: number
        source?: string
        url?: string
        lineNumber?: number | null
        columnNumber?: number | null
        repeatCount?: number
        isCurrentNavigation: boolean
      }>
      pageIdx: number
      pageSize: number
      total: number
      includePreservedMessages: boolean
    }
  }

  get_console_message: {
    params: { msgid: number }
    returns: {
      message: {
        msgid: number
        type: string
        level: string
        message: string
        args?: string[]
        stack?: string
        timestamp: number
        source?: string
        url?: string
        lineNumber?: number | null
        columnNumber?: number | null
        isCurrentNavigation: boolean
      } | null
    }
  }

  reload_page: {
    params: { delayMs?: number }
    returns: { ok: boolean; url?: string; error?: string }
  }

  click_page: {
    params: {
      elementId?: string
      targetId?: string
      targetName?: string
      selector?: string
      markId?: string
      text?: string
      role?: string
      label?: string
      nearText?: string
      index?: number
      exact?: boolean
      point?: { x: number; y: number }
      grid?: string
      gridSize?: number
      waitAfterMs?: number
    }
    returns: {
      ok: boolean
      clicked?: boolean
      error?: string
      rect?: { x: number; y: number; width: number; height: number }
    }
  }

  type_text: {
    params: {
      elementId?: string
      targetId?: string
      targetName?: string
      selector?: string
      markId?: string
      role?: string
      label?: string
      nearText?: string
      index?: number
      exact?: boolean
      point?: { x: number; y: number }
      grid?: string
      gridSize?: number
      text: string
      mode?: 'replace' | 'append' // 默认 replace，避免输入框内容被意外追加
      submitKey?: 'Enter' | 'Tab'
      blurAfter?: boolean
      waitAfterMs?: number
    }
    returns: {
      ok: boolean
      typed?: boolean
      error?: string
      rect?: { x: number; y: number; width: number; height: number }
    }
  }

  fill_text: {
    params: {
      elementId?: string
      targetId?: string
      targetName?: string
      selector?: string
      markId?: string
      role?: string
      label?: string
      nearText?: string
      index?: number
      exact?: boolean
      point?: { x: number; y: number }
      grid?: string
      gridSize?: number
      text: string
      mode?: 'replace' | 'append'
      blurAfter?: boolean // 默认 true
      force?: boolean
      waitAfterMs?: number
    }
    returns: {
      ok: boolean
      filled?: boolean
      error?: string
      rect?: { x: number; y: number; width: number; height: number }
    }
  }

  request_user_assistance: {
    params: {
      message: string
      timeoutMs?: number
    }
    returns: {
      status: 'completed' | 'canceled' | 'timeout'
      completed: boolean
      elapsedMs: number
      url: string
      title: string
    }
  }

  run_actions: {
    params: {
      actions: Array<{
        label: string
        steps: Array<
          | { type: 'click'; targetId?: string; targetName?: string; elementId?: string; selector?: string; text?: string; role?: string; label?: string; nearText?: string; index?: number; exact?: boolean; point?: { x: number; y: number }; grid?: string; gridSize?: number }
          | { type: 'type'; targetId?: string; targetName?: string; elementId?: string; selector?: string; text: string; role?: string; label?: string; nearText?: string; index?: number; exact?: boolean; mode?: 'replace' | 'append'; grid?: string; gridSize?: number }
          | { type: 'fill'; targetId?: string; targetName?: string; elementId?: string; selector?: string; text: string; role?: string; label?: string; nearText?: string; index?: number; exact?: boolean; mode?: 'replace' | 'append'; blurAfter?: boolean; grid?: string; gridSize?: number } // run_actions 中默认 false，保留焦点
          | { type: 'press_key'; key: string; targetId?: string; targetName?: string; elementId?: string; selector?: string; text?: string; role?: string; label?: string; nearText?: string; index?: number; exact?: boolean; grid?: string; gridSize?: number }
          | { type: 'clear_state'; pressEscape?: boolean; clearSelection?: boolean } // 清理页面交互状态：焦点、输入/文本选区、hover/pointer 残留；必要时 Escape 关闭菜单/浮层
          | { type: 'reload' }
          | { type: 'wait'; ms: number }
          | { type: 'wait_for_selector'; selector: string; timeoutMs?: number }
          | { type: 'wait_for_text'; text: string; selector?: string; timeoutMs?: number }
          | { type: 'screenshot'; label?: string; grid?: boolean; gridSize?: number }
          | { type: 'assert_text'; text: string; selector?: string }
          | { type: 'assert_url'; pattern: string }
          | { type: 'assert_element'; targetId?: string; targetName?: string; elementId?: string; selector?: string; exists: boolean }
        >
      }>
      stepTimeoutMs?: number
    }
    returns: {
      results: Array<{
        label: string
        ok: boolean
        error?: {
          step: number        // 第几步失败（0-indexed）
          type: string        // 失败的 step type
          expected?: string   // 期望值
          actual?: string     // 实际值
          message: string
        }
        screenshots: Array<{
          label: string
          mimeType: 'image/png'
          filePath: string
          dataOmitted: true
        }>
      }>
    }
  }
}
```

暂不进入 P0：

- 任意 `evaluate_script`
- drag / drop 拖拽操作
- SPA 多路由巡检
- full page screenshot
- network/performance/storage 读取

这些能力不是不能做，而是需要 P2 再按真实需求收敛。

### 操作权限分层

| 层级 | 能力 | 默认策略 |
|---|---|---|
| P0 读取层 | 截图、页面快照、元素信息 | 直接允许，绑定当前会话 tab |
| P1 恢复层 | reload、click、fill、type、press_key、clear_state、wait_for_selector、wait_for_text、run_actions | 直接允许，面向开发页面状态恢复和验证 |
| P2 扩展层 | hover、navigate、history back/forward | 按真实需求收敛 |

实现上不要在 `click_page` 里做复杂语义拦截，例如判断按钮是不是"删除"。这会增加误判和开发成本。更合适的平衡点是：tool 只保证当前 tab 隔离和动作可观测，AI 行为规则只强调这是开发环境工具，默认服务当前页面调试。

---

## 八、多 Tab 隔离策略

按当前 DevTailor 会话绑定，不按 URL 猜测，不让 AI 传 tab 参数。

现有模型：

- content script 从 background 获取 Chrome `tabId`。
- frontend 生成 `clientId = tab_{tabId}`。
- Bridge 维护 `clientId -> ACP session`。

Browser tool 调用时，Bridge 必须知道当前 ACP session 对应的 active `clientId`，然后只向这个 `clientId` 的 SSE 连接下发 browser action。这个绑定是 bridge 内部状态，不暴露给 AI。

不推荐：

- "最近交互过的 tab"
- "按 URL 前缀匹配一个 tab"
- "让 AI 在 tool 参数里传 pageUrl 再匹配"

这些都会在多 localhost、多 tab、多项目场景下引入误操作风险。

---

## 九、实现计划

### Phase 1: 最小闭环

- [x] Bridge 增加 browser tool request/response 通道，支持 requestId 超时。
- [x] Bridge 增加 active browser context，只绑定当前已接管 DevTailor tab。
- [x] 扩展处理 `browser_action` SSE 消息。
- [x] 实现 `take_visible_screenshot`，复用现有截图模块。
- [x] 实现 `get_page_snapshot`，读取 URL、title、viewport、交互元素摘要。
- [x] Prompt 中只提示 AI 按需使用最小 browser tool 集合。
- [x] 实现项目级元素库：`get_element_targets`、`save_element_target`、`delete_element_target`。

### Phase 2: 调试辅助

- [x] content script 缓存最近 console message。
- [x] 实现 `get_console_logs` / `get_console_message`。
- [x] Bridge 对 browser action 做 requestId 匹配、超时和结构化错误包装。
- [ ] 评估 `hover_page`：hover 后读取 tooltip、菜单、浮层状态并截图验证。

### Phase 3: 页面操作与批量执行

- [x] 实现 `reload_page`。
- [x] 实现 `click_page`，支持 selector、markId、text、role/label/nearText locator、elementId、point，并做 actionability 校验。
- [x] 实现 `fill_text` / `type_text`，支持 selector、markId、role/label/nearText locator、elementId、point；填表和键盘行为分离。
- [x] 实现 `press_key`、`clear_state`、`wait_for_selector`、`wait_for_text`，覆盖键盘提交、编辑/选区状态清理、悬浮/长按态清理和动态弹窗等待。
- [x] 实现 `run_actions`，复用 click/fill/type/press_key/clear_state/reload/wait/wait_for_selector/wait_for_text/screenshot 单步能力，支持 assert 步骤；step 失败停止当前 action，继续后续 actions。
- [x] 页面动作默认用于"刷新后恢复验证状态"和轻量交互验证。
- [ ] 观察真实使用后再决定是否需要 navigate。
- [ ] 不实现 drag/drop；拖拽交互暂时废除，避免复杂度过高。

---

## 十、反目标

短期不做：

- 不做 Playwright/Cypress 替代品；只做当前 tab 的轻量操作验证。
- 不做跨路由自动巡检。
- 不做跨页面长链路自动化。
- 不做 drag/drop 拖拽自动化。
- 不做完整 DevTools 协议封装。
- 不暴露任意 `evaluate_script` 给 AI。
- 不把 frontend history 当成 agent 真实上下文。

这些反目标是为了让 Browser MCP 服务当前 DevTailor 产品主轴，而不是把复杂度提前拉满。
