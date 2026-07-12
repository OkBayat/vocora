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
let serverState = null;
let serverRevision = 0;
const apiCalls = [];

function mockResponse(status, payload = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return payload === null ? '' : JSON.stringify(payload); }
  };
}

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
    window.fetch = async (path, options = {}) => {
      const method = options.method || 'GET';
      apiCalls.push({ path: String(path), method, body: options.body ? JSON.parse(options.body) : null });
      if (path === '/api/auth/me' && method === 'GET') return mockResponse(200, { user: { id: 7, email: 'learner@example.com' } });
      if (path === '/api/state' && method === 'GET') return mockResponse(200, { state: serverState, revision: serverRevision });
      if (path === '/api/state' && method === 'PUT') {
        const payload = JSON.parse(options.body);
        if (payload.revision !== serverRevision) {
          return mockResponse(409, { error: { code: 'STATE_CONFLICT', message: 'State changed elsewhere.' } });
        }
        serverState = JSON.parse(JSON.stringify(payload.state));
        serverRevision += 1;
        return mockResponse(200, { state: serverState, revision: serverRevision });
      }
      if (path === '/api/auth/logout' && method === 'POST') return mockResponse(204);
      return mockResponse(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
  }
});

dom.window.eval(vocabulary);
dom.window.eval(app);
await dom.window.VazheyarReady;

const { document, VazheyarTest } = dom.window;
await VazheyarTest.waitForSaves();
const readServerState = async () => {
  await VazheyarTest.waitForSaves();
  return JSON.parse(JSON.stringify(serverState));
};
const originalRandom = dom.window.Math.random;
assert.ok(VazheyarTest, 'Test API should be exposed');
assert.equal(document.querySelector('#userEmail').textContent, 'learner@example.com');
assert.equal(dom.window.localStorage.getItem('vazheyar-ielts-state-v1'), null, 'Normal learning data must not be written to localStorage');
assert.ok(apiCalls.some((call) => call.path === '/api/state' && call.method === 'PUT'), 'Initial state must be persisted through the API');
assert.equal(VazheyarTest.getStateRevision(), serverRevision, 'Client and database state revisions must stay synchronized');
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
assert.equal(document.querySelectorAll('.stat-card.tone-blue').length, 2);
assert.equal(document.querySelectorAll('.stat-card.tone-teal').length, 1);
assert.equal(document.querySelectorAll('.stat-card.tone-coral').length, 1);

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

let saved = await readServerState();
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
saved = await readServerState();
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
saved = await readServerState();
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
saved = await readServerState();
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

document.querySelector('#exitSessionBtn').click();
document.querySelector('[data-view="words"]').click();
const addToBoxOneButton = document.querySelector('.add-to-box-one');
assert.ok(addToBoxOneButton, 'Unintroduced words must show a small add-to-box-1 button');
const bankAddedId = addToBoxOneButton.dataset.id;
addToBoxOneButton.click();
saved = await readServerState();
const bankAddedWord = saved.words.find((word) => word.id === bankAddedId);
assert.equal(bankAddedWord.box, 1);
assert.equal(bankAddedWord.due, VazheyarTest.localDay());
assert.equal(bankAddedWord.addedSource, 'word-bank');
assert.equal(document.querySelector(`.add-to-box-one[data-id="${bankAddedId}"]`), null, 'The plus button must disappear after activation');

document.querySelector('[data-view="dashboard"]').click();
dom.window.Math.random = () => 0.999999;
document.querySelector('#boxOnePracticeBtn').click();
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(VazheyarTest.getCurrentWord().id, bankAddedId, 'A manually activated word must be available in box 1 practice');
document.querySelector('#answerInput').value = VazheyarTest.getCurrentWord().term;
document.querySelector('#answerForm button[type="submit"]').click();
saved = await readServerState();
assert.equal(saved.words.find((word) => word.id === bankAddedId).box, 2, 'A zero-mistake new word must graduate from free practice on its first correct answer');
assert.equal(saved.history.at(-1).promoted, true);
document.querySelector('#exitSessionBtn').click();
dom.window.Math.random = originalRandom;

document.querySelector('#addNewWordsBtn').click();
assert.equal(document.querySelector('#newWordsDialog').open, true);
saved = await readServerState();
const selectedNewIds = saved.words.filter((word) => word.box === 0).sort((a, b) => a.number - b.number).slice(0, 3).map((word) => word.id);
document.querySelector('#newWordsCountInput').value = '3';
document.querySelector('#startNewWordsBtn').click();
assert.equal(document.querySelector('#reviewSession').classList.contains('hidden'), false, 'The selected new-word test must start immediately');
assert.equal(VazheyarTest.getCurrentWord().id, selectedNewIds[0]);
document.querySelector('#answerInput').value = VazheyarTest.getCurrentWord().term;
document.querySelector('#answerForm button[type="submit"]').click();
saved = await readServerState();
assert.equal(saved.words.find((word) => word.id === selectedNewIds[0]).box, 2, 'A first correct answer must move a new word directly to box 2');
assert.equal(saved.history.at(-1).mode, 'new');

document.querySelector('#nextCardBtn').click();
assert.equal(VazheyarTest.getCurrentWord().id, selectedNewIds[1]);
document.querySelector('#dontKnowBtn').click();
saved = await readServerState();
assert.equal(saved.words.find((word) => word.id === selectedNewIds[1]).box, 1, 'A failed new word must remain in box 1');
assert.equal(saved.words.find((word) => word.id === selectedNewIds[1]).blockedUntil, VazheyarTest.addDays(VazheyarTest.localDay(), 1));

document.querySelector('#nextCardBtn').click();
assert.equal(VazheyarTest.getCurrentWord().id, selectedNewIds[2], 'A failed new word must not repeat in the initial test');
document.querySelector('#answerInput').value = VazheyarTest.getCurrentWord().term;
document.querySelector('#answerForm button[type="submit"]').click();
document.querySelector('#nextCardBtn').click();
assert.equal(document.querySelector('#sessionComplete').classList.contains('hidden'), false, 'The initial test must finish after each selected word is shown once');

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
const afterAdd = await readServerState();
assert.equal(afterAdd.words.length, 1501, 'Manual word entry must persist');
assert.deepEqual(afterAdd.words.at(-1).accepted, ['test phrase', 'test-phrase']);

const importResult = VazheyarTest.importWords(`
## Duplicate handling
1. MONDAY
2. center
3. centre / center
4. unique-import-word
5. UNIQUE-IMPORT-WORD
`);
assert.equal(importResult.found, 5);
assert.equal(importResult.added, 1);
assert.equal(importResult.skipped, 4, 'Import must reject exact, case-only, variant, and within-file duplicates');
const afterImport = await readServerState();
assert.equal(afterImport.words.length, 1502);
assert.equal(afterImport.words.filter((word) => VazheyarTest.normalizeAnswer(word.term) === 'unique-import-word').length, 1);

document.querySelector('[data-view="settings"]').click();
assert.equal(document.querySelector('.repo-link').href, 'https://github.com/OkBayat/el2-leitner');

const stateBeforeConcurrentChange = JSON.parse(JSON.stringify(serverState));
serverRevision += 1; // Simulate a write from another tab or device.
const originalConsoleError = dom.window.console.error;
dom.window.console.error = () => {};
document.querySelector('#dailyGoalInput').value = '35';
document.querySelector('#saveSettingsBtn').click();
await VazheyarTest.waitForSaves();
dom.window.console.error = originalConsoleError;
assert.deepEqual(serverState, stateBeforeConcurrentChange, 'A stale tab must not overwrite a newer database revision');
assert.match(document.querySelector('#toast').textContent, /تب یا دستگاه دیگری/, 'A state conflict must ask the learner to reload');

for (const filename of ['login.html', 'register.html']) {
  const authDom = new JSDOM(fs.readFileSync(new URL(filename, root), 'utf8'));
  const authInputs = [...authDom.window.document.querySelectorAll('#authForm input')];
  assert.deepEqual(authInputs.map((input) => input.type), ['email', 'password'], `${filename} must request only email and password`);
  assert.equal(authDom.window.document.querySelector('script[src="auth.js"]') !== null, true);
}

let migratedServerState = null;
let migrationRevision = 0;
const legacyState = {
  schemaVersion: 2,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
  settings: { dailyNew: 10, dailyGoal: 20, voiceRate: 0.85, theme: 'system' },
  words: [{ id: 'browser-legacy', number: 1, term: 'legacy', accepted: ['legacy'], category: 'Migration', box: 2, due: '2099-01-01' }],
  daily: {},
  history: []
};
const migrationDom = new JSDOM(html, {
  url: 'https://vazheyar.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.localStorage.setItem('vazheyar-ielts-state-v1', JSON.stringify(legacyState));
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.scrollTo = () => {};
    window.confirm = () => true;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; } };
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    window.fetch = async (path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/api/auth/me') return mockResponse(200, { user: { id: 8, email: 'legacy@example.com' } });
      if (path === '/api/state' && method === 'GET') return mockResponse(200, { state: null, revision: migrationRevision });
      if (path === '/api/state' && method === 'PUT') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.revision, migrationRevision);
        migratedServerState = payload.state;
        migrationRevision += 1;
        return mockResponse(200, { state: migratedServerState, revision: migrationRevision });
      }
      return mockResponse(404);
    };
  }
});
migrationDom.window.eval(vocabulary);
migrationDom.window.eval(app);
await migrationDom.window.VazheyarReady;
await migrationDom.window.VazheyarTest.waitForSaves();
assert.equal(migratedServerState.words[0].id, 'browser-legacy', 'Existing localStorage data must be uploaded when the account has no server state');
assert.equal(migrationDom.window.localStorage.getItem('vazheyar-ielts-state-v1'), null, 'Legacy data must be removed only after its successful upload');

let freshStateWithoutStorage = null;
let blockedStorageRevision = 0;
const blockedStorageDom = new JSDOM(html, {
  url: 'https://vazheyar.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  beforeParse(window) {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('Storage access blocked'); }
    });
    window.console.warn = () => {};
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.scrollTo = () => {};
    window.confirm = () => true;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.speechSynthesis = { cancel() {}, speak() {}, getVoices() { return []; } };
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
    window.fetch = async (path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/api/auth/me') return mockResponse(200, { user: { id: 9, email: 'private@example.com' } });
      if (path === '/api/state' && method === 'GET') return mockResponse(200, { state: null, revision: blockedStorageRevision });
      if (path === '/api/state' && method === 'PUT') {
        const payload = JSON.parse(options.body);
        assert.equal(payload.revision, blockedStorageRevision);
        freshStateWithoutStorage = payload.state;
        blockedStorageRevision += 1;
        return mockResponse(200, { state: freshStateWithoutStorage, revision: blockedStorageRevision });
      }
      return mockResponse(404);
    };
  }
});
blockedStorageDom.window.eval(vocabulary);
blockedStorageDom.window.eval(app);
await blockedStorageDom.window.VazheyarReady;
await blockedStorageDom.window.VazheyarTest.waitForSaves();
assert.equal(freshStateWithoutStorage.words.length, 1500, 'Blocked legacy storage must not prevent a database-backed first boot');

console.log('All Vazheyar browser tests passed.');
