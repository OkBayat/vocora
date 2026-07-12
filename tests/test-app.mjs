import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const html = fs.readFileSync(new URL('index.html', root), 'utf8')
  .replace(/<script src="vocabulary\.js"><\/script>/, '')
  .replace(/<script src="app\.js"><\/script>/, '');
const vocabulary = fs.readFileSync(new URL('vocabulary.js', root), 'utf8');
const app = fs.readFileSync(new URL('app.js', root), 'utf8');
const sourceWords = fs.readFileSync(new URL('../data/IELTS_Listening_Core_1500.md', import.meta.url), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://vazheyar.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.scrollTo = () => {};
    window.confirm = () => true;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; } };
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
  }
});

dom.window.eval(vocabulary);
dom.window.eval(app);
await new Promise((resolve) => setTimeout(resolve, 30));

const { document, VazheyarTest } = dom.window;
const originalRandom = dom.window.Math.random;
assert.ok(VazheyarTest, 'Test API should be exposed');
assert.equal(dom.window.IELTS_CORE_WORDS.length, 1500, 'Bundled list must contain 1500 items');
assert.equal(VazheyarTest.parseWordFile(sourceWords).length, 1500, 'Markdown parser must read all 1500 items');
assert.equal(VazheyarTest.normalizeAnswer('  Credit   Card  '), 'credit card');
assert.ok(VazheyarTest.isCorrectAnswer('center', { accepted: ['centre', 'center'] }));
assert.ok(VazheyarTest.isCorrectAnswer("taxpayers’ money", { accepted: ["taxpayers' money"] }));
assert.equal(VazheyarTest.addDays('2026-12-31', 1), '2027-01-01');

let report = VazheyarTest.buildAnalysisReport();
assert.equal(report.profile.totalWords, 1500);
assert.equal(report.profile.introducedWords, 10, 'Ten words must enter box 1 at the start of a calendar day');
assert.equal(report.profile.totalAttempts, 0);
assert.equal(document.querySelector('#dueStat').textContent, '۱۰');
assert.equal(report.schedulingRules.box2To3Days, 2);
assert.equal(report.schedulingRules.box3To4Days, 3);

document.querySelector('[data-view="words"]').click();
assert.equal(document.querySelectorAll('#wordsTableBody tr').length, 40, 'Words table should paginate to 40 rows');
assert.match(document.querySelector('#wordCountLabel').textContent, /۱٬۵۰۰/);

document.querySelector('[data-view="review"]').click();
assert.equal(document.querySelector('#setupNew').textContent, '۱۰');
assert.equal(document.querySelector('#setupDue').textContent, '۰');
document.querySelector('#beginSessionBtn').click();
assert.equal(document.querySelector('#reviewSession').classList.contains('hidden'), false);
document.querySelector('#dontKnowBtn').click();
assert.match(document.querySelector('#feedbackTitle').textContent, /۱‌مین خطا/);

let saved = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
assert.equal(saved.history.length, 1);
assert.equal(saved.history[0].correct, false);
const mistakenId = saved.history[0].wordId;
const mistakenWord = saved.words.find((word) => word.id === mistakenId);
assert.equal(mistakenWord.mistakes, 1);
assert.equal(mistakenWord.box, 1);
assert.equal(mistakenWord.blockedUntil, VazheyarTest.addDays(VazheyarTest.localDay(), 1));
assert.equal(mistakenWord.due, VazheyarTest.addDays(VazheyarTest.localDay(), 1));

document.querySelector('#nextCardBtn').click();
const promotable = VazheyarTest.getCurrentWord();
document.querySelector('#answerInput').value = promotable.term;
document.querySelector('#answerForm button[type="submit"]').click();
saved = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
const promotedWord = saved.words.find((word) => word.id === promotable.id);
assert.equal(promotedWord.box, 2, 'A correct scheduled answer must promote box 1 to box 2');
assert.equal(promotedWord.due, VazheyarTest.addDays(VazheyarTest.localDay(), 2), 'Box 2 must wait two calendar days');
assert.equal(saved.history.at(-1).promoted, true);

report = VazheyarTest.buildAnalysisReport();
assert.equal(report.profile.totalAttempts, 2);
assert.equal(report.profile.mistakes, 1);
assert.equal(report.hardestWords[0].mistakes, 1);
assert.equal(report.recentMistakeEvents.length, 1);

for (let index = 0; index < 2; index += 1) {
  document.querySelector('#nextCardBtn').click();
  const dueWord = VazheyarTest.getCurrentWord();
  document.querySelector('#answerInput').value = dueWord.term;
  document.querySelector('#answerForm button[type="submit"]').click();
}
document.querySelector('#nextCardBtn').click();
assert.equal(VazheyarTest.getCurrentWord().id, mistakenId, 'A wrong card should be shown once more in the same session');
document.querySelector('#answerInput').value = VazheyarTest.getCurrentWord().term;
document.querySelector('#answerForm button[type="submit"]').click();
saved = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
assert.equal(saved.words.find((word) => word.id === mistakenId).box, 1, 'A later correct answer on the same day must not unlock promotion');
assert.equal(saved.history.at(-1).promoted, false);

document.querySelector('#exitSessionBtn').click();
dom.window.Math.random = () => 0;
document.querySelector('#boxOnePracticeBtn').click();
await new Promise((resolve) => setTimeout(resolve, 80));
const freePracticeWord = VazheyarTest.getCurrentWord();
assert.equal(freePracticeWord.box, 1, 'Free practice must only select box 1');
document.querySelector('#answerInput').value = freePracticeWord.term;
document.querySelector('#answerForm button[type="submit"]').click();
saved = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
assert.equal(saved.words.find((word) => word.id === freePracticeWord.id).box, 1, 'A correct free-practice answer must not promote a card');
assert.equal(saved.history.at(-1).mode, 'box1');
assert.equal(saved.history.at(-1).promoted, false);
dom.window.Math.random = originalRandom;

const weightedCounts = new Map();
for (let index = 0; index < 300; index += 1) {
  VazheyarTest.weightedBoxOneBatch().forEach((id) => weightedCounts.set(id, (weightedCounts.get(id) || 0) + 1));
}
const mistakenFrequency = weightedCounts.get(mistakenId) || 0;
const otherFrequencies = [...weightedCounts.entries()].filter(([id]) => id !== mistakenId).map(([, count]) => count);
const otherAverage = otherFrequencies.reduce((sum, count) => sum + count, 0) / otherFrequencies.length;
assert.ok(mistakenFrequency > otherAverage * 1.25, 'Words with more mistakes must appear more often in box 1 practice');

const legacy = {
  words: [{ id: 'legacy-word', box: 4, due: '2026-01-01', introducedOn: '2026-01-01', blockedUntil: null, lastPromotedDay: null, masteredAt: null }],
  history: [
    { wordId: 'legacy-word', day: '2026-01-01', at: '2026-01-01T10:00:00Z', correct: true },
    { wordId: 'legacy-word', day: '2026-01-01', at: '2026-01-01T11:00:00Z', correct: true },
    { wordId: 'legacy-word', day: '2026-01-02', at: '2026-01-02T11:00:00Z', correct: true },
    { wordId: 'legacy-word', day: '2026-01-03', at: '2026-01-03T11:00:00Z', correct: true }
  ]
};
VazheyarTest.migrateLegacyProgress(legacy);
assert.equal(legacy.words[0].box, 3, 'Legacy same-day extra practice must not create extra promotions');
assert.equal(legacy.words[0].due, '2026-01-06', 'Migrated box 3 must wait three calendar days');

document.querySelector('[data-view="words"]').click();
document.querySelector('#addWordBtn').click();
document.querySelector('#wordTermInput').value = 'accommodation';
document.querySelector('.close-word-dialog').click();
assert.equal(document.querySelector('#wordDialog').open, false, 'Cancel must close without saving');

document.querySelector('#addWordBtn').click();
document.querySelector('#wordTermInput').value = 'test phrase';
document.querySelector('#wordVariantsInput').value = 'test-phrase';
document.querySelector('#wordCategoryInput').value = 'Test';
document.querySelector('#saveWordBtn').click();
const afterAdd = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
assert.equal(afterAdd.words.length, 1501, 'Manual word entry must persist');
assert.deepEqual(afterAdd.words.at(-1).accepted, ['test phrase', 'test-phrase']);

document.querySelector('[data-view="settings"]').click();
assert.equal(document.querySelector('.repo-link').href, 'https://github.com/OkBayat/el2-leitner');

console.log('All Vazheyar browser tests passed.');
