(() => {
  'use strict';

  const SUPPORTED_MODES = Object.freeze(['box1', 'new']);
  const SESSION_STARTERS = Object.freeze({
    beginSessionBtn: 'scheduled',
    boxOnePracticeBtn: 'box1',
    practiceExtraBtn: 'box1'
  });

  function resolvePracticeMode(instruction = '') {
    const value = String(instruction || '');
    if (value.includes('تمرین آزاد')) return 'box1';
    if (value.includes('آزمون اولیه')) return 'new';
    if (value.includes('کلمه را بشنو')) return 'scheduled';
    return null;
  }

  function parsePersianInteger(value) {
    const normalized = String(value || '')
      .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
      .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
      .replace(/[^\d]/g, '');
    return normalized ? Number(normalized) : null;
  }

  function sessionPosition(counterText) {
    const parts = String(counterText || '').split(/\s+از\s+/);
    if (parts.length !== 2) return null;
    const current = parsePersianInteger(parts[0]);
    const total = parsePersianInteger(parts[1]);
    return Number.isInteger(current) && Number.isInteger(total) ? { current, total } : null;
  }

  function queueMicrotaskSafely(windowObject, callback) {
    if (typeof windowObject.queueMicrotask === 'function') windowObject.queueMicrotask(callback);
    else Promise.resolve().then(callback);
  }

  class VocoraPracticeSessionPort {
    constructor({ window: windowObject, document: documentObject }) {
      this.window = windowObject;
      this.document = documentObject;
      this.explicitMode = null;
    }

    setMode(mode) {
      this.explicitMode = mode || null;
    }

    mode() {
      return this.explicitMode || resolvePracticeMode(this.document.querySelector('#cardInstruction')?.textContent);
    }

    isSupportedMode() {
      return SUPPORTED_MODES.includes(this.mode());
    }

    isSessionVisible() {
      const session = this.document.querySelector('#reviewSession');
      return Boolean(session && !session.classList.contains('hidden'));
    }

    currentWord() {
      const word = this.window.VazheyarTest?.getCurrentWord?.();
      if (!word?.id) return null;
      return {
        id: word.id,
        term: String(word.term || ''),
        accepted: Array.isArray(word.accepted) && word.accepted.length ? [...word.accepted] : [String(word.term || '')],
        category: String(word.category || ''),
        box: Number(word.box) || 0,
        notes: String(word.notes || '')
      };
    }

    isCorrect(answer, word, forcedWrong = false) {
      if (forcedWrong) return false;
      if (typeof this.window.VazheyarTest?.isCorrectAnswer === 'function') {
        return this.window.VazheyarTest.isCorrectAnswer(answer, word);
      }
      const normalize = this.window.VocoraPractice?.defaultNormalize || ((value) => String(value || '').trim().toLowerCase());
      const normalized = normalize(answer);
      return Boolean(normalized) && word.accepted.some((candidate) => normalize(candidate) === normalized);
    }

    shouldFlushBeforeNext() {
      if (this.mode() !== 'new') return false;
      const position = sessionPosition(this.document.querySelector('#sessionCounter')?.textContent);
      const feedbackVisible = !this.document.querySelector('#answerFeedback')?.classList.contains('hidden');
      return Boolean(position && feedbackVisible && position.current >= position.total);
    }

    continueToNextCard() {
      this.document.querySelector('#nextCardBtn')?.click();
    }

    speak(word) {
      if (!word?.term || !('speechSynthesis' in this.window) || typeof this.window.SpeechSynthesisUtterance !== 'function') {
        return false;
      }
      this.window.speechSynthesis.cancel?.();
      const utterance = new this.window.SpeechSynthesisUtterance(word.term);
      utterance.lang = 'en-GB';
      const configuredRate = Number(this.window.VazheyarTest?.getState?.()?.settings?.voiceRate);
      utterance.rate = Number.isFinite(configuredRate) ? Math.min(Math.max(configuredRate, 0.45), 1.2) : 0.85;
      const voices = this.window.speechSynthesis.getVoices?.() || [];
      utterance.voice = voices.find((voice) => /^en-GB/i.test(voice.lang))
        || voices.find((voice) => /^en/i.test(voice.lang))
        || null;
      this.window.speechSynthesis.speak?.(utterance);
      return true;
    }
  }

  class SpellingRemediationView {
    constructor({ document: documentObject, domain = documentObject.defaultView?.VocoraPractice }) {
      this.document = documentObject;
      this.domain = domain;
      this.root = null;
      this.handlers = null;
      this.originalMeta = null;
      this.faNumber = new documentObject.defaultView.Intl.NumberFormat('fa-IR');
    }

    mount(handlers) {
      if (this.root) return this.root;
      this.handlers = handlers;
      const feedback = this.document.querySelector('#answerFeedback');
      if (!feedback) throw new Error('Vocora answer feedback container was not found.');

      const root = this.document.createElement('section');
      root.id = 'practiceRemediation';
      root.className = 'practice-remediation hidden';
      root.setAttribute('aria-live', 'polite');
      root.setAttribute('aria-labelledby', 'remediationTitle');
      root.innerHTML = `
        <div class="remediation-heading">
          <span id="remediationKicker" class="remediation-kicker"></span>
          <h3 id="remediationTitle"></h3>
          <p id="remediationDescription"></p>
        </div>
        <div id="remediationComparison" class="remediation-comparison hidden">
          <div class="remediation-spelling-row wrong-spelling" dir="ltr">
            <small>پاسخ تو</small>
            <div id="remediationUserSpelling" class="remediation-spelling"></div>
          </div>
          <div class="remediation-spelling-row correct-spelling-row" dir="ltr">
            <small>املای صحیح</small>
            <div id="remediationCorrectSpelling" class="remediation-spelling"></div>
          </div>
        </div>
        <p id="remediationHint" class="remediation-hint"></p>
        <button id="remediationListenBtn" class="remediation-listen" type="button">
          <span aria-hidden="true">▶</span><span>پخش تلفظ</span>
        </button>
        <form id="remediationForm" class="remediation-form hidden" autocomplete="off">
          <label id="remediationInputLabel" for="remediationInput"></label>
          <input id="remediationInput" class="answer-input" type="text" lang="en" dir="ltr" spellcheck="false" autocapitalize="none">
          <p id="remediationValidation" class="remediation-validation" role="alert"></p>
          <button id="remediationSubmitBtn" class="btn btn-primary wide" type="submit"></button>
        </form>
        <div class="remediation-actions">
          <button id="remediationAcknowledgeBtn" class="btn btn-primary wide hidden" type="button">متوجه شدم؛ حالا از حفظ می‌نویسم</button>
          <button id="remediationContinueBtn" class="btn btn-primary wide hidden" type="button">ادامهٔ تمرین</button>
        </div>`;
      feedback.insertAdjacentElement('afterend', root);
      this.root = root;

      this.query('#remediationAcknowledgeBtn').addEventListener('click', () => this.handlers.onAcknowledge());
      this.query('#remediationContinueBtn').addEventListener('click', () => this.handlers.onContinue());
      this.query('#remediationListenBtn').addEventListener('click', () => this.handlers.onListen());
      this.query('#remediationForm').addEventListener('submit', (event) => {
        event.preventDefault();
        this.handlers.onSubmit(this.query('#remediationInput').value);
      });
      return root;
    }

    query(selector) {
      return this.root?.querySelector(selector) || null;
    }

    show({ snapshot, word, outcome = null }) {
      if (!this.root) throw new Error('Remediation view must be mounted before rendering.');
      this.captureMeta();
      this.updateMeta(word);
      this.document.querySelector('#flashCard')?.classList.add('remediation-active');
      this.root.classList.remove('hidden');

      const phase = snapshot.phase;
      const context = snapshot.context;
      const isRecheck = context === this.domain.RemediationContext.RECHECK;
      const phaseNames = this.domain.RemediationPhase;
      const comparisonVisible = [phaseNames.CORRECTION, phaseNames.COPY].includes(phase);
      const formVisible = [phaseNames.RECALL, phaseNames.COPY].includes(phase);

      this.clearOriginalFeedbackContent();
      this.query('#remediationComparison').classList.toggle('hidden', !comparisonVisible);
      if (!comparisonVisible) {
        this.query('#remediationUserSpelling').replaceChildren();
        this.query('#remediationCorrectSpelling').replaceChildren();
      }
      this.query('#remediationForm').classList.toggle('hidden', !formVisible);
      if (!formVisible) this.query('#remediationInput').value = '';
      this.query('#remediationAcknowledgeBtn').classList.toggle('hidden', phase !== phaseNames.CORRECTION);
      this.query('#remediationContinueBtn').classList.toggle('hidden', phase !== phaseNames.COMPLETED);
      this.query('#remediationListenBtn').classList.toggle('hidden', phase === phaseNames.COMPLETED);
      this.query('#remediationValidation').textContent = '';

      if (comparisonVisible && snapshot.comparison) this.renderComparison(snapshot.comparison);

      if (phase === phaseNames.CORRECTION) {
        this.setHeading('اصلاح فوری', 'اشتباه را دقیق ببین', 'قبل از ادامه، تفاوت پاسخ خودت با املای صحیح را بررسی کن.');
        this.query('#remediationHint').textContent = snapshot.hint;
        this.focusSoon('#remediationAcknowledgeBtn');
        return;
      }

      if (phase === phaseNames.RECALL) {
        this.setHeading(
          isRecheck ? `بازآزمایی ${this.faNumber.format(snapshot.recheckNumber)}` : 'بازیابی از حافظه',
          'حالا بدون دیدن پاسخ بنویس',
          'املای صحیح پنهان شده است. به تلفظ گوش کن و کل کلمه را از حافظه تایپ کن.'
        );
        this.query('#remediationHint').textContent = 'هیچ حرف یا گزینه‌ای نمایش داده نمی‌شود؛ کل کلمه را خودت تولید کن.';
        this.configureForm('املای کلمه از حافظه', 'کلمه را کامل بنویس…', 'بررسی املای من');
        this.focusSoon('#remediationInput');
        return;
      }

      if (phase === phaseNames.COPY) {
        this.setHeading('رونویسی متمرکز', 'یک بار دقیق رونویسی کن', 'پاسخ صحیح را از چپ به راست نگاه کن و همان را یک بار کامل بنویس.');
        this.query('#remediationHint').textContent = snapshot.hint;
        this.configureForm('رونویسی دقیق املای صحیح', 'املای صحیح را رونویسی کن…', 'رونویسی و پنهان‌کردن پاسخ');
        if (snapshot.copyFailures > 0) {
          this.query('#remediationValidation').textContent = 'رونویسی هنوز دقیقاً مطابق املای صحیح نیست؛ دوباره با دقت مقایسه کن.';
        } else if (snapshot.recallFailures > 0) {
          this.query('#remediationValidation').textContent = 'این بار هم درست نبود؛ ابتدا یک رونویسی متمرکز انجام بده.';
        }
        this.focusSoon('#remediationInput');
        return;
      }

      const scheduledGap = outcome?.nextRecheck?.gap;
      this.setHeading(
        isRecheck ? 'بازآزمایی کامل شد' : 'اصلاح کامل شد',
        'این بار درست نوشتی',
        isRecheck
          ? (outcome?.nextRecheck
            ? `برای تثبیت بیشتر، این کلمه پس از ${this.faNumber.format(scheduledGap)} کارت دیگر یک بار دیگر بررسی می‌شود.`
            : 'بازآزمایی این کلمه در همین جلسه با موفقیت تمام شد.')
          : `خطای اصلی ثبت شد و منطق جعبهٔ لایتنر دست‌نخورده ماند. این کلمه پس از ${this.faNumber.format(scheduledGap ?? 3)} کارت دیگر دوباره بررسی می‌شود.`
      );
      this.query('#remediationHint').textContent = '';
      this.focusSoon('#remediationContinueBtn');
    }

    configureForm(label, placeholder, buttonText) {
      this.query('#remediationInputLabel').textContent = label;
      const input = this.query('#remediationInput');
      input.value = '';
      input.placeholder = placeholder;
      this.query('#remediationSubmitBtn').textContent = buttonText;
    }

    setHeading(kicker, title, description) {
      this.query('#remediationKicker').textContent = kicker;
      this.query('#remediationTitle').textContent = title;
      this.query('#remediationDescription').textContent = description;
    }

    renderComparison(comparison) {
      this.renderTokens(this.query('#remediationUserSpelling'), comparison.answerTokens, 'پاسخی ثبت نشد');
      this.renderTokens(this.query('#remediationCorrectSpelling'), comparison.targetTokens, comparison.target);
    }

    renderTokens(container, tokens, emptyLabel) {
      container.replaceChildren();
      if (!tokens.length) {
        const empty = this.document.createElement('span');
        empty.className = 'spelling-empty';
        empty.textContent = emptyLabel;
        container.append(empty);
        return;
      }
      tokens.forEach(({ value, status }) => {
        const token = this.document.createElement('span');
        token.className = `spelling-token spelling-${status}`;
        token.textContent = value === ' ' ? '\u00A0' : value;
        container.append(token);
      });
    }

    captureMeta() {
      if (this.originalMeta) return;
      this.originalMeta = {
        category: this.document.querySelector('#cardCategory')?.textContent || '',
        box: this.document.querySelector('#cardBox')?.textContent || ''
      };
    }

    updateMeta(word) {
      const category = this.document.querySelector('#cardCategory');
      const box = this.document.querySelector('#cardBox');
      if (category) category.textContent = word.category || 'تمرین املا';
      if (box) box.textContent = word.box ? `خانهٔ ${this.faNumber.format(word.box)}` : 'تمرین همان جلسه';
    }

    clearOriginalFeedbackContent() {
      const correctAnswer = this.document.querySelector('#correctAnswer');
      const wordNote = this.document.querySelector('#wordNote');
      if (correctAnswer) correctAnswer.textContent = '';
      if (wordNote) wordNote.textContent = '';
    }

    hide({ restoreMeta = true } = {}) {
      this.root?.classList.add('hidden');
      this.document.querySelector('#flashCard')?.classList.remove('remediation-active');
      if (restoreMeta) this.restoreMeta();
    }

    restoreMeta() {
      if (!this.originalMeta) return;
      const category = this.document.querySelector('#cardCategory');
      const box = this.document.querySelector('#cardBox');
      if (category) category.textContent = this.originalMeta.category;
      if (box) box.textContent = this.originalMeta.box;
      this.originalMeta = null;
    }

    focusSoon(selector) {
      const view = this;
      setTimeout(() => view.query(selector)?.focus(), 0);
    }
  }

  class PracticeRemediationController {
    constructor({
      window: windowObject,
      document: documentObject,
      domain = windowObject.VocoraPractice,
      policy = null,
      queue = null,
      port = null,
      view = null
    }) {
      if (!domain) throw new Error('VocoraPractice domain module is required.');
      this.window = windowObject;
      this.document = documentObject;
      this.domain = domain;
      this.policy = policy || new domain.SameSessionRecheckPolicy();
      this.queue = queue || new domain.SameSessionRecheckQueue();
      this.port = port || new VocoraPracticeSessionPort({ window: windowObject, document: documentObject });
      this.view = view || new SpellingRemediationView({ document: documentObject, domain });
      this.active = null;
      this.mounted = false;
      this.observer = null;
    }

    mount() {
      if (this.mounted) return this;
      this.view.mount({
        onAcknowledge: () => this.acknowledge(),
        onSubmit: (answer) => this.submitRemediationAnswer(answer),
        onContinue: () => this.continueSession(),
        onListen: () => this.listen()
      });

      this.document.addEventListener('submit', (event) => this.captureSubmit(event), true);
      this.document.addEventListener('click', (event) => this.captureClick(event), true);
      this.document.addEventListener('keydown', (event) => this.captureKeydown(event), true);
      this.observeSessionVisibility();
      this.mounted = true;
      return this;
    }

    captureSubmit(event) {
      if (event.target?.id === 'newWordsForm') {
        this.beginSession('new');
        return;
      }
      if (event.target?.id !== 'answerForm' || this.active || !this.port.isSupportedMode()) return;
      const word = this.port.currentWord();
      if (!word) return;
      const answer = this.document.querySelector('#answerInput')?.value || '';
      this.capturePrimaryAssessment({ word, answer, forcedWrong: false });
    }

    captureClick(event) {
      const starter = event.target.closest?.('[id]');
      const starterMode = starter ? SESSION_STARTERS[starter.id] : null;
      if (starterMode) {
        this.beginSession(starterMode);
        return;
      }

      if (event.target.closest?.('#dontKnowBtn') && !this.active && this.port.isSupportedMode()) {
        const word = this.port.currentWord();
        if (word) this.capturePrimaryAssessment({ word, answer: '', forcedWrong: true });
        return;
      }

      if (!event.target.closest?.('#nextCardBtn')) return;
      if (this.active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!this.port.isSupportedMode()) return;
      const entry = this.queue.takeNext({ flush: this.port.shouldFlushBeforeNext() });
      if (!entry) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.startRecheck(entry);
    }

    captureKeydown(event) {
      if (!this.active) return;
      const insideRemediation = event.target.closest?.('#practiceRemediation');
      if (insideRemediation) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    beginSession(mode) {
      this.reset();
      this.port.setMode(mode);
    }

    capturePrimaryAssessment({ word, answer, forcedWrong }) {
      const correct = this.port.isCorrect(answer, word, forcedWrong);
      this.queue.advance();
      if (correct) return;
      queueMicrotaskSafely(this.window, () => {
        if (!this.port.isSessionVisible() || this.active || !this.port.isSupportedMode()) return;
        this.startImmediate(word, answer);
      });
    }

    startImmediate(word, answer) {
      const attempt = this.domain.RemediationAttempt.immediate({
        wordId: word.id,
        accepted: word.accepted,
        initialAnswer: answer,
        policy: this.policy
      });
      this.active = { attempt, word, mode: this.port.mode(), entry: null, outcome: null };
      this.render();
      this.emit('vocora:spelling-remediation-started', {
        wordId: word.id,
        mode: this.active.mode,
        context: this.domain.RemediationContext.IMMEDIATE
      });
    }

    startRecheck(entry) {
      const attempt = this.domain.RemediationAttempt.recheck({
        wordId: entry.word.id,
        accepted: entry.word.accepted,
        recheckNumber: entry.recheckNumber,
        policy: this.policy
      });
      this.active = { attempt, word: entry.word, mode: entry.mode, entry, outcome: null };
      this.render();
      this.emit('vocora:same-session-recheck-started', {
        wordId: entry.word.id,
        mode: entry.mode,
        recheckNumber: entry.recheckNumber
      });
    }

    acknowledge() {
      if (!this.active) return;
      this.active.attempt.acknowledgeCorrection();
      this.render();
    }

    submitRemediationAnswer(answer) {
      if (!this.active) return;
      const phase = this.active.attempt.phase;
      if (phase === this.domain.RemediationPhase.RECALL) this.active.attempt.submitRecall(answer);
      else if (phase === this.domain.RemediationPhase.COPY) this.active.attempt.submitCopy(answer);
      else return;

      if (this.active.attempt.phase === this.domain.RemediationPhase.COMPLETED) {
        this.completeActiveAttempt();
      }
      this.render();
    }

    completeActiveAttempt() {
      const outcome = this.active.attempt.outcome();
      this.active.outcome = outcome;
      if (outcome.nextRecheck) {
        this.queue.schedule({
          word: this.active.word,
          mode: this.active.mode,
          recheckNumber: outcome.nextRecheck.number,
          originId: this.active.entry?.originId || this.active.entry?.id || null
        }, outcome.nextRecheck.gap);
        this.emit('vocora:same-session-recheck-scheduled', {
          wordId: this.active.word.id,
          mode: this.active.mode,
          recheckNumber: outcome.nextRecheck.number,
          gap: outcome.nextRecheck.gap
        });
      }
      this.emit('vocora:spelling-remediation-completed', {
        wordId: this.active.word.id,
        mode: this.active.mode,
        context: outcome.context,
        recheckNumber: outcome.recheckNumber,
        correctOnFirstRecall: outcome.correctOnFirstRecall,
        recallFailures: outcome.recallFailures,
        copyFailures: outcome.copyFailures
      });
    }

    continueSession() {
      if (!this.active || this.active.attempt.phase !== this.domain.RemediationPhase.COMPLETED) return;
      this.active = null;
      this.view.hide({ restoreMeta: true });
      this.port.continueToNextCard();
    }

    listen() {
      if (this.active) this.port.speak(this.active.word);
    }

    render() {
      if (!this.active) return;
      this.view.show({
        snapshot: this.active.attempt.snapshot(),
        word: this.active.word,
        outcome: this.active.outcome
      });
    }

    observeSessionVisibility() {
      const session = this.document.querySelector('#reviewSession');
      if (!session || typeof this.window.MutationObserver !== 'function') return;
      this.observer = new this.window.MutationObserver(() => {
        if (session.classList.contains('hidden')) this.reset({ keepMode: false });
      });
      this.observer.observe(session, { attributes: true, attributeFilter: ['class'] });
    }

    reset({ keepMode = false } = {}) {
      this.active = null;
      this.queue.clear();
      this.view.hide({ restoreMeta: true });
      if (!keepMode) this.port.setMode(null);
    }

    emit(name, detail) {
      this.document.dispatchEvent(new this.window.CustomEvent(name, { detail }));
    }

    snapshot() {
      return {
        mode: this.port.mode(),
        active: this.active ? {
          wordId: this.active.word.id,
          phase: this.active.attempt.phase,
          context: this.active.attempt.context,
          recheckNumber: this.active.attempt.recheckNumber
        } : null,
        queue: this.queue.snapshot()
      };
    }
  }

  function boot() {
    if (window.VocoraPracticeRemediation) return window.VocoraPracticeRemediation;
    const controller = new PracticeRemediationController({ window, document }).mount();
    window.VocoraPracticeRemediation = controller;
    return controller;
  }

  window.VocoraPracticeUI = Object.freeze({
    SUPPORTED_MODES,
    resolvePracticeMode,
    parsePersianInteger,
    sessionPosition,
    VocoraPracticeSessionPort,
    SpellingRemediationView,
    PracticeRemediationController,
    boot
  });

  window.VocoraPracticeRemediationReady = Promise.resolve(window.VazheyarReady)
    .then(() => boot())
    .catch((error) => {
      console.error('Could not start same-session spelling remediation:', error);
      return null;
    });
})();
