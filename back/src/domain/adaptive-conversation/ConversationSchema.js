export const CONVERSATION_SCHEMA_VERSION = 1;
export const CONVERSATION_NOT_ASSESSED = Object.freeze(['ielts_band', 'pronunciation', 'fluency']);
const text = maximum => ({ type: 'string', minLength: 1, maxLength: maximum });

// A formativeTaskScore is deliberately absent: only server policy derives it.
export const CONVERSATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'assessmentStatus', 'taskResponse', 'feedback', 'nextQuestion', 'endConversation', 'notAssessed'],
  properties: {
    schemaVersion: { const: CONVERSATION_SCHEMA_VERSION },
    assessmentStatus: { enum: ['feedback_available', 'insufficient_evidence'] },
    taskResponse: { enum: ['complete', 'partial', 'off_topic', 'not_assessed'] },
    feedback: text(600),
    nextQuestion: { anyOf: [text(240), { type: 'null' }] },
    endConversation: { type: 'boolean' },
    notAssessed: { type: 'array', minItems: 3, maxItems: 3, uniqueItems: true,
      items: { enum: [...CONVERSATION_NOT_ASSESSED] } },
  },
};
