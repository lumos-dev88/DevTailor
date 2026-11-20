# DevTailor Agent Notes

> **链路现状（2026-11-20）**：现行链路是 **扩展 → devtailor-hub 仓库（`/Users/liguangzhen/代码/devtailor-hub`）的 devtailor 通道（`127.0.0.1:34781`）→ Claude Code 里的 hub-channel**。本仓库的 `devtailor-bridge/`、`claude-plugin/`、`claude-plugin-marketplace/` 与**本仓库**的 `scripts/claude-devtailor.sh`（拉起旧 Bridge）是**旧链路（遗留）**，同样占用 34781，**不要与 Hub 同时运行**。注意：Hub 仓库里还有一份**同名**的 `scripts/claude-devtailor.sh`，那才是现行启动入口（以 `server:hub` 通道启动 Claude Code），不要混淆。改 chat / 会话 / 审批 / Browser MCP 的服务端行为时，应改 Hub 仓库，而不是这里的旧 Bridge。旧链路仍保留，是因为扩展测试与 e2e 还依赖它；清理分三步：①标注（本说明）→ ②把 e2e/测试迁到 Hub → ③确认无引用后删除。下文关于 Bridge 的描述均指旧链路。

修改 chat、bridge、channel 会话、持久化、SSE、图片、Markdown、Browser MCP 或元素库逻辑前，先阅读：

- `docs/HANDOFF.md`

该文档记录了当前设计边界和防回归规则。

## 文档入口

按改动范围同步阅读和更新对应文档：

- `docs/HANDOFF.md`：当前防回归规则、关键路由、CLI 约束、已修复问题。涉及 chat、bridge、channel 会话、persistence、SSE、image、Markdown、Browser MCP、元素库时必须优先查看。
- `docs/CLAUDE_CHANNEL_PROTOCOL.md`：Claude Code Channels（MCP stdio + `experimental['claude/channel']`）依赖的官方协议点与来源。
- `docs/CLAUDE_PLUGIN_VERIFY.md`：Claude Code 插件 / 通道在真实会话上的手动验证清单（自动化测试覆盖不到的部分）。
- `docs/BROWSER_MCP_DESIGN.md`：Browser MCP 工具、active tab、`run_actions`、`run_js`、元素目标动作和 schema 设计。
- `docs/ARCHITECTURE.md`：扩展、Bridge、Claude Code 通道、会话、元素目标、持久化的数据流和模块边界。
- `docs/STATE_ANALYSIS.md`：状态模型、时序风险、已知边界和回归验证点。
- `docs/ARCHITECTURE_DECISION.md`：扩展 UI、Shadow DOM、选择器模式、DOM overlay 的架构决策。
- `docs/CLI_OPTIMIZATION.md`：Bridge CLI、daemon、agent 参数和启动约定。

## 文档同步检查

改动关键实现后，请运行：

```bash
node scripts/check-doc-sync.mjs
```

如果准备提交，可以安装本仓库的 hook 模板：

```bash
ln -sf ../../scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x scripts/hooks/pre-commit
```

检查规则：

- 改 Browser MCP、浏览器动作或元素目标逻辑时，需要同步 `docs/HANDOFF.md`、`docs/BROWSER_MCP_DESIGN.md`、`docs/ARCHITECTURE.md` 或 `docs/STATE_ANALYSIS.md`。
- 改 chat、session、persistence、SSE、Markdown 或 image 逻辑时，需要同步 `docs/HANDOFF.md`、`docs/ARCHITECTURE.md` 或 `docs/STATE_ANALYSIS.md`。
- 改 CLI、daemon 或 agent 参数时，需要同步 `docs/CLI_OPTIMIZATION.md` 或 `docs/HANDOFF.md`。
- 改扩展 UI、Shadow DOM、选择器或 overlay 时，需要同步 `docs/ARCHITECTURE_DECISION.md` 或 `docs/HANDOFF.md`。
- 若确认文档无需变化，请在最终说明里明确写出原因。

## 本地开发

在 `devtailor-bridge/` 目录启动 Bridge：

```bash
npm run dev -- --dir ../../todo
```

目录也可作为第一个位置参数传入（`npm run dev -- ../../todo`），缺省为当前工作目录。后台运行加 `-d`，另有 `status` / `stop` / `logs` 子命令。

**真实使用**：在目标项目目录运行 `scripts/claude-devtailor.sh`，由 Claude Code 以插件形式拉起 Bridge（stdio MCP server，`src/mcp-main.ts`，声明 `experimental['claude/channel']`；扩展固定连 `127.0.0.1:34781`，同一时间只能有一个 Bridge）。上面的 `npm run dev -- --dir <目录>` 只跑占位会话（`PlaceholderAgentSession`），用于占位调试 SSE/队列/展示会话，不会调用真实 AI。Bridge 不再支持 `--agent` 和 `agents` 子命令，也没有后端选择环境变量。详见 `docs/CLI_OPTIMIZATION.md`。

验证 Bridge 改动：

```bash
npm run build
npm test
```

验证扩展侧改动（纯逻辑 Node 测试 + 真实 Chrome 端到端，后者用假 MCP 客户端、不碰真实会话，且要求 34781 端口空闲）：

```bash
npm run test:ext   # = node --test '../tests/extension/*.test.js'
npm run e2e:ext    # = npm run build:plugin && node ../scripts/e2e-extension.mjs
```

## Credits

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT
