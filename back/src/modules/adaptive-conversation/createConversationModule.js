import { createHash, randomUUID } from 'node:crypto';
import { ConversationPractice } from '../../application/adaptive-conversation/ConversationPractice.js';
import { ConversationRecordings } from '../../application/adaptive-conversation/ConversationRecordings.js';
import { ConversationQuestionAudio } from '../../application/adaptive-conversation/ConversationQuestionAudio.js';
import { ResolveConversationTask } from '../../application/adaptive-conversation/ResolveConversationTask.js';
import { acceptConversationInference } from '../../application/adaptive-conversation/conversationState.js';
import { MySqlConversationRepository } from '../../infrastructure/persistence/mysql/adaptive-conversation/MySqlConversationRepository.js';
import { MySqlLearningPathDefinitionQueryRepository } from '../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathDefinitionQueryRepository.js';
import { MySqlLearningPathProgressQueryRepository } from '../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathProgressQueryRepository.js';
import { MySqlLearningPathAccessQueryRepository } from '../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathAccessQueryRepository.js';
import { OllamaConversationProvider } from '../../infrastructure/ai/OllamaConversationProvider.js';
import { ConversationError } from '../../domain/adaptive-conversation/ConversationError.js';
import { HttpSpeechRecognizer } from '../../infrastructure/speech/HttpSpeechRecognizer.js';
import { KokoroTtsClient } from '../../infrastructure/text-to-speech/KokoroTtsClient.js';
import { createConversationRouter, createConversationTaskRouter } from '../../interfaces/http/adaptive-conversation/conversationRouter.js';

export function createConversationModule({ pool, config, adapters = {}, sharedClient, cancelWork = () => {}, cancelSessionWork = () => {} }) {
  const enabled = config.adaptiveConversation?.enabled === true;
  const repository = adapters.conversationRepository ?? new MySqlConversationRepository(pool);
  const idFactory = adapters.conversationIdFactory ?? randomUUID;
  const clock = adapters.conversationClock ?? (() => new Date());
  const hashFactory = (value) => createHash('sha256').update(value).digest('hex');
  const taskResolver = adapters.conversationTaskResolver ?? new ResolveConversationTask({
    definitionReader: adapters.learningPathDefinitionReader ?? new MySqlLearningPathDefinitionQueryRepository(pool),
    progressReader: adapters.learningPathProgressReader ?? new MySqlLearningPathProgressQueryRepository(pool),
    accessReader: adapters.learningPathAccessReader ?? new MySqlLearningPathAccessQueryRepository(pool), hashFactory,
  });
  const provider = enabled ? adapters.conversationProvider ?? new OllamaConversationProvider({ client: sharedClient }) : null;
  let recordings, audio;
  const sessions = new ConversationPractice({ repository, taskResolver, enabled, idFactory, clock, hashFactory,
    retentionDays: config.adaptiveConversation?.retentionDays ?? 30, evaluationProfile: provider?.getIdentity() ?? null,
    cancelSessionWork: async (id) => { cancelSessionWork(id); audio.cancelSession(id); await recordings.cancelSession(id); },
  });
  recordings = new ConversationRecordings({ sessions, repository, idFactory, evaluationProfile: provider?.getIdentity() ?? null, cancelWork,
    speech: adapters.conversationSpeech ?? (enabled ? new HttpSpeechRecognizer({ url: config.shadowing?.url, privateOnly: true }) : null),
  });
  audio = new ConversationQuestionAudio({ sessions, options: config.tts,
    provider: adapters.conversationTts ?? (enabled ? new KokoroTtsClient({ baseUrl: config.tts?.providerUrl, timeoutMs: Math.min(config.tts?.requestTimeoutMs ?? 120000, 120000), privateOnly: true }) : null),
  });
  const handler = { enabled, provider, prefix: 'CONVERSATION', isSafeError: (error) => error instanceof ConversationError,
    evaluate: (job, signal) => { const { activeUntil: _activeUntil, ...payload } = job.payload; return provider.evaluate({ ...payload, signal }); },
    applyResult: (session, job, outcome) => acceptConversationInference(session, job, outcome, idFactory),
  };
  return { sessions, recordings, audio, repository, handler,
    createTaskRouter: (options) => createConversationTaskRouter({ sessions, ...options }),
    createRouter: (options) => createConversationRouter({ sessions, recordings, audio, ...options }),
    stop: async () => { audio.stop(); await recordings.stop(); },
  };
}
