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
   - 侧边栏 30 秒后出现 “⏳ 已发送给 Claude Code，等待响应…”，终端没动 → 通知被丢弃：确认第 0 步的 Channels 提示、启动用了开发参数、组织策略 `channelsEnabled` 未关闭。
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

## 5. 终端等待权限确认时的浏览器表现

1. 让 Claude 改一个文件（触发编辑权限提示），**不要**在终端确认。
2. 期望：侧边栏停在等待状态（30 秒后出现 “⏳ 已发送给 Claude Code，等待响应…”）；约 10 分钟仍无任何 `reply`/工具调用时变成 `Error: Claude 长时间没有回复…`。
3. 在终端确认后，Claude 的后续 `reply` 应继续正常显示（超时错误出现后该轮已结束，后续回复会被拒绝，需要重新发消息）。

## 6. 退出与端口释放

1. 正常退出 Claude（`/exit` 或 Ctrl+C 两次）。
2. 期望：`lsof -i :34781` 无输出（Bridge 随会话退出）；侧边栏变「未连接」。
3. 失败：端口仍被占 → `lsof -i :34781` 找到 PID 并 `kill`；把 Claude 退出方式和现象告诉我（stdin 关闭 / 信号处理没生效）。

## 7. 启动失败排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 脚本提示 `plugin server not built` | 没打包 | `cd devtailor-bridge && npm install && npm run build:plugin` |
| 脚本提示 `Node >= 20 required` | Node 太旧 / 不在 PATH | 升级 Node；注意 MCP 子进程用 PATH 里的 `node` |
| 终端出现 `Port 34781 is in use`（`/mcp` 里 server failed） | 另一个 DevTailor Bridge（旧终端/旧会话） | `lsof -i :34781`，关闭对应会话；Bridge 不会自动杀别人 |
| 侧边栏 “未连接”，终端无 Channels 提示 | 没用开发参数 / 组合不被识别 / 组织禁用 channels | 用 `scripts/claude-devtailor.sh`；见第 0 步备选；Team/Enterprise 请管理员开启 `channelsEnabled` |
| 侧边栏发消息 30 秒无反应、已连接 | 通知被静默丢弃（没注册为 channel） | 同上；`claude --debug` 查 `~/.claude/debug/<session-id>.txt` |
| `/mcp` 显示 `plugin:devtailor:devtailor` failed | 打包产物损坏或缺 wasm | 重新 `npm run build:plugin`；`cd devtailor-bridge && npm run smoke:plugin`；`claude --debug` 看 stderr |
| `claude plugin list` 看不到 `devtailor@inline` | `--plugin-dir` 没传或路径不对 | 在 `claude --plugin-dir ./claude-plugin plugin list` 检查；`claude plugin validate ./claude-plugin` |
| 浏览器工具返回 `NO_ACTIVE_TAB` | 没点“连接当前页”（接管） | 在页面面板点接管 |
| 本地 HTTP 请求 403 | 守卫拒绝（Host/Origin/客户端头） | 看 Bridge stderr 的 `[Guard] … reason=…`；确认用的是本仓库当前版本的扩展（需带 `X-DevTailor-Client`），重载扩展 |

## 结果记录

| 项 | 结果 | 备注 |
| --- | --- | --- |
| 0 channel 注册 | | |
| 1 空闲唤醒（秒） | | |
| 2 reply 是否弹权限 | | |
| 3 image 可见 / 路径回退 | | |
| 4 取消 | | |
| 5 权限等待 | | |
| 6 退出释放端口 | | |
