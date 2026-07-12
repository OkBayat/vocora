import fs from 'node:fs';
import path from 'node:path';

const source = process.argv[2];
const target = process.argv[3];
if (!source || !target) throw new Error('Usage: node build-vocabulary.mjs SOURCE TARGET');

const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
let category = 'General';
const words = [];
for (const line of lines) {
  const heading = line.match(/^##\s+(.+?)\s*$/);
  if (heading) category = heading[1];
  const item = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
  if (!item) continue;
  const accepted = item[2].split(/\s+\/\s+/).map((value) => value.trim()).filter(Boolean);
  words.push({ number: Number(item[1]), term: accepted[0], accepted, category });
}

if (words.length !== 1500) throw new Error(`Expected 1500 words, found ${words.length}`);
const output = `/* Generated from IELTS_Listening_Core_1500.md. */\nwindow.IELTS_CORE_WORDS = ${JSON.stringify(words, null, 2)};\n`;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, output);
console.log(`Generated ${words.length} words in ${target}`);
