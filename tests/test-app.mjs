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
assert.ok(VazheyarTest, 'Test API should be exposed');
assert.equal(dom.window.IELTS_CORE_WORDS.length, 1500, 'Bundled list must contain 1500 items');
assert.equal(VazheyarTest.parseWordFile(sourceWords).length, 1500, 'Markdown parser must read all 1500 items');
assert.equal(VazheyarTest.normalizeAnswer('  Credit   Card  '), 'credit card');
assert.ok(VazheyarTest.isCorrectAnswer('center', { accepted: ['centre', 'center'] }));
assert.ok(VazheyarTest.isCorrectAnswer("taxpayers’ money", { accepted: ["taxpayers' money"] }));
assert.equal(VazheyarTest.addDays('2026-12-31', 1), '2027-01-01');

let report = VazheyarTest.buildAnalysisReport();
assert.equal(report.profile.totalWords, 1500);
assert.equal(report.profile.totalAttempts, 0);
assert.equal(document.querySelector('#dueStat').textContent, '۰');

document.querySelector('[data-view="words"]').click();
assert.equal(document.querySelectorAll('#wordsTableBody tr').length, 40, 'Words table should paginate to 40 rows');
assert.match(document.querySelector('#wordCountLabel').textContent, /۱٬۵۰۰/);

document.querySelector('[data-view="review"]').click();
assert.equal(document.querySelector('#setupNew').textContent, '۱۰');
document.querySelector('#beginSessionBtn').click();
assert.equal(document.querySelector('#reviewSession').classList.contains('hidden'), false);
document.querySelector('#dontKnowBtn').click();
assert.match(document.querySelector('#feedbackTitle').textContent, /۱‌مین خطا/);

const saved = JSON.parse(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'));
assert.equal(saved.history.length, 1);
assert.equal(saved.history[0].correct, false);
assert.equal(saved.words.find((word) => word.id === saved.history[0].wordId).mistakes, 1);
assert.equal(saved.words.find((word) => word.id === saved.history[0].wordId).box, 1);

report = VazheyarTest.buildAnalysisReport();
assert.equal(report.profile.totalAttempts, 1);
assert.equal(report.profile.mistakes, 1);
assert.equal(report.hardestWords[0].mistakes, 1);
assert.equal(report.recentMistakeEvents.length, 1);

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

console.log('All Vazheyar browser tests passed.');
