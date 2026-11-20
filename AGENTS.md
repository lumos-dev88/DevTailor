# DevTailor Agent 笔记

> **链路现状**：扩展 → `devtailor-hub` 仓库（`/Users/liguangzhen/代码/devtailor-hub`）的 devtailor 通道（`127.0.0.1:34781`）→ Claude Code 的 hub-channel。旧 Bridge（`devtailor-bridge/`、`claude-plugin/`、`claude-plugin-marketplace/` 及配套脚本）已于本次提交删除；服务端行为请在 Hub 仓库修改。`/review` 立即返回 202，每次 `reply` 是独立消息，无 `done` / 队列。设计文档中的旧 Bridge 描述已标为历史参考。

在修改 chat、bridge、channel 会话、persistence、SSE、image、Markdown、Browser MCP 或元素库逻辑之前，请先阅读：

- `docs/HANDOFF.md`

该文档包含当前的设计边界和防回归规则。

## 文档入口

按改动范围同步阅读和更新对应文档：

- `docs/HANDOFF.md`：防回归规则、旧 Bridge 历史路由与约束、已修复问题。涉及 chat、bridge、channel 会话、persistence、SSE、image、Markdown、Browser MCP、元素库时必须优先查看。
- `docs/BROWSER_MCP_DESIGN.md`：Browser MCP 工具、active tab、`run_actions`、`run_js`、元素目标动作和 schema 设计。
- `docs/ARCHITECTURE.md`：扩展、旧 Bridge、Claude Code 通道（MCP stdio + channel）、会话、元素目标、持久化的数据流和模块边界。
- `docs/STATE_ANALYSIS.md`：状态模型、时序风险、已知边界和回归验证点。
- `docs/ARCHITECTURE_DECISION.md`：扩展 UI、Shadow DOM、选择器模式、DOM overlay 的架构决策。

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
- 改扩展 UI、Shadow DOM、选择器或 overlay 时，需要同步 `docs/ARCHITECTURE_DECISION.md` 或 `docs/HANDOFF.md`。
- 若确认文档无需变化，请在最终说明里明确写出原因。
