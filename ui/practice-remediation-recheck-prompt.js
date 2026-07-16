(() => {
  'use strict';

  const DEFAULT_DELAY_MS = 180;
  const RECHECK_CONTEXT = 'recheck';
  const RECALL_PHASE = 'recall';

  function normalizeDelay(value, fallback = DEFAULT_DELAY_MS) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  class RecheckPromptCoordinator {
    constructor({
      window: windowObject,
      document: documentObject,
      controller,
      delayMs = DEFAULT_DELAY_MS
    }) {
      if (!windowObject || !documentObject) throw new TypeError('window and document are required.');
      if (!controller || typeof controller.snapshot !== 'function' || typeof controller.listen !== 'function') {
        throw new TypeError('A remediation controller with snapshot and listen methods is required.');
      }

      this.window = windowObject;
      this.document = documentObject;
      this.controller = controller;
      this.delayMs = normalizeDelay(delayMs);
      this.timerId = null;
      this.pending = null;
      this.sequence = 0;
      this.mounted = false;
      this.sessionObserver = null;

      this.onRecheckStarted = (event) => this.schedule(event.detail || {});
      this.onRemediationStarted = (event) => {
        if (event.detail?.context !== RECHECK_CONTEXT) this.cancel({ stopSpeech: true });
      };
      this.onRemediationCompleted = () => this.cancel();
      this.onSubmit = (event) => {
        if (event.target?.id === 'remediationForm') this.cancel({ stopSpeech: true });
      };
      this.onClick = (event) => {
        const target = event.target;
        if (target?.closest?.('#remediationListenBtn')) {
          this.cancel();
          return;
        }
        if (target?.closest?.('#remediationContinueBtn, #exitSessionBtn')) {
          this.cancel({ stopSpeech: true });
        }
      };
    }

    mount() {
      if (this.mounted) return this;
      this.document.addEventListener('vocora:same-session-recheck-started', this.onRecheckStarted);
      this.document.addEventListener('vocora:spelling-remediation-started', this.onRemediationStarted);
      this.document.addEventListener('vocora:spelling-remediation-completed', this.onRemediationCompleted);
      this.document.addEventListener('submit', this.onSubmit, true);
      this.document.addEventListener('click', this.onClick, true);
      this.observeSession();
      this.mounted = true;
      return this;
    }

    unmount() {
      if (!this.mounted) return;
      this.cancel({ stopSpeech: true });
      this.document.removeEventListener('vocora:same-session-recheck-started', this.onRecheckStarted);
      this.document.removeEventListener('vocora:spelling-remediation-started', this.onRemediationStarted);
      this.document.removeEventListener('vocora:spelling-remediation-completed', this.onRemediationCompleted);
      this.document.removeEventListener('submit', this.onSubmit, true);
      this.document.removeEventListener('click', this.onClick, true);
      this.sessionObserver?.disconnect();
      this.sessionObserver = null;
      this.mounted = false;
    }

    schedule({ wordId, recheckNumber }) {
      if (!wordId || !Number.isInteger(recheckNumber) || recheckNumber < 1) return false;

      this.cancel({ stopSpeech: true });
      this.describeRecheck();
      const token = ++this.sequence;
      this.pending = { token, wordId: String(wordId), recheckNumber };
      this.timerId = this.window.setTimeout(() => this.playIfCurrent(token), this.delayMs);
      return true;
    }

    playIfCurrent(token) {
      if (!this.pending || this.pending.token !== token) return false;
      const pending = this.pending;
      this.timerId = null;
      this.pending = null;

      const active = this.controller.snapshot()?.active;
      const root = this.document.querySelector('#practiceRemediation');
      const session = this.document.querySelector('#reviewSession');
      const matches = active
        && active.context === RECHECK_CONTEXT
        && active.phase === RECALL_PHASE
        && active.wordId === pending.wordId
        && active.recheckNumber === pending.recheckNumber
        && root
        && !root.classList.contains('hidden')
        && session
        && !session.classList.contains('hidden');

      if (!matches) return false;
      this.controller.listen();
      const hint = this.document.querySelector('#remediationHint');
      if (hint) hint.textContent = 'تلفظ همین کلمه پخش شد؛ اگر لازم است دوباره گوش کن و سپس کل املا را بنویس.';
      return true;
    }

    describeRecheck() {
      const title = this.document.querySelector('#remediationTitle');
      const description = this.document.querySelector('#remediationDescription');
      const inputLabel = this.document.querySelector('#remediationInputLabel');

      if (title) title.textContent = 'اول تلفظ این بازآزمایی را بشنو';
      if (description) {
        description.textContent = 'این کلمه ممکن است با کلمهٔ قبلی فرق داشته باشد. تلفظ همین کلمه خودکار پخش می‌شود؛ سپس املای کامل آن را بنویس.';
      }
      if (inputLabel) inputLabel.textContent = 'املای کلمه‌ای که الان می‌شنوی';
    }

    cancel({ stopSpeech = false } = {}) {
      if (this.timerId !== null) this.window.clearTimeout(this.timerId);
      this.timerId = null;
      this.pending = null;
      if (stopSpeech) this.window.speechSynthesis?.cancel?.();
    }

    observeSession() {
      const session = this.document.querySelector('#reviewSession');
      if (!session || typeof this.window.MutationObserver !== 'function') return;
      this.sessionObserver = new this.window.MutationObserver(() => {
        if (session.classList.contains('hidden')) this.cancel({ stopSpeech: true });
      });
      this.sessionObserver.observe(session, { attributes: true, attributeFilter: ['class'] });
    }
  }

  let bootPromise = null;

  function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = Promise.resolve(window.VocoraPracticeRemediationReady)
      .then((controller) => {
        if (!controller) return null;
        const delayMs = normalizeDelay(window.VocoraPracticeRecheckPromptConfig?.delayMs);
        const coordinator = new RecheckPromptCoordinator({
          window,
          document,
          controller,
          delayMs
        }).mount();
        window.VocoraPracticeRecheckPromptCoordinator = coordinator;
        return coordinator;
      })
      .catch((error) => {
        console.error('Could not start spelling recheck pronunciation prompt:', error);
        return null;
      });
    return bootPromise;
  }

  window.VocoraPracticeRecheckPrompt = Object.freeze({
    DEFAULT_DELAY_MS,
    RecheckPromptCoordinator,
    normalizeDelay,
    boot
  });
  window.VocoraPracticeRecheckPromptReady = boot();
})();