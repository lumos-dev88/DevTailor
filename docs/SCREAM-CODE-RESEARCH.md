# Scream Code 0.6.2 改造调研报告

> **历史调研，不是当前架构**：本文保留 Scream Code 0.6.2 的旧方案记录。DevTailor 当前唯一后端是 Claude Code Channels，见 [`HANDOFF.md`](./HANDOFF.md)。

> **目标**：基于 scream-code 改造为纯后端 AI 引擎，去掉 TUI/Web 前端，由 DOM-Review 插件 UI 做交互层，去掉 ACP 协议，砍掉非必要功能。

---

## 一、架构拆解

### Monorepo 结构

```
scream-code-0.6.2/
├── apps/scream-code/          # 主应用（CLI + TUI）→ 整个砍
├── packages/
│   ├── agent-core/            # AI Agent 核心引擎 ★★★
│   ├── ltod/                  # LLM 抽象层 ★★★
│   ├── jian/                  # 文件系统/执行环境抽象 ★★
│   ├── node-sdk/              # 外部 SDK（ScreamHarness）★★
│   ├── config/                # 平台配置/身份 ★
│   ├── memory/                # 跨会话记忆存储 → 砍
│   └── migration-legacy/      # 旧版数据迁移 → 砍
```

### 各 Package 职责

| Package | 职责 | 保留？ |
|---------|------|:------:|
| **agent-core** | Agent loop、tool call、session 管理、MCP 连接、权限、compaction | ✅ 核心 |
| **ltod** | LLM Provider 适配（OpenAI/Anthropic/Google）、generate()、消息格式化 | ✅ 核心 |
| **jian** | 文件系统操作抽象（read/write/glob/exec/stat） | ✅ 核心 |
| **node-sdk** | ScreamHarness — 外部宿主调用 agent-core 的 SDK 门面 | ✅ 改造 |
| **config** | 平台身份、默认 headers | ✅ 精简 |
| **memory** | 跨会话记忆（embedding + FTS） | ❌ 砍 |
| **migration-legacy** | 旧版数据迁移 | ❌ 砍 |
| **apps/scream-code** | 终端 TUI | ❌ 整个砍 |

### 模块依赖图

```
ltod (LLM层)
 ↑
jian (文件系统) ←── agent-core (Agent引擎)
 ↑                  ↑
config ←────── node-sdk (SDK门面)
                     ↑
               DOM-Review 插件 UI（你的宿主）
```

---

## 二、TUI 层处理

**结论：整个 `apps/scream-code/` 目录砍掉，不保留任何 TUI 代码。**

交互层由 DOM-Review 的插件 UI（Chrome Extension / DevTools Panel）直接承载，scream-code 只作为纯 Node.js 后端引擎运行。

---

## 三、通信链路改造

### 当前架构（同一进程内 RPC）

```
TUI/SDK ←── createRPC() ──→ ScreamCore → Sessions → Agents → LLM
```

### 改造后架构（插件 UI ↔ 后端进程）

```
┌─────────────────────────┐
│  DOM-Review 插件 UI     │
│  (Chrome Extension)     │
└───────────┬─────────────┘
            │ HTTP / WebSocket
            ▼
┌─────────────────────────┐
│  Node.js 后端进程        │
│  ┌───────────────────┐  │
│  │ ScreamHarness     │  │
│  │ (SDK门面)         │  │
│  └────────┬──────────┘  │
│           │ createRPC() │
│  ┌────────▼──────────┐  │
│  │ ScreamCore        │  │
│  │ → Sessions        │  │
│  │ → Agents          │  │
│  │ → MCP Manager     │  │
│  └────────┬──────────┘  │
│           │              │
│  ┌────────▼──────────┐  │
│  │ MCP Servers       │  │
│  │ (Browser Agent等) │  │
│  └───────────────────┘  │
└─────────────────────────┘
```

### 关键改造点

1. **新增 HTTP/WS 层**：在 `ScreamHarness` 上面包一层轻量 HTTP server（推荐 Hono 或原生 http）
2. **暴露 API**：
   - `POST /api/sessions` — 创建 session
   - `POST /api/sessions/:id/prompt` — 发送消息
   - `GET /api/sessions/:id/events` — SSE 事件流（实时 tool call 状态、思考过程）
   - `POST /api/sessions/:id/cancel` — 取消
   - `POST /api/sessions/:id/set-model` — 切换模型
   - `GET /api/config` — 获取配置
3. **MCP 连接**：agent-core 的 McpConnectionManager 保持不变，Browser MCP Server 通过 stdio 或 HTTP 连接
4. **无需 ACP**：完全跳过 ACP 协议层，直接用 ScreamHarness + SDKRpcClient

---

## 四、前端 UI 调试最小功能集

### P0 — 必须有

| 功能 | 现有实现 | 复用度 |
|------|---------|:------:|
| **LLM 对话循环** | agent-core/agent + ltod/generate | 直接复用 |
| **文件读写** | agent-core/tools/builtin/file/* | 直接复用 |
| **Shell 执行** | agent-core/tools/builtin/shell/ | 直接复用 |
| **MCP 工具调用** | agent-core/mcp/ | 直接复用 |
| **Session 管理** | agent-core/session + node-sdk/session | 直接复用 |
| **流式输出** | ltod/generate + event system | SSE 推送 |
| **权限控制** | agent-core/agent/permission | 直接复用 |

### P1 — 应该有

| 功能 | 来源 | 工作量 |
|------|------|:------:|
| **Browser MCP 工具** | 需新建 MCP Server | 高（核心差异化） |
| **截图/视觉对比** | agent-core/tools/builtin/media | 中 |
| **CSS 实时修改** | 通过 MCP 工具新增 | 高 |
| **DOM 元素选择** | 通过 MCP 工具新增 | 高 |
| **历史回滚** | agent-core/agent/records | 中 |

### P2 — 可选

| 功能 | 工作量 |
|------|:------:|
| **Goal 模式** | 低 |
| **Plan 模式** | 低 |
| **Background agent** | 中 |
| **Skill 系统** | 中 |
| **Plugin 系统** | 高（可砍） |
| **Memory 记忆** | 高（可后续加） |
| **Wolfpack 模式** | 中 |

---

## 五、依赖瘦身方案

### 砍掉的依赖

| 依赖 | 来源 | 原因 |
|------|------|------|
| `@earendil-works/pi-tui` | apps/scream-code | 终端 UI，不需要 |
| `@mariozechner/clipboard` | apps/scream-code | 终端剪贴板 |
| `cli-highlight` | apps/scream-code | 终端语法高亮 |
| `commander` | apps/scream-code | CLI 参数解析 |
| `chalk` | apps/scream-code | 终端颜色 |
| `semver` | apps/scream-code | 版本比较（可按需加） |
| `onnxruntime-node` | memory | 本地推理引擎 |
| `fastembed` | memory | embedding 模型 |
| `@mozilla/readability` | agent-core | 网页提取，UI调试不需要 |
| `linkedom` | agent-core | HTML解析，不需要 |
| `tar` + `yauzl` | agent-core | 压缩包，不需要 |
| `migration-legacy` | 整包 | 旧版迁移 |

### 保留的依赖

| 依赖 | 用途 |
|------|------|
| `@modelcontextprotocol/sdk` | MCP 工具协议 |
| `openai` / `@anthropic-ai/sdk` / `@google/genai` | LLM 调用 |
| `zod` | Schema 验证 |
| `ajv` + `ajv-formats` | JSON Schema |
| `pathe` | 路径处理 |
| `nunjucks` | 模板引擎（system prompt） |
| `smol-toml` | 配置解析 |
| `picomatch` | glob 匹配 |
| `proper-lockfile` | 文件锁 |
| `@antfu/utils` | createRPC 依赖 |
| `retry` | 重试逻辑 |
| `zod-to-json-schema` | tool schema 转换 |

### 体积预估

| 版本 | node_modules 大小 |
|------|:-----------------:|
| 当前全量（含 onnxruntime） | ~60MB+ |
| 砍掉 TUI + memory | ~8MB |
| 精简到最小（ltod + jian + agent-core + mcp） | ~4MB |

---

## 六、改造路线图

### Phase 1：后端引擎抽取（3-5 天）

1. 新建 `apps/engine/` 替代 `apps/scream-code/`
2. 入口文件：初始化 ScreamCore + 暴露 HTTP API
3. API 层（推荐 Hono，极轻量）：
   ```
   POST   /api/sessions              — 创建
   POST   /api/sessions/:id/prompt   — 发消息
   GET    /api/sessions/:id/events   — SSE 事件流
   POST   /api/sessions/:id/cancel   — 取消
   POST   /api/sessions/:id/set-model — 切模型
   GET    /api/config                — 配置
   ```
4. 砍掉 apps/scream-code/、packages/memory、packages/migration-legacy
5. 精简 agent-core 的 dependency（移除 readability、linkedom、tar 等）

### Phase 2：Browser MCP Server（1-2 周）

1. 新建独立 MCP Server，通过 stdio 或 HTTP 连接
2. 工具集：
   - `browser_navigate` — 页面导航
   - `browser_click` — 元素点击
   - `browser_screenshot` — 截图
   - `browser_evaluate` — 执行 JS
   - `browser_get_dom` — 获取 DOM 结构
   - `browser_set_css` — 修改 CSS
   - `browser_select_element` — 元素选择（DevTools 协议）
   - `browser_get_computed_styles` — 获取计算样式
3. 底层通过 Chrome DevTools Protocol (CDP) 与浏览器通信

### Phase 3：插件 UI 对接（1-2 周）

1. DOM-Review 插件 UI 通过 HTTP/WS 连接后端
2. UI 面板：
   - 对话面板（流式消息 + tool call 展示）
   - 截图预览
   - DOM 树浏览器
   - CSS 实时编辑器
3. 事件推送：tool call 进度、思考状态、权限请求

### Phase 4：打磨（持续）

1. 会话持久化/恢复
2. 多浏览器实例管理
3. 历史回滚
4. 模型切换热更新
