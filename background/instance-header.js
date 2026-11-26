/** Pure helpers for the optional Hub instance-selection request header. */
(() => {
  'use strict';

  const INSTANCE_HEADER = 'X-DevTailor-Instance';
  const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  function normalizeInstanceId(value) {
    if (typeof value !== 'string') return '';
    const id = value.trim();
    return INSTANCE_ID_PATTERN.test(id) ? id : '';
  }

  function buildInstanceHeaders(value) {
    const id = normalizeInstanceId(value);
    return id ? { [INSTANCE_HEADER]: id } : {};
  }

  function instanceOptions(health, selectedId) {
    const instances = Array.isArray(health?.instances)
      ? health.instances.filter(item => normalizeInstanceId(item?.instanceId))
      : [];
    const selected = normalizeInstanceId(selectedId);
    const defaultInstance = instances.find(item => item.instanceId === health?.defaultInstanceId);
    const options = [{
      value: '',
      label: instances.length === 0
        ? '自动（无在线实例）'
        : `自动（${defaultInstance?.name || instances[0]?.name || '默认实例'}）`,
      offline: false,
    }];
    for (const item of instances) {
      options.push({ value: item.instanceId, label: item.name || item.instanceId, offline: false });
    }
    if (selected && !instances.some(item => item.instanceId === selected)) {
      options.push({ value: selected, label: '所选实例已离线', offline: true });
    }
    return { selected, options };
  }

  const api = { INSTANCE_HEADER, INSTANCE_ID_PATTERN, normalizeInstanceId, buildInstanceHeaders, instanceOptions };
  if (typeof module === 'object' && module.exports) module.exports = api;
  const root = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null);
  if (root) {
    root.__domReview = root.__domReview || {};
    root.__domReview.instanceHeader = api;
  }
})();
