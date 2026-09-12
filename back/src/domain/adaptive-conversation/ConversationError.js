const FAILURES = Object.freeze({
  CONVERSATION_INVALID_RESULT: ['The conversation response could not be validated.', false],
  CONVERSATION_INVALID_REQUEST: ['The saved conversation turn cannot be evaluated.', false],
  CONVERSATION_CONFIGURATION: ['Conversation feedback is not configured for this model.', false],
  CONVERSATION_MODEL_MISMATCH: ['The configured conversation model identity could not be verified.', false],
  CONVERSATION_TOKENIZER_UNAVAILABLE: ['The matching local tokenizer is unavailable.', false],
  CONVERSATION_TOKENIZER_MISMATCH: ['The conversation token budget could not be verified.', false],
  CONVERSATION_INPUT_TOO_LARGE: ['This conversation exceeds the current feedback capacity.', false],
  CONVERSATION_OUTPUT_LIMIT: ['The conversation response was incomplete or too large.', false],
  CONVERSATION_PROVIDER_UNAVAILABLE: ['Conversation feedback is temporarily unavailable.', true],
  CONVERSATION_TIMEOUT: ['Conversation feedback took too long.', true],
  CONVERSATION_CANCELLED: ['Conversation feedback was cancelled.', false],
  CONVERSATION_BUSY: ['Conversation feedback is already processing another request.', true],
});

export class ConversationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(FAILURES, code) ? code : 'CONVERSATION_PROVIDER_UNAVAILABLE';
    super(FAILURES[safeCode][0]);
    this.name = 'ConversationError'; this.code = safeCode; this.retryable = FAILURES[safeCode][1];
  }
}
