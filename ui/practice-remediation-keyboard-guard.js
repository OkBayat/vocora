(() => {
  'use strict';

  const INSTALLATION = Symbol.for('vocora.practiceRemediation.keyboardGuard');
  const REMEDIATION_ROOT = '#practiceRemediation';

  function ownsEnter(event) {
    return event?.key === 'Enter'
      && Boolean(event.target?.closest?.(REMEDIATION_ROOT));
  }

  function install(documentObject = globalThis.document) {
    if (!documentObject?.addEventListener) return false;
    if (documentObject[INSTALLATION]) return false;

    const handler = (event) => {
      if (!ownsEnter(event)) return;

      // The focused button/input has already received the bubbling event. Stop only
      // later document-level shortcuts; do not prevent the native click/form action.
      event.stopImmediatePropagation();
    };

    documentObject.addEventListener('keydown', handler);
    Object.defineProperty(documentObject, INSTALLATION, {
      value: handler,
      configurable: false,
      enumerable: false,
      writable: false
    });
    return true;
  }

  globalThis.VocoraRemediationKeyboardGuard = Object.freeze({
    ownsEnter,
    install
  });

  install();
})();
