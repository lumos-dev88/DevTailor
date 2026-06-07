/**
 * DevTailor — Selector Event Guard (Early Injection)
 *
 * 在 document_start 阶段注入，给正在选择的元素添加标记属性。
 * 目的：让页面的"点击外部关闭"逻辑有机会检测到 DevTailor 正在工作。
 *
 * 注意：由于浏览器扩展的隔离机制和事件监听器执行顺序限制，
 * 无法保证 100% 避免与 Radix UI 等库的冲突。详见 CLAUDE.md 的已知限制。
 *
 * 注册：window.__domReviewEventGuard
 */
(() => {
  'use strict';

  let guardActive = false;
  let checkCallback = null;

  /**
   * pointerdown 拦截器：给目标元素添加标记属性
   */
  function guardPointerDown(e) {
    if (!guardActive) return;

    // 检查是否是 DevTailor 自己的元素
    if (checkCallback && checkCallback(e.target)) {
      return;
    }

    // 给目标元素添加标记
    const target = e.target;
    if (target && target.setAttribute) {
      target.setAttribute('data-devtailor-selecting', 'true');
    }

    // 尝试阻止事件传播（可能已经晚了，但还是尝试）
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  /**
   * 在捕获阶段注册
   */
  document.addEventListener('pointerdown', guardPointerDown, {
    capture: true,
    passive: false
  });

  // 暴露控制接口
  window.__domReviewEventGuard = {
    enable(isOwnElementCheck) {
      guardActive = true;
      checkCallback = isOwnElementCheck || null;
    },
    disable() {
      guardActive = false;
      checkCallback = null;
    },
    isActive() {
      return guardActive;
    }
  };
})();
