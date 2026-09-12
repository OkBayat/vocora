import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWritingFeedbackTask } from "../src/domain/writing-feedback/WritingFeedbackTask.js";
import { resolveSlideSequenceDefinition } from "../src/domain/collection-learning-path/SlideSequenceExercise.js";

function writing(overrides = {}) {
  return {
    mode: "paragraph",
    prompt: "Write about a meal you choose.",
    instruction: "Write 20–40 words. You can invent the meal.",
    wordLimit: 40,
    recommendedMinimumWords: 20,
    register: "neutral",
    targetVocabulary: ["bread", "drink water"],
    modelAnswer: "A sample narrative must not become the correct personal answer.",
    writingFeedback: {
      schemaVersion: 1,
      learnerLevel: "A1",
      targetSkill: "Describe one familiar meal.",
      languageObjectives: ["Use I or we with a present-simple verb."],
      taskExpectations: ["Say who eats, what they eat and what they drink."],
    },
    ...overrides,
  };
}

test("unconfigured writing retains its existing submission contract", () => {
  assert.equal(parseWritingFeedbackTask({ mode: "task2-essay", prompt: "A legacy task." }), null);
});

test("task context contains authoritative educational fields without treating a sample as a key", () => {
  const source = writing();
  const result = parseWritingFeedbackTask(source);
  assert.deepEqual(result, {
    schemaVersion: 1,
    learnerLevel: "A1",
    targetSkill: "Describe one familiar meal.",
    languageObjectives: ["Use I or we with a present-simple verb."],
    taskExpectations: ["Say who eats, what they eat and what they drink."],
    prompt: source.prompt,
    instruction: source.instruction,
    mode: "paragraph",
    wordLimit: 40,
    recommendedMinimumWords: 20,
    register: "neutral",
    targetVocabulary: ["bread", "drink water"],
  });
  source.writingFeedback.languageObjectives[0] = "Changed after context assembly.";
  assert.equal(result.languageObjectives[0], "Use I or we with a present-simple verb.");
  assert.equal("modelAnswer" in result, false);
});

test("optional author-provided source text is preserved as source evidence", () => {
  const source = writing();
  source.writingFeedback.sourceText = "Ari drinks water. Jo drinks milk.";
  assert.equal(parseWritingFeedbackTask(source).sourceText, source.writingFeedback.sourceText);
});

test("writing practice can explicitly declare no vocabulary targets", () => {
  assert.deepEqual(parseWritingFeedbackTask(writing({ targetVocabulary: [] })).targetVocabulary, []);
});

test("the short-text pilot rejects unmeasured modes and invalid word constraints", () => {
  for (const overrides of [
    { mode: "task1-chart" }, { mode: "task2-essay" }, { wordLimit: 81 },
    { wordLimit: "40" }, { wordLimit: 0 }, { recommendedMinimumWords: 41 },
    { recommendedMinimumWords: -1 }, { register: "academic" },
  ]) {
    assert.throws(() => parseWritingFeedbackTask(writing(overrides)),
      { code: "INVALID_WRITING_FEEDBACK_TASK" });
  }
});

test("feedback metadata rejects provider controls, unversioned rubrics and malformed context", () => {
  for (const patch of [
    { model: "untrusted-model" }, { providerUrl: "http://example.invalid" },
    { systemPrompt: "Invent a score." }, { rubric: {} }, { schemaVersion: 2 },
    { learnerLevel: "Band 9" }, { learnerLevel: "" }, { targetSkill: " " },
    { languageObjectives: [] }, { taskExpectations: ["same", "same"] },
    { sourceText: "x".repeat(4001) }, { targetSkill: "<script>bad()</script>" },
  ]) {
    const source = writing();
    Object.assign(source.writingFeedback, patch);
    assert.throws(() => parseWritingFeedbackTask(source),
      { code: "INVALID_WRITING_FEEDBACK_TASK" });
  }
  for (const writingFeedback of [null, [], true, "enabled"]) {
    assert.throws(() => parseWritingFeedbackTask(writing({ writingFeedback })),
      { code: "INVALID_WRITING_FEEDBACK_TASK" });
  }
});

test("configured tasks reject empty, oversized, and executable prompt data", () => {
  for (const overrides of [
    { prompt: "" }, { prompt: "x".repeat(2001) }, { prompt: "<img onerror=alert(1)>" },
    { targetVocabulary: ["bread", "bread"] }, { instruction: 1 },
  ]) {
    assert.throws(() => parseWritingFeedbackTask(writing(overrides)),
      { code: "INVALID_WRITING_FEEDBACK_TASK" });
  }
});

test("the managed sequence parser invokes the task contract before publishing configured feedback", () => {
  const source = writing();
  source.writingFeedback.learnerLevel = "unknown";
  const exercise = {
    type: "slides.sequence", schemaVersion: 1, completionPolicy: "slide-sequence",
    config: { slides: [
      { id: "write", type: "writing-response", data: source },
      { id: "finish", type: "summary", terminal: true, data: {} },
    ] },
  };
  assert.throws(() => resolveSlideSequenceDefinition(exercise),
    { code: "INVALID_WRITING_FEEDBACK_TASK" });
});
