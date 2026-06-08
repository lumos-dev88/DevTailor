/**
 * DevTailor — Orchestrator
 *
 * Wires all modules together. Runs last in content_scripts injection order.
 */
(() => {
  'use strict';
  const { store, ui, selector, selectorGen, contextCapture, badges, sidebar } = window.__domReview;

  // Check if extension is enabled before initializing
  chrome.storage.sync.get('dr_enabled', (result) => {
    if (result.dr_enabled === false) {
      console.log('[DevTailor] Extension is disabled.');
      return;
    }
    bootstrap();
  });

  function bootstrap() {
    // 1. Init Shadow DOM UI
    ui.init();

    // 3. Initialize sidebar and persistent highlights
    sidebar.render();
    sidebar.updatePersistentHighlights();

    // 3.5. Initialize chat panel
    if (window.__domReview.chatPanel) {
      try {
        window.__domReview.chatPanel.init();
      } catch (err) {
        console.error('[DevTailor] Chat panel init failed:', err);
      }
    }

    // 3.55. Initialize element saver
    if (window.__domReview.elementSaver) {
      window.__domReview.elementSaver.init();
    }

    // 3.6. Wire WebSocket connection status to UI
    let currentConnStatus = 'disconnected';
    function updateStatusBar() {
      const ws = window.__domReview.wsClient;
      if (!ws) return;
      ui.setConnectionStatus(
        currentConnStatus,
        ws.getSessionTitle?.() || '新会话',
        Boolean(ws.isActive?.()),
      );
    }
    if (window.__domReview.wsClient) {
      window.__domReview.wsClient.onStatusChange((status) => {
        currentConnStatus = status;
        updateStatusBar();
      });
      window.__domReview.wsClient.onSessionChange?.(() => {
        updateStatusBar();
      });
      currentConnStatus = window.__domReview.wsClient.getStatus();
      updateStatusBar();
    }

    // 4. Render badges for restored reviews (with retries for SPA)
    badges.render();
    [500, 1000, 2000, 4000].forEach(ms => setTimeout(() => badges.render(), ms));

    function syncMarkModeUi() {
      if (!selector.isActive()) {
        ui.setMarkMode?.('idle');
      } else if (selector.isPaused?.()) {
        ui.setMarkMode?.('describing');
      } else {
        ui.setMarkMode?.('selecting');
      }
    }

    function closeDescriptionCard(options = {}) {
      window.__domReview.badges?.closeFloating?.(options);
    }

    function enterOrAdvanceMarkMode() {
      window.__domReview.chatPanel?.prepareForPageSelection?.();
      if (!selector.isActive()) {
        selector.enable();
        return;
      }
      if (selector.isPaused?.()) {
        closeDescriptionCard({ save: true, resume: true });
      }
    }

    function exitMarkMode() {
      closeDescriptionCard({ save: true, resume: false });
      selector.disable();
    }

    selector.onStateChange?.(syncMarkModeUi);

    // 5. Wire toolbar Mark button -> explicit mark workflow states
    ui.onMarkClick(() => {
      if (!selector.isActive() || selector.isPaused?.()) {
        enterOrAdvanceMarkMode();
      } else {
        exitMarkMode();
      }
      syncMarkModeUi();
    });

    // 5.5. Wire toolbar Save Element button -> independent one-shot element saving
    ui.onSaveElementClick?.(() => {
      const elementSaver = window.__domReview.elementSaver;
      if (!elementSaver) {
        console.warn('[DevTailor] Element saver module not loaded.');
        return;
      }

      // If already active, toggle off
      if (elementSaver.isActive()) {
        elementSaver.disable();
        return;
      }

      // Exit mark mode if active
      if (selector.isActive()) {
        exitMarkMode();
        syncMarkModeUi();
      }

      elementSaver.showLibraryCard?.();
    });

    // 6. Wire toolbar Screenshot button
    ui.onScreenshotClick(() => {
      if (window.__domReview.screenshot) {
        window.__domReview.screenshot.capture();
      } else {
        console.warn('[DevTailor] Screenshot module not loaded yet.');
      }
    });

    // 7. Wire toolbar New Session button
    ui.onNewSessionClick(() => {
      if (window.__domReview.chatPanel) {
        window.__domReview.chatPanel.requestNewSession();
      }
    });

    // 8. Wire toolbar Close button -> collapse to FAB
    ui.onCloseClick(() => {
      ui.hideSidebar();
    });

    // 8.1 Wire FAB click -> expand sidebar
    ui.onFabClick(() => {
      ui.showSidebar();
    });

    ui.onUndoMarkClick(() => {
      sidebar.undoLast();
    });

    ui.onDiscardBatchClick(() => {
      const count = store.getAll().length;
      if (count > 0) {
        sidebar.discardBatch();
      }
    });

    // 10. Wire element selection -> add mark to store
    selector.onSelect((element, options = {}) => {
      const selectorData = selectorGen.generate(element);
      const context = contextCapture.capture(element);
      const quick = Boolean(options.quick);

      // Check for duplicates (same selector + similar bounding box)
      const existing = store.getAll().find(r => {
        if (r.selector !== selectorData.css) return false;
        const box = r.context && r.context.boundingBox;
        const newBox = context && context.boundingBox;
        if (!box || !newBox) return false;
        const dx = Math.abs(box.x - newBox.x);
        const dy = Math.abs(box.y - newBox.y);
        return dx < 5 && dy < 5;
      });

      if (existing) {
        badges.flashReview(existing.id);
        return;
      }

      const reviewId = `r_${Date.now()}`;
      store.add({
        id: reviewId,
        selector: selectorData.css,
        xpath: selectorData.xpath,
        comment: '',
        context,
        created: new Date().toISOString(),
      });

      if (quick) {
        badges.flashReview(reviewId);
        syncMarkModeUi();
        return;
      }

      badges.selectReview(reviewId, { focusEditor: true });
      selector.pause();
      syncMarkModeUi();

      // Selector mode stays active; the opened mark card keeps the existing
      // "select → describe → collapse → select next" workflow without
      // capturing more page clicks while the note editor is open.
    });

    // 11. React to store changes
    store.onChange((reviews) => {
      badges.render();
      sidebar.render();
      sidebar.updatePersistentHighlights();
      if (window.__domReview.chatPanel) {
        window.__domReview.chatPanel.refreshSendState();
      }
    });

    // 12. Handle SPA navigation
    window.addEventListener('popstate', () => {
      badges.cleanup();
      sidebar.render();
      sidebar.updatePersistentHighlights();
      badges.render();
    });

    console.log('[DevTailor] Extension loaded. Marks:', store.getAll().length);
  }
})();
