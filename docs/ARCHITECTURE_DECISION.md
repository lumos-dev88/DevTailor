# DevTailor UI 架构技术决策

**日期**: 2026-06-02  
**状态**: ✅ 已决策  
**版本**: V1 (最终方案)

---

## 决策摘要

**保持 V1 架构（普通 DOM + 事件边界策略），不迁移到 Custom Elements。**

---

## 背景

DevTailor 的 badge 卡片需要在页面上显示浮动 UI，遇到以下技术挑战：

1. **样式隔离** - 避免页面 CSS 污染扩展 UI
2. **事件隔离** - 避免与页面 modal/dialog 的事件冲突
3. **focus trap 隔离** - 页面的 focus trap 不应拦截 badge 内的 textarea
4. **z-index 管理** - 确保扩展 UI 始终在最顶层

---

## 调研过程

### 尝试 1: Custom Elements + Shadow DOM + Popover API (失败)

**方案**: 参考 VisBug，使用 Custom Elements 封装每个 badge 卡片

```javascript
class MarkCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'closed' });
    this.setAttribute('popover', 'manual');
  }
  connectedCallback() {
    this.showPopover && this.showPopover();
  }
}
customElements.define('dt-mark-card', MarkCard);
```

**失败原因**:
- **错误**: `Uncaught TypeError: Cannot read properties of null (reading 'get')`
- **根因**: Chrome content script 运行在 isolated world，`customElements` API 不稳定
- **参考**: Chromium issue "Content scripts can't define custom elements"

### 尝试 2: Shadow DOM without Custom Elements (失败)

**方案**: 用普通 div + `attachShadow()`，不用 `customElements.define()`

```javascript
const host = document.createElement('div');
const shadow = host.attachShadow({ mode: 'closed' });
```

**失败原因**:
- Bug 比 V1 还多（用户反馈）
- 实现复杂度增加，但收益不明显
- Shadow DOM 的事件隔离不是绝对的（原生 UI 事件仍会穿透）

---

## 最终决策

### ✅ 保持 V1 架构

**核心原则**: 
> **不要把核心 UI 建在 Custom Elements 上。主方案用普通 DOM + 事件边界，复杂面板用 iframe。**

### V1 架构（当前实现）

```javascript
// 1. 普通 DOM 元素
const card = document.createElement('div');
card.className = 'dt-mark-card';

// 2. 样式隔离：命名空间前缀
.dt-mark-card { ... }
.dt-mark-card-head { ... }

// 3. 事件边界：composedPath 检查
document.addEventListener('pointerdown', (event) => {
  const path = event.composedPath();
  if (path.includes(container)) return;  // 点击在 badge 内，不处理
  closeFloating();
}, true);

// 4. z-index 管理：手动设置
const LAYER_Z = 2147483646;
```

### 为什么 V1 足够好？

| 问题 | V1 的解决方案 | 是否足够？ |
|------|--------------|-----------|
| 样式隔离 | `dt-*` 命名空间 | ✅ 足够（除非遇到极端页面 CSS） |
| 事件冲突 | `composedPath()` 检查 | ✅ 足够（处理大部分 dialog/modal） |
| focus trap | 事件边界拦截 | ✅ 基本够用 |
| z-index | 手动设置 `2147483646` | ✅ 足够（Chrome 最大值是 2147483647） |

---

## 技术选型指南

### 当前架构（适用于 badge 卡片）

```
content script
  └── container (fixed, z-index: 2147483646)
        └── card[] (普通 div)
              └── textarea, buttons
```

### 未来扩展指南

#### Small UI → 普通 DOM (当前方案)
- ✅ 适用：badge 卡片、选择框、hover 高亮、悬浮按钮
- ✅ 优点：简单、性能好、容易调试
- ⚠️ 注意：用 `dt-*` 前缀，避免样式冲突

#### Complex Panel → Shadow DOM (可选)
- ✅ 适用：主侧边栏（`shadow-ui.js` 已使用）
- ✅ 优点：样式隔离更强
- ⚠️ 注意：`attachShadow()` 直接用，不需要 Custom Elements

#### Large Panel → iframe (强隔离)
- ✅ 适用：历史记录面板、AI 结果面板、设置面板
- ✅ 优点：完全隔离（样式 + 事件 + 运行环境）
- ⚠️ 注意：通信用 `postMessage` 或 `chrome.runtime.sendMessage`

```javascript
// iframe 示例
const iframe = document.createElement('iframe');
iframe.src = chrome.runtime.getURL('panel.html');
iframe.style.cssText = `
  position: fixed;
  top: 0;
  right: 0;
  width: 400px;
  height: 100vh;
  border: none;
  z-index: 2147483647;
`;
document.body.appendChild(iframe);
```

---

## 不推荐的方案

### ❌ Custom Elements in Content Script

**原因**: 
- `customElements` API 在 isolated world 不稳定
- 需要注入到 MAIN world，会暴露给页面脚本
- 增加复杂度，收益不明显

**参考**: Chromium issue "Content scripts can't define custom elements"

### ❌ Popover API 作为主方案

**原因**:
- 浏览器兼容性（Chrome 114+）
- 不解决扩展和页面的根本隔离
- 适合做增强，不适合作为基础架构

### ❌ 全局 stopPropagation

**原因**:
- 会破坏页面正常交互
- 只在必要时拦截（如 badge 展开时）

---

## 参考资料

### 官方文档
- [Chrome Extensions: Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
- [MDN: Using Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
- [MDN: Event.composedPath()](https://developer.mozilla.org/en-US/docs/Web/API/Event/composedPath)

### 开源案例
- **Plasmo**: Content Scripts UI 架构（Shadow DOM 方案）
- **WXT**: Content script UI 分类（Shadow Root vs iframe）
- **ElementsHighlight**: React + Shadow DOM 的扩展 starter

### 类似产品
- **Grammarly**: 输入框旁悬浮 UI
- **Hypothesis**: 页面标注 + 侧边栏（iframe）
- **VisBug**: 页面设计工具（但运行在更高权限上下文）

---

## 决策理由

1. **V1 已经稳定可靠** - 经过实际使用验证
2. **Custom Elements 不稳定** - 在 content script 中有兼容性问题
3. **Shadow DOM 收益有限** - 对于 badge 这种小 UI，普通 DOM + 命名空间已够用
4. **保持简单** - 不引入不必要的复杂度

---

## 后续优化方向

### 如果遇到样式冲突

**症状**: 页面 CSS 影响 badge 样式

**解决方案**:
1. 检查是否有 `!important` 规则冲突
2. 增加 CSS 选择器权重
3. 考虑迁移到 Shadow DOM（仅针对受影响的组件）

### 如果遇到事件冲突

**症状**: 点击 badge 触发页面 dialog 关闭

**解决方案**:
1. 检查 `composedPath()` 逻辑是否正确
2. 在 badge 上添加 `stopPropagation`（谨慎使用）
3. 调整 z-index 确保在最顶层

### 如果需要复杂面板

**方案**: 使用 iframe 隔离

```javascript
const iframe = document.createElement('iframe');
iframe.src = chrome.runtime.getURL('panel.html');
// 通信用 postMessage
iframe.contentWindow.postMessage({ type: 'init' }, '*');
```

---

## 结论

**DevTailor 的 badge 卡片继续使用 V1 架构（普通 DOM + 事件边界），这是经过调研和实验验证的最佳方案。**

不追求技术上的"完美隔离"，而是选择"足够好且稳定"的实现。

---

**批准人**: [开发者签名]  
**执行日期**: 2026-06-02
