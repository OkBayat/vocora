import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const domainSource = fs.readFileSync(new URL('../practice-remediation.js', import.meta.url), 'utf8');
const adapterSource = fs.readFileSync(new URL('../practice-remediation-adapter.js', import.meta.url), 'utf8');
const promptSource = fs.readFileSync(new URL('../practice-remediation-recheck-prompt.js', import.meta.url), 'utf8');
const indexMarkup = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scriptOrder = [...indexMarkup.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);

assert.ok(
  scriptOrder.indexOf('practice-remediation-recheck-prompt.js') > scriptOrder.indexOf('practice-remediation-adapter.js'),
  'The recheck prompt coordinator must load after the remediation adapter.'
);

const WORDS = Object.freeze({
  concession: {
    id: 'concession', term: 'concession', accepted: ['concession'], category: 'Economics', box: 1, notes: ''
  },
  philosophy: {
    id: 'philosophy', term: 'philosophy', accepted: ['philosophy'], category: 'School subjects and disciplines', box: 1, notes: ''
  },
  airport: {
    id: 'airport', term: 'airport', accepted: ['airport'], category: 'Travel', box: 1, notes: ''
  },
  calendar: {
    id: 'calendar', term: 'calendar', accepted: ['calendar'], category: 'Time', box: 1, notes: ''
  },
  restaurant: {
    id: 'restaurant', term: 'restaurant', accepted: ['restaurant'], category: 'Places', box: 1, notes: ''
  },
  temperature: {
    id: 'temperature', term: 'temperature', accepted: ['temperature'], category: 'Science', box: 1, notes: ''
  }
});

function fixture() {
  return `<!doctype html><html lang="fa" dir="rtl"><body>
    <button id="beginSessionBtn" type="button">scheduled</button>
    <button id="boxOnePracticeBtn" type="button">box1</button>
    <button id="practiceExtraBtn" type="button">box1 extra</button>
    <form id="newWordsForm"><button type="submit">new</button></form>
    <div id="reviewSession">
      <div id="sessionCounter">تمرین آزاد · ۰ پاسخ</div>
      <article id="flashCard">
        <span id="cardCategory">Underlying category</span>
        <span id="cardBox">خانهٔ ۱</span>
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function recheckEntry(word, recheckNumber = 1) {
  return {
    id: `entry-${word.id}-${recheckNumber}`,
    word: { ...word, accepted: [...word.accepted] },
    mode: 'box1',
    recheckNumber,
    originId: null
  };
}

async function createHarness({ delayMs = 8, underlyingWord = WORDS.airport } = {}) {
  const spoken = [];
  let speechCancellations = 0;
  let underlyingNextCards = 0;

  const dom = new JSDOM(fixture(), {
    url: 'https://vocora.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.SpeechSynthesisUtterance = class {
        constructor(text) { this.text = text; }
      };
      window.speechSynthesis = {
        cancel() { speechCancellations += 1; },
        speak(utterance) { spoken.push(utterance.text); },
        getVoices() { return []; }
      };
    }
  });

  const { window } = dom;
  const { document } = window;
  const normalize = (value) => String(value || '').trim().toLowerCase();

  window.VazheyarTest = {
    getCurrentWord: () => underlyingWord,
    getState: () => ({ settings: { voiceRate: 0.85 } }),
    isCorrectAnswer: (answer, word) => Boolean(normalize(answer))
      && word.accepted.some((candidate) => normalize(candidate) === normalize(answer))
  };
  window.VazheyarReady = Promise.resolve();
  window.VocoraPracticeRecheckPromptConfig = { delayMs };
  document.querySelector('#nextCardBtn').addEventListener('click', () => { underlyingNextCards += 1; });

  window.eval(domainSource);
  window.eval(adapterSource);
  window.eval(promptSource);

  const controller = await window.VocoraPracticeRemediationReady;
  const coordinator = await window.VocoraPracticeRecheckPromptReady;
  assert.ok(controller);
  assert.ok(coordinator);
  assert.strictEqual(await window.VocoraPracticeRecheckPrompt.boot(), coordinator, 'Prompt boot must be idempotent.');

  return {
    dom,
    window,
    document,
    controller,
    coordinator,
    spoken,
    metrics: () => ({ speechCancellations, underlyingNextCards })
  };
}

function submitRemediation(harness, answer) {
  harness.document.querySelector('#remediationInput').value = answer;
  harness.document.querySelector('#remediationForm').dispatchEvent(
    new harness.window.Event('submit', { bubbles: true, cancelable: true })
  );
}

// A queued recheck must identify its own word, not the unrelated primary card that
// remains underneath the overlay. Input stays locked until that prompt is delivered,
// and the target spelling remains absent from the recall DOM.
const identity = await createHarness({ underlyingWord: WORDS.airport });
identity.controller.startRecheck(recheckEntry(WORDS.concession));
const identityInput = identity.document.querySelector('#remediationInput');
assert.equal(identityInput.disabled, true);
assert.equal(identityInput.getAttribute('aria-busy'), 'true');
assert.match(identityInput.placeholder, /پخش تلفظ/);
await wait(25);
assert.deepEqual(identity.spoken, ['concession']);
assert.equal(identityInput.disabled, false);
assert.equal(identityInput.hasAttribute('aria-busy'), false);
assert.equal(identity.document.activeElement, identityInput);
assert.equal(identity.controller.snapshot().active?.wordId, 'concession');
assert.equal(identity.document.querySelector('#cardCategory').textContent, 'Economics');
assert.match(identity.document.querySelector('#remediationTitle').textContent, /تلفظ/);
assert.match(identity.document.querySelector('#remediationDescription').textContent, /ممکن است با کلمهٔ قبلی فرق داشته باشد/);
assert.match(identity.document.querySelector('#remediationInputLabel').textContent, /الان می‌شنوی/);
assert.equal(
  identity.document.querySelector('#practiceRemediation').textContent.includes('concession'),
  false,
  'Automatic prompting must not leak the target spelling into the recall DOM.'
);
assert.ok(identity.metrics().speechCancellations >= 1, 'Starting a recheck must cancel stale pronunciation first.');

// Reproduce the reported shape: two due words can be rechecked back-to-back. The
// second one must lock, pronounce, and describe itself before accepting input, so
// entering the previous word is clearly a mistake for the newly prompted word.
identity.controller.queue.schedule({
  word: WORDS.philosophy,
  mode: 'box1',
  recheckNumber: 1,
  originId: null
}, 0);
submitRemediation(identity, 'concession');
assert.equal(identity.controller.snapshot().active?.phase, 'completed');
identity.document.querySelector('#remediationContinueBtn').click();
assert.equal(identityInput.disabled, true);
await wait(25);
assert.deepEqual(identity.spoken, ['concession', 'philosophy']);
assert.equal(identityInput.disabled, false);
assert.equal(identity.metrics().underlyingNextCards, 0, 'A due recheck may intercept navigation without consuming a primary card.');
assert.equal(identity.controller.snapshot().active?.wordId, 'philosophy');
assert.equal(identity.controller.snapshot().active?.phase, 'recall');
assert.equal(identity.document.querySelector('#cardCategory').textContent, 'School subjects and disciplines');
submitRemediation(identity, 'concession');
assert.equal(identity.controller.snapshot().active?.phase, 'copy');
assert.equal(identity.document.querySelector('#remediationUserSpelling').textContent, 'concession');
assert.equal(identity.document.querySelector('#remediationCorrectSpelling').textContent, 'philosophy');
assert.equal(identity.spoken.at(-1), 'philosophy', 'The learner must hear the word that the failed recall is checked against.');

// If another recheck replaces a pending prompt before its timer fires, only the
// current active word may be spoken and the input remains gated for that current word.
const replaced = await createHarness({ delayMs: 20 });
replaced.controller.startRecheck(recheckEntry(WORDS.concession));
replaced.controller.startRecheck(recheckEntry(WORDS.philosophy));
assert.equal(replaced.document.querySelector('#remediationInput').disabled, true);
await wait(45);
assert.deepEqual(replaced.spoken, ['philosophy']);
assert.equal(replaced.document.querySelector('#remediationInput').disabled, false);
assert.equal(replaced.controller.snapshot().active?.wordId, 'philosophy');

// Manual replay owns the prompt: clicking it before the automatic timer fires must
// unlock input and produce one pronunciation, not a delayed duplicate.
const manual = await createHarness({ delayMs: 25 });
manual.controller.startRecheck(recheckEntry(WORDS.calendar));
assert.equal(manual.document.querySelector('#remediationInput').disabled, true);
manual.document.querySelector('#remediationListenBtn').click();
assert.equal(manual.document.querySelector('#remediationInput').disabled, false);
await wait(50);
assert.deepEqual(manual.spoken, ['calendar']);

// Submitting a recall immediately cancels the pending automatic prompt. No stale
// pronunciation may start after the screen has already changed to completion.
const fastSubmit = await createHarness({ delayMs: 25 });
fastSubmit.controller.startRecheck(recheckEntry(WORDS.restaurant));
assert.equal(fastSubmit.document.querySelector('#remediationInput').disabled, true);
submitRemediation(fastSubmit, 'restaurant');
assert.equal(fastSubmit.controller.snapshot().active?.phase, 'completed');
assert.equal(fastSubmit.document.querySelector('#remediationInput').disabled, false);
await wait(50);
assert.deepEqual(fastSubmit.spoken, []);

// Closing the session before the timer fires clears the prompt, unlocks the hidden
// control, and stops stale audio.
const closed = await createHarness({ delayMs: 25 });
closed.controller.startRecheck(recheckEntry(WORDS.temperature));
assert.equal(closed.document.querySelector('#remediationInput').disabled, true);
closed.document.querySelector('#reviewSession').classList.add('hidden');
await wait(50);
assert.deepEqual(closed.spoken, []);
assert.equal(closed.document.querySelector('#remediationInput').disabled, false);
assert.ok(closed.metrics().speechCancellations >= 1);

// Immediate correction screens are not new audio prompts; only queued hidden-answer
// rechecks receive this automatic identification behavior.
const immediate = await createHarness({ delayMs: 5 });
immediate.controller.startImmediate(WORDS.concession, 'concesion');
await wait(20);
assert.deepEqual(immediate.spoken, []);
assert.equal(immediate.controller.snapshot().active?.context, 'immediate');
assert.equal(immediate.controller.snapshot().active?.phase, 'correction');
assert.equal(immediate.document.querySelector('#remediationInput').disabled, false);

console.log('Spelling recheck pronunciation prompt tests passed.');