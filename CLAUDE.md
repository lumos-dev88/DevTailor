# DevTailor Agent Notes

修改 chat、bridge、ACP session、持久化、SSE、图片、Markdown、Browser MCP 或元素库逻辑前，先阅读：

- `docs/HANDOFF.md`

该文档记录了当前设计边界和防回归规则。

## 文档入口

按改动范围同步阅读和更新对应文档：

- `docs/HANDOFF.md`：当前防回归规则、关键路由、CLI 约束、已修复问题。涉及 chat、bridge、ACP session、persistence、SSE、image、Markdown、Browser MCP、元素库时必须优先查看。
- `docs/BROWSER_MCP_DESIGN.md`：Browser MCP 工具、active tab、`run_actions`、`run_js`、元素目标动作和 schema 设计。
- `docs/ARCHITECTURE.md`：扩展、Bridge、ACP、会话、元素目标、持久化的数据流和模块边界。
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
npm run dev -- --dir ../../todo --agent claude
```

查看支持的 Agent：

```bash
npm run dev -- agents
```

验证 Bridge 改动：

```bash
npm run build
npm test
```

## Credits

- DOM Review — `https://github.com/AAnkacHH/web-review-extention` — MIT
- VisBug — `https://github.com/GoogleChromeLabs/ProjectVisBug` — Apache-2.0
- wechat-acp — `https://github.com/formulahendry/wechat-acp` — MIT
