import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('../share-story-v2.js', import.meta.url), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom.window.eval(source);

const { VocoraShare } = dom.window;
assert.ok(VocoraShare, 'Share story API must be available');
assert.equal(VocoraShare.STORY_WIDTH, 1080);
assert.equal(VocoraShare.STORY_HEIGHT, 1920);
assert.equal(VocoraShare.STORY_SAFE_TOP, 270);
assert.equal(VocoraShare.STORY_SAFE_BOTTOM, 1536);
assert.equal(VocoraShare.STORY_MIME_TYPE, 'image/png');
assert.equal(fs.existsSync(new URL('../fonts/vazirmatn-arabic-wght-normal.woff2', import.meta.url)), true, 'The Persian story font must be bundled locally');

const now = new Date(2026, 6, 13, 12);
const privateState = {
  email: 'private@example.com',
  settings: { dailyGoal: 20, dailyNew: 10 },
  words: [
    { term: 'private-secret-word', box: 1, introducedOn: '2026-07-13', mistakes: 9 },
    { term: 'another-secret', box: 0 }
  ],
  daily: {},
  history: [{ answer: 'private-wrong-answer', correct: false }]
};

const startMoments = VocoraShare.buildShareMoments(privateState, { now, today: '2026-07-13' });
assert.equal(startMoments.length, 1);
assert.equal(startMoments[0].kind, 'journey');
assert.equal(startMoments[0].recommended, true);
const publicPayload = JSON.stringify(startMoments);
for (const secret of ['private@example.com', 'private-secret-word', 'another-secret', 'private-wrong-answer']) {
  assert.equal(publicPayload.includes(secret), false, `Share model must not contain ${secret}`);
}
assert.equal(publicPayload.includes('یاد گرفتم'), false, 'Activated words must never be mislabeled as learned');

const returningState = {
  settings: { dailyGoal: 20, dailyNew: 10 },
  words: [{ term: 'private-past-word', box: 2, introducedOn: '2026-07-01' }],
  daily: { '2026-07-05': { attempts: 4, correct: 2 } }
};
const [returningMoment] = VocoraShare.buildShareMoments(returningState, { now, today: '2026-07-13' });
assert.equal(returningMoment.kind, 'journey');
assert.match(returningMoment.title, /ادامه می‌دهم/, 'A returning learner must not be mislabeled as just starting');
assert.equal(JSON.stringify(returningMoment).includes('private-past-word'), false);

const progressState = {
  settings: { dailyGoal: 10, dailyNew: 5 },
  words: Array.from({ length: 12 }, (_, index) => ({
    term: `secret-${index}`,
    box: index < 10 ? 5 : 2,
    introducedOn: '2026-07-01'
  })),
  daily: {
    '2026-07-13': { attempts: 12, correct: 10 },
    '2026-07-12': { attempts: 5, correct: 4 },
    '2026-07-11': { attempts: 3, correct: 2 },
    '2026-07-06': { attempts: 2, correct: 1 }
  }
};

const progressMoments = VocoraShare.buildShareMoments(progressState, { now, today: '2026-07-13' });
assert.ok(progressMoments.some((moment) => moment.kind === 'daily'));
assert.ok(progressMoments.some((moment) => moment.kind === 'streak'));
assert.ok(progressMoments.some((moment) => moment.kind === 'mastery'));
assert.match(progressMoments.find((moment) => moment.kind === 'daily').title, /کامل کردم/);
assert.equal(progressMoments.find((moment) => moment.kind === 'mastery').unit, 'واژه در خانهٔ تسلط');
assert.equal(JSON.stringify(progressMoments).includes('secret-'), false);

const withSession = VocoraShare.buildShareMoments(progressState, {
  now,
  today: '2026-07-13',
  session: { answered: 9, correct: 8, wrong: 1, durationMinutes: 4 }
});
assert.equal(withSession[0].kind, 'session', 'A just-completed session should be the recommended story');
assert.equal(withSession[0].stats.some((stat) => stat.label === 'دقت جلسه'), true);

const tinySession = VocoraShare.buildShareMoments(privateState, {
  now,
  today: '2026-07-13',
  session: { answered: 3, correct: 1, wrong: 2, durationMinutes: 1 }
});
assert.equal(tinySession[0].stats.some((stat) => stat.label === 'دقت جلسه'), false, 'Tiny samples should not foreground accuracy');
assert.equal(tinySession[0].stats.some((stat) => stat.label.includes('درست')), false, 'A shared session must not expose raw correct-answer counts');

const strugglingSession = VocoraShare.buildShareMoments(progressState, {
  now,
  today: '2026-07-13',
  session: { answered: 10, correct: 1, wrong: 9, durationMinutes: 4 }
});
assert.equal(strugglingSession[0].stats.some((stat) => stat.label === 'دقت جلسه'), false, 'Low accuracy should not become a public shame signal');
assert.equal(strugglingSession[0].value, '۱۰', 'The neutral effort metric should remain shareable');

const corruptDailyState = {
  settings: { dailyGoal: 5 },
  words: [],
  daily: { '2026-07-13': { attempts: 5, correct: 99 } }
};
const corruptDaily = VocoraShare.buildShareMoments(corruptDailyState, { now, today: '2026-07-13' })
  .find((moment) => moment.kind === 'daily');
assert.equal(corruptDaily.stats.find((stat) => stat.label === 'دقت امروز').value, '۱۰۰٪', 'Displayed percentages must be clamped to a valid range');

const momentumState = {
  settings: { dailyGoal: 10 },
  words: [],
  daily: {}
};
const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
for (let offset = 0; offset < 7; offset += 1) {
  const recentDate = new Date(2026, 6, 13 - offset, 12);
  const previousDate = new Date(2026, 6, 6 - offset, 12);
  momentumState.daily[dateKey(recentDate)] = { attempts: 6, correct: 6 };
  momentumState.daily[dateKey(previousDate)] = { attempts: 2, correct: 2 };
}
const momentum = VocoraShare.buildShareMoments(momentumState, { now, today: '2026-07-13' })
  .find((moment) => moment.kind === 'momentum');
assert.ok(momentum, 'A meaningful week-over-week increase should produce a momentum story');
assert.deepEqual(Array.from(momentum.stats, (stat) => stat.label), ['۷ روز اخیر', '۷ روز قبل']);
assert.equal(momentum.value, '+۲۰۰٪', 'Growth above 100% must not be silently capped like an accuracy metric');

const drawnText = [];
const context = {
  globalAlpha: 1,
  beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
  arc() {}, stroke() {}, fill() {}, save() {}, restore() {}, fillRect() {},
  createLinearGradient() { return { addColorStop() {} }; },
  measureText(text) { return { width: String(text).length * 23 }; },
  fillText(text, x, y) { drawnText.push({ text: String(text), x, y }); }
};
const canvas = {
  width: 0,
  height: 0,
  getContext() { return context; },
  toBlob(callback, type) { callback(new dom.window.Blob(['png'], { type })); }
};

await VocoraShare.renderStory(canvas, withSession[0]);
assert.equal(canvas.width, 1080);
assert.equal(canvas.height, 1920);
assert.ok(drawnText.some(({ text }) => text === 'VOCORA'));
assert.ok(drawnText.some(({ text }) => text.includes('vocora.ir')));
assert.equal(drawnText.map(({ text }) => text).join(' ').includes('private@example.com'), false);
assert.equal(
  drawnText.every(({ y }) => y >= VocoraShare.STORY_SAFE_TOP && y <= VocoraShare.STORY_SAFE_BOTTOM),
  true,
  'All story text must remain inside the conservative Instagram UI-safe area'
);

await assert.rejects(
  VocoraShare.renderStory({ getContext: () => null }, withSession[0]),
  /بوم تصویر/,
  'Canvas failures must surface instead of producing a false ready state'
);

const file = await VocoraShare.storyFile(canvas, withSession[0]);
assert.equal(file.type, 'image/png');
assert.match(file.name, /^vocora-session-\d{4}-\d{2}-\d{2}\.png$/);

const sharedPayloads = [];
const checkedPayloads = [];
const supportedNavigator = {
  canShare(payload) {
    checkedPayloads.push(payload);
    return payload.files?.length === 1 && payload.files[0].type === 'image/png';
  },
  async share(payload) { sharedPayloads.push(payload); }
};
assert.equal(VocoraShare.supportsFileShare(supportedNavigator), true);
checkedPayloads.length = 0;
const shared = await VocoraShare.shareStory(canvas, withSession[0], supportedNavigator, file);
assert.equal(shared.status, 'shared');
assert.equal(sharedPayloads.length, 1);
assert.equal(checkedPayloads.length, 1);
assert.equal(checkedPayloads[0], sharedPayloads[0], 'The exact payload validated by canShare must be passed to share');
assert.equal(sharedPayloads[0].files[0], file);
assert.match(sharedPayloads[0].text, /vocora\.ir/);

const unsupported = await VocoraShare.shareStory(canvas, withSession[0], { canShare: () => false }, file);
assert.equal(unsupported.status, 'unsupported');
assert.equal(unsupported.file, file);

const cancelled = await VocoraShare.shareStory(canvas, withSession[0], {
  canShare: () => true,
  async share() { throw new dom.window.DOMException('Cancelled', 'AbortError'); }
}, file);
assert.equal(cancelled.status, 'cancelled');

assert.match(VocoraShare.shareText(withSession[0]), /#Vocora/);
assert.match(VocoraShare.shareText(withSession[0]), /#یادگیری_زبان/);

console.log('All Vocora share story tests passed.');
