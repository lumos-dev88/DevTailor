# DevTailor — 让 AI 直接在浏览器里帮你调试

> **一句话**：在浏览器页面里标记问题，让 AI 自动查看页面、修改代码，并在浏览器里验证修改效果。

## 这东西是干嘛的？

你写前端代码时，会不会遇到这种场景：

- 页面上有个按钮样式不对，你想告诉 AI，但又懒得截图、描述 DOM 结构、贴控制台报错；
- AI 帮你改完代码，你还要手动切回浏览器刷新、点击按钮看效果，来回折腾；
- 想让 AI 做一些临时验证，但又不想写完整的 E2E 测试用例。

DevTailor 就是为了解决这些麻烦而存在的。它把你的浏览器和本机的 **Claude Code** 会话连接起来，让 Claude 能：

1. **看到你看到的** — 页面 DOM 结构、控制台报错、当前截图、你圈出来的元素；
2. **操作你正在操作的页面** — 点击按钮、填写表单、运行 JS、截图验证；
3. **改你项目里的代码** — 基于真实页面上下文定位问题并修复。

整个过程你只需要在浏览器里标记问题、说一句话，剩下的交给 AI。

---

## 它怎么工作？

DevTailor 由两部分组成，安装后它们会自动配合，不需要你手动管理：

1. **Chrome 扩展** — 在网页里加一个悬浮聊天窗口，你可以在这里圈元素、截图、和 AI 对话。
2. **Claude Code 插件（内含本地 Bridge）** — 随 Claude Code 会话启动，把页面信息作为 channel 消息推给 Claude，再把 Claude 的浏览器操作送回页面执行。

整个流程大概是这样：

```text
你在浏览器里标记问题 → Bridge 把页面上下文打包发给 AI
    AI 读取/修改项目代码 → AI 让浏览器做操作
        浏览器执行点击/填写/截图 → 结果返回给 AI 继续分析
```

## 你能用它做什么？

### 标记问题，圈出来就能说清楚

- 页面上点一下那个出问题的按钮、输入框或任何元素，AI 就知道你说的是哪个；
- 一键截取当前页面截图，连同控制台报错信息自动打包发给 AI；
- 常用的业务组件可以存进「元素库」，以后直接点名就能复用。

### 让 AI 在浏览器里干活

AI 可以在你正在调试的页面上做这些事（不需要你写测试代码）：

- 获取页面信息：页面结构、截图、控制台日志、你标记的元素
- 页面操作：点击、输入文字、按键、刷新页面、等待某个元素出现
- 执行自定义 JS 代码
- 组合多步操作（比如：点击登录 → 等待跳转 → 断言页面标题）

### 项目隔离

- 每个项目的聊天记录、截图、元素库独立保存在项目的 `.devtailor/` 下（不要提交进仓库）；
- 刷新页面不会丢失当前调试会话，新开标签页只需点一下「连接当前页」（接管）即可切换调试目标。

## 一个完整的例子

1. 你看到页面上有个按钮样式不对
2. 打开悬浮面板 → 标记 → 输入"这个按钮样式不对，帮我看看"
3. AI 查看页面 DOM 和控制台报错 → 找到代码里的问题 → 修改源码
4. AI 自动在浏览器里点击按钮、截图验证修改效果
5. 你在聊天面板里看到验证结果，确认问题已解决

**什么时候适合用它：**

- 本地调试前端页面的各种 UI 问题、样式问题、交互问题
- 让 AI 基于真实页面上下文定位代码缺陷
- 轻量级自动化验证（介于手动测试和重型 E2E 框架之间）

---

## 快速开始

完整流程：**装扩展 → 构建插件 → 用脚本启动 Claude Code → 在页面里接管 → 在侧边栏对话**。

### 要求

- **Claude Code ≥ 2.1.80**，用 **claude.ai 账号**（或 Console API key）认证；Bedrock / Vertex / Foundry 不支持 channel（依据官方 channels 文档，见 docs/CLAUDE_CHANNEL_PROTOCOL.md）。
- Channel 目前是 **research preview**：自定义 channel 不在官方白名单里，**必须**用开发参数启动（下面的脚本已带上），否则浏览器消息会被静默丢弃。
- Node.js 20+，Chrome / Chromium 系列浏览器。
- Team / Enterprise 组织需管理员开启 channels。

### 1. 安装扩展

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本项目根目录（含 `manifest.json`）

### 2. 构建 Claude Code 插件

```bash
cd devtailor-bridge
npm install
npm run build:plugin   # 生成 claude-plugin/server/mcp-main.cjs（不入库）
```

### 3. 启动 Claude Code

在**你要调试的前端项目目录**里运行：

```bash
/path/to/DOM-Review/scripts/claude-devtailor.sh
```

脚本会检查 `claude` 与 Node 版本、确认插件已构建，然后执行等价于：

```bash
claude --plugin-dir <本仓库>/claude-plugin \
  --dangerously-load-development-channels plugin:devtailor@inline
```

Bridge 作为插件的 MCP server 随这个会话启动（监听 `127.0.0.1:34781`），会话退出时一起退出。看到终端启动横幅里出现 Channels (experimental) 提示即表示 channel 已注册。其他参数直接追加，例如 `claude-devtailor.sh --continue`。

### 4. 接管并对话

1. 用 Chrome 打开要调试的页面（如 `http://localhost:3000`）
2. 打开 DevTailor 面板，状态应显示「Claude Code 已连接」
3. 点「连接当前页」（接管）让 DevTailor 使用当前标签页
4. 在页面上标记元素 / 截图，或直接在侧边栏输入问题；Claude 的回复会显示在侧边栏

### 已知限制

- 这个终端会话必须保持打开；合盖休眠、断网或 `claude` 退出后，侧边栏会变成「未连接」。
- 权限提示（编辑文件、执行命令、首次调用 MCP 工具等）出现在**终端**里，不在浏览器里；Claude 等待确认期间浏览器只显示等待提示，约 10 分钟无响应后报错。
- 侧边栏的“新会话”只重置展示，不会清空 Claude 的上下文。
- 同时只能有一个 DevTailor Bridge（端口固定 34781）。
- 首次使用建议按 [docs/CLAUDE_PLUGIN_VERIFY.md](docs/CLAUDE_PLUGIN_VERIFY.md) 验证空闲会话唤醒、`reply` 权限和截图渲染。

### 作为已安装插件使用（可选）

```bash
scripts/make-local-marketplace.sh
claude plugin marketplace add ./claude-plugin-marketplace
claude plugin install devtailor@devtailor-local
DEVTAILOR_CHANNEL_ENTRY=plugin:devtailor@devtailor-local DEVTAILOR_NO_PLUGIN_DIR=1 scripts/claude-devtailor.sh
```

开发时也可以不构建插件，直接把 `.mcp.json` 的 server 指向 `devtailor-bridge/dist/mcp-main.js`（`npm run build`），再用 `--dangerously-load-development-channels server:<名字>`。

## 整体数据流

```text
你在浏览器里标记问题、截图、发送消息
              ↓ 扩展 service worker → http://127.0.0.1:34781
Bridge（Claude Code 插件内的 MCP server）
              ↓ notifications/claude/channel
Claude Code 会话（读代码 → 改代码 → 调用浏览器工具）
              ↓ reply 工具 / 浏览器工具结果
你在聊天面板里看到回复和验证结果
```

## 开发者须知

如果你要修改本项目源码（尤其是聊天面板、Bridge 通信、会话管理、页面截图等关键逻辑），请先阅读 [docs/HANDOFF.md](docs/HANDOFF.md) 中的防回归规则。

```bash
cd devtailor-bridge
npm run build && npm test          # 单元/集成测试
npm run build:plugin               # 打包插件
npm run smoke:plugin               # 对打包产物做 MCP 冒烟
node ../scripts/e2e-extension.mjs  # 真实 Chrome 端到端（需本机 Chrome + playwright-core，不在 npm test 内）
```

## 开源与致谢

### 参考项目

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT

### 开源协议

Apache-2.0
