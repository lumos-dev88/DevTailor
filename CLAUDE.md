# DevTailor Agent Notes

修改 chat、bridge、ACP session、持久化、SSE、图片或 Markdown 逻辑前，先阅读：

- `docs/HANDOFF.md`

该文档记录了当前设计边界和防回归规则。

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
