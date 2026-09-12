const CODES = new Set(['INVALID_RESULT', 'CONFIGURATION', 'MODEL_MISMATCH', 'TOKENIZER_UNAVAILABLE',
  'TOKENIZER_MISMATCH', 'INPUT_TOO_LARGE', 'OUTPUT_LIMIT', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'BUSY']);

/** Internal failure identity only; feature adapters supply public, fixed messages. */
export class StructuredInferenceError extends Error {
  constructor(code) {
    const suffix = String(code).replace(/^STRUCTURED_INFERENCE_/, '');
    super('The private structured inference request could not be completed.');
    this.name = 'StructuredInferenceError';
    this.code = `STRUCTURED_INFERENCE_${CODES.has(suffix) ? suffix : 'PROVIDER_UNAVAILABLE'}`;
  }
}
