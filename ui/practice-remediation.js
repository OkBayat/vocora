(() => {
  'use strict';

  const RemediationPhase = Object.freeze({
    CORRECTION: 'correction',
    RECALL: 'recall',
    COPY: 'copy',
    COMPLETED: 'completed'
  });

  const RemediationContext = Object.freeze({
    IMMEDIATE: 'immediate',
    RECHECK: 'recheck'
  });

  function defaultNormalize(value) {
    return String(value ?? '')
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘]/g, "'")
      .replace(/[–—]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function splitGraphemes(value) {
    const text = String(value ?? '').normalize('NFKC');
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
      return [...segmenter.segment(text)].map(({ segment }) => segment);
    }
    return Array.from(text);
  }

  function levenshteinDistance(left, right, normalize = defaultNormalize) {
    const source = splitGraphemes(normalize(left));
    const target = splitGraphemes(normalize(right));
    const previous = Array.from({ length: target.length + 1 }, (_, index) => index);

    for (let row = 1; row <= source.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= target.length; column += 1) {
        const substitutionCost = source[row - 1] === target[column - 1] ? 0 : 1;
        current[column] = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + substitutionCost
        );
      }
      previous.splice(0, previous.length, ...current);
    }

    return previous[target.length];
  }

  function uniqueAcceptedSpellings(accepted) {
    const source = Array.isArray(accepted) ? accepted : [accepted];
    const seen = new Set();
    const result = [];
    source.forEach((item) => {
      const value = String(item ?? '').trim();
      const key = defaultNormalize(value);
      if (value && !seen.has(key)) {
        seen.add(key);
        result.push(value);
      }
    });
    if (!result.length) throw new TypeError('At least one accepted spelling is required.');
    return result;
  }

  function selectClosestAccepted(answer, accepted, normalize = defaultNormalize) {
    const candidates = uniqueAcceptedSpellings(accepted);
    const normalizedAnswer = normalize(answer);
    if (!normalizedAnswer) return candidates[0];

    return candidates.reduce((best, candidate, index) => {
      const normalizedCandidate = normalize(candidate);
      const score = levenshteinDistance(normalizedAnswer, normalizedCandidate, (value) => String(value));
      const lengthDelta = Math.abs(splitGraphemes(normalizedAnswer).length - splitGraphemes(normalizedCandidate).length);
      if (!best || score < best.score || (score === best.score && lengthDelta < best.lengthDelta)) {
        return { candidate, score, lengthDelta, index };
      }
      return best;
    }, null).candidate;
  }

  function buildEditOperations(answer, target) {
    const source = splitGraphemes(answer);
    const expected = splitGraphemes(target);
    const rows = source.length + 1;
    const columns = expected.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));

    for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
    for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

    for (let row = 1; row < rows; row += 1) {
      for (let column = 1; column < columns; column += 1) {
        const cost = source[row - 1] === expected[column - 1] ? 0 : 1;
        matrix[row][column] = Math.min(
          matrix[row - 1][column] + 1,
          matrix[row][column - 1] + 1,
          matrix[row - 1][column - 1] + cost
        );
      }
    }

    const operations = [];
    let row = source.length;
    let column = expected.length;

    while (row > 0 || column > 0) {
      if (
        row > 0
        && column > 0
        && source[row - 1] === expected[column - 1]
        && matrix[row][column] === matrix[row - 1][column - 1]
      ) {
        operations.push({ type: 'equal', answer: source[row - 1], target: expected[column - 1] });
        row -= 1;
        column -= 1;
        continue;
      }

      if (
        row > 0
        && column > 0
        && matrix[row][column] === matrix[row - 1][column - 1] + 1
      ) {
        operations.push({ type: 'replace', answer: source[row - 1], target: expected[column - 1] });
        row -= 1;
        column -= 1;
        continue;
      }

      if (column > 0 && matrix[row][column] === matrix[row][column - 1] + 1) {
        operations.push({ type: 'insert', answer: '', target: expected[column - 1] });
        column -= 1;
        continue;
      }

      operations.push({ type: 'delete', answer: source[row - 1], target: '' });
      row -= 1;
    }

    return {
      operations: operations.reverse(),
      distance: matrix[source.length][expected.length]
    };
  }

  function detectAdjacentTransposition(answer, target) {
    const source = splitGraphemes(answer);
    const expected = splitGraphemes(target);
    if (source.length !== expected.length) return null;

    const mismatches = [];
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== expected[index]) mismatches.push(index);
    }

    if (
      mismatches.length === 2
      && mismatches[1] === mismatches[0] + 1
      && source[mismatches[0]] === expected[mismatches[1]]
      && source[mismatches[1]] === expected[mismatches[0]]
    ) {
      return {
        answer: `${source[mismatches[0]]}${source[mismatches[1]]}`,
        target: `${expected[mismatches[0]]}${expected[mismatches[1]]}`
      };
    }
    return null;
  }

  function buildSpellingComparison(answer, target) {
    const displayedAnswer = defaultNormalize(answer);
    const displayedTarget = defaultNormalize(target);
    const { operations, distance } = buildEditOperations(displayedAnswer, displayedTarget);
    const answerTokens = [];
    const targetTokens = [];

    operations.forEach((operation) => {
      if (operation.type === 'equal') {
        answerTokens.push({ value: operation.answer, status: 'equal' });
        targetTokens.push({ value: operation.target, status: 'equal' });
      } else if (operation.type === 'replace') {
        answerTokens.push({ value: operation.answer, status: 'replace' });
        targetTokens.push({ value: operation.target, status: 'replace' });
      } else if (operation.type === 'delete') {
        answerTokens.push({ value: operation.answer, status: 'extra' });
      } else if (operation.type === 'insert') {
        targetTokens.push({ value: operation.target, status: 'missing' });
      }
    });

    const frozenAnswerTokens = Object.freeze(answerTokens.map((token) => Object.freeze({ ...token })));
    const frozenTargetTokens = Object.freeze(targetTokens.map((token) => Object.freeze({ ...token })));
    const frozenOperations = Object.freeze(operations.map((operation) => Object.freeze({ ...operation })));
    const transposition = detectAdjacentTransposition(displayedAnswer, displayedTarget);
    return Object.freeze({
      answer: displayedAnswer,
      target: displayedTarget,
      answerTokens: frozenAnswerTokens,
      targetTokens: frozenTargetTokens,
      operations: frozenOperations,
      distance,
      transposition: transposition ? Object.freeze({ ...transposition }) : null
    });
  }

  function quotedPart(value) {
    const text = String(value ?? '').replace(/\s/g, '␠');
    return `«${text}»`;
  }

  function buildOrthographicHint(comparison, level = 1) {
    if (!comparison.answer) return 'املای درست را یک‌بار از چپ به راست با دقت نگاه کن.';
    if (comparison.transposition) {
      return `ترتیب ${quotedPart(comparison.transposition.answer)} جابه‌جا شده؛ شکل درست ${quotedPart(comparison.transposition.target)} است.`;
    }

    const missing = comparison.operations.filter(({ type }) => type === 'insert').map(({ target }) => target).join('');
    const extra = comparison.operations.filter(({ type }) => type === 'delete').map(({ answer }) => answer).join('');
    const replacement = comparison.operations.find(({ type }) => type === 'replace');
    let hint = 'بخش‌های رنگی را مقایسه کن و ترتیب همهٔ حروف را به خاطر بسپار.';

    if (missing) hint = `${quotedPart(missing)} در پاسخ جا افتاده است.`;
    else if (extra) hint = `${quotedPart(extra)} اضافه نوشته شده است.`;
    else if (replacement) hint = `${quotedPart(replacement.answer)} باید ${quotedPart(replacement.target)} نوشته شود.`;

    if (level > 1) hint += ' بخش دشوار را جداگانه نگاه کن، سپس کل کلمه را یک‌جا از حافظه بنویس.';
    return hint;
  }

  class SameSessionRecheckPolicy {
    constructor({ initialGap = 3, retryGap = 1, maxRechecks = 2 } = {}) {
      this.initialGap = SameSessionRecheckPolicy.#integer(initialGap, 'initialGap', 0);
      this.retryGap = SameSessionRecheckPolicy.#integer(retryGap, 'retryGap', 0);
      this.maxRechecks = SameSessionRecheckPolicy.#integer(maxRechecks, 'maxRechecks', 0);
      Object.freeze(this);
    }

    static #integer(value, name, minimum) {
      if (!Number.isInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}.`);
      }
      return value;
    }

    nextRecheck({ context, recheckNumber = 0, correctOnFirstRecall = null }) {
      if (context === RemediationContext.IMMEDIATE) {
        return this.maxRechecks >= 1 ? { number: 1, gap: this.initialGap } : null;
      }
      if (
        context === RemediationContext.RECHECK
        && correctOnFirstRecall === false
        && recheckNumber < this.maxRechecks
      ) {
        return { number: recheckNumber + 1, gap: this.retryGap };
      }
      return null;
    }
  }

  class RemediationAttempt {
    constructor({
      wordId,
      accepted,
      initialAnswer = '',
      context = RemediationContext.IMMEDIATE,
      recheckNumber = 0,
      normalize = defaultNormalize,
      policy = new SameSessionRecheckPolicy(),
      now = () => new Date().toISOString()
    }) {
      if (!wordId) throw new TypeError('wordId is required.');
      if (![RemediationContext.IMMEDIATE, RemediationContext.RECHECK].includes(context)) {
        throw new TypeError('Unknown remediation context.');
      }
      const minimumRecheckNumber = context === RemediationContext.RECHECK ? 1 : 0;
      if (!Number.isInteger(recheckNumber) || recheckNumber < minimumRecheckNumber) {
        throw new TypeError(`recheckNumber must be an integer greater than or equal to ${minimumRecheckNumber}.`);
      }
      if (typeof normalize !== 'function') throw new TypeError('normalize must be a function.');
      if (!policy || typeof policy.nextRecheck !== 'function') {
        throw new TypeError('policy must provide a nextRecheck method.');
      }
      if (typeof now !== 'function') throw new TypeError('now must be a function.');

      this.wordId = wordId;
      this.accepted = uniqueAcceptedSpellings(accepted);
      this.initialAnswer = String(initialAnswer ?? '');
      this.context = context;
      this.recheckNumber = recheckNumber;
      this.normalize = normalize;
      this.policy = policy;
      this.now = now;
      this.target = selectClosestAccepted(this.initialAnswer, this.accepted, this.normalize);
      this.phase = context === RemediationContext.IMMEDIATE
        ? RemediationPhase.CORRECTION
        : RemediationPhase.RECALL;
      this.lastAnswer = this.initialAnswer;
      this.recallSubmissions = 0;
      this.recallFailures = 0;
      this.copySubmissions = 0;
      this.copyFailures = 0;
      this.correctOnFirstRecall = null;
      this.completedAt = null;
    }

    static immediate(options) {
      return new RemediationAttempt({ ...options, context: RemediationContext.IMMEDIATE, recheckNumber: 0 });
    }

    static recheck(options) {
      return new RemediationAttempt({ ...options, context: RemediationContext.RECHECK });
    }

    acknowledgeCorrection() {
      this.#expect(RemediationPhase.CORRECTION);
      this.phase = RemediationPhase.RECALL;
      this.lastAnswer = '';
      return this.snapshot();
    }

    submitRecall(answer) {
      this.#expect(RemediationPhase.RECALL);
      const value = String(answer ?? '');
      const correct = Boolean(this.normalize(value))
        && this.accepted.some((candidate) => this.normalize(candidate) === this.normalize(value));

      if (this.recallSubmissions === 0) this.correctOnFirstRecall = correct;
      this.recallSubmissions += 1;
      this.lastAnswer = value;

      if (correct) {
        this.phase = RemediationPhase.COMPLETED;
        this.completedAt = this.now();
      } else {
        this.recallFailures += 1;
        this.target = selectClosestAccepted(value, this.accepted, this.normalize);
        this.phase = RemediationPhase.COPY;
      }
      return this.snapshot();
    }

    submitCopy(answer) {
      this.#expect(RemediationPhase.COPY);
      const value = String(answer ?? '');
      const correct = Boolean(this.normalize(value)) && this.normalize(value) === this.normalize(this.target);
      this.copySubmissions += 1;
      this.lastAnswer = value;

      if (correct) {
        this.phase = RemediationPhase.RECALL;
        this.lastAnswer = '';
      } else {
        this.copyFailures += 1;
      }
      return this.snapshot();
    }

    outcome() {
      this.#expect(RemediationPhase.COMPLETED);
      const nextRecheck = this.policy.nextRecheck({
        context: this.context,
        recheckNumber: this.recheckNumber,
        correctOnFirstRecall: this.correctOnFirstRecall
      });
      return Object.freeze({
        wordId: this.wordId,
        context: this.context,
        recheckNumber: this.recheckNumber,
        target: this.target,
        correctOnFirstRecall: this.correctOnFirstRecall,
        recallSubmissions: this.recallSubmissions,
        recallFailures: this.recallFailures,
        copySubmissions: this.copySubmissions,
        copyFailures: this.copyFailures,
        completedAt: this.completedAt,
        nextRecheck: nextRecheck ? Object.freeze({ ...nextRecheck }) : null
      });
    }

    snapshot() {
      const answerForComparison = this.phase === RemediationPhase.CORRECTION
        ? this.initialAnswer
        : this.lastAnswer;
      const comparison = [RemediationPhase.CORRECTION, RemediationPhase.COPY].includes(this.phase)
        ? buildSpellingComparison(answerForComparison, this.target)
        : null;

      return Object.freeze({
        wordId: this.wordId,
        context: this.context,
        recheckNumber: this.recheckNumber,
        phase: this.phase,
        target: this.target,
        accepted: Object.freeze([...this.accepted]),
        initialAnswer: this.initialAnswer,
        lastAnswer: this.lastAnswer,
        recallSubmissions: this.recallSubmissions,
        recallFailures: this.recallFailures,
        copySubmissions: this.copySubmissions,
        copyFailures: this.copyFailures,
        correctOnFirstRecall: this.correctOnFirstRecall,
        answerVisible: [RemediationPhase.CORRECTION, RemediationPhase.COPY].includes(this.phase),
        inputMode: this.phase === RemediationPhase.RECALL
          ? 'recall'
          : this.phase === RemediationPhase.COPY ? 'copy' : null,
        comparison,
        hint: comparison ? buildOrthographicHint(comparison, Math.max(1, this.recallFailures)) : ''
      });
    }

    #expect(expected) {
      if (this.phase !== expected) {
        throw new Error(`Invalid remediation transition: expected ${expected}, received ${this.phase}.`);
      }
    }
  }

  class SameSessionRecheckQueue {
    constructor() {
      this.entries = [];
      this.sequence = 0;
    }

    schedule({ word, mode, recheckNumber = 1, originId = null }, gap) {
      if (!word?.id) throw new TypeError('A word with an id is required.');
      if (!mode) throw new TypeError('mode is required.');
      if (!Number.isInteger(recheckNumber) || recheckNumber < 1) {
        throw new TypeError('recheckNumber must be a positive integer.');
      }
      if (!Number.isInteger(gap) || gap < 0) throw new TypeError('gap must be a non-negative integer.');

      const duplicate = this.entries.find((entry) => (
        entry.word.id === word.id && entry.recheckNumber === recheckNumber
      ));
      if (duplicate) {
        duplicate.remainingCards = Math.min(duplicate.remainingCards, gap);
        return duplicate.id;
      }

      const entry = {
        id: `same-session-recheck-${++this.sequence}`,
        word: {
          id: word.id,
          term: String(word.term ?? ''),
          accepted: uniqueAcceptedSpellings(word.accepted?.length ? word.accepted : [word.term]),
          category: String(word.category ?? ''),
          box: Number(word.box) || 0,
          notes: String(word.notes ?? '')
        },
        mode,
        recheckNumber,
        originId,
        remainingCards: gap,
        sequence: this.sequence
      };
      this.entries.push(entry);
      return entry.id;
    }

    advance() {
      this.entries.forEach((entry) => {
        if (entry.remainingCards > 0) entry.remainingCards -= 1;
      });
    }

    takeNext({ flush = false } = {}) {
      let index = this.entries.findIndex((entry) => entry.remainingCards <= 0);
      if (index < 0 && flush && this.entries.length) {
        index = this.entries.reduce((bestIndex, entry, currentIndex, entries) => {
          const best = entries[bestIndex];
          if (entry.remainingCards < best.remainingCards) return currentIndex;
          if (entry.remainingCards === best.remainingCards && entry.sequence < best.sequence) return currentIndex;
          return bestIndex;
        }, 0);
      }
      if (index < 0) return null;
      const [entry] = this.entries.splice(index, 1);
      return entry;
    }

    clear() {
      this.entries = [];
    }

    get size() {
      return this.entries.length;
    }

    snapshot() {
      return this.entries.map((entry) => ({
        ...entry,
        word: { ...entry.word, accepted: [...entry.word.accepted] }
      }));
    }
  }

  globalThis.VocoraPractice = Object.freeze({
    RemediationPhase,
    RemediationContext,
    SameSessionRecheckPolicy,
    RemediationAttempt,
    SameSessionRecheckQueue,
    defaultNormalize,
    splitGraphemes,
    levenshteinDistance,
    selectClosestAccepted,
    buildSpellingComparison,
    buildOrthographicHint
  });
})();
