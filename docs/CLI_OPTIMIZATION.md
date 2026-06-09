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
-h, --help              输出帮助
-v, --version           输出版本
--dir <path>            项目目录
--cwd <path>            项目目录别名
```

子命令：

```text
agents                  列出内置 Agent 预设
stop                    停止后台进程
status                  查看后台进程状态
```

环境变量：

```text
DEVTAILOR_AGENT         默认 Agent，优先级低于 --agent
```

## 固定端口规则

Bridge 固定运行在 `34781`，这是 Chrome 扩展侧的约定端口。

当前 CLI 不再提供 `--port`。如果用户已有旧 Bridge 进程占用端口，启动时会尝试杀掉该端口上的旧进程：

```text
[DevTailor] Killing old process on port 34781 (PID: ...)
```

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

启动前会检查 resolved command 是否在 PATH 中；找不到会退出并提示用户安装。

## 后台进程规则

后台模式：

```bash
devtailor --daemon --dir /path/to/project
```

当前行为：

- 使用 Node detached child process。
- PID 文件路径为 `/tmp/devtailor-bridge.pid`。
- `stop` 和 `status` 都读取该 PID 文件。
- 后台日志目前不会写入专用日志文件。

已知限制：

- PID 文件是单实例模型，不适合同时管理多个 Bridge daemon。
- 后台日志缺少持久化入口。
- 如果未来需要多项目 daemon 管理，应先设计 project-scoped PID/log 目录，不要只加更多临时参数。

## 错误处理规则

当前 CLI 已实现：

- 未知参数报错。
- `--agent` / `--dir` 缺值报错。
- 项目目录不存在时报错。
- `--help` / `--version` 直接退出。

当前 CLI 未实现：

- `--port`。
- 配置文件。
- shell completion。
- daemon 日志查看命令。

## 示例

```bash
devtailor
devtailor /path/to/project
devtailor --dir /path/to/project --agent gemini
devtailor --cwd /path/to/project --agent codex
devtailor --daemon --dir /path/to/project
devtailor agents
devtailor status
devtailor stop
```

## 后续可选改进

这些是未来增强，不是当前规范：

- 引入 Commander.js 或保持原生解析但补充更多子命令。
- 增加 `logs` 命令。
- 支持 project-scoped daemon 管理。
- 支持配置文件。
- 支持 shell completion。
