# DevTailor UI 架构技术决策

**日期**: 2026-06-02  
**更新**: 2026-06-09  
**状态**: 已决策，按当前代码执行  

## 决策摘要

DevTailor content UI 采用分层隔离策略：

- **主面板和复杂卡片**：使用 Shadow DOM 宿主，由 `content/modules/shadow-ui.js` 管理。
- **页面选择/高亮/轻量 overlay**：使用普通 DOM + `dt-*` 命名空间 + 明确事件边界。
- **强隔离需求**：未来才考虑 iframe，不作为当前默认。
- **不使用 Custom Elements 作为核心 UI 基础**。

这比旧的“普通 DOM V1”描述更贴近当前代码。当前主 UI 已经是 Shadow DOM。

## 当前实现边界

### Shadow DOM 主 UI

`shadow-ui.js` 创建 DevTailor 宿主和面板，负责：

- 顶部工具栏。
- Chat 面板。
- 接管状态栏。
- 大部分按钮和面板样式。

规则：

- 宿主容器和辅助层默认尽量不拦截页面点击。
- 只有真实可见、可操作的 DevTailor 卡片/按钮恢复 `pointer-events: auto`。
- 面板内部事件要 `stopPropagation`，避免触发页面外部点击逻辑。

### 普通 DOM overlay

普通 DOM 仍适用于：

- 元素选择高亮。
- VisBug 风格 hit-test 辅助层。
- 小型 badge 或临时 overlay。

规则：

- 使用 `dt-*` 命名空间。
- 使用高 z-index，但避免覆盖 DevTailor 主面板最高层。
- 选择/标记流程必须忽略 DevTailor 自身 UI。

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
