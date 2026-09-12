import { createHash } from 'node:crypto';
import { ConversationError } from '../../domain/adaptive-conversation/ConversationError.js';
import { CONVERSATION_SCHEMA, CONVERSATION_SCHEMA_VERSION, CONVERSATION_NOT_ASSESSED } from '../../domain/adaptive-conversation/ConversationSchema.js';
import { validateConversationResult, CONVERSATION_SCORE_POLICY_VERSION } from '../../domain/adaptive-conversation/ConversationResult.js';
import { parseConversationEvaluation, buildConversationMessages, CONVERSATION_PROMPT_VERSION, CONVERSATION_SYSTEM_PROMPT } from '../../domain/adaptive-conversation/ConversationPrompt.js';
import { OllamaStructuredTextClient } from './OllamaStructuredTextClient.js';
import { StructuredInferenceError } from './StructuredInferenceError.js';

function conversationError(error) {
  if (error instanceof ConversationError) return error;
  if (error instanceof StructuredInferenceError) {
    return new ConversationError(error.code.replace('STRUCTURED_INFERENCE_', 'CONVERSATION_'));
  }
  return new ConversationError('CONVERSATION_PROVIDER_UNAVAILABLE');
}

export class OllamaConversationProvider {
  constructor({ client, ...options } = {}) {
    try { this.client = client ?? new OllamaStructuredTextClient(options); }
    catch (error) { throw conversationError(error); }
  }

  getIdentity() {
    return { schemaVersion: CONVERSATION_SCHEMA_VERSION, promptVersion: CONVERSATION_PROMPT_VERSION,
      schemaSha256: createHash('sha256').update(JSON.stringify(CONVERSATION_SCHEMA)).digest('hex'),
      promptSha256: createHash('sha256').update(CONVERSATION_SYSTEM_PROMPT).digest('hex'),
      scorePolicyVersion: CONVERSATION_SCORE_POLICY_VERSION, ...this.client.getIdentity(), locale: 'en' };
  }

  async evaluate(input) {
    const context = parseConversationEvaluation(input);
    if (input.signal?.aborted) throw new ConversationError('CONVERSATION_CANCELLED');
    const identity = { ...this.getIdentity(), sessionVersion: context.sessionVersion, turnVersion: context.turnVersion,
      contentVersion: context.contentVersion, asrIdentity: context.transcript.providerIdentity };
    if (context.transcript.status === 'insufficient_evidence') {
      return { result: validateConversationResult({ schemaVersion: CONVERSATION_SCHEMA_VERSION,
        assessmentStatus: 'insufficient_evidence', taskResponse: 'not_assessed',
        feedback: 'I could not assess the transcript. Please try the same question again.',
        nextQuestion: context.currentQuestion, endConversation: false, notAssessed: [...CONVERSATION_NOT_ASSESSED] }, context),
      identity, metrics: {} };
    }
    try {
      const { decoded, provenance, metrics } = await this.client.infer({ messages: buildConversationMessages(context),
        format: CONVERSATION_SCHEMA, signal: input.signal });
      return { result: validateConversationResult(decoded, context), identity: { ...identity, ...provenance }, metrics };
    } catch (error) { throw conversationError(error); }
  }
}
