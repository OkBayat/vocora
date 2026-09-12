import { ValidationError } from "../errors.js";

const DEFINITION_FIELDS = new Set([
  "mode", "goal", "openingPrompt", "minimumTurns", "maximumTurns", "responseSeconds",
  "learnerLevel", "targetVocabulary", "questionConstraints",
]);
const CONSTRAINT_FIELDS = new Set(["maximumWords", "oneQuestionOnly", "avoidAnswerDisclosure"]);
const LEVELS = new Set(["beginner", "elementary", "intermediate", "advanced"]);

function invalid(message) {
  throw new ValidationError("INVALID_ADAPTIVE_CONVERSATION_DEFINITION", message);
}

function object(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.has(key))) invalid(`${label} contains unsupported fields.`);
  return value;
}

function text(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value) || /<\/?[a-z][^>]*>/iu.test(value)
    || /<\|[^>]*\|>/u.test(value)) invalid(`${label} must be bounded plain text.`);
  return value.trim();
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function questionConstraints(value) {
  const source = object(value, CONSTRAINT_FIELDS, "Question constraints");
  if (source.oneQuestionOnly !== true || source.avoidAnswerDisclosure !== true) {
    invalid("Conversation questions must request one question without disclosing an answer.");
  }
  return {
    maximumWords: integer(source.maximumWords, 1, 20, "Question maximumWords"),
    oneQuestionOnly: true,
    avoidAnswerDisclosure: true,
  };
}

/** Validate structure; topic relevance and answer disclosure still need model-quality evaluation. */
export function parseConversationQuestion(value, constraints) {
  const limits = questionConstraints(constraints);
  const question = text(value, 240, "Conversation question");
  if (!/\p{L}/u.test(question) || !question.endsWith("?") || question.split("?").length !== 2
    || question.split(/\s+/u).length > limits.maximumWords) {
    invalid("Conversation questions must end with one question mark and fit the authored word bound.");
  }
  return question;
}

export function parseConversationDefinition(value) {
  const source = object(value, DEFINITION_FIELDS, "Conversation definition");
  if (source.mode !== "guided-dialogue") invalid("Conversation mode is unsupported.");
  if (!LEVELS.has(source.learnerLevel)) invalid("Conversation learnerLevel is unsupported.");
  const minimumTurns = integer(source.minimumTurns, 2, 4, "Conversation minimumTurns");
  const maximumTurns = integer(source.maximumTurns, 2, 4, "Conversation maximumTurns");
  if (minimumTurns > maximumTurns) invalid("Conversation minimumTurns must not exceed maximumTurns.");
  const constraints = questionConstraints(source.questionConstraints);
  const targets = source.targetVocabulary === undefined ? [] : source.targetVocabulary;
  if (!Array.isArray(targets) || targets.length > 30) invalid("Conversation vocabulary must contain at most 30 targets.");
  const targetVocabulary = targets.map((item) => text(item, 120, "Conversation vocabulary target"));
  if (new Set(targetVocabulary.map((item) => item.toLowerCase())).size !== targetVocabulary.length) {
    invalid("Conversation vocabulary targets must be distinct.");
  }
  return {
    mode: source.mode,
    goal: text(source.goal, 400, "Conversation goal"),
    openingPrompt: parseConversationQuestion(source.openingPrompt, constraints),
    minimumTurns,
    maximumTurns,
    responseSeconds: integer(source.responseSeconds, 5, 30, "Conversation responseSeconds"),
    learnerLevel: source.learnerLevel,
    targetVocabulary,
    questionConstraints: constraints,
  };
}
