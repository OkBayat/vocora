import { ValidationError } from "../errors.js";

const TASK_ERROR = "INVALID_WRITING_FEEDBACK_TASK";
const TASK_SCHEMA_VERSION = 1;
export const MAXIMUM_PILOT_WORDS = 80;
const PILOT_MODES = new Set(["sentence", "paragraph"]);
const LEARNER_LEVELS = new Set(["A1", "A2", "B1", "B2", "C1", "C2"]);
const REGISTERS = new Set(["formal", "informal", "neutral"]);
const METADATA_FIELDS = new Set([
  "schemaVersion", "learnerLevel", "targetSkill", "languageObjectives",
  "taskExpectations", "sourceText",
]);

function invalid(message) {
  throw new ValidationError(TASK_ERROR, message);
}

function plainText(value, label, maximum, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    invalid(`${label} must be nonempty text of at most ${maximum} characters.`);
  }
  if (/<\/?[a-z][^>]*>/iu.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    invalid(`${label} must contain plain educational text.`);
  }
  return value;
}

function textList(value, label, { maximumItems = 8, maximumLength = 300, optional = false } = {}) {
  if (value === undefined && optional) return [];
  if (optional && Array.isArray(value) && value.length === 0) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) {
    invalid(`${label} must contain one to ${maximumItems} text items.`);
  }
  const entries = value.map((item) => plainText(item, label, maximumLength));
  if (new Set(entries.map((item) => item.trim().toLowerCase())).size !== entries.length) {
    invalid(`${label} must contain distinct items.`);
  }
  return entries;
}

function wordLimit(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PILOT_WORDS) {
    invalid(`${label} must be an integer from 1 to ${MAXIMUM_PILOT_WORDS} for the short-text pilot.`);
  }
  return value;
}

/** Resolve authored context without accepting client rubrics or personal model answers. */
export function parseWritingFeedbackTask(slideData) {
  if (slideData?.writingFeedback === undefined) return null;
  const metadata = slideData.writingFeedback;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    invalid("Writing feedback metadata must be an object.");
  }
  if (Object.keys(metadata).some((key) => !METADATA_FIELDS.has(key))) {
    invalid("Writing feedback metadata contains an unsupported field.");
  }
  if (metadata.schemaVersion !== TASK_SCHEMA_VERSION) invalid("Writing feedback schemaVersion must be 1.");
  if (!LEARNER_LEVELS.has(metadata.learnerLevel)) invalid("Writing feedback learnerLevel must be a CEFR level.");
  if (!PILOT_MODES.has(slideData.mode)) invalid("Writing feedback currently supports short sentences and paragraphs.");
  const register = slideData.register ?? "neutral";
  if (!REGISTERS.has(register)) invalid("Writing feedback register is unsupported.");
  const maximumWords = wordLimit(slideData.wordLimit, "Writing wordLimit", MAXIMUM_PILOT_WORDS);
  const recommendedMinimumWords = wordLimit(slideData.recommendedMinimumWords, "Writing recommendedMinimumWords");
  if (recommendedMinimumWords !== undefined && recommendedMinimumWords > maximumWords) {
    invalid("Writing recommendedMinimumWords must not exceed wordLimit.");
  }
  const sourceText = plainText(metadata.sourceText, "Writing sourceText", 4000, true);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    learnerLevel: metadata.learnerLevel,
    targetSkill: plainText(metadata.targetSkill, "Writing targetSkill", 400),
    languageObjectives: textList(metadata.languageObjectives, "Writing languageObjectives"),
    taskExpectations: textList(metadata.taskExpectations, "Writing taskExpectations"),
    prompt: plainText(slideData.prompt, "Writing prompt", 2000),
    ...(slideData.instruction === undefined ? {} : {
      instruction: plainText(slideData.instruction, "Writing instruction", 2000),
    }),
    mode: slideData.mode,
    wordLimit: maximumWords,
    ...(recommendedMinimumWords === undefined ? {} : { recommendedMinimumWords }),
    register,
    targetVocabulary: textList(slideData.targetVocabulary, "Writing targetVocabulary", {
      maximumItems: 30, maximumLength: 120, optional: true,
    }),
    ...(sourceText === undefined ? {} : { sourceText }),
  };
}
