# DevTailor Bridge CLI 当前规范

> 本文按当前 `devtailor-bridge/src/index.ts` 记录 CLI 行为。它不是未来方案草案。

## 当前命令形态

```bash
devtailor [dir] [options]
devtailor <command>
```

参数：

```text
dir                     项目目录，默认当前目录
-d, --daemon            后台运行
-f, --follow            跟随日志输出（配合 logs 使用）
-h, --help              输出帮助
-v, --version           输出版本
--dir <path>            项目目录
--cwd <path>            项目目录别名
```

子命令：

```text
start                   启动 Bridge（默认）
stop                    停止后台进程
status                  查看后台进程状态
logs                    查看后台日志
```

模型与密钥：

- Bridge 不再保存或读取任何模型配置；AI 由 Claude Code 担任（Channels 通道）。`/model-config`、`OPENAI_*`、`DEVTAILOR_MODEL`、`DEVTAILOR_MAX_STEPS`、`DEVTAILOR_RUNTIME` 都已移除。
- 可选环境变量：`DEVTAILOR_EXTENSION_ID`——设置后 Bridge 只接受 `chrome-extension://<该 ID>` 的请求（见 `docs/HANDOFF.md`「安全守卫」）。
- 没有后端选择开关。**真实使用**：在目标项目目录运行 `scripts/claude-devtailor.sh`，由 Claude Code 以插件形式拉起 Bridge（stdio MCP server，`src/mcp-main.ts`，声明 `experimental['claude/channel']`）；CLI 入口 `devtailor --dir` 只跑占位会话（`PlaceholderAgentSession`），仅用于调试 SSE/队列/展示会话。
- 由于扩展固定连 34781，同一时间只能有一个 Bridge：由 `scripts/claude-devtailor.sh` 拉起的那个会话持有端口，别的 Bridge 请先让对应 Claude Code 会话退出。`DEVTAILOR_PROJECT_DIR`（其次 `CLAUDE_PROJECT_DIR`，最后 `process.cwd()`）决定项目目录，`DEVTAILOR_PORT` 只用于测试/调试。Bridge 退出（stdin 关闭或 SIGINT/SIGTERM）时关闭 HTTP server 并退出。

输出约定：Bridge 所有日志和 CLI 提示（含 `--help`、`--version`）都写 stderr，stdout 保留给 MCP stdio 协议。

## 固定端口规则

Bridge 固定运行在 `127.0.0.1:34781`（只绑回环地址），这是 Chrome 扩展侧的约定端口。

当前 CLI 不再提供 `--port`。启动时若端口已被占用：

- **不会杀掉占用者**，也不再读取别的进程的 pid。
- 向 stderr 打印明确提示（占用者 PID 可得时附带；若占用者是另一个 DevTailor Bridge，提示「另一个 DevTailor 桥接正在运行，请关闭对应的 Claude Code 会话或进程」），并以退出码 1 退出。
- 端口检查发生在打开 `.devtailor/sessions.db` 之前，第二个实例不会改写第一个实例的数据库。

不要在文档或示例里继续推荐 `--port`，除非扩展侧也同步支持动态端口发现。

## Runtime 规则

Bridge 不再支持 `--agent` 和内置 Agent 预设，也不再带自有 AI runtime（Scream / RealAgentSession / LocalAgentSession / workspace tools 均已删除）。CLI 入口（`src/index.ts`）独立运行时只用占位会话 `PlaceholderAgentSession`（所有 review 立即返回「Claude Code 通道尚未连接」），仅用于调试 SSE/队列/展示会话；真实使用必须走 `scripts/claude-devtailor.sh`，由 Claude Code 拉起 `src/mcp-main.ts`。

## 后台进程规则

后台模式：

```bash
devtailor --daemon --dir /path/to/project
```

当前行为：

- 使用 Node detached child process。
- PID 文件路径为 `/tmp/devtailor-bridge.pid`，仅在成功绑定端口后写入、退出时仅当内容是自己的 PID 才删除；只有显式的 `stop` / `status` 命令会读取它。
- 后台日志写入 `{dir}/.devtailor/bridge.log`。

查看日志：

```bash
devtailor logs              # 显示最近 100 行
devtailor logs -f           # 持续跟随
devtailor logs --dir /path  # 查看指定项目目录的日志
```

已知限制：

- PID 文件是单实例模型，不适合同时管理多个 Bridge daemon。
- 如果未来需要多项目 daemon 管理，应先设计 project-scoped PID/log 目录，不要只加更多临时参数。

## 健康检查响应

`GET /health` 不需要 Origin，无 Origin 时只返回：

```json
{ "ok": true, "protocolVersion": 1 }
```

带合法 `chrome-extension://` Origin 时（扩展使用）额外返回 `projectId`、`projectName`、`bridgeInstanceId`、`agentKey`、`agentLabel`、`activeClientId`、`activeSessionId`、`isProcessing`、`processingSessionId`。不再返回 `pid`、`activeSessionTitle`、`agentSessionId`。

## 错误处理规则

当前 CLI 已实现：

- 未知参数报错。
- `--dir` 缺值报错。
- 项目目录不存在时报错。
- `--help` / `--version` 直接退出。
- 端口被非 Bridge 进程占用时报错退出。

当前 CLI 未实现：

- `--port`。
- 配置文件。
- shell completion。

## 示例

```bash
devtailor
devtailor /path/to/project
devtailor --dir /path/to/project
devtailor --cwd /path/to/project
devtailor --daemon --dir /path/to/project
devtailor logs
devtailor logs -f
devtailor status
devtailor stop
```

## 后续可选改进

这些是未来增强，不是当前规范：

- 引入 Commander.js 或保持原生解析但补充更多子命令。
- 支持配置文件。
- 支持 shell completion。
- 支持 project-scoped daemon 管理（仅当产品明确需要多项目并行时）。
