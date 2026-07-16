import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const domainSource = fs.readFileSync(new URL('../practice-remediation.js', import.meta.url), 'utf8');
const adapterSource = fs.readFileSync(new URL('../practice-remediation-adapter.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const indexMarkup = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(indexMarkup, /href="practice-remediation\.css"/);
const scriptOrder = [...indexMarkup.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
assert.ok(scriptOrder.indexOf('practice-remediation.js') < scriptOrder.indexOf('app-v2.js'));
assert.ok(scriptOrder.indexOf('practice-remediation-keyboard-guard.js') < scriptOrder.indexOf('app-v2.js'));
assert.ok(scriptOrder.indexOf('practice-remediation-adapter.js') > scriptOrder.indexOf('app-v2.js'));

function htmlFixture() {
  return `<!doctype html><html lang="fa" dir="rtl"><body>
    <button id="beginSessionBtn" type="button">scheduled</button>
    <button id="boxOnePracticeBtn" type="button">box1</button>
    <button id="practiceExtraBtn" type="button">box1 extra</button>
    <form id="newWordsForm"><button id="startNewWordsBtn" type="submit">new</button></form>
    <div id="reviewSession">
      <div id="sessionCounter">تمرین آزاد · ۰ پاسخ</div>
      <article id="flashCard">
        <span id="cardCategory">Test</span><span id="cardBox">خانهٔ ۱</span>
        <p id="cardInstruction">تمرین آزاد خانهٔ ۱؛ این پاسخ جای کارت را تغییر نمی‌دهد.</p>
        <button id="listenWordBtn" type="button">listen</button>
        <button id="slowListenBtn" type="button">slow</button>
        <form id="answerForm"><input id="answerInput"><button type="submit">submit</button></form>
        <button id="dontKnowBtn" type="button">نمی‌دانم</button>
        <div id="answerFeedback" class="hidden">
          <span id="feedbackIcon"></span><strong id="feedbackTitle"></strong><p id="feedbackDetail"></p>
          <strong id="correctAnswer"></strong><p id="wordNote"></p>
          <button id="nextCardBtn" type="button">next</button>
        </div>
      </article>
    </div>
    <div id="sessionComplete" class="hidden">complete</div>
  </body></html>`;
}

const WORDS = Object.freeze([
  { id: 'environment', term: 'environment', accepted: ['environment'], category: 'Nature', box: 1, notes: '' },
  { id: 'airport', term: 'airport', accepted: ['airport'], category: 'Travel', box: 1, notes: '' },
  { id: 'library', term: 'library', accepted: ['library'], category: 'Places', box: 1, notes: '' },
  { id: 'medicine', term: 'medicine', accepted: ['medicine'], category: 'Health', box: 1, notes: '' },
  { id: 'lecture', term: 'lecture', accepted: ['lecture'], category: 'Education', box: 1, notes: '' },
  { id: 'calendar', term: 'calendar', accepted: ['calendar'], category: 'Time', box: 1, notes: '' },
  { id: 'restaurant', term: 'restaurant', accepted: ['restaurant'], category: 'Places', box: 1, notes: '' },
  { id: 'temperature', term: 'temperature', accepted: ['temperature'], category: 'Science', box: 1, notes: '' }
]);

async function createHarness({ mode = 'box1', finiteTotal = null } = {}) {
  const words = WORDS.map((word) => ({ ...word, accepted: [...word.accepted] }));
  let wordIndex = 0;
  let primaryAnswered = 0;
  let appSubmissions = 0;
  let appNextCards = 0;
  let appWrong = 0;
  let appCorrect = 0;
  let sessionFinished = false;
  const emittedEvents = [];

  if (mode === 'new') {
    assert.ok(Number.isInteger(finiteTotal) && finiteTotal > 0 && finiteTotal <= words.length);
  }

  const dom = new JSDOM(htmlFixture(), {
    url: 'https://vocora.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; } };
    }
  });
  const { window } = dom;
  const { document } = window;
  const normalize = (value) => String(value || '').trim().toLowerCase();

  window.VazheyarTest = {
    getCurrentWord: () => words[wordIndex],
    getState: () => ({ settings: { voiceRate: 0.85 } }),
    isCorrectAnswer: (answer, word) => Boolean(normalize(answer))
      && word.accepted.some((accepted) => normalize(accepted) === normalize(answer))
  };
  window.VazheyarReady = Promise.resolve();

  const updateCounter = () => {
    if (mode === 'new') {
      // Mirrors app-v2: while feedback is open, the counter already points at the
      // next primary card. Therefore "N of N" does not prove the session is over.
      const completedUnique = Math.min(primaryAnswered, finiteTotal);
      const current = Math.min(finiteTotal, completedUnique + 1);
      document.querySelector('#sessionCounter').textContent = `کارت ${current} از ${finiteTotal}`;
    } else if (mode === 'box1') {
      document.querySelector('#sessionCounter').textContent = `تمرین آزاد · ${primaryAnswered} پاسخ`;
    } else {
      document.querySelector('#sessionCounter').textContent = `کارت ${primaryAnswered + 1} از ۱۰`;
    }
  };

  const showPrimaryCard = () => {
    document.querySelector('#answerInput').value = '';
    document.querySelector('#answerForm').classList.remove('hidden');
    document.querySelector('#dontKnowBtn').classList.remove('hidden');
    document.querySelector('#answerFeedback').classList.add('hidden');
    document.querySelector('#cardCategory').textContent = words[wordIndex].category;
    document.querySelector('#cardBox').textContent = `خانهٔ ${words[wordIndex].box}`;
  };

  const renderPrimaryFeedback = (correct) => {
    appSubmissions += 1;
    primaryAnswered += 1;
    if (correct) appCorrect += 1;
    else appWrong += 1;
    document.querySelector('#answerForm').classList.add('hidden');
    document.querySelector('#dontKnowBtn').classList.add('hidden');
    document.querySelector('#answerFeedback').classList.remove('hidden');
    document.querySelector('#feedbackTitle').textContent = correct ? 'درست بود!' : 'اشتباه بود';
    document.querySelector('#correctAnswer').textContent = words[wordIndex].term;
    updateCounter();
  };

  document.querySelector('#newWordsForm').addEventListener('submit', (event) => event.preventDefault());
  document.querySelector('#answerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = document.querySelector('#answerInput').value;
    renderPrimaryFeedback(window.VazheyarTest.isCorrectAnswer(answer, words[wordIndex]));
  });
  document.querySelector('#dontKnowBtn').addEventListener('click', () => renderPrimaryFeedback(false));
  document.querySelector('#nextCardBtn').addEventListener('click', () => {
    appNextCards += 1;
    if (mode === 'new' && primaryAnswered >= finiteTotal) {
      sessionFinished = true;
      document.querySelector('#reviewSession').classList.add('hidden');
      document.querySelector('#sessionComplete').classList.remove('hidden');
      return;
    }
    wordIndex = mode === 'box1'
      ? (wordIndex + 1) % words.length
      : Math.min(wordIndex + 1, words.length - 1);
    showPrimaryCard();
  });

  for (const eventName of [
    'vocora:spelling-remediation-started',
    'vocora:spelling-remediation-completed',
    'vocora:same-session-recheck-scheduled',
    'vocora:same-session-recheck-started'
  ]) {
    document.addEventListener(eventName, (event) => emittedEvents.push({ name: eventName, detail: event.detail }));
  }

  window.eval(domainSource);
  window.eval(adapterSource);
  const controller = await window.VocoraPracticeRemediationReady;
  assert.ok(controller, 'The browser adapter should boot after the main app is ready.');

  if (mode === 'box1') {
    document.querySelector('#boxOnePracticeBtn').click();
    document.querySelector('#cardInstruction').textContent = 'تمرین آزاد خانهٔ ۱؛ این پاسخ جای کارت را تغییر نمی‌دهد.';
  } else if (mode === 'new') {
    document.querySelector('#newWordsForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector('#cardInstruction').textContent = 'آزمون اولیه؛ پاسخ درست کارت را مستقیم به خانهٔ ۲ می‌برد.';
  } else {
    document.querySelector('#beginSessionBtn').click();
    document.querySelector('#cardInstruction').textContent = 'کلمه را بشنو و املای آن را بنویس.';
  }
  updateCounter();

  return {
    dom,
    window,
    document,
    words,
    controller,
    emittedEvents,
    currentWord: () => words[wordIndex],
    metrics: () => ({
      appSubmissions,
      appNextCards,
      appWrong,
      appCorrect,
      primaryAnswered,
      wordIndex,
      sessionFinished
    })
  };
}

function submitPrimary(harness, answer) {
  harness.document.querySelector('#answerInput').value = answer;
  harness.document.querySelector('#answerForm').dispatchEvent(
    new harness.window.Event('submit', { bubbles: true, cancelable: true })
  );
}

function submitRemediation(harness, answer) {
  harness.document.querySelector('#remediationInput').value = answer;
  harness.document.querySelector('#remediationForm').dispatchEvent(
    new harness.window.Event('submit', { bubbles: true, cancelable: true })
  );
}

async function completeImmediateCorrection(harness, wrongAnswer = 'enviroment') {
  submitPrimary(harness, wrongAnswer);
  await tick();
  assert.equal(harness.controller.snapshot().active?.phase, 'correction');
  harness.document.querySelector('#remediationAcknowledgeBtn').click();
  assert.equal(harness.controller.snapshot().active?.phase, 'recall');
  submitRemediation(harness, harness.currentWord().term);
  assert.equal(harness.controller.snapshot().active?.phase, 'completed');
}

function continueRemediation(harness) {
  harness.document.querySelector('#remediationContinueBtn').click();
}

async function answerPrimaryCorrect(harness) {
  submitPrimary(harness, harness.currentWord().term);
  await tick();
  assert.equal(harness.controller.snapshot().active, null);
}

function nextPrimary(harness) {
  harness.document.querySelector('#nextCardBtn').click();
}

// Regression: after correcting the first of two new words, the second new word must
// appear. The pending recheck still has a three-card gap and must not be force-flushed.
const twoCards = await createHarness({ mode: 'new', finiteTotal: 2 });
await completeImmediateCorrection(twoCards);
assert.equal(twoCards.controller.snapshot().queue[0].remainingCards, 3);
continueRemediation(twoCards);
assert.equal(twoCards.controller.snapshot().active, null);
assert.equal(twoCards.metrics().wordIndex, 1);
assert.equal(twoCards.currentWord().id, 'airport');
assert.equal(twoCards.metrics().sessionFinished, false);
assert.equal(twoCards.emittedEvents.filter(({ name }) => name === 'vocora:same-session-recheck-started').length, 0);

// A short finite session with only two intervening cards must finish normally. It
// must not collapse a three-card spacing rule into an immediate or early recheck.
const shortSession = await createHarness({ mode: 'new', finiteTotal: 3 });
await completeImmediateCorrection(shortSession);
continueRemediation(shortSession);
assert.equal(shortSession.currentWord().id, 'airport');
await answerPrimaryCorrect(shortSession);
nextPrimary(shortSession);
assert.equal(shortSession.currentWord().id, 'library');
await answerPrimaryCorrect(shortSession);
nextPrimary(shortSession);
await tick();
assert.equal(shortSession.metrics().sessionFinished, true);
assert.equal(shortSession.controller.snapshot().active, null);
assert.equal(shortSession.controller.snapshot().queue.length, 0, 'Ending the session must discard transient, not-yet-due rechecks.');
assert.equal(shortSession.emittedEvents.filter(({ name }) => name === 'vocora:same-session-recheck-started').length, 0);

// The same rule applies when the wrong word is the only/last primary card.
const lastCard = await createHarness({ mode: 'new', finiteTotal: 1 });
await completeImmediateCorrection(lastCard);
continueRemediation(lastCard);
await tick();
assert.equal(lastCard.metrics().sessionFinished, true);
assert.equal(lastCard.controller.snapshot().active, null);
assert.equal(lastCard.controller.snapshot().queue.length, 0);

// When three genuine primary cards do remain, the recheck should happen exactly
// after those three cards and before the finite session completes.
const exactGap = await createHarness({ mode: 'new', finiteTotal: 4 });
await completeImmediateCorrection(exactGap);
continueRemediation(exactGap);
for (let index = 0; index < 2; index += 1) {
  await answerPrimaryCorrect(exactGap);
  nextPrimary(exactGap);
  assert.equal(exactGap.controller.snapshot().active, null);
}
await answerPrimaryCorrect(exactGap);
nextPrimary(exactGap);
assert.equal(exactGap.metrics().sessionFinished, false);
assert.equal(exactGap.controller.snapshot().active?.context, 'recheck');
assert.equal(exactGap.controller.snapshot().active?.wordId, 'environment');
assert.equal(exactGap.controller.snapshot().active?.recheckNumber, 1);
submitRemediation(exactGap, 'environment');
assert.equal(exactGap.controller.snapshot().active?.phase, 'completed');
continueRemediation(exactGap);
await tick();
assert.equal(exactGap.metrics().sessionFinished, true);
assert.equal(exactGap.metrics().appSubmissions, 4, 'Rechecks must remain outside primary/Leitner statistics.');

// Free practice keeps the same three-primary-card spacing behavior.
const freePractice = await createHarness({ mode: 'box1' });
await completeImmediateCorrection(freePractice);
continueRemediation(freePractice);
for (let index = 0; index < 3; index += 1) {
  await answerPrimaryCorrect(freePractice);
  nextPrimary(freePractice);
}
assert.equal(freePractice.controller.snapshot().active?.context, 'recheck');
assert.equal(freePractice.controller.snapshot().active?.wordId, 'environment');
assert.equal(freePractice.metrics().appSubmissions, 4);

// Multiple mistakes keep independent gaps and are rechecked in due order without
// jumping ahead of unseen primary words.
const multipleMistakes = await createHarness({ mode: 'new', finiteTotal: 5 });
await completeImmediateCorrection(multipleMistakes, 'enviroment');
continueRemediation(multipleMistakes);
assert.equal(multipleMistakes.currentWord().id, 'airport');
await completeImmediateCorrection(multipleMistakes, 'airprot');
continueRemediation(multipleMistakes);
assert.equal(multipleMistakes.currentWord().id, 'library');
await answerPrimaryCorrect(multipleMistakes);
nextPrimary(multipleMistakes);
assert.equal(multipleMistakes.currentWord().id, 'medicine');
await answerPrimaryCorrect(multipleMistakes);
nextPrimary(multipleMistakes);
assert.equal(multipleMistakes.controller.snapshot().active?.wordId, 'environment');
submitRemediation(multipleMistakes, 'environment');
continueRemediation(multipleMistakes);
assert.equal(multipleMistakes.currentWord().id, 'lecture');
await answerPrimaryCorrect(multipleMistakes);
nextPrimary(multipleMistakes);
assert.equal(multipleMistakes.controller.snapshot().active?.wordId, 'airport');
submitRemediation(multipleMistakes, 'airport');
continueRemediation(multipleMistakes);
await tick();
assert.equal(multipleMistakes.metrics().sessionFinished, true);
assert.equal(multipleMistakes.metrics().appSubmissions, 5);

// A failed recheck schedules its one-card retry without running it immediately.
const retryGap = await createHarness({ mode: 'box1' });
await completeImmediateCorrection(retryGap);
continueRemediation(retryGap);
for (let index = 0; index < 3; index += 1) {
  await answerPrimaryCorrect(retryGap);
  nextPrimary(retryGap);
}
assert.equal(retryGap.controller.snapshot().active?.recheckNumber, 1);
submitRemediation(retryGap, 'enviroment');
assert.equal(retryGap.controller.snapshot().active?.phase, 'copy');
submitRemediation(retryGap, 'environment');
assert.equal(retryGap.controller.snapshot().active?.phase, 'recall');
submitRemediation(retryGap, 'environment');
assert.equal(retryGap.controller.snapshot().active?.phase, 'completed');
assert.equal(retryGap.controller.snapshot().queue[0].remainingCards, 1);
continueRemediation(retryGap);
assert.equal(retryGap.controller.snapshot().active, null);
await answerPrimaryCorrect(retryGap);
nextPrimary(retryGap);
assert.equal(retryGap.controller.snapshot().active?.context, 'recheck');
assert.equal(retryGap.controller.snapshot().active?.recheckNumber, 2);

// Scheduled “today review” remains outside the remediation capability.
const scheduled = await createHarness({ mode: 'scheduled' });
submitPrimary(scheduled, 'enviroment');
await tick();
assert.equal(scheduled.metrics().appSubmissions, 1);
assert.equal(scheduled.controller.snapshot().active, null);
assert.equal(scheduled.controller.snapshot().queue.length, 0);
assert.equal(scheduled.document.querySelector('#practiceRemediation').classList.contains('hidden'), true);

console.log('Same-session spelling remediation browser adapter tests passed.');
