import assert from 'node:assert/strict';

await import('../practice-remediation.js');

const {
  RemediationPhase,
  RemediationContext,
  SameSessionRecheckPolicy,
  RemediationAttempt,
  SameSessionRecheckQueue,
  defaultNormalize,
  levenshteinDistance,
  selectClosestAccepted,
  buildSpellingComparison,
  buildOrthographicHint
} = globalThis.VocoraPractice;

assert.equal(defaultNormalize('  Credit   Card  '), 'credit card');
assert.equal(defaultNormalize('taxpayers’ money'), "taxpayers' money");
assert.equal(buildSpellingComparison('Enviroment', 'environment').distance, 1, 'Diff feedback must follow the app’s case-insensitive answer rules.');
assert.equal(levenshteinDistance('enviroment', 'environment'), 1);
assert.equal(selectClosestAccepted('center', ['centre', 'center']), 'center');
assert.equal(selectClosestAccepted('color', ['colour', 'color']), 'color');

const missingLetter = buildSpellingComparison('enviroment', 'environment');
assert.equal(missingLetter.distance, 1);
assert.equal(missingLetter.operations.filter(({ type }) => type === 'insert').map(({ target }) => target).join(''), 'n');
assert.match(buildOrthographicHint(missingLetter), /n/);
assert.ok(missingLetter.targetTokens.some(({ status, value }) => status === 'missing' && value === 'n'));

const replacement = buildSpellingComparison('definate', 'definite');
assert.ok(replacement.operations.some(({ type, answer, target }) => type === 'replace' && answer === 'a' && target === 'i'));
assert.match(buildOrthographicHint(replacement), /a/);
assert.match(buildOrthographicHint(replacement), /i/);

const transposition = buildSpellingComparison('freind', 'friend');
assert.deepEqual(transposition.transposition, { answer: 'ei', target: 'ie' });
assert.match(buildOrthographicHint(transposition), /جابه‌جا/);

const policy = new SameSessionRecheckPolicy({ initialGap: 3, retryGap: 1, maxRechecks: 2 });
const clock = () => '2026-07-16T10:00:00.000Z';
const immediate = RemediationAttempt.immediate({
  wordId: 'environment',
  accepted: ['environment'],
  initialAnswer: 'enviroment',
  policy,
  now: clock
});

assert.equal(immediate.phase, RemediationPhase.CORRECTION);
assert.equal(immediate.snapshot().answerVisible, true);
immediate.acknowledgeCorrection();
assert.equal(immediate.phase, RemediationPhase.RECALL);
assert.equal(immediate.snapshot().answerVisible, false, 'The correct answer must be fully hidden during recall.');

immediate.submitRecall('envirnment');
assert.equal(immediate.phase, RemediationPhase.COPY);
assert.equal(immediate.snapshot().answerVisible, true);
assert.equal(immediate.snapshot().recallFailures, 1);

immediate.submitCopy('environmentt');
assert.equal(immediate.phase, RemediationPhase.COPY, 'An inaccurate copy must not advance the state machine.');
assert.equal(immediate.snapshot().copyFailures, 1);

immediate.submitCopy('environment');
assert.equal(immediate.phase, RemediationPhase.RECALL);
assert.equal(immediate.snapshot().answerVisible, false, 'The copied answer must be hidden before the final recall.');

immediate.submitRecall('environment');
assert.equal(immediate.phase, RemediationPhase.COMPLETED);
assert.deepEqual(immediate.outcome().nextRecheck, { number: 1, gap: 3 });
assert.equal(immediate.outcome().correctOnFirstRecall, false);
assert.equal(immediate.outcome().completedAt, clock());
assert.throws(() => immediate.submitRecall('environment'), /Invalid remediation transition/);

const firstPassImmediate = RemediationAttempt.immediate({
  wordId: 'accommodation',
  accepted: ['accommodation'],
  initialAnswer: 'acommodation',
  policy
});
firstPassImmediate.acknowledgeCorrection();
firstPassImmediate.submitRecall('accommodation');
assert.equal(firstPassImmediate.outcome().correctOnFirstRecall, true);
assert.deepEqual(firstPassImmediate.outcome().nextRecheck, { number: 1, gap: 3 });

const successfulRecheck = RemediationAttempt.recheck({
  wordId: 'environment',
  accepted: ['environment'],
  recheckNumber: 1,
  policy
});
assert.equal(successfulRecheck.context, RemediationContext.RECHECK);
assert.equal(successfulRecheck.phase, RemediationPhase.RECALL);
successfulRecheck.submitRecall('environment');
assert.equal(successfulRecheck.outcome().nextRecheck, null, 'A first-try successful recheck must end the same-session cycle.');

const failedRecheck = RemediationAttempt.recheck({
  wordId: 'environment',
  accepted: ['environment'],
  recheckNumber: 1,
  policy
});
failedRecheck.submitRecall('enviroment');
failedRecheck.submitCopy('environment');
failedRecheck.submitRecall('environment');
assert.deepEqual(failedRecheck.outcome().nextRecheck, { number: 2, gap: 1 });

const finalRecheck = RemediationAttempt.recheck({
  wordId: 'environment',
  accepted: ['environment'],
  recheckNumber: 2,
  policy
});
finalRecheck.submitRecall('enviroment');
finalRecheck.submitCopy('environment');
finalRecheck.submitRecall('environment');
assert.equal(finalRecheck.outcome().nextRecheck, null, 'The policy must cap repeated rechecks.');

const variants = RemediationAttempt.immediate({
  wordId: 'centre',
  accepted: ['centre', 'center'],
  initialAnswer: 'centar',
  policy
});
assert.equal(variants.target, 'center', 'Feedback should use the accepted spelling closest to the learner answer.');
variants.acknowledgeCorrection();
variants.submitRecall('centre');
assert.equal(variants.phase, RemediationPhase.COMPLETED, 'Any accepted spelling must complete recall.');

const queue = new SameSessionRecheckQueue();
const queuedWord = { id: 'w1', term: 'environment', accepted: ['environment'], category: 'Test', box: 1 };
queue.schedule({ word: queuedWord, mode: 'box1', recheckNumber: 1 }, 3);
assert.equal(queue.takeNext(), null);
queue.advance();
assert.equal(queue.takeNext(), null);
queue.advance();
assert.equal(queue.takeNext(), null);
queue.advance();
assert.equal(queue.snapshot()[0].remainingCards, 0);
assert.equal(queue.takeNext().word.id, 'w1', 'The recheck must become available after three intervening practice cards.');
assert.equal(queue.size, 0);

queue.schedule({ word: queuedWord, mode: 'new', recheckNumber: 1 }, 3);
assert.equal(queue.takeNext(), null);
assert.equal(queue.takeNext({ flush: true }).word.id, 'w1', 'A finite practice session must flush pending rechecks before completion.');

queue.schedule({ word: queuedWord, mode: 'box1', recheckNumber: 1 }, 3);
queue.schedule({ word: queuedWord, mode: 'box1', recheckNumber: 1 }, 1);
assert.equal(queue.size, 1, 'Equivalent pending rechecks must be deduplicated.');
assert.equal(queue.snapshot()[0].remainingCards, 1);
queue.clear();
assert.equal(queue.size, 0);

const customPolicyAttempt = RemediationAttempt.immediate({
  wordId: 'open-policy',
  accepted: ['word'],
  initialAnswer: 'wrd',
  policy: { nextRecheck: () => ({ number: 1, gap: 5 }) }
});
customPolicyAttempt.acknowledgeCorrection();
customPolicyAttempt.submitRecall('word');
assert.deepEqual(customPolicyAttempt.outcome().nextRecheck, { number: 1, gap: 5 }, 'A future policy implementation must be injectable without subclassing.');
assert.throws(() => new SameSessionRecheckPolicy({ initialGap: -1 }), /initialGap/);
assert.throws(() => RemediationAttempt.recheck({ wordId: '', accepted: ['word'], recheckNumber: 1 }), /wordId/);
assert.throws(() => RemediationAttempt.recheck({ wordId: 'word', accepted: ['word'], recheckNumber: 0 }), /recheckNumber/);
assert.throws(() => queue.schedule({ word: {}, mode: 'box1' }, 1), /word/);

console.log('Same-session spelling remediation domain tests passed.');
