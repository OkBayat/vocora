export const WRITING_FEEDBACK_SCHEMA_VERSION = 1;
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const nullableText = maxLength => ({ anyOf: [text(maxLength, 0), { type: 'null' }] });
const object = properties => ({
  type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
});

export const WRITING_FEEDBACK_SCHEMA = object({
  schema_version: { const: WRITING_FEEDBACK_SCHEMA_VERSION },
  assessment_status: { enum: ['feedback_available', 'insufficient_evidence'] },
  abstention_reason: nullableText(600),
  task_relevance: { enum: ['on_topic', 'partly_on_topic', 'off_topic', 'not_assessed'] },
  task_comment: text(600),
  issues: { type: 'array', maxItems: 3, items: object({
    category: { enum: ['grammar', 'spelling', 'punctuation', 'word_choice', 'coherence', 'task_coverage', 'source_fidelity'] },
    kind: { enum: ['error', 'suggestion'] },
    quoted_text: nullableText(1000),
    occurrence: { anyOf: [{ type: 'integer', minimum: 1, maximum: 4000 }, { type: 'null' }] },
    replacement: nullableText(1000),
    explanation: text(600),
  }) },
  revision_actions: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: text(600) },
  not_assessed: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
    items: { enum: ['ielts_band', 'task_coverage', 'source_fidelity'] } },
  ielts_band: { type: 'null' },
});
