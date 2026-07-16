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
  </body></html>`;
}

async function createHarness({ mode = 'box1', finiteTotal = null } = {}) {
  const words = [
    { id: 'environment', term: 'environment', accepted: ['environment'], category: 'Nature', box: 1, notes: '' },
    { id: 'filler-1', term: 'airport', accepted: ['airport'], category: 'Travel', box: 1, notes: '' },
    { id: 'filler-2', term: 'library', accepted: ['library'], category: 'Places', box: 1, notes: '' },
    { id: 'filler-3', term: 'medicine', accepted: ['medicine'], category: 'Health', box: 1, notes: '' },
    { id: 'filler-4', term: 'lecture', accepted: ['lecture'], category: 'Education', box: 1, notes: '' }
  ];
  let wordIndex = 0;
  let appSubmissions = 0;
  let appNextCards = 0;
  let appWrong = 0;
  let appCorrect = 0;
  const emittedEvents = [];

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
    isCorrectAnswer: (answer, word) => Boolean(normalize(answer))
      && word.accepted.some((accepted) => normalize(accepted) === normalize(answer))
  };
  window.VazheyarReady = Promise.resolve();

  const renderPrimaryFeedback = (correct) => {
    appSubmissions += 1;
    if (correct) appCorrect += 1;
    else appWrong += 1;
    document.querySelector('#answerForm').classList.add('hidden');
    document.querySelector('#dontKnowBtn').classList.add('hidden');
    document.querySelector('#answerFeedback').classList.remove('hidden');
    document.querySelector('#feedbackTitle').textContent = correct ? 'درست بود!' : 'اشتباه بود';
    document.querySelector('#correctAnswer').textContent = words[wordIndex].term;
  };

  document.querySelector('#answerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = document.querySelector('#answerInput').value;
    renderPrimaryFeedback(window.VazheyarTest.isCorrectAnswer(answer, words[wordIndex]));
  });
  document.querySelector('#dontKnowBtn').addEventListener('click', () => renderPrimaryFeedback(false));
  document.querySelector('#nextCardBtn').addEventListener('click', () => {
    appNextCards += 1;
    wordIndex = Math.min(wordIndex + 1, words.length - 1);
    document.querySelector('#answerInput').value = '';
    document.querySelector('#answerForm').classList.remove('hidden');
    document.querySelector('#dontKnowBtn').classList.remove('hidden');
    document.querySelector('#answerFeedback').classList.add('hidden');
    document.querySelector('#cardCategory').textContent = words[wordIndex].category;
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
    document.querySelector('#sessionCounter').textContent = 'تمرین آزاد · ۰ پاسخ';
  } else if (mode === 'new') {
    document.querySelector('#newWordsForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector('#cardInstruction').textContent = 'آزمون اولیه؛ پاسخ درست کارت را مستقیم به خانهٔ ۲ می‌برد.';
    document.querySelector('#sessionCounter').textContent = `کارت ۱ از ${finiteTotal || 1}`;
  } else {
    document.querySelector('#beginSessionBtn').click();
    document.querySelector('#cardInstruction').textContent = 'کلمه را بشنو و املای آن را بنویس.';
    document.querySelector('#sessionCounter').textContent = 'کارت ۱ از ۱۰';
  }

  return {
    dom,
    window,
    document,
    words,
    controller,
    emittedEvents,
    metrics: () => ({ appSubmissions, appNextCards, appWrong, appCorrect, wordIndex }),
    setWordIndex: (index) => { wordIndex = index; }
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

const practice = await createHarness({ mode: 'box1' });
submitPrimary(practice, 'enviroment');
await tick();

assert.equal(practice.metrics().appSubmissions, 1, 'The original wrong attempt must still be recorded by the existing app.');
assert.equal(practice.metrics().appWrong, 1);
assert.equal(practice.controller.snapshot().active.phase, 'correction');
assert.equal(practice.document.querySelector('#practiceRemediation').classList.contains('hidden'), false);
assert.equal(practice.document.querySelector('#remediationComparison').classList.contains('hidden'), false);
assert.match(practice.document.querySelector('#remediationCorrectSpelling').textContent, /environment/);
assert.ok(practice.document.querySelector('#remediationCorrectSpelling .spelling-missing'), 'The missing letter must be visually highlighted.');

practice.document.querySelector('#remediationAcknowledgeBtn').click();
assert.equal(practice.controller.snapshot().active.phase, 'recall');
assert.equal(practice.document.querySelector('#remediationComparison').classList.contains('hidden'), true, 'The answer must be hidden before recall.');
assert.equal(practice.document.querySelector('#practiceRemediation').textContent.includes('environment'), false, 'The hidden recall screen must not leak the target spelling.');
assert.equal(practice.document.querySelector('#correctAnswer').textContent, '', 'The existing feedback node must also be cleared during remediation recall.');
assert.equal(practice.document.querySelector('#remediationInput').value, '');

submitRemediation(practice, 'envirnment');
assert.equal(practice.controller.snapshot().active.phase, 'copy');
assert.match(practice.document.querySelector('#remediationValidation').textContent, /درست نبود/);
assert.match(practice.document.querySelector('#remediationCorrectSpelling').textContent, /environment/);
assert.equal(practice.metrics().appSubmissions, 1, 'Correction attempts must not be counted as Leitner/session assessments.');

submitRemediation(practice, 'environmentt');
assert.equal(practice.controller.snapshot().active.phase, 'copy');
assert.match(practice.document.querySelector('#remediationValidation').textContent, /مطابق/);
submitRemediation(practice, 'environment');
assert.equal(practice.controller.snapshot().active.phase, 'recall');
assert.equal(practice.document.querySelector('#remediationComparison').classList.contains('hidden'), true);
submitRemediation(practice, 'environment');
assert.equal(practice.controller.snapshot().active.phase, 'completed');
assert.equal(practice.controller.snapshot().queue.length, 1);
assert.equal(practice.controller.snapshot().queue[0].remainingCards, 3);
assert.equal(practice.metrics().appSubmissions, 1);

practice.document.querySelector('#remediationContinueBtn').click();
assert.equal(practice.metrics().appNextCards, 1);
assert.equal(practice.controller.snapshot().active, null);

for (let index = 1; index <= 3; index += 1) {
  const word = practice.words[index];
  submitPrimary(practice, word.term);
  await tick();
  assert.equal(practice.controller.snapshot().active, null);
  practice.document.querySelector('#nextCardBtn').click();
}

assert.equal(practice.metrics().appSubmissions, 4, 'Only the primary cards should contribute to existing app metrics.');
assert.equal(practice.metrics().appNextCards, 3, 'The due recheck must intercept navigation instead of consuming another app card.');
assert.equal(practice.controller.snapshot().active.context, 'recheck');
assert.equal(practice.controller.snapshot().active.phase, 'recall');
assert.equal(practice.controller.snapshot().active.wordId, 'environment');
assert.equal(practice.document.querySelector('#cardCategory').textContent, 'Nature');

submitRemediation(practice, 'environment');
assert.equal(practice.controller.snapshot().active.phase, 'completed');
assert.equal(practice.controller.snapshot().queue.length, 0);
assert.equal(practice.metrics().appSubmissions, 4, 'A same-session recheck must remain outside Leitner statistics and history.');
practice.document.querySelector('#remediationContinueBtn').click();
assert.equal(practice.metrics().appNextCards, 4);
assert.equal(practice.document.querySelector('#cardCategory').textContent, 'Education', 'The underlying card metadata must be restored before normal navigation.');
assert.ok(practice.emittedEvents.some(({ name }) => name === 'vocora:same-session-recheck-started'));
assert.ok(practice.emittedEvents.some(({ name, detail }) => name === 'vocora:spelling-remediation-completed' && detail.context === 'recheck'));

const finite = await createHarness({ mode: 'new', finiteTotal: 1 });
submitPrimary(finite, 'enviroment');
await tick();
finite.document.querySelector('#remediationAcknowledgeBtn').click();
submitRemediation(finite, 'environment');
assert.equal(finite.controller.snapshot().queue[0].remainingCards, 3);
finite.document.querySelector('#remediationContinueBtn').click();
assert.equal(finite.metrics().appNextCards, 0, 'A finite practice session must not finish while a recheck is pending.');
assert.equal(finite.controller.snapshot().active.context, 'recheck');
submitRemediation(finite, 'environment');
finite.document.querySelector('#remediationContinueBtn').click();
assert.equal(finite.metrics().appNextCards, 1, 'Normal completion may continue after the pending recheck is resolved.');
assert.equal(finite.metrics().appSubmissions, 1);

const scheduled = await createHarness({ mode: 'scheduled' });
submitPrimary(scheduled, 'enviroment');
await tick();
assert.equal(scheduled.metrics().appSubmissions, 1);
assert.equal(scheduled.controller.snapshot().active, null, 'The scheduled “today review” flow must stay untouched.');
assert.equal(scheduled.controller.snapshot().queue.length, 0);
assert.equal(scheduled.document.querySelector('#practiceRemediation').classList.contains('hidden'), true);

console.log('Same-session spelling remediation browser adapter tests passed.');
