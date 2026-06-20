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

模型配置：

- 首选入口是 Chrome 扩展 popup 的「模型配置」，通过 Bridge `GET/POST /model-config` 保存到当前项目 `.devtailor/sessions.db`。
- 下列环境变量只作为一次性迁移兜底：当项目还没有 UI 模型配置时，Bridge 启动会把完整环境变量写入项目配置。

```text
OPENAI_BASE_URL         OpenAI-compatible API base URL
OPENAI_API_KEY          OpenAI-compatible API key
OPENAI_MODEL            OpenAI-compatible model id
DEVTAILOR_MODEL         OPENAI_MODEL 为空时的模型标识 fallback
DEVTAILOR_MAX_STEPS     单次 provider/tool loop 最大步数，默认 8
```

## 固定端口规则

Bridge 固定运行在 `34781`，这是 Chrome 扩展侧的约定端口。

当前 CLI 不再提供 `--port`。如果端口上已有进程，启动前会先探测 `GET /health`：

- 若响应包含 `projectId` 和 `pid`，确认是 DevTailor Bridge，向其发送 `SIGTERM` 并等待释放端口。
- 若响应存在但不是 Bridge（缺少 `projectId`），报错退出，避免误杀其他服务。
- 若端口无响应，继续启动；如绑定失败再由操作系统报错。

不要在文档或示例里继续推荐 `--port`，除非扩展侧也同步支持动态端口发现。

## Runtime 规则

Bridge 不再支持 `--agent`、内置 Agent 预设或原始 ACP 命令。启动后使用本地后端 runtime：

- 项目模型配置完整时启用 `RealAgentSession` + `OpenAICompatibleProvider`。
- 项目模型配置缺失或禁用时 fallback 到 `LocalAgentSession` 过渡 runtime。
- `RealAgentSession` 同时注入 `BrowserToolRunner` 和 `WorkspaceToolRunner`：browser tools 路由到当前接管 tab，workspace tools 在 Bridge `--dir` 项目根目录内执行。
- workspace tools 对齐 scream-code 的工作区边界：`--dir` / `--cwd` 是唯一 workspace root；相对路径从该目录解析，绝对路径必须位于该目录内。
- 当前 workspace tools 包括 `bash`、`read_file`、`write_file`、`edit_file`、`grep_files`、`glob_files`、`list_directory`。
- workspace tools 的模型体验对齐 scream-code 常用约定：`read_file` 提供 Anchor 和换行状态，`edit_file` 可用 Anchor 做冲突检测并保留 CRLF，`grep_files` 支持上下文/分页，`bash` 提供合并输出和明确失败退出码。
- 不恢复 ACP/MCP adapter。

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
  "agentSessionId": "..."
}
```

`pid` 用于 CLI 在端口冲突时安全地停止旧 Bridge 实例。

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
