# DevTailor UI 架构技术决策

**日期**: 2026-06-02  
**更新**: 2026-06-09  
**状态**: 已决策，按当前代码执行  

## 决策摘要

DevTailor content UI 采用分层隔离策略：

- **Chat 侧边栏**：可使用 `chrome.sidePanel` 作为后续 Chat 主体验容器，当前仅保留 shell/demo。
- **主面板和复杂卡片**：使用 Shadow DOM 宿主，由 `content/modules/shadow-ui.js` 管理。
- **页面选择/高亮/轻量 overlay**：使用普通 DOM + `dt-*` 命名空间 + 明确事件边界。
- **强隔离需求**：未来才考虑 iframe，不作为当前默认。
- **不使用 Custom Elements 作为核心 UI 基础**。

这比旧的“普通 DOM V1”描述更贴近当前代码。当前主 UI 已经是 Shadow DOM。

## 当前实现边界

### 全局按需注入

`manifest.json` 不包含静态 `content_scripts`。popup、侧边栏“接管当前页”和 `Ctrl/Cmd+Shift+X` 统一请求 service worker：按 MAIN console bridge → MAIN framework bridge → CSS → isolated modules 的顺序注入，再连接并 `/activate`。未接管网页没有 DevTailor 页面脚本。已接管 tab 的刷新/跳转由 `chrome.storage.session` 状态恢复；非 active tab 只补注入，不抢控制权。控制台捕获只能覆盖注入后的日志。

### Chrome Side Panel

sidePanel 适合作为 Chat 主体验容器：

- 会话列表、输入框、模型配置和 Bridge 状态可以放在扩展页面内，避免嵌入宿主页面 DOM。
- sidePanel 与 content script 都通过 background service worker 访问 Bridge，避免形成两个状态权威。
- 页面内 Shadow DOM / 普通 DOM overlay 继续负责必须贴近页面 DOM 的工具能力：元素标记、选择器模式、高亮、截图网格、命中测试和快速工具入口。

当前 sidePanel 只是 shell/demo；正式迁移 chat 前不要删除现有 Shadow DOM chat 模块。

### Shadow DOM 主 UI

`shadow-ui.js` 创建 DevTailor 宿主与共享样式变量，负责：

- Shadow DOM 宿主（`#dom-review-host`）与 `:host` 设计变量。
- 页内标记工具条的挂载点（`toolbar.js`）。
- UI 事件边界：宿主导出事件停止冒泡，非文本控件不抢页面焦点。

规则：

- 宿主容器和辅助层默认尽量不拦截页面点击。
- 只有真实可见、可操作的 DevTailor 卡片/按钮恢复 `pointer-events: auto`。
- 面板内部事件要 `stopPropagation`，避免触发页面外部点击逻辑。
- 面板和 FAB 的视口边界 clamp 必须允许四边贴边，边距为 `0`；不要为顶部预留默认安全距离。
- 面板坐标中的 `0` 是合法值，读取 `left/top` 时只能在解析结果不是数字时使用初始默认值，不能用 `parseFloat(...) || DEFAULT_POSITION.*` 这类会把 `0` 当作缺省值的写法。

### 页内工具条形态

`toolbar.js` 在 Shadow DOM 里渲染贴左悬浮的紧凑圆角竖条（VisBug 式），共五个按钮：选取（`V`）、参考元素（`R`）、截图（`S`）、接管状态点、打开侧边栏。它不再有整页抽屉，也不托管标记/参考列表——标记与参考的查看/编辑/删除/清空都归侧边栏（`mark-tray.js` / `references-tray.js`）。

- 拖动：按住按钮以外的空白处在视口内水平/垂直移动；位置按站点持久化，旧存储值继续兼容。
- 快捷键判定是纯逻辑（`toolbar-core.matchShortcut` / `isEditableEvent`）：无修饰键、非输入法组合、焦点不在可编辑元素（含 shadow DOM 深层 activeElement）才生效，未命中不吞页面按键。
- 说明卡用按钮内的 `.dt-tip`（hover/focus 显示），不额外注入浮层。

### 普通 DOM overlay

普通 DOM 仍适用于：

- 元素选择高亮（含 padding/margin 盒模型层）。
- VisBug 风格 hit-test 辅助层。
- 标记编号徽标与就地备注卡。

规则：

- 使用 `dt-*` 命名空间。
- 使用高 z-index，但避免覆盖 DevTailor 主面板最高层。
- 覆盖层 `pointer-events: none`，只让真实可见、可操作的卡片恢复点击。
- 选择/标记流程必须忽略 DevTailor 自身 UI（`visbug-hit-test.js` 的 `isOwnElement` 同时认识选取与参考两套 overlay/popup 的 id）。

### 参考元素采集

参考元素复用选取的点选思路，但作为独立模式：进入参考模式会退出标记模式（反之亦然），覆盖层用紫色 `#7c3aed` 与标记配色区分；备注框 Enter 保存 / Esc 取消并尊重 IME 组合。截图前临时隐藏 DevTailor 的 UI 与覆盖层、遮住元素内输入文字，并在所有路径（含异常）恢复；只截发起请求且在前台的标签页。脱敏（样式白名单、HTML 清洗、URL 敏感参数）全部在纯逻辑 `references-core.js` 里，便于单测。

### iframe 预留

iframe 只在需要更强事件/焦点沙箱时考虑，例如：

- 复杂设置页。
- 独立历史管理页。
- 与宿主页面 focus trap 冲突严重的长期面板。

当前代码没有把主 Chat UI 迁移到 iframe。

## 不采用 Custom Elements

原因：

- content script isolated world 中 `customElements` 兼容性和行为更复杂。
- 注入 MAIN world 会把扩展 UI 暴露给页面脚本。
- 相比 Shadow DOM host + 原生模块，收益不足。

## Popover API 不是基础架构

Popover API 可以作为局部增强，但不作为 DevTailor UI 的基础层。

原因：

- 不解决扩展和页面之间的隔离问题。
- 与页面已有 popover/dialog/focus trap 组合时仍需额外边界处理。
- 当前普通 DOM/Shadow DOM 分层已经覆盖主要需求。

## 事件边界规则

- DevTailor UI 内部交互必须阻止冒泡到宿主页面。
- DevTailor 的空白区域、透明区域、定位容器应允许页面点击穿透。
- Browser MCP 截图、坐标点击、grid 点击默认跳过或隐藏 DevTailor UI。
- Shadow DOM 不能阻止宿主页面更早注册的 document 捕获阶段监听器看到部分 composed 事件；若必须完全隔离，应评估 iframe。

## 后续优化方向

如果遇到样式冲突：

- 优先加强 Shadow DOM 内样式边界。
- 普通 overlay 增加命名空间权重。
- 不要回退到全局 CSS reset。

如果遇到事件冲突：

- 优先检查 pointer-events 和 stopPropagation 边界。
- 缩小全局捕获监听范围。
- 对长期复杂面板评估 iframe。

如果遇到 z-index 冲突：

- 统一调整 DevTailor layer 常量。
- 不要散落多个接近 `2147483647` 的魔法值。
