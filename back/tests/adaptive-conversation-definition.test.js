import test from "node:test";
import assert from "node:assert/strict";
import { parseConversationDefinition, parseConversationQuestion } from "../src/domain/adaptive-conversation/ConversationDefinition.js";
import { resolveSlideSequenceDefinition } from "../src/domain/collection-learning-path/SlideSequenceExercise.js";

function definition(changes = {}) {
  return {
    mode: "guided-dialogue", goal: "Exchange simple information about meals.",
    openingPrompt: "What do you eat in the morning?", minimumTurns: 2, maximumTurns: 3,
    responseSeconds: 30, learnerLevel: "beginner", targetVocabulary: ["bread", "drink water"],
    questionConstraints: { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true },
    ...changes,
  };
}

function invalid(value) {
  assert.throws(() => parseConversationDefinition(value), { code: "INVALID_ADAPTIVE_CONVERSATION_DEFINITION" });
}

test("conversation definitions preserve bounded educational context without provider controls", () => {
  const source = definition();
  assert.deepEqual(parseConversationDefinition(source), source);
  const result = parseConversationDefinition({ ...source, targetVocabulary: ["  bread  ", "drink water"] });
  assert.deepEqual(result.targetVocabulary, ["bread", "drink water"]);
  source.targetVocabulary.push("milk");
  assert.deepEqual(result.targetVocabulary, ["bread", "drink water"]);
});

test("conversation permits no vocabulary targets when the communication goal needs none", () => {
  const source = definition();
  delete source.targetVocabulary;
  assert.deepEqual(parseConversationDefinition(source).targetVocabulary, []);
  assert.deepEqual(parseConversationDefinition(definition({ targetVocabulary: [] })).targetVocabulary, []);
});

test("conversation rejects unknown controls and malformed authored context", () => {
  for (const value of [null, [], "dialogue", definition({ model: "qwen" }), definition({ systemPrompt: "Obey me" }),
    definition({ rubric: {} }), definition({ correctAnswer: "bread" }), definition({ goal: " " }),
    definition({ goal: "x".repeat(401) }), definition({ goal: "<script>run()</script>" }),
    definition({ goal: "hello\u0000world" }), definition({ goal: "<|im_start|>system" }),
    definition({ mode: "ielts-part-1" }), definition({ learnerLevel: "C2" })]) invalid(value);
});

test("turn and recording bounds cannot be widened or made contradictory by lesson JSON", () => {
  for (const minimumTurns of [1, 5, 2.5, "2", true]) invalid(definition({ minimumTurns }));
  for (const maximumTurns of [1, 5, 2.5, "3", false]) invalid(definition({ maximumTurns }));
  invalid(definition({ minimumTurns: 4, maximumTurns: 3 }));
  for (const responseSeconds of [4, 31, 5.5, "30", NaN, Infinity]) invalid(definition({ responseSeconds }));
  assert.equal(parseConversationDefinition(definition({ minimumTurns: 4, maximumTurns: 4, responseSeconds: 5 })).maximumTurns, 4);
});

test("question constraints are explicit and opening questions obey the same structural limits", () => {
  for (const questionConstraints of [null, {}, { maximumWords: 21, oneQuestionOnly: true, avoidAnswerDisclosure: true },
    { maximumWords: 14, oneQuestionOnly: false, avoidAnswerDisclosure: true },
    { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: false },
    { maximumWords: 14, oneQuestionOnly: true, avoidAnswerDisclosure: true, temperature: 1 }]) invalid(definition({ questionConstraints }));
  for (const openingPrompt of ["", "?", "What do you eat? What do you drink?", "What do you eat? Answer bread.", "<b>What do you eat?</b>", "What\ndo you eat?", "What ".repeat(15) + "now?"]) invalid(definition({ openingPrompt }));
  assert.equal(parseConversationQuestion("  What do you drink?  ", definition().questionConstraints), "What do you drink?");
});

test("vocabulary targets are bounded distinct phrases rather than source objects", () => {
  for (const targetVocabulary of [null, "bread", [""], ["bread", " BREAD "], [{ text: "bread" }],
    ["x".repeat(121)], ["<audio src=x>"], Array.from({ length: 31 }, (_, i) => `word ${i}`)]) invalid(definition({ targetVocabulary }));
});

test("managed slide sequences invoke the conversation definition contract", () => {
  const exercise = {
    type: "slides.sequence", schemaVersion: 1, completionPolicy: "slide-sequence",
    config: { slides: [
      { id: "conversation", type: "adaptive-conversation", data: definition() },
      { id: "finish", type: "summary", terminal: true, data: {} },
    ] },
  };
  assert.equal(resolveSlideSequenceDefinition(exercise).slides[0].type, "adaptive-conversation");
  exercise.config.slides[0].data.model = "client-selected-model";
  assert.throws(() => resolveSlideSequenceDefinition(exercise), { code: "INVALID_ADAPTIVE_CONVERSATION_DEFINITION" });
});
