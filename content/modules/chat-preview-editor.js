/**
 * DevTailor — Chat Image Preview Editor
 *
 * Owns the image preview modal and lightweight canvas annotations.
 *
 * Registers: window.__domReview.chatPreviewEditor
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function create({ ui, isImageDataUrl, addImage, showHint }) {
    const editorState = {
      tool: null,
      color: '#ef4444',
      stroke: 3,
      isDrawing: false,
      startX: 0,
      startY: 0,
      history: [],
      currentImageSrc: null,
    };

    function getCanvasCtx() {
      const canvas = ui.getImagePreviewCanvas?.();
      if (!canvas) return null;
      return canvas.getContext('2d');
    }

    function setupCanvasForImage() {
      const canvas = ui.getImagePreviewCanvas?.();
      const img = ui.getImagePreviewImage?.();
      const wrap = ui.getImagePreviewWrap?.();
      if (!canvas || !img || !wrap) return;

      const rect = img.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      canvas.style.left = (rect.left - wrapRect.left) + 'px';
      canvas.style.top = (rect.top - wrapRect.top) + 'px';
    }

    function saveCanvasState() {
      const canvas = ui.getImagePreviewCanvas?.();
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      editorState.history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (editorState.history.length > 20) editorState.history.shift();
    }

    function undoCanvas() {
      const canvas = ui.getImagePreviewCanvas?.();
      if (!canvas || editorState.history.length === 0) return;
      const ctx = canvas.getContext('2d');
      const state = editorState.history.pop();
      ctx.putImageData(state, 0, 0);
    }

    function clearCanvas() {
      const canvas = ui.getImagePreviewCanvas?.();
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      editorState.history = [];
    }

    function getCanvasPoint(e) {
      const canvas = ui.getImagePreviewCanvas?.();
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    function drawRect(ctx, x1, y1, x2, y2) {
      const w = x2 - x1;
      const h = y2 - y1;
      ctx.strokeStyle = editorState.color;
      ctx.lineWidth = editorState.stroke;
      ctx.strokeRect(x1, y1, w, h);
    }

    function drawArrow(ctx, x1, y1, x2, y2) {
      const headLen = Math.max(12, editorState.stroke * 4);
      const angle = Math.atan2(y2 - y1, x2 - x1);
      ctx.strokeStyle = editorState.color;
      ctx.fillStyle = editorState.color;
      ctx.lineWidth = editorState.stroke;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }

    function startTextAnnotation(e) {
      const canvas = ui.getImagePreviewCanvas?.();
      const wrap = ui.getImagePreviewWrap?.();
      if (!canvas || !wrap) return;

      const pt = getCanvasPoint(e);
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'dt-image-text-input';
      input.style.left = pt.x + 'px';
      input.style.top = pt.y + 'px';
      input.style.color = editorState.color;
      input.style.fontSize = Math.max(12, editorState.stroke * 5) + 'px';
      input.placeholder = '输入文字...';

      wrap.appendChild(input);
      input.focus();

      function commit() {
        const text = input.value.trim();
        if (text) {
          saveCanvasState();
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = editorState.color;
          ctx.font = `600 ${Math.max(12, editorState.stroke * 5)}px sans-serif`;
          ctx.fillText(text, pt.x, pt.y + Math.max(12, editorState.stroke * 5) * 0.8);
        }
        input.remove();
      }

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        if (ev.key === 'Escape') input.remove();
      });
      input.addEventListener('blur', commit);
    }

    function init() {
      const canvas = ui.getImagePreviewCanvas?.();
      const toolbar = ui.getImageEditorToolbar?.();
      const colorPicker = ui.getImageColorPicker?.();
      const strokeInput = ui.getImageStrokeInput?.();
      const undoBtn = ui.getImageUndoBtn?.();
      const saveBtn = ui.getImageSaveBtn?.();
      if (!canvas || !toolbar) return;

      toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tool]');
        if (!btn) return;
        const tool = btn.dataset.tool;
        if (editorState.tool === tool) {
          editorState.tool = null;
          btn.classList.remove('dt-active');
          canvas.style.cursor = 'default';
        } else {
          toolbar.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('dt-active'));
          editorState.tool = tool;
          btn.classList.add('dt-active');
          canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
        }
      });

      if (colorPicker) {
        colorPicker.addEventListener('input', (e) => {
          editorState.color = e.target.value;
        });
      }

      if (strokeInput) {
        strokeInput.addEventListener('input', (e) => {
          editorState.stroke = parseInt(e.target.value, 10) || 3;
        });
      }

      if (undoBtn) {
        undoBtn.addEventListener('click', undoCanvas);
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', saveEditedImage);
      }

      canvas.addEventListener('pointerdown', (e) => {
        if (!editorState.tool) return;
        e.preventDefault();
        if (editorState.tool === 'text') {
          startTextAnnotation(e);
          return;
        }
        editorState.isDrawing = true;
        const pt = getCanvasPoint(e);
        editorState.startX = pt.x;
        editorState.startY = pt.y;
        saveCanvasState();
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!editorState.isDrawing || !editorState.tool || editorState.tool === 'text') return;
        const pt = getCanvasPoint(e);
        const ctx = getCanvasCtx();
        if (!ctx) return;

        ctx.putImageData(editorState.history[editorState.history.length - 1], 0, 0);

        if (editorState.tool === 'rect') {
          drawRect(ctx, editorState.startX, editorState.startY, pt.x, pt.y);
        } else if (editorState.tool === 'arrow') {
          drawArrow(ctx, editorState.startX, editorState.startY, pt.x, pt.y);
        }
      });

      const finishDraw = () => {
        if (!editorState.isDrawing) return;
        editorState.isDrawing = false;
      };

      canvas.addEventListener('pointerup', finishDraw);
      canvas.addEventListener('pointerleave', finishDraw);
    }

    function saveEditedImage() {
      const canvas = ui.getImagePreviewCanvas?.();
      const img = ui.getImagePreviewImage?.();
      if (!canvas || !img) return;

      const merged = document.createElement('canvas');
      merged.width = canvas.width;
      merged.height = canvas.height;
      const ctx = merged.getContext('2d');
      ctx.drawImage(img, 0, 0, merged.width, merged.height);
      ctx.drawImage(canvas, 0, 0);

      const dataUrl = merged.toDataURL('image/png');
      editorState.currentImageSrc = dataUrl;

      addImage(dataUrl);
      showHint?.('编辑后的图片已保存到聊天输入框');
      close();
    }

    function open(src) {
      if (!isImageDataUrl(src)) return;
      const modal = ui.getImagePreview?.();
      const image = ui.getImagePreviewImage?.();
      if (!modal || !image) return;

      editorState.currentImageSrc = src;
      editorState.tool = null;
      editorState.history = [];
      editorState.isDrawing = false;

      image.src = src;
      image.onload = () => {
        setupCanvasForImage();
        clearCanvas();
      };

      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
    }

    function close() {
      const modal = ui.getImagePreview?.();
      const image = ui.getImagePreviewImage?.();
      if (!modal || !image || !modal.classList.contains('is-open')) return;
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      image.removeAttribute('src');
      clearCanvas();
      editorState.tool = null;
      editorState.history = [];
      const toolbar = ui.getImageEditorToolbar?.();
      if (toolbar) toolbar.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('dt-active'));
    }

    function handlePreviewClick(e) {
      const image = e.target.closest('[data-preview-image]');
      if (!image) return false;
      e.preventDefault();
      open(image.dataset.previewImage);
      return true;
    }

    return {
      init,
      open,
      close,
      handlePreviewClick,
    };
  }

  window.__domReview.chatPreviewEditor = { create };
})();
