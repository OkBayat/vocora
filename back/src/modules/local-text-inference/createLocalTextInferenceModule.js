import { randomUUID } from 'node:crypto';
import { LocalTextInferenceWorker } from '../../application/local-text-inference/LocalTextInferenceWorker.js';
import { MySqlLocalTextInferenceQueue } from '../../infrastructure/persistence/mysql/local-text-inference/MySqlLocalTextInferenceQueue.js';
import { OllamaStructuredTextClient } from '../../infrastructure/ai/OllamaStructuredTextClient.js';
import { WritingFeedbackTokenizer } from '../../infrastructure/ai/WritingFeedbackTokenizer.js';
import { createWritingFeedbackModule } from '../writing-feedback/createWritingFeedbackModule.js';
import { createConversationModule } from '../adaptive-conversation/createConversationModule.js';

/** One process worker, one database lease and one pinned local client across both families. */
export function createLocalTextInferenceModule({ pool, config, adapters = {}, logger = console }) {
  const writing = config.writingFeedback ?? {};
  const writingEnabled = writing.enabled === true;
  const conversationEnabled = config.adaptiveConversation?.enabled === true;
  const needsClient = (writingEnabled && !adapters.writingFeedbackProvider) || (conversationEnabled && !adapters.conversationProvider);
  const sharedClient = needsClient ? adapters.localTextInferenceClient ?? new OllamaStructuredTextClient({
    baseUrl: writing.providerUrl, model: writing.model, modelDigest: writing.modelDigest,
    tokenizer: adapters.writingFeedbackTokenizer ?? new WritingFeedbackTokenizer(writing.tokenizer), timeoutMs: writing.timeoutMs,
  }) : null;
  let worker;
  const writingFeedback = createWritingFeedbackModule({ pool, config: writing, adapters, logger, sharedClient, createWorker: false, cancelWork: (id) => worker.cancel(id, 'writing-feedback') });
  const adaptiveConversation = createConversationModule({ pool, config, adapters, sharedClient,
    cancelWork: (id) => worker.cancel(id, 'adaptive-conversation'), cancelSessionWork: (id) => worker.cancelSession(id),
  });
  worker = new LocalTextInferenceWorker({ repository: adapters.localTextInferenceQueue ?? new MySqlLocalTextInferenceQueue(pool),
    handlers: { 'writing-feedback': writingFeedback.handler, 'adaptive-conversation': adaptiveConversation.handler },
    clock: adapters.localTextInferenceClock ?? (() => new Date()), idFactory: adapters.localTextInferenceIdFactory ?? randomUUID,
    timeoutMs: writing.timeoutMs, pollIntervalMs: writingEnabled || conversationEnabled ? 1000 : 60000, logger,
  });
  // Keep the established module facade; no second scheduler is constructed.
  writingFeedback.worker = worker;
  return { worker, writingFeedback, adaptiveConversation };
}
