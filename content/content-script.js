/**
 * DevTailor — Orchestrator
 *
 * Wires all modules together. Runs last in content_scripts injection order.
 *
 * The page-side UI is only the marks toolbar (toolbar.js). Chat, sessions, approvals, mode, plan and
 * usage live in the side panel; marks flow there through marks-sync.js.
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
    const toolbar = window.__domReview.toolbar;

    // 1. Shadow DOM host + marks toolbar
    ui.init();

    function syncMarkModeUi() {
      if (!selector.isActive()) {
        toolbar?.setPickMode('idle');
      } else if (selector.isPaused?.()) {
        toolbar?.setPickMode('describing');
      } else {
        toolbar?.setPickMode('selecting');
      }
    }

    function closeDescriptionCard(options = {}) {
      window.__domReview.badges?.closeFloating?.(options);
    }

    function enterOrAdvanceMarkMode() {
      // Picking and saving to the library are exclusive page-click modes.
      if (window.__domReview.elementSaver?.isActive()) window.__domReview.elementSaver.disable();
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

    // 2. Toolbar "选取" -> explicit mark workflow states
    toolbar?.init({
      onPick: () => {
        if (!selector.isActive() || selector.isPaused?.()) {
          enterOrAdvanceMarkMode();
        } else {
          exitMarkMode();
        }
        syncMarkModeUi();
      },
    });

    // 3. Persistent highlights, element library, side-panel sync
    sidebar.updatePersistentHighlights();
    window.__domReview.elementSaver?.init();
    window.__domReview.marksSync?.init();

    // 4. Render badges for restored reviews (with retries for SPA)
    badges.render();
    [500, 1000, 2000, 4000].forEach(ms => setTimeout(() => badges.render(), ms));

    // 5. Element selection -> add mark to store
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

    // 6. React to store changes
    store.onChange(() => {
      badges.render();
      sidebar.updatePersistentHighlights();
    });

    // 7. Handle SPA navigation
    window.addEventListener('popstate', () => {
      badges.cleanup();
      sidebar.updatePersistentHighlights();
      badges.render();
    });

    console.log('[DevTailor] Extension loaded. Marks:', store.getAll().length);
  }
})();
