import { ValidationError } from "../errors.js";
import { parseVocabularyExerciseScope } from "./VocabularyExerciseScope.js";
import { parseWritingFeedbackTask } from "../writing-feedback/WritingFeedbackTask.js";
import { parseConversationDefinition } from "../adaptive-conversation/ConversationDefinition.js";

export const SLIDE_SEQUENCE_TYPE = "slides.sequence";
export const SLIDE_SEQUENCE_SCHEMA_VERSION = 1;
export const SLIDE_SEQUENCE_COMPLETION_POLICY = "slide-sequence";
export const LESSON_VOCABULARY_SCOPE_SLIDE_TYPE = "lesson-vocabulary-scope";

const GENERATED_TYPES = new Map([
  ["dictation", "dictation"],
  ["meaning-choice", "choice"],
]);
const UNSCORED_TYPES = new Set(["message", "teaching-card", "summary", LESSON_VOCABULARY_SCOPE_SLIDE_TYPE]);
const SUBMITTED_TYPES = new Set(["selection", "number-input", "speaking-response", "writing-response", "adaptive-conversation"]);
const ANSWER_FIELD_TYPES = new Set(["cloze", "structured-completion", "word-formation", "labeling"]);
const MAX_EVIDENCE_BYTES = 256_000;

function invalid(message) {
  throw new ValidationError("INVALID_SLIDE_SEQUENCE_DEFINITION", message);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function identifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 160) invalid(`${label} must be a valid public id.`);
  return normalized;
}

function requiredString(source, key, label) {
  const value = String(source?.[key] ?? "").trim();
  if (!value) invalid(`${label} is required.`);
  return value;
}

function requiredBoolean(source, key, label) {
  if (typeof source?.[key] !== "boolean") invalid(`${label} must be a boolean.`);
  return source[key];
}

function generatedVocabularyConfig(scopeSlide) {
  const intro = record(scopeSlide.data.intro);
  requiredString(intro, "eyebrow", "Lesson vocabulary intro eyebrow");
  requiredString(intro, "title", "Lesson vocabulary intro title");
  requiredString(intro, "description", "Lesson vocabulary intro description");

  const primary = record(record(record(scopeSlide.chrome)?.footer)?.primary);
  if (requiredString(primary, "id", "Lesson vocabulary primary action id") !== "start-vocabulary-scope"
    || requiredString(primary, "behavior", "Lesson vocabulary primary action behavior") !== "content") {
    invalid("Lesson vocabulary primary action must start the generated scope.");
  }
  requiredString(primary, "label", "Lesson vocabulary primary action label");

  const generated = record(scopeSlide.data.generatedSlide);
  const type = requiredString(generated, "type", "Lesson vocabulary generated slide type");
  requiredString(generated, "instruction", "Lesson vocabulary generated slide instruction");
  if (type === "dictation") {
    if (!new Set(["word", "phrase", "sentence"]).has(requiredString(generated, "mode", "Generated dictation mode"))) {
      invalid("Generated dictation mode is unsupported.");
    }
    const speech = record(generated.speech);
    requiredBoolean(speech, "autoplay", "Generated dictation speech autoplay");
    requiredBoolean(speech, "replay", "Generated dictation speech replay");
    requiredBoolean(generated, "caseSensitive", "Generated dictation caseSensitive");
    requiredBoolean(generated, "punctuationSensitive", "Generated dictation punctuationSensitive");
  } else if (type === "meaning-choice") {
    if (requiredString(generated, "mode", "Generated meaning choice mode") !== "meaning") {
      invalid("Generated meaning choice mode is unsupported.");
    }
    if (!Number.isSafeInteger(generated.optionCount) || generated.optionCount < 2) {
      invalid("Generated meaning choice optionCount must be an integer of at least two.");
    }
    requiredString(generated, "explanationTemplate", "Generated meaning choice explanationTemplate");
  }
  return { type, generated };
}

function strings(value) {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function selectionConfig(data) {
  const mode = requiredString(data, "mode", "Selection mode");
  if (mode !== "single" && mode !== "multiple") invalid("Selection mode is unsupported.");
  requiredString(data, "question", "Selection question");
  if ("expansionId" in data) requiredString(data, "expansionId", "Selection expansionId");
  if (["correctOptionId", "correctOptionIds", "answers"].some((key) => key in data)) {
    invalid("Selection must not define correctness fields.");
  }
  if (!Array.isArray(data.options) || data.options.length < 2) {
    invalid("Selection requires at least two options.");
  }
  const optionIds = data.options.map((candidate) => {
    const option = record(candidate);
    const id = requiredString(option, "id", "Selection option id");
    requiredString(option, "label", "Selection option label");
    return id;
  });
  if (new Set(optionIds).size !== optionIds.length) invalid("Selection option ids must be unique.");
  return { mode, optionIds };
}

function numberInputConfig(data) {
  requiredString(data, "question", "Number input question");
  const values = Object.fromEntries(["min", "max", "step", "initialValue"].map((key) => {
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(`Number input ${key} must be a finite number.`);
    return [key, value];
  }));
  if (values.max < values.min) invalid("Number input max must be greater than or equal to min.");
  if (values.step <= 0) invalid("Number input step must be greater than zero.");
  if (values.initialValue < values.min || values.initialValue > values.max) {
    invalid("Number input initialValue must be within min and max.");
  }
  if ("expansionId" in data) requiredString(data, "expansionId", "Number input expansionId");
  return values;
}

function completeOrder(value, expectedIds, label) {
  const ids = strings(value);
  if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length
    || !ids.every((id) => expectedIds.includes(id))) {
    invalid(`${label} must contain every ordering item exactly once.`);
  }
  return ids;
}

function orderingConfig(data) {
  const configuredItems = Array.isArray(data.items) ? data.items : [];
  const primaryIds = strings(data.correctOrderIds);
  if (primaryIds.length < 2) invalid("Ordering correctOrderIds must contain at least two items.");
  const itemIds = configuredItems.length
    ? configuredItems.map((candidate) => {
        const item = record(candidate);
        const id = requiredString(item, "id", "Ordering item id");
        requiredString(item, "label", "Ordering item label");
        return id;
      })
    : primaryIds;
  if (new Set(itemIds).size !== itemIds.length) invalid("Ordering item ids must be unique.");
  const primary = completeOrder(data.correctOrderIds, itemIds, "Ordering correctOrderIds");
  if (data.acceptedOrders !== undefined && !Array.isArray(data.acceptedOrders)) {
    invalid("Ordering acceptedOrders must be an array.");
  }
  const accepted = data.acceptedOrders === undefined
    ? [primary]
    : data.acceptedOrders.map((order, index) => completeOrder(order, itemIds, `Ordering acceptedOrders[${index}]`));
  if (!accepted.length) invalid("Ordering acceptedOrders must contain at least one order.");
  if (new Set(accepted.map((order) => order.join("\u0000"))).size !== accepted.length) {
    invalid("Ordering acceptedOrders must be unique.");
  }
  if (!accepted.some((order) => order.every((id, index) => primary[index] === id))) {
    invalid("Ordering acceptedOrders must include correctOrderIds.");
  }
  return accepted;
}

function answerFieldConfig(candidate, label) {
  const field = record(candidate);
  const id = requiredString(field, "id", `${label} id`);
  if (!strings(field.answers).length) invalid(`${label} answers are required.`);
  return { field, id };
}

function labelingConfig(data) {
  const mode = requiredString(data, "mode", "Labeling mode");
  if (!new Set(["map", "plan", "diagram"]).has(mode)) invalid("Labeling mode is unsupported.");
  requiredString(data, "question", "Labeling question");
  const stimulus = record(data.stimulus);
  const stimulusType = requiredString(stimulus, "type", "Labeling stimulus type");
  if (stimulusType === "diagram") requiredString(stimulus, "imageSrc", "Labeling diagram source");
  else if (stimulusType === "image") requiredString(stimulus, "src", "Labeling image source");
  else invalid("Labeling requires an image or diagram stimulus.");
  requiredString(stimulus, "alt", "Labeling stimulus alternative text");
  if (!Array.isArray(data.targets) || !data.targets.length) invalid("Labeling targets are required.");
  const targetIds = data.targets.map((candidate) => {
    const { field, id } = answerFieldConfig(candidate, "Labeling target");
    requiredString(field, "label", "Labeling target label");
    requiredString(field, "markerLabel", "Labeling target marker label");
    for (const key of ["xPercent", "yPercent"]) {
      const value = field[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        invalid("Labeling target coordinates must be between 0 and 100.");
      }
    }
    return id;
  });
  if (new Set(targetIds).size !== targetIds.length) invalid("Labeling target ids must be unique.");
  const inputMode = String(data.inputMode ?? "text").trim();
  if (!new Set(["text", "word-bank"]).has(inputMode)) invalid("Labeling inputMode is unsupported.");
  if (inputMode === "word-bank") {
    const wordBank = strings(data.wordBank);
    if (wordBank.length < 2 || new Set(wordBank).size !== wordBank.length) {
      invalid("Labeling wordBank must contain at least two unique options.");
    }
    if (data.targets.some((target) => wordBank.every((option) => !answerMatches(option, target)))) {
      invalid("Every labeling target needs an accepted answer in the word bank.");
    }
  }
}

function shortAnswerConfig(data) {
  if ("evidenceRequired" in data && typeof data.evidenceRequired !== "boolean") {
    invalid("Short-answer evidenceRequired must be a boolean.");
  }
  if (data.evidenceRequired === true) requiredString(data, "evidencePrompt", "Short-answer evidencePrompt");
}

function wordCount(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function normalizeAnswer(value, field = {}) {
  let normalized = String(value ?? "").trim().replace(/\s+/gu, " ");
  if (field.punctuationSensitive !== true) normalized = normalized.replace(/[.,!?;:]+$/gu, "").trim();
  if (field.caseSensitive !== true) normalized = normalized.toLocaleLowerCase("en");
  return normalized;
}

function answerMatches(value, field) {
  if (!String(value ?? "").trim() || (field.wordLimit && wordCount(value) > field.wordLimit)) return false;
  const normalization = field.exactSpelling === true
    ? { caseSensitive: true, punctuationSensitive: true }
    : field;
  const actual = normalizeAnswer(value, normalization);
  return strings(field.answers).some((answer) => normalizeAnswer(answer, normalization) === actual);
}

function equalIds(actual, expected) {
  const normalizedActual = strings(actual);
  const normalizedExpected = strings(expected);
  return normalizedActual.length === normalizedExpected.length
    && new Set(normalizedActual).size === normalizedActual.length
    && normalizedActual.every((id) => normalizedExpected.includes(id));
}

function isSubmittedSlide(slide) {
  if (SUBMITTED_TYPES.has(slide.type)) return true;
  return slide.type === "rewrite"
    && strings(slide.data.acceptedAnswers).length === 0
    && strings(slide.data.requiredFragments).length === 0;
}

function gradeAnswerFields(data, fieldKey, resultData) {
  const answers = record(resultData.answers);
  const fields = Array.isArray(data[fieldKey]) ? data[fieldKey] : [];
  return Boolean(answers) && fields.length > 0 && fields.every((candidate) => {
    const field = record(candidate);
    const id = String(field?.id ?? "").trim();
    return Boolean(id) && answerMatches(answers[id], field);
  });
}

function gradeConfiguredResult(slide, resultData) {
  const data = slide.data;
  if (slide.type === "choice") return equalIds(resultData.selectedOptionIds, data.correctOptionIds);
  if (slide.type === "truth" || slide.type === "pronunciation") {
    return equalIds(resultData.selectedOptionIds, [data.correctOptionId]);
  }
  if (slide.type === "matching") {
    const assignments = record(resultData.assignments);
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    return Boolean(assignments) && pairs.length > 0 && pairs.every((candidate) => {
      const pair = record(candidate);
      const id = String(pair?.id ?? "").trim();
      const rightId = String(pair?.rightId ?? id).trim();
      return Boolean(id && rightId) && assignments[id] === rightId;
    });
  }
  if (slide.type === "classification") {
    const assignments = record(resultData.assignments);
    const items = Array.isArray(data.items) ? data.items : [];
    return Boolean(assignments) && items.length > 0 && items.every((candidate) => {
      const item = record(candidate);
      const id = String(item?.id ?? "").trim();
      const expected = String(item?.correctCategoryId ?? "").trim();
      return Boolean(id && expected) && assignments[id] === expected;
    });
  }
  if (slide.type === "cloze") return gradeAnswerFields(data, "blanks", resultData);
  if (ANSWER_FIELD_TYPES.has(slide.type)) {
    return gradeAnswerFields(data, slide.type === "labeling" ? "targets" : "fields", resultData);
  }
  if (slide.type === "short-answer") {
    return (!data.evidenceRequired || Boolean(String(resultData.supportingEvidence ?? "").trim()))
      && answerMatches(resultData.answer, {
      answers: data.answers,
      caseSensitive: data.exactSpelling === true,
      punctuationSensitive: data.exactSpelling === true,
    });
  }
  if (slide.type === "dictation") {
    return answerMatches(resultData.answer, {
      answers: [data.answer, ...strings(data.acceptedAnswers)],
      caseSensitive: data.caseSensitive !== false,
      punctuationSensitive: data.punctuationSensitive === true,
    });
  }
  if (slide.type === "error-correction") {
    return answerMatches(resultData.correction, { answers: data.answers });
  }
  if (slide.type === "rewrite") {
    const response = normalizeAnswer(resultData.response);
    return Boolean(response) && (
      strings(data.acceptedAnswers).some((answer) => normalizeAnswer(answer) === response)
      || (strings(data.requiredFragments).length > 0
        && strings(data.requiredFragments).every((fragment) => response.includes(normalizeAnswer(fragment))))
    );
  }
  if (slide.type === "ordering") {
    const actual = strings(resultData.orderedItemIds);
    return orderingConfig(data).some((order) => equalIds(actual, order)
      && actual.every((id, index) => id === order[index]));
  }
  return false;
}

function verifySubmission(slide, resultData, context) {
  if (slide.type === "selection") {
    const { mode, optionIds } = selectionConfig(slide.data);
    const selectedOptionIds = strings(resultData.selectedOptionIds);
    return selectedOptionIds.length > 0
      && new Set(selectedOptionIds).size === selectedOptionIds.length
      && (mode === "multiple" || selectedOptionIds.length === 1)
      && selectedOptionIds.every((id) => optionIds.includes(id));
  }
  if (slide.type === "number-input") {
    const config = numberInputConfig(slide.data);
    const value = resultData.value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < config.min || value > config.max) return false;
    const steps = (value - config.min) / config.step;
    return Math.abs(steps - Math.round(steps)) < Number.EPSILON * 10;
  }
  if (slide.type === "adaptive-conversation") {
    const id = typeof resultData.conversationEvidenceId === "string" ? resultData.conversationEvidenceId : "";
    const receipt = context.conversationEvidence?.get(id);
    const config = parseConversationDefinition(slide.data);
    return Boolean(id && receipt) && receipt.status === "completed"
      && ["userId", "pathId", "lessonId", "exerciseId"].every((key) => String(receipt[key]) === String(context[key]))
      && receipt.slideId === slide.id
      && new Date(receipt.exerciseStartedAt).getTime() === new Date(context.exerciseStartedAt).getTime()
      && receipt.minimumTurns === config.minimumTurns
      && Number.isSafeInteger(receipt.acceptedTurnCount)
      && receipt.acceptedTurnCount >= config.minimumTurns && receipt.acceptedTurnCount <= config.maximumTurns;
  }
  if (slide.type === "speaking-response") {
    const artifactId = String(resultData.recordingArtifactId ?? "").trim();
    const artifact = context.recordingArtifacts?.get(artifactId);
    return Boolean(artifactId && artifact)
      && String(artifact.userId) === String(context.userId)
      && String(artifact.exerciseId) === String(context.exerciseId)
      && new Date(artifact.exerciseStartedAt).getTime() === new Date(context.exerciseStartedAt).getTime()
      && artifact.slideId === slide.id
      && Number(artifact.byteSize) >= 256;
  }
  const response = String(resultData.response ?? "").trim();
  return response.length > 0 && response.length <= 20_000;
}

export function resolveSlideSequenceDefinition(exercise) {
  if (exercise?.type !== SLIDE_SEQUENCE_TYPE) invalid(`Exercise type must be ${SLIDE_SEQUENCE_TYPE}.`);
  if (Number(exercise.schemaVersion) !== SLIDE_SEQUENCE_SCHEMA_VERSION) {
    invalid(`slides.sequence schemaVersion must be ${SLIDE_SEQUENCE_SCHEMA_VERSION}.`);
  }
  if (exercise.completionPolicy !== SLIDE_SEQUENCE_COMPLETION_POLICY) {
    invalid(`slides.sequence completionPolicy must be ${SLIDE_SEQUENCE_COMPLETION_POLICY}.`);
  }
  const config = record(exercise.config);
  if (!config || !Array.isArray(config.slides) || config.slides.length < 2) {
    invalid("slides.sequence requires at least two configured slides.");
  }
  const slides = config.slides.map((candidate) => {
    const slide = record(candidate);
    if (!slide) invalid("slides.sequence slides must be objects.");
    return {
      id: identifier(slide.id, "slide id"),
      type: identifier(slide.type, "slide type"),
      terminal: slide.terminal === true,
      data: record(slide.data) ?? {},
      chrome: record(slide.chrome),
    };
  });
  if (new Set(slides.map((slide) => slide.id)).size !== slides.length) invalid("slides.sequence slide ids must be unique.");
  slides.filter((slide) => slide.type === "selection").forEach((slide) => selectionConfig(slide.data));
  slides.filter((slide) => slide.type === "number-input").forEach((slide) => numberInputConfig(slide.data));
  slides.filter((slide) => slide.type === "ordering").forEach((slide) => orderingConfig(slide.data));
  slides.filter((slide) => slide.type === "labeling").forEach((slide) => labelingConfig(slide.data));
  slides.filter((slide) => slide.type === "short-answer").forEach((slide) => shortAnswerConfig(slide.data));
  slides.filter((slide) => slide.type === "writing-response").forEach((slide) => parseWritingFeedbackTask(slide.data));
  slides.filter((slide) => slide.type === "adaptive-conversation").forEach((slide) => parseConversationDefinition(slide.data));
  if (slides.filter((slide) => slide.terminal).length !== 1 || !slides.at(-1).terminal) {
    invalid("slides.sequence requires exactly one terminal final slide.");
  }
  const scopeSlides = slides.filter((slide) => slide.type === LESSON_VOCABULARY_SCOPE_SLIDE_TYPE);
  const scope = config.scope === undefined
    ? null
    : parseVocabularyExerciseScope(config.scope, {
        code: "INVALID_SLIDE_SEQUENCE_DEFINITION",
        label: "slides.sequence scope",
      });
  if (scopeSlides.length > 1 || (scopeSlides.length === 1) !== Boolean(scope)) {
    invalid("A slides.sequence vocabulary scope and its generator slide must be configured together exactly once.");
  }
  let generated = null;
  if (scopeSlides[0]) {
    const generatedConfig = generatedVocabularyConfig(scopeSlides[0]);
    const generatedType = generatedConfig.type;
    const slideType = GENERATED_TYPES.get(generatedType);
    if (!slideType) invalid("Unsupported lesson vocabulary generated slide type.");
    generated = { scopeSlideId: scopeSlides[0].id, generatedType, slideType, config: generatedConfig.generated };
  }
  return { slides, scope, generated };
}

export function createSlideSequenceVocabularyPayload(scope, scopedVocabulary = []) {
  const seen = new Set();
  const items = [];
  for (const source of scopedVocabulary) {
    const id = String(source?.vocabularyId ?? "").trim();
    const term = String(source?.term ?? "").trim();
    if (!id || !term || seen.has(id)) continue;
    seen.add(id);
    const definitions = Array.isArray(source?.definitions)
      ? source.definitions.map((value) => String(value ?? "").trim()).filter(Boolean)
      : [];
    items.push({ id, term, definitions });
  }
  return {
    scope: scope ? { kind: scope.kind, ref: scope.ref } : null,
    items,
    summary: { total: items.length },
  };
}

function completionResults(outcome) {
  const evidence = record(outcome?.evidence);
  if (!evidence || Number(evidence.schemaVersion) !== 1 || !Array.isArray(evidence.results)) return null;
  if (evidence.results.length > 1000) return null;
  try {
    if (JSON.stringify(evidence.results).length > MAX_EVIDENCE_BYTES) return null;
  } catch {
    return null;
  }
  const results = [];
  for (const candidate of evidence.results) {
    const result = record(candidate);
    const rootSlideId = String(result?.rootSlideId ?? "").trim();
    const slideType = String(result?.slideType ?? "").trim();
    const itemId = String(result?.itemId ?? "").trim() || null;
    const eventType = String(result?.eventType ?? "").trim();
    const data = record(result?.data);
    if (!rootSlideId || rootSlideId.length > 160 || !slideType || slideType.length > 96
      || !new Set(["answered", "submitted"]).has(eventType) || !data) return null;
    results.push({ rootSlideId, slideType, itemId, eventType, data });
  }
  return results;
}

export function verifySlideSequenceCompletion(exercise, outcome, scopedVocabulary = [], context = {}) {
  const definition = resolveSlideSequenceDefinition(exercise);
  const results = completionResults(outcome);
  if (!results) return false;
  const expectedStatic = new Map();
  for (const slide of definition.slides) {
    if (UNSCORED_TYPES.has(slide.type)) continue;
    expectedStatic.set(slide.id, slide);
  }
  const payload = createSlideSequenceVocabularyPayload(definition.scope, scopedVocabulary);
  const expectedItems = new Map(payload.items.map((item) => [item.id, item]));
  const satisfiedStatic = new Set();
  const satisfiedItems = new Set();
  for (const result of results) {
    const expected = expectedStatic.get(result.rootSlideId);
    if (expected) {
      if (result.itemId || result.slideType !== expected.type) return false;
      const submitted = isSubmittedSlide(expected);
      if (result.eventType !== (submitted ? "submitted" : "answered")) return false;
      if (submitted ? verifySubmission(expected, result.data, context) : gradeConfiguredResult(expected, result.data)) {
        satisfiedStatic.add(result.rootSlideId);
      }
      continue;
    }
    if (!definition.generated || !result.itemId || !expectedItems.has(result.itemId)) return false;
    if (result.slideType !== definition.generated.slideType
      || result.rootSlideId !== `${definition.generated.scopeSlideId}-${result.itemId}`) return false;
    if (result.eventType !== "answered") return false;
    const item = expectedItems.get(result.itemId);
    const correct = definition.generated.generatedType === "dictation"
      ? answerMatches(result.data.answer, {
          answers: [item.term],
          caseSensitive: definition.generated.config.caseSensitive,
          punctuationSensitive: definition.generated.config.punctuationSensitive,
        })
      : equalIds(result.data.selectedOptionIds, [item.id]);
    if (correct) satisfiedItems.add(result.itemId);
  }
  if (satisfiedStatic.size !== expectedStatic.size || satisfiedItems.size !== expectedItems.size) return false;
  if (definition.scope && expectedItems.size === 0) return false;
  return {
    evidenceType: SLIDE_SEQUENCE_COMPLETION_POLICY,
    evidenceRef: `exercise:${identifier(exercise.id, "exercise id")}:slides:${expectedStatic.size + expectedItems.size}`,
  };
}
