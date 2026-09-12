import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VocabularyFileParser } from "../src/domain/library/VocabularyFileParser.js";
import { parseFileManagedLearningPathSource } from "../src/domain/collection-learning-path/FileManagedLearningPathSource.js";
import {
  resolveSlideSequenceDefinition,
  verifySlideSequenceCompletion,
} from "../src/domain/collection-learning-path/SlideSequenceExercise.js";
import { loadLearningPathSources } from "../src/infrastructure/content/loadLearningPathSources.js";

const LEARNING_PATH_SOURCES = new URL("../data/learning-paths/", import.meta.url);
const COLLECTION_SOURCE = new URL("../data/collections/ielts.md", import.meta.url);

async function authoredSlide(id) {
  const source = JSON.parse(await readFile(new URL("ielts.json", LEARNING_PATH_SOURCES), "utf8"));
  const slide = source.lessons.flatMap(({ exercises }) => exercises)
    .flatMap(({ config }) => config.slides ?? []).find((candidate) => candidate.id === id);
  assert.ok(slide, `Missing authored slide ${id}`);
  return slide;
}

function accepts(slide, data) {
  const exercise = {
    id: "ielts-authored-answer-check",
    type: "slides.sequence",
    schemaVersion: 1,
    completionPolicy: "slide-sequence",
    config: { slides: [slide, { id: "finish", type: "summary", terminal: true, data: {} }] },
  };
  return Boolean(verifySlideSequenceCompletion(exercise, {
    kind: "completed",
    evidence: { schemaVersion: 1, results: [{
      rootSlideId: slide.id, slideType: slide.type, eventType: "answered", data,
    }] },
  }));
}

const REUSABLE_SLIDE_TYPES = new Set([
  "adaptive-conversation",
  "choice",
  "classification",
  "cloze",
  "dictation",
  "error-correction",
  "matching",
  "pronunciation",
  "rewrite",
  "short-answer",
  "speaking-response",
  "structured-completion",
  "summary",
  "teaching-card",
  "truth",
  "writing-response",
]);

test("IELTS L0001 uses the managed JSON path and reusable slide contracts", async () => {
  const sources = await loadLearningPathSources(
    LEARNING_PATH_SOURCES,
    parseFileManagedLearningPathSource,
  );
  const definition = sources.find(({ fileName }) => fileName === "ielts.json")?.definition;

  assert.ok(definition);
  assert.deepEqual(definition.path, {
    id: "ielts-learning-path",
    collectionId: "ielts",
    title: "Vocora IELTS Academic",
    mode: "finite",
    status: "published",
  });
  assert.equal(definition.lessons.length, 1);

  const [lesson] = definition.lessons;
  assert.equal(lesson.id, "ielts-l0001");
  assert.equal(lesson.source.collectionId, "ielts");
  assert.equal(lesson.exercises.length, 15);
  assert.deepEqual(
    lesson.exercises.map(({ position }) => position),
    [10, 20, 30, 40, 50, 60, 70, 75, 80, 90, 100, 110, 120, 130, 140],
  );
  assert.equal(lesson.exercises[0].type, "vocabulary.intake");

  const sequences = lesson.exercises.slice(1);
  const slides = sequences.flatMap((exercise) => exercise.config.slides);
  assert.ok(sequences.every((exercise) => exercise.type === "slides.sequence"));
  assert.ok(sequences.every((exercise) => resolveSlideSequenceDefinition(exercise)));
  const unscored = new Set(["teaching-card", "summary", "speaking-response", "writing-response", "adaptive-conversation"]);
  assert.ok(sequences.every((exercise) =>
    !exercise.config.slides.some(({ type }) => !unscored.has(type))
      || exercise.config.retryIncorrect === true),
  "Scored practice must allow correction before server-verified completion");
  assert.ok(slides.every((slide) => REUSABLE_SLIDE_TYPES.has(slide.type)));
  assert.equal(new Set(slides.map(({ id }) => id)).size, slides.length);
  assert.ok(sequences.every((exercise) => {
    const terminalSlides = exercise.config.slides.filter(({ terminal }) => terminal === true);
    return terminalSlides.length === 1
      && exercise.config.slides.at(-1) === terminalSlides[0]
      && terminalSlides[0].type === "summary";
  }));
  assert.ok(slides
    .filter(({ type }) => type === "teaching-card")
    .every((slide) => slide.chrome?.header?.progress === null));
  assert.equal(JSON.stringify(definition).includes("AUTHORING BRIEF"), false);
  assert.equal(JSON.stringify(definition).includes("_placeholder"), false);
});

test("IELTS L0001 collection keeps the exact eight-item opening scope", async () => {
  const source = await readFile(COLLECTION_SOURCE, "utf8");
  const parsed = new VocabularyFileParser().parse(source, { requireStructured: true });

  assert.equal(parsed.title, "Vocora IELTS Academic");
  assert.deepEqual(parsed.sections.map(({ title }) => title), [
    "L0001 — Food and everyday meals: Form and meaning",
  ]);
  assert.deepEqual(parsed.entries.map(({ primaryForm }) => primaryForm), [
    "bread",
    "rice",
    "water",
    "milk",
    "eat",
    "drink",
    "have breakfast",
    "drink water",
  ]);
  assert.ok(parsed.entries.every(({ definitions, examples }) =>
    definitions.length === 1 && examples.length === 1));
});

test("IELTS word-partner practice accepts natural alternatives without accepting wrong actions", async () => {
  const slide = await authoredSlide("ielts-l0001-e06-cloze");
  assert.equal(accepts(slide, { answers: { have: "have", drink: "drink" } }), true);
  assert.equal(accepts(slide, { answers: { have: "eat", drink: "have" } }), true);
  assert.equal(accepts(slide, { answers: { have: "drink", drink: "eat" } }), false);
});

test("IELTS listening uses speaker-specific one-word keys and permits capital-letter answers", async () => {
  const slide = await authoredSlide("ielts-l0001-e07b-form");
  assert.equal(slide.data.stimulus.type, "dialogue");
  assert.equal(new Set(slide.data.stimulus.turns.map(({ speaker }) => speaker)).size, 2);
  const answers = { "jo-food": "RICE", "jo-drink": "WATER", "ari-food": "BREAD", "ari-drink": "MILK" };
  assert.equal(accepts(slide, { answers }), true);
  assert.equal(accepts(slide, { answers: { ...answers, "jo-drink": "milk" } }), false);
  assert.equal(accepts(slide, { answers: { ...answers, "jo-food": "rice grains" } }), false);
});

test("IELTS punctuation practice requires the capital and full stop it teaches", async () => {
  const slide = await authoredSlide("ielts-l0001-e13-capital-full-stop");
  assert.equal(accepts(slide, { answer: "I drink water." }), true);
  assert.equal(accepts(slide, { answer: "i drink water." }), false);
  assert.equal(accepts(slide, { answer: "I drink water" }), false);
});

test("IELTS optional conversation teaches the question focus and requires real completion evidence", async () => {
  const source = JSON.parse(await readFile(new URL("ielts.json", LEARNING_PATH_SOURCES), "utf8"));
  const exercise = source.lessons[0].exercises.find(({ id }) => id === "ielts-l0001-e09-conversation");
  assert.ok(exercise);
  assert.equal(exercise.required, false, "Disabled optional feedback must not block existing lesson progress");
  assert.equal(exercise.position, 90);
  const [food, followUp, conversation] = exercise.config.slides;
  assert.equal(food.type, "teaching-card");
  assert.equal(followUp.type, "teaching-card");
  assert.equal(conversation.type, "adaptive-conversation");
  assert.equal(conversation.data.minimumTurns, 2);
  assert.equal(conversation.data.maximumTurns, 3);
  assert.equal(conversation.data.openingPrompt, "What do you eat in the morning?");
  assert.equal(verifySlideSequenceCompletion(exercise, {
    kind: "completed", evidence: { schemaVersion: 1, results: [{
      rootSlideId: conversation.id, slideType: conversation.type, eventType: "submitted",
      data: { response: "finished", acceptedTurnCount: 3, formativeTaskScore: 2 },
    }] },
  }), false, "Client counts or model scores cannot replace an owned conversation receipt");
});
