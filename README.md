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

1. **Chrome 扩展** — 在网页左侧悬浮一条紧凑的“标记工具条”（选取、参考元素、截图、接管状态、打开侧边栏），并提供浏览器侧边栏：查看/编辑标记与参考元素、和 Claude 对话、管理展示会话。页面里没有悬浮球，也没有页内聊天。
2. **本地 Hub** — 服务端实现在独立的 `devtailor-hub` 仓库（`/Users/liguangzhen/代码/devtailor-hub`）。扩展经 HTTP/SSE 连接其 devtailor 通道（`127.0.0.1:34781`），由 Claude Code 的 **hub-channel** 接收消息、回复并调用浏览器工具。AI 的上下文由 Claude Code 持有，Hub 管理本地展示会话。

整个流程大概是这样：

```text
你在浏览器里标记问题 → Hub 经 hub-channel 通知把页面上下文发给当前 Claude Code 会话
    Claude 读取/修改项目代码 → Claude 调用浏览器工具（stdio MCP）
        Hub 经 SSE 让当前接管的 tab 执行点击/填写/截图 → 结果返回给 Claude 继续分析
            Claude 用 reply 工具把回复写回侧边栏
```

## 你能用它做什么？

### 标记问题，圈出来就能说清楚

- 页面上点一下那个出问题的按钮、输入框或任何元素，AI 就知道你说的是哪个；
- 用「参考元素」（`R`）把“目标样式”直接抓给 AI：白名单计算样式 + 裁剪脱敏后的结构 + 元素截图；
- 一键截取当前页面截图，连同控制台报错信息自动打包发给 AI；
- 元素库（`get_element_targets` / `save_element_target` / `delete_element_target`）保留项目级元素目标，由 Claude 或 browser tool 直接点名复用。

### 让 AI 在浏览器里干活

AI 可以在你正在调试的页面上做这些事（不需要你写测试代码）：

- 获取页面信息：页面结构、截图、控制台日志、你标记的元素
- 页面操作：点击、输入文字、按键、刷新页面、等待某个元素出现
- 执行自定义 JS 代码
- 组合多步操作（比如：点击登录 → 等待跳转 → 断言页面标题）

### 全局接管与实例选择

- 扩展没有网址白名单，也不会在打开网页时静态注入。任意普通 http/https 页面都可以从 popup、侧边栏或 `Ctrl/Cmd+Shift+X` 主动接管；
- `Ctrl/Cmd+Shift+X`：未接管＝注入并接管；已接管＝切换页内工具条的显示/隐藏；别的标签页正在接管时只注入并显示/收起当前页工具条，接管权仍留给原来那个标签页（popup / 侧边栏的「接管当前页」按钮不受影响）；
- 已接管页面刷新或跳转后会自动补注入。只有当前接管的标签页会重新接管，其他曾注入标签页不会抢走控制权；在页内工具条点“取消接管”后，后台会清除接管归属（保留注入记录），刷新不会再自动接管；
- 侧边栏可选择具体 Claude Code 实例，或保留“自动”让 Hub 使用默认实例。选择会在浏览器本地持久化。

## 一个完整的例子

1. 你看到页面上有个按钮样式不对
2. 点页面左侧工具条的“选取”（或按 `V`）→ 点要说的元素并写备注 → 在侧边栏输入"这个按钮样式不对，帮我看看"（标记会随消息一起发给 Claude）
3. AI 查看页面 DOM 和控制台报错 → 找到代码里的问题 → 修改源码
4. AI 自动在浏览器里点击按钮、截图验证修改效果
5. 你在侧边栏里看到验证结果，确认问题已解决

**什么时候适合用它：**

- 本地调试前端页面的各种 UI 问题、样式问题、交互问题
- 让 AI 基于真实页面上下文定位代码缺陷
- 轻量级自动化验证（介于手动测试和重型 E2E 框架之间）

---

## 快速开始

完整流程：**按 Hub 仓库文档启动 Hub 与 Claude Code 的 hub-channel → 加载扩展 → 点「接管当前页」→ 在侧边栏聊天**。

### 要求

- Chrome / Chromium 系列浏览器。
- 本机已安装并登录 Claude Code；Node.js 与服务端依赖要求以 `devtailor-hub` 仓库文档为准。

### 1. 启动 Hub 与 Claude Code 通道

在独立的 `devtailor-hub` 仓库中，按其 README 安装依赖并启动 Hub，再在目标项目中连接 Claude Code 的 `hub-channel`。启动命令和服务端配置以 Hub 仓库文档为准。

扩展固定连接 Hub 的 devtailor 通道 `127.0.0.1:34781`，请确认该通道已启动。服务端、通道、会话和 Browser MCP 的服务端行为均在 Hub 仓库维护。

### 2. 加载扩展

1. 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」，选择本项目根目录（含 `manifest.json`）

### 3. 接管当前页 / 显示工具条

1. 用 Chrome 打开任意普通 http/https 页面；此时 DevTailor 不会向页面注入任何脚本
2. 点击扩展 popup 或侧边栏里的「接管当前页」，也可按 `Ctrl/Cmd+Shift+X`（未接管且没有别的标签页在接管时＝注入并接管；已有接管页时＝只注入并显示/收起当前页的工具条）
3. 注入完成后页面左侧出现 DevTailor 标记工具条，即可标记、添加参考元素和截图。没有接管的页面同样可以采集参考元素（标记则只在接管后随消息发送）

Chrome 内置页、Chrome 扩展商店等浏览器禁止注入的页面会显示明确提示。MAIN world 的控制台捕获也从接管注入后才开始，因此注入前的控制台日志不会被补采集。

### 4. 在侧边栏聊天

点击工具栏里的 DevTailor 图标 →「打开 Chat 侧边栏」，然后直接输入并发送：

- **新会话**：重置本地展示层（Claude 的上下文不会被清空）；
- 发送即完成：`POST /review` 受理后立即返回 **202**，可以继续发送下一条消息；
- Claude 每次调用 `reply` 都会生成独立消息，无 `done` 事件或等待回复的队列。

### 注意事项

- 使用期间保持 Hub 和 Claude Code 的 hub-channel 连接可用。
- `127.0.0.1:34781` 由 Hub 的 devtailor 通道监听，避免启动其他占用该端口的服务。
- 消息已受理不代表 Claude 已回复；权限确认与通道状态请结合 Claude Code 和 Hub 的提示检查。
- 官方 Channel 协议的历史参考见 [docs/CLAUDE_CHANNEL_PROTOCOL.md](docs/CLAUDE_CHANNEL_PROTOCOL.md)，现行配置以 Hub 仓库文档为准。

## 整体数据流

```text
你在浏览器里标记问题、截图、发送消息
              ↓ 扩展 service worker → http://127.0.0.1:34781（HTTP/SSE）
Hub 的 devtailor 通道（服务端位于 devtailor-hub 仓库）
              ↓ Claude Code 的 hub-channel → 读代码、改代码、调用浏览器工具
              ↑ Claude 用 reply 工具回复 → SSE → 侧边栏独立消息
              ↑ 浏览器工具调用 → SSE browser_action → 当前接管 tab → 工具结果
```

## 开发者须知

如果你要修改本项目源码（尤其是标记工具条、侧边栏聊天、Hub 通信、会话管理、页面截图等关键逻辑），请先阅读 [docs/HANDOFF.md](docs/HANDOFF.md) 中的防回归规则。

```bash
# 仓库根目录（现行链路：扩展 → Hub）
npm run test:ext                   # 扩展侧纯逻辑测试（tests/extension，node --test）
npm run e2e:ext                    # 真实 Chrome 端到端：扩展 + 临时 Hub + 假 MCP 客户端（需 34781 空闲，且 Hub 仓库已装依赖）

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

页面左侧悬浮的紧凑圆角竖条（默认贴左边缘，按住工具条任意位置拖过几个像素即可水平/垂直移动，单击仍触发按钮，位置按站点记忆），共五个按钮，悬停显示说明卡（名称 + 一句说明 + 快捷键）：

- **选取**（快捷键 `V`）：开/关选择模式，点页面元素就会加编号徽标并在元素旁就地写备注（Enter 保存 / Esc 取消），`Esc` 退出。
- **参考元素**（快捷键 `R`）：点选页面元素存为「参考」（白名单计算样式、裁剪脱敏后的 `outerHTML`、该元素可见区域的截图），最多 8 个，随下一条侧边栏消息发送。与「选取」互斥，高亮为紫色；`Esc` 退出或放弃。
- **截图**（快捷键 `S`）：截可见区域，作为待发送附件（带待发送角标）。
- **接管状态点**：绿=已接管，灰=未接管（点击“连接当前页”），红=Hub 未连接（请按 Hub 仓库文档检查 devtailor 通道）；已接管时点击取消接管，刷新后不会自动重新接管。
- **打开侧边栏**：有待审批请求时带红点（Claude Code 权限请求会转发到这里审批，见 `docs/HANDOFF.md`「权限转发」）。

快捷键只在无修饰键、焦点不在输入框/文本域/可编辑区（含 shadow DOM 深层 activeElement）、且非输入法组合时生效，其它按键原样留给页面。

### 参考元素

「参考元素」用来回答“照这个样子改”：它不依赖标记，也不需要页面被接管——任何已注入工具条的页面都能采集。采集内容在扩展内脱敏后才入库：

- 计算样式只保留固定白名单（颜色、背景、字体、间距、尺寸、边框、阴影等）；
- `outerHTML` 去掉 `script/style/iframe` 内容、`on*` 事件属性、`srcdoc`、超长 `data:` 串，以及所有表单输入值（`input` 的 value、textarea 文本、selected/checked、password/hidden、contenteditable 里的文字）；
- 截图按元素可见区域裁剪（长边 ≤ 800px、JPEG），拍摄时临时遮住 DevTailor 自己的 UI 与元素内的输入文字，异常路径也会恢复；发起采集的标签页不在前台时只省略截图。

页面 URL 会去掉 hash 与账号密码，并把 `token/key/secret/auth/sig/session/code/password` 这类查询参数的值替换为 `REDACTED`。

参考列表是全局的（`chrome.storage.session`，浏览器会话内有效，最多 8 条），在侧边栏输入框上方独立的「参考」分区查看：缩略图、来源域名+路径（悬停看完整 URL）、备注；可就地编辑备注（Enter 保存 / Esc 取消）、删除单条、清空全部。发送时参考作为 `/review` 的独立字段 `references` 传给 Hub，不混进标记和截图；只有参考、没有标记和文字时也可以发送。Hub 回 `referencesAccepted` 等于本次条数时才移除这些参考，否则保留并提示。
