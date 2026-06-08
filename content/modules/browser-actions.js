/**
 * DevTailor — Browser Actions
 *
 * Executes Browser MCP actions in the current tab.
 *
 * Registers: window.__domReview.browserActions
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function waitUntil(check, timeoutMs, message) {
    const deadline = Date.now() + Math.max(100, Math.min(Number(timeoutMs) || 5000, 60000));
    let lastValue = null;
    while (Date.now() <= deadline) {
      lastValue = check();
      if (lastValue) return lastValue;
      await sleep(100);
    }
    throw new Error(message || 'Wait timed out');
  }

  function rectJson(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  function captureVisibleScreenshot(params = {}) {
    const hide = params.hideDevTailor !== false;
    const uiElements = [
      { id: 'dom-review-host', prop: 'display' },
      { id: 'dom-review-highlights', prop: 'display' },
      { id: 'dom-review-badges', prop: 'display' },
      { id: 'devtailor-host', prop: 'display' },
      { id: 'devtailor-highlights', prop: 'display' },
      { id: 'devtailor-badges', prop: 'display' },
    ];
    const originals = [];

    if (hide) {
      for (const { id, prop } of uiElements) {
        const el = document.getElementById(id);
        if (el) {
          originals.push({ el, prop, value: el.style[prop] });
          el.style[prop] = 'none';
        }
      }
    }

    function restore() {
      for (const { el, prop, value } of originals) {
        el.style[prop] = value;
      }
    }

    return new Promise((resolve, reject) => {
      // Wait for next paint to ensure elements are hidden before capture
      requestAnimationFrame(() => {
        setTimeout(() => {
          try {
            chrome.runtime.sendMessage({ type: 'CAPTURE_VISIBLE_TAB' }, (response) => {
              restore();
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              if (!response?.success || !response.dataUrl) {
                reject(new Error(response?.error || 'Failed to capture visible tab'));
                return;
              }
              const finalize = (dataUrl, extra = {}) => {
                const match = /^data:(.+?);base64,/.exec(dataUrl);
                resolve({
                  mimeType: match?.[1] || 'image/jpeg',
                  data: dataUrl,
                  ...extra,
                });
              };
              if (params.grid) {
                overlayGrid(response.dataUrl, params)
                  .then(({ dataUrl, grid }) => finalize(dataUrl, { grid }))
                  .catch(() => finalize(response.dataUrl));
                return;
              }
              const match = /^data:(.+?);base64,/.exec(response.dataUrl);
              resolve({
                mimeType: match?.[1] || 'image/jpeg',
                data: response.dataUrl,
              });
            });
          } catch (err) {
            restore();
            reject(err);
          }
        }, 150);
      });
    });
  }

  function overlayGrid(dataUrl, params = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const cell = Math.max(20, Math.min(Number(params.gridSize) || 80, 240));
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const scaleX = canvas.width / window.innerWidth;
          const scaleY = canvas.height / window.innerHeight;
          ctx.save();
          ctx.strokeStyle = 'rgba(59,130,246,0.72)';
          ctx.lineWidth = Math.max(1, Math.round(Math.min(scaleX, scaleY)));
          ctx.font = `${Math.max(10, Math.round(12 * scaleY))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.fillStyle = 'rgba(15,23,42,0.72)';
          ctx.textBaseline = 'top';
          const cols = Math.ceil(window.innerWidth / cell);
          const rows = Math.ceil(window.innerHeight / cell);
          for (let c = 0; c <= cols; c++) {
            const x = Math.round(c * cell * scaleX);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height);
            ctx.stroke();
          }
          for (let r = 0; r <= rows; r++) {
            const y = Math.round(r * cell * scaleY);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
          }
          if (params.gridLabels !== false) {
            for (let c = 0; c < cols; c++) {
              for (let r = 0; r < rows; r++) {
                const label = `${columnLabel(c)}${r + 1}`;
                const x = Math.round(c * cell * scaleX + 4 * scaleX);
                const y = Math.round(r * cell * scaleY + 4 * scaleY);
                const metrics = ctx.measureText(label);
                ctx.fillRect(x - 2, y - 1, metrics.width + 5, Math.max(13, 14 * scaleY));
                ctx.fillStyle = '#bfdbfe';
                ctx.fillText(label, x, y);
                ctx.fillStyle = 'rgba(15,23,42,0.72)';
              }
            }
          }
          ctx.restore();
          resolve({
            dataUrl: canvas.toDataURL('image/png'),
            grid: {
              enabled: true,
              cellSize: cell,
              columns: cols,
              rows,
              labels: params.gridLabels !== false,
              coordinateSpace: 'viewport-css-pixels',
            },
          });
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to draw grid screenshot'));
      img.src = dataUrl;
    });
  }

  function columnLabel(index) {
    let n = index + 1;
    let label = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      label = String.fromCharCode(65 + rem) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  async function reloadPage(params = {}) {
    const url = location.href;
    setTimeout(() => {
      location.reload();
    }, Math.max(0, Math.min(Number(params.delayMs) || 80, 1000)));
    return { ok: true, url, reloading: true };
  }

  function stepError(index, step, err, detail = {}) {
    return {
      step: index,
      type: step?.type || 'unknown',
      code: err?.code || detail.code || undefined,
      expected: detail.expected == null ? undefined : String(detail.expected),
      actual: detail.actual == null ? undefined : String(detail.actual),
      message: detail.message || err?.message || String(err || 'Step failed'),
      diagnostics: detail.target || detail.hitElement || detail.point ? detail : undefined,
    };
  }

  function hasElementTarget(step = {}) {
    return Boolean(
      step.targetId ||
      step.targetName ||
      step.selector ||
      step.elementId ||
      step.markId ||
      step.text ||
      step.role ||
      step.label ||
      step.testId ||
      step.nearText ||
      step.point ||
      step.grid,
    );
  }

  function requireElementTarget(step, purpose) {
    if (hasElementTarget(step)) return;
    const err = new Error(`${purpose} step requires an explicit locator: targetId, targetName, selector, elementId, markId, text, role, label, testId, nearText, or point`);
    err.code = 'MISSING_LOCATOR';
    err.detail = {
      expected: 'explicit element locator',
      actual: 'no locator fields provided',
      message: err.message,
    };
    throw err;
  }

  async function resolveElementTargetParams(params = {}) {
    const resolver = window.__domReview.elementTargets?.resolveParams;
    if (!resolver || (!params.targetId && !params.targetName)) return params;
    return resolver(params);
  }

  async function withStepTimeout(promise, timeoutMs, step) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${step.type} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runStep(step, actionLabel, stepIndex, stepTimeoutMs) {
    const dom = window.__domReview.browserActionDom;
    const type = step && step.type;
    switch (type) {
      case 'click': {
        requireElementTarget(step, 'click');
        const resolvedStep = await resolveElementTargetParams(step);
        const result = await dom.click(resolvedStep);
        await sleep(step.waitAfterMs);
        return { ok: true, type, result };
      }
      case 'type': {
        requireElementTarget(step, 'type');
        const resolvedStep = await resolveElementTargetParams(step);
        const result = dom.typeText(resolvedStep);
        await sleep(step.waitAfterMs);
        return { ok: true, type, result };
      }
      case 'fill': {
        requireElementTarget(step, 'fill');
        const resolvedStep = await resolveElementTargetParams(step);
        const result = dom.fillText({ blurAfter: false, ...resolvedStep });
        await sleep(step.waitAfterMs);
        return { ok: true, type, result };
      }
      case 'press_key': {
        const resolvedStep = await resolveElementTargetParams(step);
        const result = dom.pressKey(resolvedStep);
        await sleep(step.waitAfterMs);
        return { ok: true, type, result };
      }
      case 'clear_state': {
        const result = dom.clearState(step);
        await sleep(step.waitAfterMs);
        return { ok: true, type, result };
      }
      case 'wait': {
        const ms = Math.max(0, Math.min(Number(step.ms) || 0, stepTimeoutMs));
        await sleep(ms);
        return { ok: true, type, result: { waitedMs: ms } };
      }
      case 'wait_for_selector': {
        const selector = String(step.selector || '');
        if (!selector) throw new Error('wait_for_selector requires selector');
        const el = await waitUntil(() => {
          const found = document.querySelector(selector);
          return found && dom.isVisible(found) ? found : null;
        }, step.timeoutMs || stepTimeoutMs, `Timed out waiting for selector: ${selector}`);
        return { ok: true, type, result: { selector, rect: rectJson(el) } };
      }
      case 'wait_for_text': {
        const text = String(step.text || '');
        if (!text) throw new Error('wait_for_text requires text');
        await waitUntil(() => dom.textInScope(text, step.selector), step.timeoutMs || stepTimeoutMs, `Timed out waiting for text: ${text}`);
        return { ok: true, type, result: { text, selector: step.selector || null } };
      }
      case 'screenshot': {
        const shot = await captureVisibleScreenshot({
          hideDevTailor: step.hideDevTailor !== false,
          grid: step.grid,
          gridSize: step.gridSize,
          gridLabels: step.gridLabels,
        });
        return {
          ok: true,
          type,
          screenshot: {
            label: step.label || `${actionLabel} #${stepIndex}`,
            mimeType: shot.mimeType || 'image/png',
            data: shot.data,
            grid: shot.grid,
          },
        };
      }
      case 'assert_text': {
        const assertion = dom.assertText(step);
        if (!assertion.ok) {
          const err = new Error(assertion.message);
          err.detail = assertion;
          throw err;
        }
        return { ok: true, type, result: assertion };
      }
      case 'assert_url': {
        const assertion = dom.assertUrl(step);
        if (!assertion.ok) {
          const err = new Error(assertion.message);
          err.detail = assertion;
          throw err;
        }
        return { ok: true, type, result: assertion };
      }
      case 'assert_element': {
        requireElementTarget(step, 'assert_element');
        const resolvedStep = await resolveElementTargetParams(step);
        const assertion = dom.assertElement(resolvedStep);
        if (!assertion.ok) {
          const err = new Error(assertion.message);
          err.detail = assertion;
          throw err;
        }
        return { ok: true, type, result: assertion };
      }
      case 'reload': {
        const result = await reloadPage(step);
        return {
          ok: true,
          type,
          result: {
            ...result,
            note: 'Reload was scheduled. Put reload_page before run_actions when subsequent verification must happen after the reload.',
          },
          stopAction: true,
        };
      }
      default:
        throw new Error(`Unsupported run_actions step: ${type}`);
    }
  }

  async function runActions(params = {}) {
    const actions = Array.isArray(params.actions) ? params.actions : [];
    const stepTimeoutMs = Math.max(500, Math.min(Number(params.stepTimeoutMs) || 5000, 30000));
    const results = [];

    for (const action of actions) {
      const label = String(action?.label || `Action ${results.length + 1}`);
      const steps = Array.isArray(action?.steps) ? action.steps : [];
      const actionResult = {
        label,
        ok: true,
        steps: [],
        screenshots: [],
      };

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] || {};
        try {
          const stepResult = await withStepTimeout(
            Promise.resolve(runStep(step, label, i, stepTimeoutMs)),
            stepTimeoutMs,
            step,
          );
          actionResult.steps.push({
            index: i,
            type: step.type,
            ok: true,
            result: stepResult.result,
          });
          if (stepResult.screenshot) {
            actionResult.screenshots.push(stepResult.screenshot);
          }
          if (stepResult.stopAction) {
            break;
          }
        } catch (err) {
          actionResult.ok = false;
          actionResult.error = stepError(i, step, err, err.detail);
          actionResult.steps.push({
            index: i,
            type: step.type || 'unknown',
            ok: false,
            error: actionResult.error,
          });
          break;
        }
      }

      results.push(actionResult);
    }

    return { results };
  }

  function requestUserAssistance(params = {}) {
    const message = String(params.message || '请在当前页面完成需要的操作，然后点击“已完成，继续”。');
    const timeoutMs = Math.max(5000, Math.min(Number(params.timeoutMs) || 5 * 60 * 1000, 10 * 60 * 1000));
    const startedAt = Date.now();
    const host = document.getElementById('dom-review-host');
    const root = host?.shadowRoot || document.body;
    const previous = root.querySelector?.('#dt-user-assistance');
    if (previous) previous.remove();

    return new Promise(resolve => {
      const box = document.createElement('div');
      box.id = 'dt-user-assistance';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-live', 'polite');
      box.innerHTML = `
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#f8fafc;">需要你协助一下</div>
        <div style="font-size:12px;line-height:1.5;color:#cbd5e1;white-space:pre-wrap;margin-bottom:10px;"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" data-action="cancel" style="border:1px solid rgba(255,255,255,.14);background:#334155;color:#e2e8f0;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;">取消</button>
          <button type="button" data-action="done" style="border:1px solid rgba(96,165,250,.5);background:#2563eb;color:white;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;">已完成，继续</button>
        </div>
      `;
      Object.assign(box.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        width: '320px',
        maxWidth: 'calc(100vw - 36px)',
        zIndex: '2147483647',
        padding: '14px',
        borderRadius: '12px',
        border: '1px solid rgba(96,165,250,.35)',
        background: 'rgba(15,23,42,.96)',
        boxShadow: '0 18px 50px rgba(0,0,0,.38)',
        fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        pointerEvents: 'auto',
      });
      box.children[1].textContent = message;

      let settled = false;
      let timer = null;
      const cleanup = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        box.remove();
        resolve({
          status,
          completed: status === 'completed',
          message,
          elapsedMs: Date.now() - startedAt,
          url: location.href,
          title: document.title,
        });
      };

      box.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        cleanup(button.dataset.action === 'done' ? 'completed' : 'canceled');
      });
      timer = setTimeout(() => cleanup('timeout'), timeoutMs);
      root.appendChild(box);
    });
  }

  async function handle(action) {
    const name = action.action;
    const params = action.params || {};
    switch (name) {
      case 'take_visible_screenshot':
        return captureVisibleScreenshot(params);
      case 'get_page_snapshot':
        return window.__domReview.browserActionDom.snapshot(params);
      case 'get_console_logs':
        return window.__domReview.browserConsole?.getLogs?.(params) || { messages: [], total: 0 };
      case 'get_console_message':
        return { message: window.__domReview.browserConsole?.getMessage?.(params) || null };
      case 'reload_page':
        return reloadPage(params);
      case 'click_page': {
        const resolvedParams = await resolveElementTargetParams(params);
        const result = await window.__domReview.browserActionDom.click(resolvedParams);
        await sleep(params.waitAfterMs);
        return result;
      }
      case 'type_text': {
        const resolvedParams = await resolveElementTargetParams(params);
        const result = window.__domReview.browserActionDom.typeText(resolvedParams);
        await sleep(params.waitAfterMs);
        return result;
      }
      case 'fill_text': {
        const resolvedParams = await resolveElementTargetParams(params);
        const result = window.__domReview.browserActionDom.fillText(resolvedParams);
        await sleep(params.waitAfterMs);
        return result;
      }
      case 'run_actions':
        return runActions(params);
      case 'press_key': {
        const resolvedParams = await resolveElementTargetParams(params);
        const result = window.__domReview.browserActionDom.pressKey(resolvedParams);
        await sleep(params.waitAfterMs);
        return result;
      }
      case 'clear_state': {
        const result = window.__domReview.browserActionDom.clearState(params);
        await sleep(params.waitAfterMs);
        return result;
      }
      case 'wait_for_selector': {
        const selector = String(params.selector || '');
        if (!selector) throw new Error('wait_for_selector requires selector');
        const el = await waitUntil(() => {
          const found = document.querySelector(selector);
          return found && window.__domReview.browserActionDom.isVisible(found) ? found : null;
        }, params.timeoutMs, `Timed out waiting for selector: ${selector}`);
        return { selector, found: true, rect: rectJson(el) };
      }
      case 'wait_for_text': {
        const text = String(params.text || '');
        if (!text) throw new Error('wait_for_text requires text');
        await waitUntil(
          () => window.__domReview.browserActionDom.textInScope(text, params.selector),
          params.timeoutMs,
          `Timed out waiting for text: ${text}`,
        );
        return { text, selector: params.selector || null, found: true };
      }
      case 'request_user_assistance':
        return requestUserAssistance(params);
      case 'get_element_targets':
        return {
          targets: await window.__domReview.elementTargets?.listAllTargets?.() || [],
        };
      case 'save_element_target': {
        const target = await window.__domReview.elementTargets?.savePayload?.(params);
        return { target };
      }
      case 'delete_element_target': {
        const targetId = params.targetId || params.id;
        const targetName = params.targetName;
        if (!targetId && !targetName) {
          throw new Error('Missing targetId or targetName for delete_element_target');
        }
        // Try delete by id first, then by name
        if (targetId) {
          await window.__domReview.elementTargets?.deleteTarget?.(targetId);
          return { deleted: targetId };
        }
        // Delete by name: list and find matching
        const targets = await window.__domReview.elementTargets?.listAllTargets?.() || [];
        const match = targets.find(t => String(t.name || '').trim().toLowerCase() === String(targetName).trim().toLowerCase());
        if (!match) {
          throw new Error(`Element target not found by name: ${targetName}`);
        }
        await window.__domReview.elementTargets?.deleteTarget?.(match.id || match.targetId);
        return { deleted: match.id || match.targetId };
      }
      case 'run_js': {
        const result = await window.__domReview.browserActionDom.runJs(params);
        return { executed: true, result };
      }
      default:
        throw new Error(`Unsupported browser action: ${name}`);
    }
  }

  window.__domReview.browserActions = { handle };
})();
