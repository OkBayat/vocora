const FAILURES = Object.freeze({
  WRITING_FEEDBACK_INVALID_RESULT: ['The feedback could not be validated.', false],
  WRITING_FEEDBACK_INVALID_REQUEST: ['The saved writing task cannot be evaluated.', false],
  WRITING_FEEDBACK_CONFIGURATION: ['Writing feedback is not configured for this model.', false],
  WRITING_FEEDBACK_MODEL_MISMATCH: ['The configured feedback model identity could not be verified.', false],
  WRITING_FEEDBACK_TOKENIZER_UNAVAILABLE: ['The matching local tokenizer is unavailable.', false],
  WRITING_FEEDBACK_TOKENIZER_MISMATCH: ['The feedback token budget could not be verified.', false],
  WRITING_FEEDBACK_INPUT_TOO_LARGE: ['This writing task exceeds the current feedback capacity.', false],
  WRITING_FEEDBACK_OUTPUT_LIMIT: ['The feedback response was incomplete or too large.', false],
  WRITING_FEEDBACK_PROVIDER_UNAVAILABLE: ['Writing feedback is temporarily unavailable.', true],
  WRITING_FEEDBACK_TIMEOUT: ['Writing feedback took too long.', true],
  WRITING_FEEDBACK_CANCELLED: ['Writing feedback was cancelled.', false],
  WRITING_FEEDBACK_BUSY: ['Writing feedback is already processing another request.', true],
});

export class WritingFeedbackError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(FAILURES, code) ? code : 'WRITING_FEEDBACK_PROVIDER_UNAVAILABLE';
    super(FAILURES[safeCode][0]);
    this.name = 'WritingFeedbackError';
    this.code = safeCode;
    this.retryable = FAILURES[safeCode][1];
  }
}
