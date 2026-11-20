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

DevTailor 由两部分组成：

1. **Chrome 扩展** — 在网页右边缘放一条“标记工具条”（选取、标记、搜索、截图），并提供浏览器侧边栏：和 Claude 对话、管理展示会话。页面里没有悬浮球，也没有页内聊天。
2. **本地桥接服务（Bridge）** — 用 `scripts/claude-devtailor.sh` 在你要调试的项目目录启动 Claude Code 时，Claude Code 以插件形式把 Bridge 作为 **stdio MCP server**（`devtailor-bridge/src/mcp-main.ts`，声明 `experimental['claude/channel']`）拉起。侧边栏经 HTTP/SSE `127.0.0.1:34781` 与 Bridge 通信，Claude 的回复走 `reply` MCP 工具，浏览器工具走 MCP。**AI 的上下文在 Claude Code 那边**（Bridge 只保存本地展示会话），工具授权请求会转发到侧边栏审批卡（终端对话框与侧边栏谁先答谁生效）。

整个流程大概是这样：

```text
你在浏览器里标记问题 → Bridge 经 channel 通知把页面上下文发给当前 Claude Code 会话
    Claude 读取/修改项目代码 → Claude 调用浏览器工具（stdio MCP）
        Bridge 经 SSE 让当前接管的 tab 执行点击/填写/截图 → 结果返回给 Claude 继续分析
            Claude 用 reply 工具把回复写回侧边栏
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

- 元素库、展示会话和消息都存在项目目录的 `.devtailor/` 下（不要提交进仓库）；AI 的对话上下文在 Claude Code 那边，Bridge 只存本地展示镜像；
- 刷新页面后侧边栏会自动重新接上当前会话，新开标签页只需点一下「连接当前页」（接管）即可切换调试目标。

## 一个完整的例子

1. 你看到页面上有个按钮样式不对
2. 点页面右侧工具条的“选取” → 点要说的元素并写备注 → 在侧边栏输入"这个按钮样式不对，帮我看看"（标记会随消息一起发给 Claude）
3. AI 查看页面 DOM 和控制台报错 → 找到代码里的问题 → 修改源码
4. AI 自动在浏览器里点击按钮、截图验证修改效果
5. 你在侧边栏里看到验证结果，确认问题已解决

**什么时候适合用它：**

- 本地调试前端页面的各种 UI 问题、样式问题、交互问题
- 让 AI 基于真实页面上下文定位代码缺陷
- 轻量级自动化验证（介于手动测试和重型 E2E 框架之间）

---

## 快速开始

完整流程：**构建插件 → 在项目目录用 `scripts/claude-devtailor.sh` 启动 Claude Code（Bridge 随之启动）→ 加载扩展 → 在页面里点「连接当前页」→ 在侧边栏聊天**。

### 要求

- **Node.js 20+**（Bridge 与插件打包的最低要求）；Chrome / Chromium 系列浏览器。
- 本机已安装并**登录**过 Claude Code（在终端运行过一次 `claude` 并完成登录，启动脚本会检查 `claude` 在 PATH 里）。

### 1. 启动 Claude Code 通道（Bridge 随之启动）

首次使用先安装依赖并打包插件（只需一次，改过 Bridge 代码后需重新 `npm run build:plugin`）：

```bash
cd /path/to/DOM-Review/devtailor-bridge
npm install && npm run build:plugin
```

然后**在你要调试的项目目录**里启动 Claude Code（`--plugin-dir` 会加载本仓库的插件，Bridge 作为该会话的 stdio MCP server 启动）：

```bash
# 在你要调试的项目目录里一条命令启动（前台运行，Ctrl+C 退出）
cd /absolute/path/to/your/project
/path/to/DOM-Review/scripts/claude-devtailor.sh
# 建议设别名：alias devtailor='/path/to/DOM-Review/scripts/claude-devtailor.sh'
```

要注意：

- Bridge 固定监听 `127.0.0.1:34781`（扩展约定端口），**同一时间只能有一个 Bridge**；端口被占用时新会话的 Bridge 不会抢占，直接报错退出（启动脚本会先探测并给出警告）。
- 必须用脚本里的 `--dangerously-load-development-channels`（channel 是研究预览，自定义 channel 不在 allowlist 里），否则浏览器发来的通知会被静默丢弃。
- 开发 Bridge 本身时可以 `cd devtailor-bridge && npm run dev -- --dir /绝对路径`（`--` 不能省）或 `npm run mcp:dev`：前者只跑**占位会话**（不会调用真实 AI，仅用于调试 SSE/队列/展示会话），后者手工跑同一个 stdio MCP 入口。

### 2. 加载扩展

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本项目根目录（含 `manifest.json`）

### 3. 接管当前页

1. 用 Chrome 打开要调试的页面（如 `http://localhost:3000`），页面右边缘出现一条窄的 DevTailor 标记工具条
2. 状态栏显示“未接管当前标签”时，点「连接当前页」

### 4. 在侧边栏聊天

点击工具栏里的 DevTailor 图标 →「打开 Chat 侧边栏」，然后直接输入并发送：

- **新会话**：重置本地展示层（Claude 的上下文不会被清空）；
- 聊天时可以看到流式回复、工具调用卡片（带文件 diff / 命令输出）和上下文占用；可以随时点「取消」（Bridge 会推一条取消通知给 Claude）；
- Claude 要执行命令或改文件时的**权限确认出现在启动它的那个终端里**（侧边栏的权限转发还没做，浏览器侧此时只会看到“等待”）。

### 注意事项

- **会话必须保持打开**：Bridge 是 Claude Code 的子进程，Claude 会话结束（stdin 关闭）或 Ctrl+C 时 Bridge 一起退出。
- **同时只能有一个 Bridge**（端口固定 34781）：多个 Claude Code 会话各自启动 MCP 时会争这个端口，后来者退出（不会互相 kill）。
- 通知发出后不再有“等待响应”提示或无回复超时；如果终端里的 Claude 没有反应，请确认它是否在等权限确认，必要时在侧边栏取消该轮。
- 同时到达的多条通知会被 Claude 合并处理，回复靠 `turn_id` 路由到正确的会话。
- 更多细节与手动验证步骤：[docs/CLAUDE_PLUGIN_VERIFY.md](docs/CLAUDE_PLUGIN_VERIFY.md) 与 [docs/CLAUDE_CHANNEL_PROTOCOL.md](docs/CLAUDE_CHANNEL_PROTOCOL.md)。

## 整体数据流

```text
你在浏览器里标记问题、截图、发送消息
              ↓ 扩展 service worker → http://127.0.0.1:34781（HTTP/SSE）
Bridge（Claude Code 以插件形式拉起的 stdio MCP server，同进程跑 WSServer）
              ↓ notifications/claude/channel → Claude Code 会话（读代码 → 改代码 → 调用浏览器工具）
              ↑ Claude 用 reply 工具回复 → SSE stream
              ↑ Claude 调用浏览器工具 → BrowserActionRouter → SSE browser_action → 当前接管 tab
你在侧边栏里看到流式回复、工具调用卡片和验证结果（权限确认在终端里）
```

## 开发者须知

如果你要修改本项目源码（尤其是标记工具条、侧边栏聊天、Bridge 通信、会话管理、页面截图等关键逻辑），请先阅读 [docs/HANDOFF.md](docs/HANDOFF.md) 中的防回归规则。

```bash
# 仓库根目录（现行链路：扩展 → Hub）
npm run test:ext                   # 扩展侧纯逻辑测试（tests/extension，node --test）
npm run e2e:ext                    # 真实 Chrome 端到端：扩展 + 临时 Hub + 假 MCP 客户端（需 34781 空闲，且 Hub 仓库已装依赖）

# 旧 Bridge（遗留，待删除）
cd devtailor-bridge
npm run build && npm test          # Bridge 单元/集成测试（含插件 stdio 冒烟测试）
npm run build:plugin               # 打包 Claude Code 插件（claude-plugin/server）
```

e2e 脚本需要本机 Chrome 和 playwright-core（路径用 `DEVTAILOR_PLAYWRIGHT_CORE` 指定），且 34781 端口必须空闲。

## 开源与致谢

### 参考项目

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT

### 开源协议

Apache-2.0


## 标记工具条

页面右边缘的窄竖条（折叠 44px，可上下拖动，位置和展开状态按站点记忆），自上而下：

- **选取**：开/关选择模式，点页面元素就会加编号徽标并可写备注，`Esc` 退出。
- **标记**：显示标记数量，点击展开右侧抽屉（约 320px，不挤压页面）。
- **搜索**：展开抽屉并聚焦搜索框；抽屉打开时按 `/` 也可聚焦，`Esc` 先清搜索再关抽屉。搜索按编号、标签/id/class、选择器、文字、备注、组件名、文件路径做不区分大小写的子串匹配，空格分词、全部命中才算；只过滤显示，不影响发送。
- **截图**：截可见区域，作为待发送附件。
- **存元素**：把当前对象存进元素库。
- **接管状态点**：绿=已接管，灰=未接管（点击“连接当前页”），红=桥接未连接（悬停看启动命令 `scripts/claude-devtailor.sh`）。
- **打开侧边栏**：有待审批请求时带红点（Claude Code 权限请求会转发到这里审批，见 `docs/HANDOFF.md`「权限转发」）。
- **收起/展开**。

抽屉里每个标记一行：编号、元素简述、备注、组件文件。悬停高亮页面元素，点击滚动并闪烁；可展开详情、改备注（Enter 保存/Esc 取消）、存入元素库、删除；底部可“清空全部标记”（二次确认）和“在侧边栏发送”。

标记会同步到侧边栏输入框上方的“标记托盘”，在侧边栏发送消息时随消息一起发给 Claude（选择器、备注、组件文件、截图），用户消息气泡下方会显示这些标记。历史会话里由 DevTailor 拼出的长 Markdown 会被紧凑显示为“意图文字 + 含 N 个标记”。发送的标记在消息发送成功（服务端受理）后自动清除；发送失败则恢复为可再次发送。可以连续发送多条消息，每条回复是独立的气泡。
