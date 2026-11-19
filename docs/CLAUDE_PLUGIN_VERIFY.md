# Claude Code 真实会话验证清单

给人手动跑。自动化部分（扩展 ↔ Bridge ↔ 假 Claude）已由 `node scripts/e2e-extension.mjs` 覆盖；下面是**必须真 Claude Code 才能确认**的项。

前置：

```bash
cd devtailor-bridge && npm install && npm run build:plugin   # 生成 claude-plugin/server/
# 扩展已在 chrome://extensions 加载；34781 端口空闲：lsof -i :34781
cd /你的前端项目 && /path/to/DOM-Review/scripts/claude-devtailor.sh
```

（用到的 `claude` 版本记在下面结果里：`claude --version`。）

## 0. 通道是否注册（最先做）

1. 终端会弹出开发 channel 的确认提示，选确认。
2. 期望：启动横幅下方有一行 `Channels (experimental) messages from plugin:devtailor@inline …`。运行 `/mcp`，应看到 `plugin:devtailor:devtailor` 状态 connected。
3. 在 Chrome 打开任意 `http://localhost:*` 页面，DevTailor 面板状态应为「Claude Code 已连接」；点「连接当前页」后变「已接管」。
4. 失败：
   - 没有 Channels 提示 → 说明 `--plugin-dir` + `plugin:devtailor@inline` 这个组合没被当作 channel（官方文档没写明）。改用备选：在项目根放 `.mcp.json`（`{"mcpServers":{"devtailor":{"command":"node","args":["/abs/path/DOM-Review/claude-plugin/server/mcp-main.cjs"]}}}`），运行 `DEVTAILOR_CHANNEL_ENTRY=server:devtailor DEVTAILOR_NO_PLUGIN_DIR=1 scripts/claude-devtailor.sh`；并把结果告诉我，脚本默认值要改。
   - 或试安装形态：`scripts/make-local-marketplace.sh && claude plugin marketplace add ./claude-plugin-marketplace && claude plugin install devtailor@devtailor-local`，然后 `DEVTAILOR_CHANNEL_ENTRY=plugin:devtailor@devtailor-local DEVTAILOR_NO_PLUGIN_DIR=1 scripts/claude-devtailor.sh`。

## 1. 空闲会话是否被侧边栏消息唤醒（未知项 1）

1. 终端里 Claude 处于空闲（等待输入，无任何任务在跑）。
2. 在侧边栏发 “你好，请回复 pong”。
3. 期望：终端自动出现 `<channel source="plugin:devtailor:devtailor" …>` 并开始处理，侧边栏收到回复。**记录从发送到终端开始处理的秒数**：______。
4. 失败：
   - 终端没有任何反应（侧边栏不再显示“等待响应”提示） → 通知可能被丢弃：确认第 0 步的 Channels 提示、启动用了开发参数、组织策略 `channelsEnabled` 未关闭。
   - 终端有反应但要等你按键/很久才处理 → 记录下来，说明空闲时通知不会主动唤醒（需要改成别的唤醒方式）。

## 2. `reply` 首次调用是否弹权限提示（未知项 2）

1. 第 1 步里 Claude 首次调用 `reply` 时观察终端。
2. 期望之一：直接执行；之二：弹出权限对话框（工具名形如 `devtailor` 下的 `reply`）。**记录是否弹出**：______。
3. 若弹出，选择 “always allow” 或预置规则。确认实际工具名：在会话里运行 `/mcp` 进入 `plugin:devtailor:devtailor` 看工具列表，或看权限对话框里的名字。按官方规则，插件内 server 的工具名是 `mcp__plugin_<plugin>_<server>__<tool>`，这里是：

   ```json
   {
     "permissions": {
       "allow": [
         "mcp__plugin_devtailor_devtailor__reply",
         "mcp__plugin_devtailor_devtailor__get_page_snapshot",
         "mcp__plugin_devtailor_devtailor__get_console_logs",
         "mcp__plugin_devtailor_devtailor__get_console_message",
         "mcp__plugin_devtailor_devtailor__get_element_targets",
         "mcp__plugin_devtailor_devtailor__save_element_target",
         "mcp__plugin_devtailor_devtailor__delete_element_target",
         "mcp__plugin_devtailor_devtailor__reload_page",
         "mcp__plugin_devtailor_devtailor__click_page",
         "mcp__plugin_devtailor_devtailor__fill_text",
         "mcp__plugin_devtailor_devtailor__type_text",
         "mcp__plugin_devtailor_devtailor__press_key",
         "mcp__plugin_devtailor_devtailor__clear_state",
         "mcp__plugin_devtailor_devtailor__wait_for_selector",
         "mcp__plugin_devtailor_devtailor__wait_for_text",
         "mcp__plugin_devtailor_devtailor__run_actions",
         "mcp__plugin_devtailor_devtailor__request_user_assistance",
         "mcp__plugin_devtailor_devtailor__run_js",
         "mcp__plugin_devtailor_devtailor__take_visible_screenshot"
       ]
     }
   }
   ```

   放到 `~/.claude/settings.json` 或项目 `.claude/settings.local.json`。等价的整台放行写法是 `"mcp__plugin_devtailor_devtailor__*"`（`run_js` 能在页面执行任意 JS，是否放行由你决定）。
4. 失败：规则写了仍弹窗 → 工具名前缀和上面不一致，以 `/mcp` 里实际显示的为准修改；`claude doctor` 可查看被跳过的无效规则。

## 3. 截图是否可见（未知项 3）

1. 让 Claude “截一张当前页面的图并描述你看到的”。
2. 期望：Claude 调 `take_visible_screenshot`，能准确描述页面内容。**记录**：image content 直接可见 / 不可见：______。
3. 不可见时检查回退：工具文本结果里应带有 `.devtailor/images/shot-<时间>-<n>.png` 路径；确认文件存在并能打开：`ls <项目>/.devtailor/images/`。让 Claude 用 Read 读这个路径，看它能否描述。**回退可用：**______。
4. 入站截图：在侧边栏点“截图”后发消息。期望消息正文里有 `.devtailor/images/<turn_id>-<n>.png` 的绝对路径，Claude 用 Read 查看。

## 4. 中途取消

1. 让 Claude 做一个较长任务（如“逐个检查页面上所有按钮并汇报”）。
2. 在侧边栏点停止/取消。
3. 期望：侧边栏立即结束该轮；终端里出现 `kind=cancel` 的 channel 消息，Claude 停止继续操作且不再回复。之后再发新消息能正常处理。
4. 失败：Claude 继续做完 → 取消只能“请求”，不能强制中断；需要在终端按 Esc。记录现象。

## 5. 终端等待权限确认时的浏览器审批卡（permission relay，需 Claude Code ≥ 2.1.81）

1. 确认版本：`claude --version` 应 ≥ 2.1.81（更低版本不认 `claude/channel/permission` capability，侧边栏不会弹卡）。**记录版本**：______。
2. 在侧边栏确认已「连接当前页」。让 Claude 执行一条**需要授权**的 Bash 命令（例如“在当前目录跑 `npm run build` 并把输出贴给我”，或先清掉该命令的 allow 规则）。
3. 期望：侧边栏弹出审批卡（工具名 `Bash` + 描述 + 命令预览，两个按钮「允许 / 拒绝」），同时终端保留自己的权限对话框。
4. 在**侧边栏点「允许」** → 期望：命令真的执行，卡片变「已允许」，Claude 继续正常 `reply`。
5. 再来一条需要授权的命令，在**侧边栏点「拒绝」** → 期望：命令被拒（Claude 收到拒绝，通常会改用别的办法或报告失败），卡片变「已拒绝」。
6. **谁先答谁生效**：再来一条需授权的命令，这次在**终端**先按允许 → 期望命令执行；侧边栏那张卡片不会自己消失，会一直留到 5 分钟超时才变成「已超时」（协议没有「终端已答复」的撤销信号，已知限制）。
7. 反例（无客户端不发裁决）：关掉侧边栏/断开「接管」后再触发一次权限请求 → 终端对话框正常等待；**不要**期望侧边栏报错，也不要在无 UI 时自动拒绝。
8. 反例（MCP 工具审批）：让 Claude 调一个未放行的 `mcp__plugin_devtailor_devtailor__*` 工具 → 同样应弹卡（工具使用审批范围包含 MCP 工具）。
9. 记录：卡片是否弹出 / 允许是否生效 / 拒绝是否生效 / 终端先答后卡片残留是否如描述：______。

## 6. AI 状态标（hooks 上报，`POST /agent-status`）

前提：另一个 agent 负责在 `claude-plugin/hooks/` 里装 hook 上报脚本；Bridge 侧只提供路由与状态机（见 `docs/HANDOFF.md`「AI 状态（hooks 上报）」）。手测前确认令牌文件已生成：

```bash
ls -l <你的项目>/.devtailor/agent-hook-token   # 应是 -rw------- (0600)，32 位十六进制
```

1. 打开侧边栏（或页内工具条），确认状态标初始为「空闲」。
2. 让 Claude **读一个文件**（如“看一下 src/index.ts 的前 50 行”）。期望：状态标在工具执行期间变成「正在读…/工具」类文案，工具结束后回到「思考中」，本轮结束时回到「空闲」。
3. 让 Claude **跑一条命令**（如“跑 npm run build”）。期望：状态标在命令执行期间显示该命令的 label（hook 已脱敏截断，Bridge 再截到 120 字符），结束后回「思考中」。
4. 让 Claude **同时开多个工具**（如“同时读这 3 个文件”）。期望：状态标一直在工具态，直到最后一个工具结束才回「思考中」（`activeTools` 从 N 递减）。
5. 触发一次需要确认的提示（如让 Claude 用 `request_user_assistance`，或在侧边栏发一条会触发权限审批的消息）。期望：状态标变「等待你的确认」。
6. **纯终端输入也会触发**：在终端（不是侧边栏）直接敲一句 “你好”，回车。期望：状态标从「空闲」变「思考中」→（读文件/跑命令时「工具」）→「空闲」，不需要经过侧边栏。
7. 在侧边栏发一条消息（走 `/review`）。期望：Bridge 内部的 `turn_start` 让状态标进入「思考中」，Claude `reply(final)` / 取消 / 超时后经 `turn_end` 回到「空闲」。
8. 刷新侧边栏页面。期望：重连后立刻看到当前状态快照（不是空白，也不用等下一次 hook 事件）。
9. 反例（不应放行）：在浏览器控制台对 `http://127.0.0.1:34781/agent-status` 发一次 `fetch(..., {method:'POST', body:'{"event":"Stop"}'})` → 期望状态标不变化；Bridge stderr 有 `[Guard] … denied POST /agent-status reason=origin_not_extension`。带正确令牌但带网页 Origin 同样被拒。
10. 记录：状态标文案/切换是否跟得上、终端输入是否触发、刷新后快照是否立刻出现、以及 10 分钟无事件后是否回到「空闲」（不想等 10 分钟可用 `curl` 只验路由，不验过期）：______。

## 7. 退出与端口释放

1. 正常退出 Claude（`/exit` 或 Ctrl+C 两次）。
2. 期望：`lsof -i :34781` 无输出（Bridge 随会话退出）；侧边栏变「未连接」；`<项目>/.devtailor/agent-hook-token` 被删除（Bridge 停止时尽力清理）。
3. 失败：端口仍被占 → `lsof -i :34781` 找到 PID 并 `kill`；把 Claude 退出方式和现象告诉我（stdin 关闭 / 信号处理没生效）。

## 8. 启动失败排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 脚本提示 `plugin server not built` | 没打包 | `cd devtailor-bridge && npm install && npm run build:plugin` |
| 脚本提示 `Node >= 20 required` | Node 太旧 / 不在 PATH | 升级 Node；注意 MCP 子进程用 PATH 里的 `node` |
| 终端出现 `Port 34781 is in use`（`/mcp` 里 server failed） | 另一个 DevTailor Bridge（旧终端/旧会话） | `lsof -i :34781`，关闭对应会话；Bridge 不会自动杀别人 |
| 侧边栏 “未连接”，终端无 Channels 提示 | 没用开发参数 / 组合不被识别 / 组织禁用 channels | 用 `scripts/claude-devtailor.sh`；见第 0 步备选；Team/Enterprise 请管理员开启 `channelsEnabled` |
| 侧边栏发消息后终端无反应、已连接 | 通知被静默丢弃（没注册为 channel） | 同上；`claude --debug` 查 `~/.claude/debug/<session-id>.txt` |
| `/mcp` 显示 `plugin:devtailor:devtailor` failed | 打包产物损坏或缺 wasm | 重新 `npm run build:plugin`；`cd devtailor-bridge && npm run smoke:plugin`；`claude --debug` 看 stderr |
| `claude plugin list` 看不到 `devtailor@inline` | `--plugin-dir` 没传或路径不对 | 在 `claude --plugin-dir ./claude-plugin plugin list` 检查；`claude plugin validate ./claude-plugin` |
| 浏览器工具返回 `NO_ACTIVE_TAB` | 没点“连接当前页”（接管） | 在页面面板点接管 |
| 本地 HTTP 请求 403 | 守卫拒绝（Host/Origin/客户端头） | 看 Bridge stderr 的 `[Guard] … reason=…`；确认用的是本仓库当前版本的扩展（需带 `X-DevTailor-Client`），重载扩展 |
| 权限请求不弹侧边栏卡片 | Claude Code 版本 < 2.1.81 / 没声明 `claude/channel/permission` / 侧边栏没连 Bridge | `claude --version`；看 Bridge stderr 的 `[MCP] permission …` 行；确认侧边栏「已接管」 |
| AI 状态标一直「空闲」 | hook 没装 / 令牌文件读不到 / Bridge 未重启导致令牌过期（每次启动重写） | 看 `<项目>/.devtailor/agent-hook-token` 是否存在且 0600；手动 `curl -i -X POST -H "Authorization: Bearer $(cat <项目>/.devtailor/agent-hook-token)" -H 'Content-Type: application/json' -d '{"event":"PreToolUse","toolName":"Read","label":"test"}' http://127.0.0.1:34781/agent-status` 应回 `{"ok":true}`；看 stderr `[Guard]` / `[AgentStatus]` 行 |

## 结果记录

| 项 | 结果 | 备注 |
| --- | --- | --- |
| 0 channel 注册 | | |
| 1 空闲唤醒（秒） | | |
| 2 reply 是否弹权限 | | |
| 3 image 可见 / 路径回退 | | |
| 4 取消 | | |
| 5 权限审批卡（允许/拒绝/终端先答） | | |
| 6 AI 状态标（工具/思考/等待/终端输入/刷新快照） | | |
| 7 退出释放端口 + 令牌文件删除 | | |
