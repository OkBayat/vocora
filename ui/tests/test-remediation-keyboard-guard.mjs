import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const guardSource = fs.readFileSync(new URL('../practice-remediation-keyboard-guard.js', import.meta.url), 'utf8');
const indexMarkup = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scriptOrder = [...indexMarkup.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);

assert.ok(
  scriptOrder.indexOf('practice-remediation-keyboard-guard.js') < scriptOrder.indexOf('app-v2.js'),
  'The remediation keyboard guard must register before the legacy app shortcut listener.'
);

const dom = new JSDOM(`<!doctype html><html><body>
  <section id="practiceRemediation">
    <button id="remediationAcknowledgeBtn" type="button">acknowledge</button>
    <form id="remediationForm">
      <input id="remediationInput">
      <button id="remediationSubmitBtn" type="submit">submit</button>
    </form>
  </section>
  <button id="ordinaryControl" type="button">ordinary</button>
</body></html>`, {
  url: 'https://vocora.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});

const { window } = dom;
const { document } = window;
let targetKeydowns = 0;
let legacyNextCards = 0;
let unrelatedVoiceStarts = 0;

for (const selector of ['#remediationAcknowledgeBtn', '#remediationInput']) {
  document.querySelector(selector).addEventListener('keydown', () => { targetKeydowns += 1; });
}

window.eval(guardSource);
assert.equal(window.VocoraRemediationKeyboardGuard.install(document), false, 'Installing the guard twice must be idempotent.');

// This models app-v2's document-level Enter shortcut, which used to call showNextCard()
// while the remediation UI still owned the keyboard interaction.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  legacyNextCards += 1;
  unrelatedVoiceStarts += 1;
});

function pressEnter(element) {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true
  });
  element.dispatchEvent(event);
  return event;
}

let event = pressEnter(document.querySelector('#remediationAcknowledgeBtn'));
assert.equal(targetKeydowns, 1, 'Enter must still reach the focused remediation action.');
assert.equal(legacyNextCards, 0, 'Enter on the correction screen must not advance the underlying card.');
assert.equal(unrelatedVoiceStarts, 0, 'Enter on the correction screen must not start another word voice.');
assert.equal(event.defaultPrevented, false, 'The guard must preserve the control’s native Enter behavior.');

event = pressEnter(document.querySelector('#remediationInput'));
assert.equal(targetKeydowns, 2, 'Enter must still reach the remediation recall input/form.');
assert.equal(legacyNextCards, 0, 'Enter in recall must not advance the underlying card before validation.');
assert.equal(unrelatedVoiceStarts, 0, 'Enter in recall must not start another word voice.');
assert.equal(event.defaultPrevented, false, 'The guard must not cancel native form submission.');

event = pressEnter(document.querySelector('#ordinaryControl'));
assert.equal(legacyNextCards, 1, 'Enter outside remediation must retain the existing app shortcut.');
assert.equal(unrelatedVoiceStarts, 1);
assert.equal(event.defaultPrevented, true);

console.log('Remediation keyboard guard tests passed.');
