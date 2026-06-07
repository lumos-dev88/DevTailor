/**
 * DevTailor — Chat Scroll Manager
 *
 * Preserves history reading while still following streaming output when the
 * user is pinned near the bottom.
 *
 * Registers: window.__domReview.chatScroll
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  const AUTO_FOLLOW_PX = 80;
  const JUMP_BUTTON_PX = 120;

  function create({ getContainer, getJumpButton }) {
    let isPinnedToBottom = true;
    let followScrollFrame = null;
    let resizeObserver = null;
    let mutationObserver = null;

    function distanceFromBottom(container) {
      if (!container) return 0;
      return container.scrollHeight - container.scrollTop - container.clientHeight;
    }

    function setJumpButtonVisible(visible) {
      const button = getJumpButton?.();
      if (button) button.classList.toggle('is-visible', Boolean(visible));
    }

    function updatePinState() {
      const container = getContainer?.();
      if (!container) return;
      const distance = distanceFromBottom(container);
      isPinnedToBottom = distance <= AUTO_FOLLOW_PX;
      setJumpButtonVisible(distance > JUMP_BUTTON_PX);
    }

    function scrollToBottom(options = {}) {
      const container = getContainer?.();
      if (!container) return;
      if (options.smooth && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      isPinnedToBottom = true;
      setJumpButtonVisible(false);
    }

    function followLatestIfPinned() {
      if (!isPinnedToBottom) {
        updatePinState();
        return;
      }
      if (followScrollFrame) return;
      followScrollFrame = requestAnimationFrame(() => {
        followScrollFrame = null;
        if (isPinnedToBottom) scrollToBottom();
      });
    }

    function observeChildren() {
      const container = getContainer?.();
      if (!container || !resizeObserver) return;
      resizeObserver.disconnect();
      resizeObserver.observe(container);
      Array.from(container.children).forEach(child => resizeObserver.observe(child));
    }

    function setup() {
      const container = getContainer?.();
      if (!container) return;
      container.addEventListener('scroll', updatePinState, { passive: true });

      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => followLatestIfPinned());
        observeChildren();
      }

      if (typeof MutationObserver === 'function') {
        mutationObserver = new MutationObserver(() => {
          observeChildren();
          followLatestIfPinned();
        });
        mutationObserver.observe(container, { childList: true, subtree: false });
      }

      updatePinState();
    }

    function isPinned() {
      return isPinnedToBottom;
    }

    return {
      setup,
      scrollToBottom,
      followLatestIfPinned,
      updatePinState,
      isPinned,
    };
  }

  window.__domReview.chatScroll = { create };
})();
