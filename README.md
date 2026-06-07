# DevTailor

DevTailor 是 **浏览器页面 ↔ ACP Agent 前端开发桥接工具**，由「Chrome 浏览器扩展 + 本地 Bridge 服务」双组件构成。它打通真实运行页面与编码 Agent 的数据和指令链路，让 Agent 能直接获取页面 DOM、截图、元素、控制台信息，并在修改代码后回到浏览器执行点击、填写、断言和截图验证。

## 一、产品定位

DevTailor 面向本地前端开发调试：用户在浏览器页面里标记问题，Agent 通过 Bridge 获取结构化页面上下文，修改项目源码，再通过 Browser MCP 工具回到当前页面完成自动校验。

### 组件分工

1. **Chrome 扩展（前端层）**  
   页面内嵌悬浮 Chat 面板，提供元素标记、截图、元素库管理、Browser MCP 工具调用和消息流式展示。

2. **Local Bridge（中转层）**  
   通过 SSE/HTTP 对接浏览器扩展，收拢页面上下文，并基于 ACP 协议通过 stdio 转发给兼容 Agent；同时接收 Agent 指令，路由到已接管的浏览器 tab 执行。

## 二、核心功能

### 1. 交互能力

- 页面悬浮 Chat 面板，原地和本地 ACP Agent 实时对话。
- 元素打点标注：点击 DOM 元素、填写备注，一键打包上下文发给 Agent。
- 截图能力：可见区域截图、网格辅助定位截图、图片粘贴入对话。
- 元素库：保存常用业务控件，通过 `targetId` / `targetName` 后续快速复用。

### 2. Browser MCP 内置工具集

轻量化 E2E 能力，无需编写测试用例文件，适合临时调试和验证改动。

```text
页面信息：get_page_snapshot、take_visible_screenshot、get_console_logs、get_console_message、get_element_targets
元素管理：save_element_target
页面控制：reload_page、wait_for_selector、wait_for_text
交互操作：click_page、type_text、fill_text、press_key、clear_state
代码执行：run_js
批量流程：run_actions
辅助能力：request_user_assistance
```

`run_actions` 可以组合多步操作和断言，临时执行，不落地为测试文件。

### 3. 项目与会话管理

- 项目级持久化：会话展示数据、截图引用、保存元素目标存储在项目根目录 `.devtailor/`。
- 会话隔离：前端聊天记录仅用于 UI 展示，不参与 Agent 上下文；多轮上下文由底层 ACP Session 维护。
- Tab 接管机制：刷新页面保留项目会话；新开标签页需要手动点击「接管」才会替换当前生效调试页面；Browser actions 仅作用于已接管 tab。

### 4. 多 Agent 兼容

内置 Agent 预设：

```text
claude、copilot、gemini、qwen、codex、opencode、kiro、kimi
```

同时支持自定义原生 ACP 命令接入任意符合 ACP 规范的 Agent 客户端。

## 三、适用场景

1. 本地调试前端 UI 异常，省去大段文字描述元素位置，直接圈选页面控件并提交问题。
2. 需要 Agent 获取真实页面 DOM、运行时控制台报错、页面截图来定位代码缺陷。
3. Agent 修改源码后，自动在浏览器执行点击、输入、断言，即时验证修改效果。
4. 需要一个介于手动测试和重型 E2E 测试框架之间的轻量化调试自动化方案。

## 四、环境依赖

- 浏览器：Chrome / Chromium 系列。
- 运行环境：Node.js 20+。
- Agent：任意 ACP 协议兼容 Agent，例如 Claude Code、Codex CLI、Gemini CLI 等。
- 调试载体：本地前端项目，通常是 `localhost` 或 `127.0.0.1` 开发环境。

## 五、快速启动

### 1. 启动 Bridge 服务

在 `devtailor-bridge/` 目录执行：

```bash
npm run dev -- --dir ../../todo --agent claude
```

常用启动方式：

```bash
npm run dev -- --dir /absolute/path/to/project
npm run dev -- --dir . --agent gemini
npm run dev -- --dir . --agent codex
npm run dev -- agents
```

### 2. 浏览器侧配置

1. Chrome 开发者模式加载当前仓库扩展源码。
2. 打开本地 `localhost` 或 `127.0.0.1` 前端页面。
3. 打开 DevTailor 悬浮面板，点击「接管」当前标签页。
4. 标记元素、截图或输入问题，开始和 Agent 联动调试。

## 六、整体数据流

```text
Chrome 页面（DevTailor 扩展）
        ↓ SSE / HTTP
devtailor-bridge（会话管理 + Tab 路由 + ACP 协议封装）
        ↓ ACP stdio
ACP Agent（读取 / 修改项目源码 → 下发 Browser MCP 指令）
        ↓ 指令回传 Bridge → 转发扩展
浏览器执行点击 / 填写 / 运行 JS / 截图 / 断言，结果回传给 Agent
```

## 七、本地开发规范

修改聊天 UI、Bridge 通信、ACP 会话、持久化存储、SSE、图片或 Markdown 渲染逻辑前，优先查阅 [docs/HANDOFF.md](docs/HANDOFF.md)。

Bridge 构建和测试：

```bash
cd devtailor-bridge
npm run build
npm test
```

## 八、开源参考与授权

### 参考开源项目

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT

### 项目开源协议

MIT
