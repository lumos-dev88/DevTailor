/**
 * DevTailor — Chat Image Manager
 *
 * Owns pending screenshot/pasted images and thumbnail preview rendering.
 *
 * Registers: window.__domReview.chatImages
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function isImageDataUrl(value) {
    return typeof value === 'string'
      && /^data:image\/[a-z0-9+.-]+;base64,[a-z0-9+/\s]+=*$/i.test(value);
  }

  function normalizeImages(value) {
    if (Array.isArray(value)) {
      return value.filter(isImageDataUrl);
    }
    if (typeof value === 'string' && isImageDataUrl(value)) {
      return [value];
    }
    return [];
  }

  function create({ getPreview, showHint, refreshSendState, schedulePersist }) {
    let pendingImages = [];

    function getImages() {
      return pendingImages.slice();
    }

    function getScreenshot() {
      return pendingImages[0] || null;
    }

    function count() {
      return pendingImages.length;
    }

    function setImages(value, options = {}) {
      pendingImages = normalizeImages(value);
      if (options.render !== false) renderPreview();
      if (options.persist) schedulePersist?.();
    }

    function clear(options = {}) {
      pendingImages = [];
      if (options.render !== false) renderPreview();
      if (options.persist) schedulePersist?.();
    }

    function setScreenshot(base64) {
      return addImage(base64);
    }

    function addImage(base64) {
      if (!isImageDataUrl(base64)) return false;
      pendingImages.push(base64);
      renderPreview();
      schedulePersist?.();
      return true;
    }

    function removeScreenshot(index) {
      if (typeof index === 'number') {
        pendingImages.splice(index, 1);
      } else {
        pendingImages = [];
      }
      renderPreview();
      schedulePersist?.();
    }

    function setScreenshotFromFile(file) {
      if (!file || !file.type || !file.type.startsWith('image/')) return false;

      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') return;
        if (!addImage(reader.result)) {
          showHint?.('暂不支持该图片格式，请使用 PNG、JPEG 或 WebP');
          return;
        }
        showHint?.(`图片已添加（共 ${pendingImages.length} 张），发送时会一起带给 AI`);
        refreshSendState?.();
      };
      reader.onerror = () => {
        showHint?.('图片读取失败，请重新复制后粘贴');
      };
      reader.readAsDataURL(file);
      return true;
    }

    function handlePaste(e) {
      const items = Array.from(e.clipboardData?.items || []);

      const imageItems = items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
      if (imageItems.length) {
        const handled = imageItems
          .map(item => item.getAsFile())
          .filter(Boolean)
          .map(file => setScreenshotFromFile(file))
          .some(Boolean);
        if (handled) e.preventDefault();
        return;
      }

      const htmlItem = items.find(item => item.kind === 'string' && item.type === 'text/html');
      if (htmlItem) {
        htmlItem.getAsString((html) => {
          const match = html.match(/<img[^>]+src="(data:image\/[^"]+)"/i);
          if (match && match[1]) {
            const url = match[1].replace(/&amp;/g, '&');
            if (addImage(url)) {
              e.preventDefault();
              showHint?.(`图片已添加（共 ${pendingImages.length} 张），发送时会一起带给 AI`);
              refreshSendState?.();
            }
          }
        });
        return;
      }

      const plainItem = items.find(item => item.kind === 'string' && item.type === 'text/plain');
      if (plainItem) {
        plainItem.getAsString((text) => {
          const trimmed = text.trim();
          if (isImageDataUrl(trimmed) && addImage(trimmed)) {
            e.preventDefault();
            showHint?.(`图片已添加（共 ${pendingImages.length} 张），发送时会一起带给 AI`);
            refreshSendState?.();
          }
        });
      }
    }

    function renderPreview() {
      const preview = getPreview?.();
      if (!preview) return;

      if (!pendingImages.length) {
        preview.classList.remove('has-image');
        preview.innerHTML = '';
        return;
      }

      preview.classList.add('has-image');
      preview.innerHTML = `
        <div class="dt-screenshot-list">
          ${pendingImages.map((src, idx) => `
            <div class="dt-screenshot-wrap">
              <img src="${escapeHtml(src)}" alt="截图 ${idx + 1}" data-preview-image="${escapeHtml(src)}">
              <button class="dt-screenshot-remove" data-image-index="${idx}" title="移除截图">×</button>
            </div>
          `).join('')}
        </div>
      `;

      preview.querySelectorAll('.dt-screenshot-remove').forEach(btn => {
        btn.addEventListener('click', () => {
          removeScreenshot(Number(btn.dataset.imageIndex));
          refreshSendState?.();
        });
      });
    }

    return {
      getImages,
      getScreenshot,
      count,
      setImages,
      clear,
      setScreenshot,
      addImage,
      removeScreenshot,
      setScreenshotFromFile,
      handlePaste,
      renderPreview,
    };
  }

  window.__domReview.chatImages = {
    create,
    isImageDataUrl,
    normalizeImages,
  };
})();
