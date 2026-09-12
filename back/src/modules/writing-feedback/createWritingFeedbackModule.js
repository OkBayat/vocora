import { createHash, randomUUID } from "node:crypto";
import { WritingFeedback } from "../../application/writing-feedback/WritingFeedback.js";
import { WritingFeedbackWorker, writingFeedbackHandler } from "../../application/writing-feedback/WritingFeedbackWorker.js";
import { ResolveWritingFeedbackTask } from "../../application/writing-feedback/ResolveWritingFeedbackTask.js";
import { MySqlWritingFeedbackRepository } from "../../infrastructure/persistence/mysql/writing-feedback/MySqlWritingFeedbackRepository.js";
import { MySqlLearningPathDefinitionQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathDefinitionQueryRepository.js";
import { MySqlLearningPathProgressQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathProgressQueryRepository.js";
import { MySqlLearningPathAccessQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathAccessQueryRepository.js";
import { OllamaWritingFeedbackProvider } from "../../infrastructure/ai/OllamaWritingFeedbackProvider.js";
import { WritingFeedbackTokenizer } from "../../infrastructure/ai/WritingFeedbackTokenizer.js";
import { createWritingFeedbackTaskRouter, createWritingFeedbackJobRouter } from "../../interfaces/http/writing-feedback/writingFeedbackRouter.js";

export function createWritingFeedbackModule({ pool, config = {}, adapters = {}, logger = console, sharedClient, createWorker = true, cancelWork }) {
  const enabled = config.enabled === true;
  const repository = adapters.writingFeedbackRepository ?? new MySqlWritingFeedbackRepository(pool);
  const clock = adapters.writingFeedbackClock ?? (() => new Date());
  const idFactory = adapters.writingFeedbackIdFactory ?? randomUUID;
  const hashFactory = (value) => createHash("sha256").update(value).digest("hex");
  const taskResolver = adapters.writingFeedbackTaskResolver ?? new ResolveWritingFeedbackTask({
    definitionReader: adapters.learningPathDefinitionReader ?? new MySqlLearningPathDefinitionQueryRepository(pool),
    progressReader: adapters.learningPathProgressReader ?? new MySqlLearningPathProgressQueryRepository(pool),
    accessReader: adapters.learningPathAccessReader ?? new MySqlLearningPathAccessQueryRepository(pool),
    hashFactory,
  });
  const provider = enabled ? adapters.writingFeedbackProvider ?? new OllamaWritingFeedbackProvider(sharedClient ? { client: sharedClient } : {
    baseUrl: config.providerUrl, model: config.model, modelDigest: config.modelDigest,
    tokenizer: adapters.writingFeedbackTokenizer ?? new WritingFeedbackTokenizer(config.tokenizer),
    timeoutMs: config.timeoutMs,
  }) : null;
  const worker = createWorker ? new WritingFeedbackWorker({ repository, provider, enabled, clock, idFactory, timeoutMs: config.timeoutMs, pollIntervalMs: enabled ? 1000 : 60_000, logger }) : null;
  const service = new WritingFeedback({
    repository, taskResolver, enabled, clock, idFactory, hashFactory,
    retentionDays: config.retentionDays ?? 30,
    evaluationProfile: provider?.getIdentity() ?? null,
    cancelWork: cancelWork ?? ((id) => worker.cancel(id)),
  });
  return {
    service,
    repository,
    handler: writingFeedbackHandler(provider, enabled),
    worker,
    createTaskRouter: (options) => createWritingFeedbackTaskRouter({ service, ...options }),
    createJobRouter: (options) => createWritingFeedbackJobRouter({ service, ...options }),
  };
}
