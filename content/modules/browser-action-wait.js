/**
 * DevTailor — Smart Waiting Strategies
 *
 * Auto-waiting utilities inspired by Playwright:
 * - Wait for DOM stability after interactions
 * - Wait for network idle
 * - Wait for animations to complete
 *
 * Registers: window.__domReview.browserWait
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  /**
   * Wait for DOM to stabilize (no mutations for a certain period)
   */
  async function waitForDOMStable(options = {}) {
    const { timeout = 1000, stableTime = 100 } = options;
    let lastMutation = Date.now();

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        lastMutation = Date.now();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });

      const checkStable = setInterval(() => {
        if (Date.now() - lastMutation > stableTime) {
          clearInterval(checkStable);
          observer.disconnect();
          resolve({ stable: true, waitedMs: Date.now() - lastMutation + stableTime });
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkStable);
        observer.disconnect();
        resolve({ stable: false, waitedMs: timeout, timedOut: true });
      }, timeout);
    });
  }

  /**
   * Wait for network to be idle (no pending requests for a certain period)
   */
  async function waitForNetworkIdle(options = {}) {
    const { timeout = 2000, idleTime = 500 } = options;
    const startTime = Date.now();
    let pendingRequests = 0;
    let lastActivityTime = Date.now();

    return new Promise((resolve) => {
      // Track fetch requests
      const originalFetch = window.fetch;
      window.fetch = function(...args) {
        pendingRequests++;
        lastActivityTime = Date.now();
        return originalFetch.apply(this, args).finally(() => {
          pendingRequests--;
          lastActivityTime = Date.now();
        });
      };

      // Track XHR requests
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(...args) {
        this._tracked = true;
        return originalOpen.apply(this, args);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        if (this._tracked) {
          pendingRequests++;
          lastActivityTime = Date.now();
          this.addEventListener('loadend', () => {
            pendingRequests--;
            lastActivityTime = Date.now();
          });
        }
        return originalSend.apply(this, args);
      };

      const cleanup = () => {
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
      };

      const checkIdle = setInterval(() => {
        if (pendingRequests === 0 && Date.now() - lastActivityTime > idleTime) {
          clearInterval(checkIdle);
          cleanup();
          resolve({ idle: true, waitedMs: Date.now() - startTime });
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkIdle);
        cleanup();
        resolve({ idle: false, waitedMs: timeout, timedOut: true, pendingRequests });
      }, timeout);
    });
  }

  /**
   * Wait for navigation to complete
   */
  async function waitForNavigation(options = {}) {
    const { timeout = 2000 } = options;
    const startUrl = location.href;

    return new Promise((resolve) => {
      const checkNav = setInterval(() => {
        if (location.href !== startUrl) {
          clearInterval(checkNav);
          resolve({ navigated: true, from: startUrl, to: location.href });
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkNav);
        resolve({ navigated: false, timedOut: true });
      }, timeout);
    });
  }

  /**
   * Smart wait after click - combines multiple strategies
   */
  async function waitAfterClick(options = {}) {
    const {
      waitForNavigation: shouldWaitNav = true,
      waitForNetworkIdle: shouldWaitNetwork = true,
      waitForDOMStable: shouldWaitDOM = true,
      timeout = 3000
    } = options;

    const results = { strategies: [] };

    // First, check for quick navigation
    if (shouldWaitNav) {
      const navResult = await Promise.race([
        waitForNavigation({ timeout: 500 }),
        sleep(500).then(() => ({ navigated: false }))
      ]);
      results.strategies.push({ type: 'navigation', ...navResult });
      if (navResult.navigated) {
        return results; // If navigated, no need to wait for other things
      }
    }

    // Then wait for network and DOM in parallel (with shorter timeouts)
    const pending = [];

    if (shouldWaitNetwork) {
      pending.push(
        waitForNetworkIdle({ timeout: 1000, idleTime: 300 })
          .then(r => ({ type: 'network', ...r }))
      );
    }

    if (shouldWaitDOM) {
      pending.push(
        waitForDOMStable({ timeout: 800, stableTime: 100 })
          .then(r => ({ type: 'dom', ...r }))
      );
    }

    if (pending.length > 0) {
      const settled = await Promise.all(pending);
      results.strategies.push(...settled);
    }

    return results;
  }

  /**
   * Wait for element to appear with auto-retry
   */
  async function waitForSelector(selector, options = {}) {
    const {
      timeout = 5000,
      visible = true,
      retryInterval = 100,
      state = 'visible' // 'visible' | 'attached' | 'hidden'
    } = options;

    const deadline = Date.now() + timeout;
    const dom = window.__domReview.browserActionDom;

    while (Date.now() < deadline) {
      try {
        const elements = document.querySelectorAll(selector);

        if (elements.length === 0) {
          await sleep(retryInterval);
          continue;
        }

        // Find matching element based on state
        for (const el of elements) {
          const isElementVisible = dom?.isVisible?.(el) ?? (
            el.offsetWidth > 0 &&
            el.offsetHeight > 0 &&
            getComputedStyle(el).visibility !== 'hidden'
          );

          if (state === 'attached') {
            return el;
          } else if (state === 'visible' && isElementVisible) {
            return el;
          } else if (state === 'hidden' && !isElementVisible) {
            return el;
          }
        }

        await sleep(retryInterval);
      } catch (err) {
        // Invalid selector or other error
        await sleep(retryInterval);
      }
    }

    throw new Error(`Timeout waiting for selector: ${selector} (state: ${state})`);
  }

  window.__domReview.browserWait = {
    waitForDOMStable,
    waitForNetworkIdle,
    waitForNavigation,
    waitAfterClick,
    waitForSelector,
    sleep,
  };
})();
