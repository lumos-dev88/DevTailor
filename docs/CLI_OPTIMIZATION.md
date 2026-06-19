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
-a, --agent <agent>     Agent 类型或原始 ACP 命令，默认 claude
-d, --daemon            后台运行
-f, --follow            跟随日志输出（配合 logs 使用）
-h, --help              输出帮助
-v, --version           输出版本
--dir <path>            项目目录
--cwd <path>            项目目录别名
```

子命令：

```text
agents                  列出内置 Agent 预设
start                   启动 Bridge（默认）
stop                    停止后台进程
status                  查看后台进程状态
logs                    查看后台日志
```

环境变量：

```text
DEVTAILOR_AGENT         默认 Agent，可被 --agent 覆盖
```

## 固定端口规则

Bridge 固定运行在 `34781`，这是 Chrome 扩展侧的约定端口。

当前 CLI 不再提供 `--port`。如果端口上已有进程，启动前会先探测 `GET /health`：

- 若响应包含 `projectId` 和 `pid`，确认是 DevTailor Bridge，向其发送 `SIGTERM` 并等待释放端口。
- 若响应存在但不是 Bridge（缺少 `projectId`），报错退出，避免误杀其他服务。
- 若端口无响应，继续启动；如绑定失败再由操作系统报错。

不要在文档或示例里继续推荐 `--port`，除非扩展侧也同步支持动态端口发现。

## Agent 规则

内置 Agent 来自 `agent-presets.ts`，可通过以下命令查看：

```bash
devtailor agents
```

`--agent` 既支持内置 id，也支持原始 ACP 命令：

```bash
devtailor --agent codex --dir /path/to/project
devtailor --agent "my-acp-agent --flag" --dir /path/to/project
```

启动前会检查 resolved command 是否可用：

- 直接二进制命令（如 `claude-agent-acp`、`kimi`）使用 `which` / `where` 检查 PATH。
- `npx` 命令只检查 `npx` 本身是否在 PATH 中，不对具体包做 `dry-run` 预检。真实解析失败会在 spawn 阶段暴露，避免 valid npx 包因 dry-run 失败被误杀。
- 所有 npx 预设的 args 都以 `--yes` 开头，确保 npx 非交互安装，不污染 ACP stdio。

## 后台进程规则

后台模式：

```bash
devtailor --daemon --dir /path/to/project
```

当前行为：

- 使用 Node detached child process。
- PID 文件路径为 `/tmp/devtailor-bridge.pid`。
- `stop` 和 `status` 都读取该 PID 文件。
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

`GET /health` 现在额外返回：

```json
{
  "ok": true,
  "projectId": "...",
  "projectName": "...",
  "bridgeInstanceId": "...",
  "agentKey": "...",
  "agentLabel": "...",
  "pid": 12345,
  "activeClientId": "...",
  "activeSessionId": "...",
  "activeSessionTitle": "...",
  "acpSessionId": "..."
}
```

`pid` 用于 CLI 在端口冲突时安全地停止旧 Bridge 实例。

## 错误处理规则

当前 CLI 已实现：

- 未知参数报错。
- `--agent` / `--dir` 缺值报错。
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
devtailor --dir /path/to/project --agent gemini
devtailor --cwd /path/to/project --agent codex
devtailor --daemon --dir /path/to/project
devtailor logs
devtailor logs -f
devtailor agents
devtailor status
devtailor stop
```

## 后续可选改进

这些是未来增强，不是当前规范：

- 引入 Commander.js 或保持原生解析但补充更多子命令。
- 支持配置文件。
- 支持 shell completion。
- 支持 project-scoped daemon 管理（仅当产品明确需要多项目并行时）。
