# DevTailor Agent Notes

> **链路现状**：扩展 → devtailor-hub（`127.0.0.1:34781`）→ Claude Code hub-channel；服务端改动在 Hub 仓库做。

修改 chat、bridge、channel 会话、持久化、SSE、图片、Markdown、Browser MCP 或元素库逻辑前，先阅读：

- `docs/HANDOFF.md`

该文档记录了当前设计边界和防回归规则。

## 文档入口

按改动范围同步阅读和更新对应文档：

- `docs/HANDOFF.md`：防回归规则、已修复问题。涉及 chat、bridge、channel 会话、persistence、SSE、image、Markdown、Browser MCP、元素库时必须优先查看。
- `docs/CLAUDE_CHANNEL_PROTOCOL.md`：Claude Code Channels（MCP stdio + `experimental['claude/channel']`）依赖的官方协议点与来源。
- `docs/BROWSER_MCP_DESIGN.md`：Browser MCP 工具、active tab、`run_actions`、`run_js`、元素目标动作和 schema 设计。
- `docs/ARCHITECTURE.md`：扩展、Claude Code 通道、会话、元素目标、持久化的数据流和模块边界。
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

## 本地开发

Hub 的启动与服务端开发请参阅 `devtailor-hub` 仓库文档。

验证扩展侧改动（纯逻辑 Node 测试 + 真实 Chrome 端到端，后者用假 MCP 客户端、不碰真实会话，且要求 34781 端口空闲）：

```bash
# 在仓库根目录运行（扩展 → Hub）
npm run test:ext   # = node --test 'tests/extension/*.test.js'
npm run e2e:ext    # = node scripts/e2e-extension.mjs（真实 Chrome + 临时 Hub + 假 MCP 客户端；需 Hub 仓库已装依赖，且 34781 空闲，即要先停掉正在运行的 Hub）
```

## Credits

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT
