/**
 * DevTailor — Export/Import Module
 *
 * Handles exporting reviews as JSON file download and importing
 * from JSON file or raw data.
 *
 * Depends on: store (Track 1) — toJSON(), fromJSON()
 * Registers: window.__domReview.exportImport
 */
(() => {
  'use strict';
  window.__domReview = window.__domReview || {};

  function getFilename() {
    const host = location.hostname.replace(/[^a-z0-9]/gi, '-');
    const date = new Date().toISOString().slice(0, 10);
    return `devtailor-${host}-${date}.json`;
  }

  function validate(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.reviews)) return false;
    return data.reviews.every(r =>
      r && typeof r.id === 'string' &&
      typeof r.selector === 'string' &&
      typeof r.comment === 'string'
    );
  }

  function exportJSON() {
    const { store } = window.__domReview;
    const data = store.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = getFilename();
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function importJSON() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          importFromData(data);
        } catch (e) {
          alert('Failed to parse JSON file: ' + e.message);
        }
      };
      reader.onerror = () => alert('Failed to read file.');
      reader.readAsText(file);
      // Cleanup
      document.body.removeChild(input);
    });

    document.body.appendChild(input);
    input.click();
  }

  function importFromData(data) {
    if (!validate(data)) {
      alert('Invalid review data format. Expected { version, reviews: [...] }');
      return;
    }
    const { store } = window.__domReview;
    store.fromJSON(data);
  }

  window.__domReview.exportImport = { exportJSON, importJSON, importFromData };
})();
