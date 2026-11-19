/**
 * DevTailor — project header (pure logic, no DOM, no chrome API)
 *
 * Every request the extension makes to the Bridge/Hub carries the project the
 * bridge serves, so a Hub fronting several projects knows who is asking.
 * The value must stay header-safe: only [A-Za-z0-9_-] is allowed, anything else
 * (spaces, separators, control characters) means "no project" — we drop the
 * header instead of sending a mangled/injected one.
 *
 * Loaded by the service worker through importScripts (self.__domReview.projectHeader).
 * Node (tests): module.exports.
 */
(() => {
  'use strict';

  const PROJECT_HEADER = 'X-DevTailor-Project';
  const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  /** Header-safe project id, or '' when the value cannot be sent as a header. */
  function normalizeProjectId(projectId) {
    if (typeof projectId !== 'string') return '';
    const value = projectId.trim();
    return PROJECT_ID_PATTERN.test(value) ? value : '';
  }

  /** `{ 'X-DevTailor-Project': id }` or `{}` when there is no usable project id. */
  function buildProjectHeaders(projectId) {
    const id = normalizeProjectId(projectId);
    return id ? { [PROJECT_HEADER]: id } : {};
  }

  const api = {
    PROJECT_HEADER,
    PROJECT_ID_PATTERN,
    normalizeProjectId,
    buildProjectHeaders,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;

  const root = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null);
  if (root) {
    root.__domReview = root.__domReview || {};
    root.__domReview.projectHeader = api;
  }
})();
