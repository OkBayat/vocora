import { GetLearningTimeline } from "./application/learning/GetLearningTimeline.js";
import { MySqlLearningTimelineRepository } from "./infrastructure/persistence/mysql/MySqlLearningTimelineRepository.js";
import { ShadowingPractice } from "./application/shadowing-practice/ShadowingPractice.js";
import { HttpSpeechRecognizer } from "./infrastructure/speech/HttpSpeechRecognizer.js";
import { GetListeningEpisodeImage } from "./application/listening-practice/GetListeningEpisodeImage.js";
import { GetListeningEpisodeVocabulary } from "./application/listening-practice/GetListeningEpisodeVocabulary.js";
import { MySqlListeningVocabularyRepository } from "./infrastructure/persistence/mysql/MySqlListeningVocabularyRepository.js";
import { GetCurrentUser } from "./application/auth/GetCurrentUser.js";
import { LoginUser } from "./application/auth/LoginUser.js";
import { RegisterUser } from "./application/auth/RegisterUser.js";
import { GetListeningEpisodeAudio } from "./application/listening-practice/GetListeningEpisodeAudio.js";
import { ListListeningLessons } from "./application/listening-practice/ListListeningLessons.js";
import { StartListeningAttempt } from "./application/listening-practice/StartListeningAttempt.js";
import { SubmitListeningAttempt } from "./application/listening-practice/SubmitListeningAttempt.js";
import { GetVocabularySources } from "./application/library/GetVocabularySources.js";
import { LibraryCommands } from "./application/library/LibraryCommands.js";
import { LibraryQueries } from "./application/library/LibraryQueries.js";
import { ActivateVocabulary } from "./application/learning/ActivateVocabulary.js";
import { ActivateVocabularyBatch } from "./application/learning/ActivateVocabularyBatch.js";
import { ExcludeVocabulary } from "./application/learning/ExcludeVocabulary.js";
import { GetLearningState } from "./application/learning/GetLearningState.js";
import { GetLeitnerHouse } from "./application/learning/GetLeitnerHouse.js";
import { LearningSessionCommands } from "./application/learning/LearningSessionCommands.js";
import { RecordReviewResult } from "./application/learning/RecordReviewResult.js";
import { SaveLearningState } from "./application/learning/SaveLearningState.js";
import { UpdateLearningSettings } from "./application/learning/UpdateLearningSettings.js";
import { UpdateThemePreference } from "./application/learning/UpdateThemePreference.js";
import { UpdateVocabulary } from "./application/learning/UpdateVocabulary.js";
import { GetSentencePracticeCards } from "./application/sentence-practice/GetSentencePracticeCards.js";
import { LibraryAdminPolicy } from "./domain/library/LibraryAdminPolicy.js";
import { VocabularyFileParser } from "./domain/library/VocabularyFileParser.js";
import { MySqlEditableLearningBootstrapRepository } from "./infrastructure/persistence/mysql/MySqlEditableLearningBootstrapRepository.js";
import { MySqlLearningSettingsRepository } from "./infrastructure/persistence/mysql/MySqlLearningSettingsRepository.js";
import { MySqlListeningGoalLearningStateRepository } from "./infrastructure/persistence/mysql/MySqlListeningGoalLearningStateRepository.js";
import { MySqlLibraryRepository } from "./infrastructure/persistence/mysql/MySqlLibraryRepository.js";
import { MySqlListeningPracticeRepository } from "./infrastructure/persistence/mysql/MySqlListeningPracticeRepository.js";
import { MySqlPracticeSessionRepository } from "./infrastructure/persistence/mysql/MySqlPracticeSessionRepository.js";
import { MySqlReviewProgressRepository } from "./infrastructure/persistence/mysql/MySqlReviewProgressRepository.js";
import { MySqlSentencePracticeRepository } from "./infrastructure/persistence/mysql/MySqlSentencePracticeRepository.js";
import { MySqlUserRepository } from "./infrastructure/persistence/mysql/MySqlUserRepository.js";
import { MySqlVocabularyActivationRepository } from "./infrastructure/persistence/mysql/MySqlVocabularyActivationRepository.js";
import { MySqlVocabularySourceRepository } from "./infrastructure/persistence/mysql/MySqlVocabularySourceRepository.js";
import { BcryptPasswordHasher } from "./infrastructure/security/BcryptPasswordHasher.js";
import { JwtTokenService } from "./infrastructure/security/JwtTokenService.js";
import { createLocalTextInferenceModule } from "./modules/local-text-inference/createLocalTextInferenceModule.js";
import { createCollectionLearningPathModule } from "./modules/collection-learning-path/createCollectionLearningPathModule.js";
import { SynthesizeSpeech } from "./application/text-to-speech/SynthesizeSpeech.js";
import { FileTtsAudioCache } from "./infrastructure/text-to-speech/FileTtsAudioCache.js";
import { KokoroTtsClient } from "./infrastructure/text-to-speech/KokoroTtsClient.js";

export function createContainer({ pool, config, adapters = {} }) {
  const userRepository = adapters.userRepository ?? new MySqlUserRepository(pool);
  const learningStateRepository =
    adapters.learningStateRepository ?? new MySqlListeningGoalLearningStateRepository(pool);
  const learningSettingsRepository =
    adapters.learningSettingsRepository ?? new MySqlLearningSettingsRepository(pool);
  const learningBootstrapRepository = adapters.learningBootstrapRepository
    ?? (adapters.learningStateRepository
      ? learningStateRepository
      : new MySqlEditableLearningBootstrapRepository(pool, learningStateRepository));
  const libraryRepository = adapters.libraryRepository ?? new MySqlLibraryRepository(pool);
  const listeningPracticeRepository =
    adapters.listeningPracticeRepository ?? new MySqlListeningPracticeRepository(pool);
  const practiceSessionRepository =
    adapters.practiceSessionRepository ?? new MySqlPracticeSessionRepository(pool);
  const reviewProgressRepository =
    adapters.reviewProgressRepository ?? new MySqlReviewProgressRepository(pool);
  const sentencePracticeRepository =
    adapters.sentencePracticeRepository ?? new MySqlSentencePracticeRepository(pool);
  const vocabularyActivationRepository =
    adapters.vocabularyActivationRepository ?? new MySqlVocabularyActivationRepository(pool);
  const vocabularySourceRepository =
    adapters.vocabularySourceRepository ?? new MySqlVocabularySourceRepository(pool);
  const passwordHasher = adapters.passwordHasher ?? new BcryptPasswordHasher();
  const tokenService = adapters.tokenService ?? new JwtTokenService({
    secret: config.auth.jwtSecret,
    expiresIn: config.auth.jwtExpiresIn
  });
  const libraryAdminPolicy =
    adapters.libraryAdminPolicy ?? new LibraryAdminPolicy(config.library?.adminEmails || []);
  const vocabularyFileParser = adapters.vocabularyFileParser ?? new VocabularyFileParser();
  const getSentencePracticeCards = new GetSentencePracticeCards({ sentencePracticeRepository });
  const collectionLearningPath = createCollectionLearningPathModule({ pool, adapters });
  const localTextInference = createLocalTextInferenceModule({ pool, config, adapters });
  const { writingFeedback, adaptiveConversation } = localTextInference;
  const ttsAudioCache = adapters.ttsAudioCache ?? new FileTtsAudioCache({
    directory: config.tts.cacheDirectory
  });
  const ttsProvider = adapters.ttsProvider ?? new KokoroTtsClient({
    baseUrl: config.tts.providerUrl,
    timeoutMs: config.tts.requestTimeoutMs
  });

  return {
    tokenService,
    authCookie: config.auth.cookie,
    authRateLimit: config.auth.rateLimit,
    listeningAudioDirectory: config.listening.audioDirectory,
    listeningEpisodesDirectory: config.listening.episodesDirectory,
    collectionLearningPath,
    writingFeedback,
    adaptiveConversation,
    localTextInference,
    useCases: {
      synthesizeSpeech: new SynthesizeSpeech({
        audioCache: ttsAudioCache,
        ttsProvider,
        requestOptions: {
          allowedVoices: config.tts.allowedVoices,
          defaultVoice: config.tts.defaultVoice,
          defaultSpeed: config.tts.defaultSpeed,
          defaultFormat: config.tts.defaultFormat,
          maxTextLength: config.tts.maxTextLength,
          model: config.tts.model,
          modelVersion: config.tts.modelVersion
        }
      }),
      getLearningTimeline: new GetLearningTimeline({
        timelineRepository: adapters.timelineRepository ?? new MySqlLearningTimelineRepository(pool)
      }),
      shadowingPractice: new ShadowingPractice({
        getSentencePracticeCards,
        sentencePracticeRepository,
        // Only server-assessed speech can opt into shadowing accounting.
        practiceSessionRepository: {
          start: (...args) => practiceSessionRepository.start(...args),
          recordAttempt: (userId, sessionId, input) => practiceSessionRepository.recordAttempt(userId, sessionId, { ...input, shadowing: true }),
          complete: (...args) => practiceSessionRepository.complete(...args)
        },
        speech: adapters.speechRecognizer ?? new HttpSpeechRecognizer(config.shadowing)
      }),
      registerUser: new RegisterUser({ userRepository, passwordHasher }),
      loginUser: new LoginUser({ userRepository, passwordHasher }),
      getCurrentUser: new GetCurrentUser({ userRepository }),
      getListeningEpisodeImage: new GetListeningEpisodeImage({ listeningPracticeRepository }),
      getListeningEpisodeVocabulary: new GetListeningEpisodeVocabulary({
        listeningVocabularyRepository: adapters.listeningVocabularyRepository ?? new MySqlListeningVocabularyRepository(pool)
      }),
      getListeningEpisodeAudio: new GetListeningEpisodeAudio({ listeningPracticeRepository }),
      listListeningLessons: new ListListeningLessons({ listeningPracticeRepository }),
      startListeningAttempt: new StartListeningAttempt({ listeningPracticeRepository }),
      submitListeningAttempt: new SubmitListeningAttempt({ listeningPracticeRepository }),
      getLearningState: new GetLearningState({ learningStateRepository, learningBootstrapRepository }),
      getLeitnerHouse: new GetLeitnerHouse({ learningStateRepository }),
      getSentencePracticeCards,
      saveLearningState: new SaveLearningState({ learningStateRepository }),
      updateLearningSettings: new UpdateLearningSettings({ learningSettingsRepository }),
      updateThemePreference: new UpdateThemePreference({ learningStateRepository }),
      updateVocabulary: new UpdateVocabulary({ learningStateRepository }),
      activateVocabulary: new ActivateVocabulary({ vocabularyActivationRepository }),
      activateVocabularyBatch: new ActivateVocabularyBatch({ vocabularyActivationRepository }),
      excludeVocabulary: new ExcludeVocabulary({ vocabularyActivationRepository }),
      getVocabularySources: new GetVocabularySources({ vocabularySourceRepository }),
      recordReviewResult: new RecordReviewResult({ reviewProgressRepository }),
      learningSessionCommands: new LearningSessionCommands({ practiceSessionRepository }),
      libraryQueries: new LibraryQueries({ libraryRepository, adminPolicy: libraryAdminPolicy }),
      libraryCommands: new LibraryCommands({
        libraryRepository,
        adminPolicy: libraryAdminPolicy,
        vocabularyFileParser
      })
    }
  };
}
