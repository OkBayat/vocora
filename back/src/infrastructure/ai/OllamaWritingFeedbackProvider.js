import { createHash } from 'node:crypto';
import { WritingFeedbackError } from '../../domain/writing-feedback/WritingFeedbackError.js';
import { WRITING_FEEDBACK_SCHEMA, WRITING_FEEDBACK_SCHEMA_VERSION } from '../../domain/writing-feedback/WritingFeedbackSchema.js';
import { validateWritingFeedbackResult } from '../../domain/writing-feedback/WritingFeedbackResult.js';
import { buildWritingFeedbackMessages, WRITING_FEEDBACK_PROMPT_VERSION, WRITING_FEEDBACK_SYSTEM_PROMPT } from '../../domain/writing-feedback/WritingFeedbackPrompt.js';
import { OllamaStructuredTextClient } from './OllamaStructuredTextClient.js';
import { StructuredInferenceError } from './StructuredInferenceError.js';

function writingError(error) {
  if (error instanceof WritingFeedbackError) return error;
  if (error instanceof StructuredInferenceError) {
    return new WritingFeedbackError(error.code.replace('STRUCTURED_INFERENCE_', 'WRITING_FEEDBACK_'));
  }
  return new WritingFeedbackError('WRITING_FEEDBACK_PROVIDER_UNAVAILABLE');
}

export class OllamaWritingFeedbackProvider {
  constructor({ client, ...options } = {}) {
    try { this.client = client ?? new OllamaStructuredTextClient(options); }
    catch (error) { throw writingError(error); }
  }

  get busy() { return this.client.busy; }

  getIdentity() {
    const profile = this.client.getIdentity();
    return { schemaVersion: WRITING_FEEDBACK_SCHEMA_VERSION, promptVersion: WRITING_FEEDBACK_PROMPT_VERSION,
      schemaSha256: createHash('sha256').update(JSON.stringify(WRITING_FEEDBACK_SCHEMA)).digest('hex'),
      promptSha256: createHash('sha256').update(WRITING_FEEDBACK_SYSTEM_PROMPT).digest('hex'),
      model: profile.model, modelDigest: profile.modelDigest, locale: 'en', decodingVersion: profile.decodingVersion,
      tokenizerIdentity: profile.tokenizerIdentity, options: profile.options };
  }

  async evaluate(input) {
    const messages = buildWritingFeedbackMessages(input);
    try {
      const { decoded, provenance, metrics } = await this.client.infer({ messages,
        format: WRITING_FEEDBACK_SCHEMA, signal: input.signal });
      const result = validateWritingFeedbackResult(decoded, input.draftText);
      if (!input.taskContext.sourceText) {
        if (result.issues.some(issue => issue.category === 'source_fidelity')) {
          throw new WritingFeedbackError('WRITING_FEEDBACK_INVALID_RESULT');
        }
        if (!result.not_assessed.includes('source_fidelity')) result.not_assessed.push('source_fidelity');
      }
      return { result, identity: { ...this.getIdentity(), draftVersion: input.draftVersion,
        contentVersion: input.contentVersion, ...provenance }, metrics };
    } catch (error) { throw writingError(error); }
  }
}
