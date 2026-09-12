import { matchesClosedSchema } from '../structured-output/matchesClosedSchema.js';
import { ConversationError } from './ConversationError.js';
import { parseConversationDefinition, parseConversationQuestion } from './ConversationDefinition.js';
import { CONVERSATION_SCHEMA, CONVERSATION_NOT_ASSESSED } from './ConversationSchema.js';

export const CONVERSATION_SCORE_POLICY_VERSION = 'formative-task-response-v1';
const SCORES = Object.freeze({ complete: 2, partial: 1, off_topic: 0, not_assessed: null });
const invalid = () => { throw new ConversationError('CONVERSATION_INVALID_RESULT'); };

/** Checks syntax and internal consistency, not semantic correctness or model quality. */
export function validateConversationResult(value, { config, currentQuestion, acceptedTurns }) {
  let task;
  try {
    task = parseConversationDefinition(config);
    parseConversationQuestion(currentQuestion, task.questionConstraints);
  } catch { invalid(); }
  if (!Number.isSafeInteger(acceptedTurns) || acceptedTurns < 0 || acceptedTurns >= task.maximumTurns
    || !matchesClosedSchema(CONVERSATION_SCHEMA, value)) invalid();
  if (/[\u0000-\u001f\u007f]/u.test(value.feedback) || /<\/?[a-z][^>]*>/iu.test(value.feedback)
    || /<\|[^>]*\|>/u.test(value.feedback)) invalid();
  let nextQuestion = null;
  if (value.nextQuestion !== null) {
    try { nextQuestion = parseConversationQuestion(value.nextQuestion, task.questionConstraints); }
    catch { invalid(); }
  }
  if (value.assessmentStatus === 'insufficient_evidence') {
    if (value.taskResponse !== 'not_assessed' || value.endConversation || nextQuestion !== currentQuestion) invalid();
    return { ...value, formativeTaskScore: null, nextQuestion, notAssessed: [...CONVERSATION_NOT_ASSESSED] };
  }
  if (value.taskResponse === 'not_assessed') invalid();
  const nextAcceptedCount = acceptedTurns + 1;
  const endConversation = nextAcceptedCount >= task.maximumTurns
    || (nextAcceptedCount >= task.minimumTurns && value.endConversation);
  if (!endConversation && nextQuestion === null) invalid();
  return { ...value, formativeTaskScore: SCORES[value.taskResponse],
    nextQuestion: endConversation ? null : nextQuestion, endConversation, notAssessed: [...CONVERSATION_NOT_ASSESSED] };
}
