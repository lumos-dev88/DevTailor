/**
 * DevTailor — Framework Bridge (MAIN world)
 *
 * This script runs in the PAGE's JavaScript context (world: "MAIN"),
 * NOT in the extension's isolated world. It has full access to
 * __vue__, __reactFiber$, __ngContext__ etc.
 *
 * Communication with the content script happens via:
 *   - Custom DOM events (synchronous via dispatchEvent)
 *   - DOM attributes (shared between worlds)
 */
(function() {
  'use strict';

  if (window.__DEVTAILOR_FRAMEWORK_BRIDGE_INSTALLED__) return;
  window.__DEVTAILOR_FRAMEWORK_BRIDGE_INSTALLED__ = true;

  var MAX_DEPTH = 30;
  var MAX_KEYS = 20;

  // --- Utilities ---

  function summarize(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'function') return '[Function]';
    if (typeof val === 'symbol') return '[Symbol]';
    if (val instanceof HTMLElement) return '[HTMLElement]';
    if (val instanceof Node) return '[Node]';
    if (Array.isArray(val)) return '[Array(' + val.length + ')]';
    if (typeof val === 'object') {
      try {
        var keys = Object.keys(val);
        if (keys.length <= 3) {
          var o = {};
          keys.forEach(function(k) {
            try { o[k] = typeof val[k] === 'object' ? '[Object]' : val[k]; }
            catch(e) { o[k] = '[err]'; }
          });
          return o;
        }
      } catch(e) {}
      return '[Object]';
    }
    return val;
  }

  function shallow(obj) {
    if (!obj || typeof obj !== 'object') return {};
    var result = {}, count = 0;
    try {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        if (count >= MAX_KEYS) break;
        var k = keys[i];
        if (k.charAt(0) === '_' || k.charAt(0) === '$') continue;
        if (k === 'children' || k === 'key' || k === 'ref') continue;
        try { result[k] = summarize(obj[k]); }
        catch(e) { result[k] = '[inaccessible]'; }
        count++;
      }
    } catch(e) {}
    return result;
  }

  // --- Framework Detectors ---

  function tryVue3(el) {
    var cur = el, depth = 0;
    while (cur && depth < MAX_DEPTH) {
      var inst = cur.__vueParentComponent;
      if (inst) {
        var type = inst.type || {};
        var name = type.name || type.__name || 'Anonymous';
        var filePath = type.__file || null;
        var props = shallow(inst.props);
        var stateSource = inst.setupState || inst.data || {};
        var state = shallow(typeof stateSource === 'function' ? {} : stateSource);
        var parentName = null;
        if (inst.parent && inst.parent.type) {
          parentName = inst.parent.type.name || inst.parent.type.__name || null;
        }
        return {
          framework: 'vue3', componentName: name, filePath: filePath,
          props: props, state: state, parentComponentName: parentName,
          componentRootElement: cur.tagName.toLowerCase()
        };
      }
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function tryVue2(el) {
    var cur = el, depth = 0;
    while (cur && depth < MAX_DEPTH) {
      if (cur.__vue__) {
        var vm = cur.__vue__;
        var opts = vm.$options || {};
        var name = opts.name || opts._componentTag || 'Anonymous';
        var filePath = opts.__file || null;
        var props = shallow(vm.$props);
        var state = shallow(vm.$data);
        var parentName = null;
        if (vm.$parent && vm.$parent.$options) {
          parentName = vm.$parent.$options.name || vm.$parent.$options._componentTag || null;
        }
        return {
          framework: 'vue2', componentName: name, filePath: filePath,
          props: props, state: state, parentComponentName: parentName,
          componentRootElement: cur.tagName.toLowerCase()
        };
      }
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  function tryReact(el) {
    var fiberKey = null;
    function findKey(node) {
      if (fiberKey && node[fiberKey] !== undefined) return fiberKey;
      var keys = Object.keys(node);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          fiberKey = keys[i]; return fiberKey;
        }
      }
      return null;
    }
    function findComp(fiber) {
      var c = fiber, d = 0;
      while (c && d < MAX_DEPTH) {
        if (c.type && typeof c.type !== 'string') return c;
        c = c.return; d++;
      }
      return null;
    }
    var cur = el, depth = 0;
    while (cur && depth < MAX_DEPTH) {
      var key = findKey(cur);
      if (key) {
        var comp = findComp(cur[key]);
        if (comp) {
          var name = comp.type.displayName || comp.type.name || 'Anonymous';
          var filePath = comp._debugSource ? comp._debugSource.fileName : null;
          var props = shallow(comp.memoizedProps);
          var state = {};
          if (comp.memoizedState && typeof comp.memoizedState === 'object'
              && !comp.memoizedState.memoizedState) {
            state = shallow(comp.memoizedState);
          }
          var parentName = null;
          if (comp.return) {
            var p = findComp(comp.return);
            if (p) parentName = p.type.displayName || p.type.name || null;
          }
          return {
            framework: 'react', componentName: name, filePath: filePath,
            props: props, state: state, parentComponentName: parentName,
            componentRootElement: cur.tagName.toLowerCase()
          };
        }
      }
      cur = cur.parentElement; depth++;
    }
    return null;
  }

  function tryAngular(el) {
    var cur = el, depth = 0;
    while (cur && depth < MAX_DEPTH) {
      var ctx = cur.__ngContext__;
      if (ctx && Array.isArray(ctx)) {
        for (var i = 0; i < ctx.length && i < 50; i++) {
          var item = ctx[i];
          if (item && typeof item === 'object' && !Array.isArray(item)
              && item.constructor && item.constructor.name
              && item.constructor.name !== 'Object'
              && !(item instanceof Node)) {
            var name = item.constructor.name;
            var props = shallow(item);
            return {
              framework: 'angular', componentName: name, filePath: null,
              props: props, state: props, parentComponentName: null,
              componentRootElement: cur.tagName.toLowerCase()
            };
          }
        }
      }
      cur = cur.parentElement; depth++;
    }
    return null;
  }

  function detectElement(el) {
    return tryVue3(el) || tryVue2(el) || tryReact(el) || tryAngular(el) || null;
  }

  function detectPage() {
    var frameworks = [];
    var app = document.getElementById('app') || document.body.firstElementChild;
    // Vue 3
    if (app && app.__vue_app__) frameworks.push('vue3');
    if (frameworks.indexOf('vue3') === -1 && app) {
      var c = app, d = 0;
      while (c && d < 8) {
        if (c.__vueParentComponent) { frameworks.push('vue3'); break; }
        c = c.firstElementChild; d++;
      }
    }
    // Vue 2
    if (app) {
      var c2 = app, d2 = 0;
      while (c2 && d2 < 8) {
        if (c2.__vue__) { frameworks.push('vue2'); break; }
        c2 = c2.firstElementChild; d2++;
      }
    }
    // React
    if (document.querySelector('[data-reactroot]')) {
      frameworks.push('react');
    } else {
      var roots = [document.getElementById('root'), document.getElementById('__next'), app];
      for (var r = 0; r < roots.length; r++) {
        if (!roots[r]) continue;
        var keys = Object.keys(roots[r]);
        for (var j = 0; j < keys.length; j++) {
          if (keys[j].indexOf('__reactFiber$') === 0) { frameworks.push('react'); break; }
        }
        if (frameworks.indexOf('react') !== -1) break;
      }
    }
    // Angular
    if (document.querySelector('[ng-version]')) frameworks.push('angular');
    return frameworks;
  }

  // --- Event listeners (communication with content script) ---

  document.addEventListener('dr-detect-element', function() {
    var target = document.querySelector('[data-dr-detect-target]');
    if (!target) return;
    var result = detectElement(target);
    target.setAttribute('data-dr-result', JSON.stringify(result));
  });

  document.addEventListener('dr-detect-page', function() {
    var result = detectPage();
    document.documentElement.setAttribute('data-dr-frameworks', JSON.stringify(result));
  });

})();
