/**
 * DevTailor — Browser Console Bridge (MAIN world)
 *
 * Runs in the page JavaScript context and forwards page console messages
 * to the isolated content script collector.
 */
(function() {
  'use strict';

  if (window.__DEVTAILOR_CONSOLE_BRIDGE_INSTALLED__) return;
  window.__DEVTAILOR_CONSOLE_BRIDGE_INSTALLED__ = true;

  var EVENT_NAME = '__devtailor_console_message__';
  var original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    trace: console.trace.bind(console),
    assert: console.assert.bind(console),
  };

  function stringifyArg(arg) {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    if (arg instanceof Element) {
      var id = arg.id ? '#' + arg.id : '';
      var cls = typeof arg.className === 'string' && arg.className.trim()
        ? '.' + arg.className.trim().split(/\s+/).slice(0, 3).join('.')
        : '';
      return '<' + arg.tagName.toLowerCase() + id + cls + '>';
    }
    if (typeof arg === 'function') return '[Function ' + (arg.name || 'anonymous') + ']';
    if (typeof arg === 'symbol') return String(arg);
    try {
      return JSON.stringify(arg);
    } catch (err) {
      try { return String(arg); } catch (e) { return '[Unserializable]'; }
    }
  }

  function stackFromArgs(args) {
    for (var i = 0; i < args.length; i++) {
      if (args[i] instanceof Error && args[i].stack) return args[i].stack;
    }
    return '';
  }

  function emit(type, args, extra) {
    var list = Array.prototype.slice.call(args || []);
    var stringArgs = list.map(stringifyArg);
    var payload = Object.assign({
      type: type,
      args: stringArgs,
      message: stringArgs.filter(Boolean).join(' ') || String(type),
      stack: stackFromArgs(list),
      timestamp: Date.now(),
      url: location.href,
      source: 'page-console',
      lineNumber: null,
      columnNumber: null,
    }, extra || {});

    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify(payload),
      }));
    } catch (err) {
      // Keep page behavior unchanged if DevTailor cannot receive the event.
    }
  }

  function wrap(level) {
    console[level] = function patchedConsoleMethod() {
      var args = Array.prototype.slice.call(arguments);
      if (level === 'assert') {
        if (args[0]) return original.assert.apply(console, args);
        emit('assert', args.length > 1 ? args.slice(1) : ['Assertion failed']);
        return original.assert.apply(console, args);
      }
      emit(level, args);
      return original[level].apply(console, args);
    };
  }

  ['log', 'info', 'debug', 'warn', 'error', 'trace', 'assert'].forEach(wrap);

  window.addEventListener('error', function(event) {
    emit('error', [event.error || event.message], {
      source: 'page-error',
      url: event.filename || location.href,
      lineNumber: Number.isFinite(event.lineno) ? event.lineno : null,
      columnNumber: Number.isFinite(event.colno) ? event.colno : null,
      stack: event.error && event.error.stack ? event.error.stack : '',
    });
  });

  window.addEventListener('unhandledrejection', function(event) {
    emit('error', [event.reason || 'Unhandled promise rejection'], {
      source: 'page-unhandledrejection',
      stack: event.reason && event.reason.stack ? event.reason.stack : '',
    });
  });
})();
