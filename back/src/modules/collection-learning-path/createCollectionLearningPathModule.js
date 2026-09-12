import { MySqlConversationRepository } from "../../infrastructure/persistence/mysql/adaptive-conversation/MySqlConversationRepository.js";
import { createHash, randomUUID } from "node:crypto";

import { ActivateVocabularyIntake } from "../../application/collection-learning-path/commands/ActivateVocabularyIntake.js";
import { CompleteExercise } from "../../application/collection-learning-path/commands/CompleteExercise.js";
import { StartExercise } from "../../application/collection-learning-path/commands/StartExercise.js";
import { StartLearningPath } from "../../application/collection-learning-path/commands/StartLearningPath.js";
import { RemoveLearningPathEnrollment } from "../../application/collection-learning-path/commands/RemoveLearningPathEnrollment.js";
import { StartVocabularyMasteryCheck } from "../../application/collection-learning-path/commands/StartVocabularyMasteryCheck.js";
import { StartVocabularySpelling } from "../../application/collection-learning-path/commands/StartVocabularySpelling.js";
import { UploadSlideSequenceRecording } from "../../application/collection-learning-path/commands/UploadSlideSequenceRecording.js";
import { createDefaultExerciseRuntimeRegistry } from "../../application/collection-learning-path/ExerciseRuntimeRegistry.js";
import { GetCollectionLearningPath } from "../../application/collection-learning-path/queries/GetCollectionLearningPath.js";
import { GetExerciseContext } from "../../application/collection-learning-path/queries/GetExerciseContext.js";
import { GetIeltsListeningExerciseContext } from "../../application/collection-learning-path/queries/GetIeltsListeningExerciseContext.js";
import { GetLearningPathLesson } from "../../application/collection-learning-path/queries/GetLearningPathLesson.js";
import { GetLearningPath } from "../../application/collection-learning-path/queries/GetLearningPath.js";
import { GetLearningPathResumePoint } from "../../application/collection-learning-path/queries/GetLearningPathResumePoint.js";
import { GetScopedVocabularyQuickReviewContext } from "../../application/collection-learning-path/queries/GetScopedVocabularyQuickReviewContext.js";
import { GetSlideSequenceExerciseContext } from "../../application/collection-learning-path/queries/GetSlideSequenceExerciseContext.js";
import { GetVocabularyIntakeContext } from "../../application/collection-learning-path/queries/GetVocabularyIntakeContext.js";
import { GetVocabularyMasteryCheckContext } from "../../application/collection-learning-path/queries/GetVocabularyMasteryCheckContext.js";
import { ListAvailableLearningPathCollections } from "../../application/collection-learning-path/queries/ListAvailableLearningPathCollections.js";
import { ResolveLegacyLearningPathRoute } from "../../application/collection-learning-path/queries/ResolveLegacyLearningPathRoute.js";
import { VerifyIeltsListeningCompletion } from "../../application/collection-learning-path/queries/VerifyIeltsListeningCompletion.js";
import { VerifyScopedVocabularyQuickReviewCompletion } from "../../application/collection-learning-path/queries/VerifyScopedVocabularyQuickReviewCompletion.js";
import { VerifySlideSequenceCompletion } from "../../application/collection-learning-path/queries/VerifySlideSequenceCompletion.js";
import { VerifyShadowingExerciseCompletion } from "../../application/collection-learning-path/queries/VerifyShadowingExerciseCompletion.js";
import { VerifyVocabularyIntakeCompletion } from "../../application/collection-learning-path/queries/VerifyVocabularyIntakeCompletion.js";
import { VerifyVocabularyMasteryCheckCompletion } from "../../application/collection-learning-path/queries/VerifyVocabularyMasteryCheckCompletion.js";
import { VerifyVocabularySpellingCompletion } from "../../application/collection-learning-path/queries/VerifyVocabularySpellingCompletion.js";
import {
  IELTS_LISTENING_COMPLETION_POLICY,
  IELTS_LISTENING_TYPE,
} from "../../domain/collection-learning-path/IeltsListeningExercise.js";
import {
  VOCABULARY_QUICK_REVIEW_COMPLETION_POLICY,
  VOCABULARY_QUICK_REVIEW_TYPE,
} from "../../domain/collection-learning-path/ScopedVocabularyPractice.js";
import { SHADOWING_COMPLETION_POLICY } from "../../domain/collection-learning-path/ShadowingExercise.js";
import {
  SLIDE_SEQUENCE_COMPLETION_POLICY,
  SLIDE_SEQUENCE_TYPE,
} from "../../domain/collection-learning-path/SlideSequenceExercise.js";
import { VOCABULARY_INTAKE_COMPLETION_POLICY, VOCABULARY_INTAKE_TYPE } from "../../domain/collection-learning-path/VocabularyIntake.js";
import {
  VOCABULARY_MASTERY_CHECK_COMPLETION_POLICY,
  VOCABULARY_MASTERY_CHECK_TYPE,
} from "../../domain/collection-learning-path/VocabularyMasteryCheck.js";
import {
  VOCABULARY_SPELLING_COMPLETION_POLICY,
} from "../../domain/collection-learning-path/VocabularySpellingPractice.js";
import { ListeningPracticeLearningPathAdapter } from "../../infrastructure/integration/collection-learning-path/ListeningPracticeLearningPathAdapter.js";
import { MySqlListeningPracticeRepository } from "../../infrastructure/persistence/mysql/MySqlListeningPracticeRepository.js";
import { MySqlPracticeSessionRepository } from "../../infrastructure/persistence/mysql/MySqlPracticeSessionRepository.js";
import { MySqlVocabularyActivationRepository } from "../../infrastructure/persistence/mysql/MySqlVocabularyActivationRepository.js";
import { MySqlLearningPathAccessQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathAccessQueryRepository.js";
import { MySqlLearningPathCatalogQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathCatalogQueryRepository.js";
import { MySqlLearningPathDefinitionQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathDefinitionQueryRepository.js";
import { MySqlLearningPathMasteryCheckEvidenceQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathMasteryCheckEvidenceQueryRepository.js";
import { MySqlLearningPathMasteryCheckSessionCommandRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathMasteryCheckSessionCommandRepository.js";
import { MySqlLearningPathProgressCommandRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathProgressCommandRepository.js";
import { MySqlLearningPathProgressQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathProgressQueryRepository.js";
import { MySqlLearningPathQuickReviewEvidenceQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathQuickReviewEvidenceQueryRepository.js";
import { MySqlLearningPathRecordingArtifactRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathRecordingArtifactRepository.js";
import { MySqlLearningPathShadowingEvidenceQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathShadowingEvidenceQueryRepository.js";
import { MySqlLearningPathTransactionManager } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathTransactionManager.js";
import { MySqlLearningPathVocabularyIntakeCommandRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathVocabularyIntakeCommandRepository.js";
import { MySqlLearningPathVocabularyIntakeQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathVocabularyIntakeQueryRepository.js";
import { MySqlLearningPathVocabularySpellingQueryRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathVocabularySpellingQueryRepository.js";
import { MySqlLearningPathVocabularySpellingSessionCommandRepository } from "../../infrastructure/persistence/mysql/collection-learning-path/MySqlLearningPathVocabularySpellingSessionCommandRepository.js";
import { createCollectionLearningPathRouter } from "../../interfaces/http/collection-learning-path/collectionLearningPathRouter.js";

export function createCollectionLearningPathModule({ pool, adapters = {} }) {
  const definitionReader = adapters.learningPathDefinitionReader
    ?? new MySqlLearningPathDefinitionQueryRepository(pool);
  const progressReader = adapters.learningPathProgressReader
    ?? new MySqlLearningPathProgressQueryRepository(pool);
  const progressWriter = adapters.learningPathProgressWriter
    ?? new MySqlLearningPathProgressCommandRepository(pool);
  const accessReader = adapters.learningPathAccessReader
    ?? new MySqlLearningPathAccessQueryRepository(pool);
  const catalogReader = adapters.learningPathCatalogReader
    ?? new MySqlLearningPathCatalogQueryRepository(pool);
  const transactionManager = adapters.learningPathTransactionManager
    ?? new MySqlLearningPathTransactionManager(pool);
  const vocabularyIntakeReader = adapters.learningPathVocabularyIntakeReader
    ?? new MySqlLearningPathVocabularyIntakeQueryRepository(pool);
  const scopedVocabularyReader = adapters.learningPathScopedVocabularyReader
    ?? vocabularyIntakeReader;
  const quickReviewEvidenceReader = adapters.learningPathQuickReviewEvidenceReader
    ?? new MySqlLearningPathQuickReviewEvidenceQueryRepository(pool);
  const spellingReader = adapters.learningPathVocabularySpellingReader
    ?? new MySqlLearningPathVocabularySpellingQueryRepository(pool);
  const spellingEvidenceReader = adapters.learningPathVocabularySpellingEvidenceReader
    ?? quickReviewEvidenceReader;
  const masteryCheckEvidenceReader = adapters.learningPathMasteryCheckEvidenceReader
    ?? new MySqlLearningPathMasteryCheckEvidenceQueryRepository(pool);
  const shadowingEvidenceReader = adapters.learningPathShadowingEvidenceReader
    ?? new MySqlLearningPathShadowingEvidenceQueryRepository(pool);
  const practiceSessionRepository = adapters.learningPathPracticeSessionRepository
    ?? adapters.practiceSessionRepository
    ?? new MySqlPracticeSessionRepository(pool);
  const masteryCheckSessionWriter = adapters.learningPathMasteryCheckSessionWriter
    ?? new MySqlLearningPathMasteryCheckSessionCommandRepository(practiceSessionRepository);
  const spellingSessionWriter = adapters.learningPathVocabularySpellingSessionWriter
    ?? new MySqlLearningPathVocabularySpellingSessionCommandRepository(practiceSessionRepository);
  const vocabularyActivationRepository = adapters.learningPathVocabularyActivationRepository
    ?? adapters.vocabularyActivationRepository
    ?? new MySqlVocabularyActivationRepository(pool);
  const vocabularyIntakeWriter = adapters.learningPathVocabularyIntakeWriter
    ?? new MySqlLearningPathVocabularyIntakeCommandRepository(vocabularyActivationRepository);
  const listeningPracticeRepository = adapters.listeningPracticeRepository
    ?? new MySqlListeningPracticeRepository(pool);
  const ieltsListeningReader = adapters.learningPathIeltsListeningReader
    ?? new ListeningPracticeLearningPathAdapter({ listeningPracticeRepository });
  const recordingArtifactRepository = adapters.learningPathRecordingArtifactRepository
    ?? new MySqlLearningPathRecordingArtifactRepository(pool);
  const clock = adapters.learningPathClock ?? (() => new Date());
  const idFactory = adapters.learningPathIdFactory ?? randomUUID;
  const hashFactory = adapters.learningPathRecordingHashFactory
    ?? ((bytes) => createHash("sha256").update(bytes).digest("hex"));

  const getVocabularyIntakeContext = new GetVocabularyIntakeContext({ vocabularyIntakeReader });
  const verifyVocabularyIntakeCompletion = new VerifyVocabularyIntakeCompletion({ vocabularyIntakeReader });
  const getScopedVocabularyQuickReviewContext = new GetScopedVocabularyQuickReviewContext({ scopedVocabularyReader });
  const verifyScopedVocabularyQuickReviewCompletion = new VerifyScopedVocabularyQuickReviewCompletion({
    scopedVocabularyReader,
    quickReviewEvidenceReader,
  });
  const getVocabularyMasteryCheckContext = new GetVocabularyMasteryCheckContext({ scopedVocabularyReader });
  const verifyVocabularyMasteryCheckCompletion = new VerifyVocabularyMasteryCheckCompletion({
    scopedVocabularyReader,
    masteryCheckEvidenceReader,
  });
  const verifyVocabularySpellingCompletion = new VerifyVocabularySpellingCompletion({
    spellingReader,
    spellingEvidenceReader,
  });
  const getIeltsListeningExerciseContext = new GetIeltsListeningExerciseContext({ ieltsListeningReader });
  const verifyIeltsListeningCompletion = new VerifyIeltsListeningCompletion({ ieltsListeningReader });
  const verifyShadowingExerciseCompletion = new VerifyShadowingExerciseCompletion({ shadowingEvidenceReader });
  const getSlideSequenceExerciseContext = new GetSlideSequenceExerciseContext({ vocabularyReader: vocabularyIntakeReader });
  const verifySlideSequenceCompletion = new VerifySlideSequenceCompletion({
    conversationRepository: adapters.conversationRepository ?? new MySqlConversationRepository(pool),
    vocabularyReader: vocabularyIntakeReader,
    recordingArtifactRepository,
  });
  const exerciseRuntime = adapters.learningPathExerciseRuntime
    ?? createDefaultExerciseRuntimeRegistry({
      contextHydrators: {
        [VOCABULARY_INTAKE_TYPE]: (context) => getVocabularyIntakeContext.execute(context),
        [VOCABULARY_QUICK_REVIEW_TYPE]: (context) => getScopedVocabularyQuickReviewContext.execute(context),
        [VOCABULARY_MASTERY_CHECK_TYPE]: (context) => getVocabularyMasteryCheckContext.execute(context),
        [IELTS_LISTENING_TYPE]: (context) => getIeltsListeningExerciseContext.execute(context),
        [SLIDE_SEQUENCE_TYPE]: (context) => getSlideSequenceExerciseContext.execute(context),
      },
      completionPolicies: {
        [VOCABULARY_INTAKE_COMPLETION_POLICY]: (context) => verifyVocabularyIntakeCompletion.execute(context),
        [VOCABULARY_QUICK_REVIEW_COMPLETION_POLICY]: (context) => verifyScopedVocabularyQuickReviewCompletion.execute(context),
        [VOCABULARY_MASTERY_CHECK_COMPLETION_POLICY]: (context) => verifyVocabularyMasteryCheckCompletion.execute(context),
        [VOCABULARY_SPELLING_COMPLETION_POLICY]: (context) => verifyVocabularySpellingCompletion.execute(context),
        [IELTS_LISTENING_COMPLETION_POLICY]: (context) => verifyIeltsListeningCompletion.execute(context),
        [SHADOWING_COMPLETION_POLICY]: (context) => verifyShadowingExerciseCompletion.execute(context),
        [SLIDE_SEQUENCE_COMPLETION_POLICY]: (context) => verifySlideSequenceCompletion.execute(context),
      },
    });

  const dependencies = {
    definitionReader,
    progressReader,
    progressWriter,
    accessReader,
    catalogReader,
    transactionManager,
    exerciseRuntime,
    vocabularyIntakeReader,
    vocabularyIntakeWriter,
    scopedVocabularyReader,
    quickReviewEvidenceReader,
    masteryCheckEvidenceReader,
    masteryCheckSessionWriter,
    spellingReader,
    spellingEvidenceReader,
    spellingSessionWriter,
    ieltsListeningReader,
    shadowingEvidenceReader,
    recordingArtifactRepository,
    clock,
  };

  const queries = {
    listAvailableCollections: new ListAvailableLearningPathCollections(dependencies),
    getCollectionLearningPath: new GetCollectionLearningPath(dependencies),
    getLearningPath: new GetLearningPath(dependencies),
    getLearningPathLesson: new GetLearningPathLesson(dependencies),
    getExerciseContext: new GetExerciseContext(dependencies),
    getLearningPathResumePoint: new GetLearningPathResumePoint(dependencies),
    resolveLegacyLearningPathRoute: new ResolveLegacyLearningPathRoute(dependencies),
  };
  const commands = {
    startLearningPath: new StartLearningPath(dependencies),
    removeLearningPathEnrollment: new RemoveLearningPathEnrollment(dependencies),
    startExercise: new StartExercise(dependencies),
    activateVocabularyIntake: new ActivateVocabularyIntake(dependencies),
    startVocabularyMasteryCheck: new StartVocabularyMasteryCheck(dependencies),
    startVocabularySpelling: new StartVocabularySpelling({
      ...dependencies,
      practiceSessionWriter: spellingSessionWriter,
    }),
    uploadSlideSequenceRecording: new UploadSlideSequenceRecording({
      ...dependencies,
      recordingArtifactRepository,
      idFactory,
      hashFactory,
    }),
    completeExercise: new CompleteExercise(dependencies),
  };

  return {
    queries,
    commands,
    createHttpRouter({ authenticate, audioDirectory }) {
      return createCollectionLearningPathRouter({ queries, commands, authenticate, audioDirectory });
    },
  };
}
