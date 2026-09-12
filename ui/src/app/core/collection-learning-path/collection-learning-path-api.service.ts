import { Injectable, inject } from '@angular/core';
import type {
  CollectionLearningPathView,
  CompletedLearningPathExerciseOutcome,
  ExerciseContextView,
  LearningPathExerciseStartView,
  LearningPathExerciseCompletionView,
  LearningPathResumeView,
} from '../../domain/collection-learning-path/learning-path';
import type { VocabularyIntakeActivationView } from '../../domain/collection-learning-path/vocabulary-intake';
import type { VocabularyMasteryCheckStartView } from '../../domain/collection-learning-path/vocabulary-mastery-check';
import type { VocabularySpellingScope, VocabularySpellingStartView } from '../../domain/collection-learning-path/vocabulary-spelling-practice';
import type { LibraryCollection } from '../../domain/learning/models';
import { ApiClientService } from '../http/api-client.service';
import type { WritingFeedbackSaveRequest, WritingFeedbackHistory, WritingSubmission } from '../../shared/slide-exercise/writing-feedback-contracts';

export interface LearningPathCatalogRoute {
  collectionId: string;
  pathId: string;
}

export interface LearningPathCatalogItem {
  collectionId: string;
  pathId: string | null;
  title: string;
  learnerStatus: 'available' | 'in_progress' | 'completed' | 'up_to_date';
  enrolled: boolean;
}

export interface LearningPathCatalogResponse {
  collectionIds?: string[];
  learningPaths?: Array<LearningPathCatalogRoute | LearningPathCatalogItem>;
}

const learnerStatuses = new Set<LearningPathCatalogItem['learnerStatus']>([
  'available',
  'in_progress',
  'completed',
  'up_to_date',
]);

function isRichCatalogItem(item: LearningPathCatalogRoute | LearningPathCatalogItem): item is LearningPathCatalogItem {
  const candidate = item as Partial<LearningPathCatalogItem>;
  return typeof candidate.title === 'string'
    && typeof candidate.enrolled === 'boolean'
    && learnerStatuses.has(candidate.learnerStatus as LearningPathCatalogItem['learnerStatus']);
}

export function normalizeLearningPathCatalog(
  response: LearningPathCatalogResponse,
  collections: readonly Pick<LibraryCollection, 'id' | 'title' | 'subscribed'>[],
): LearningPathCatalogItem[] {
  const collectionsById = new Map(collections.map((collection) => [collection.id, collection]));
  const routes: Array<LearningPathCatalogRoute | LearningPathCatalogItem> = Array.isArray(response.learningPaths)
    ? response.learningPaths
    : (response.collectionIds ?? []).map((collectionId) => ({ collectionId, pathId: '' }));

  return routes.flatMap((route) => {
    const collection = collectionsById.get(route.collectionId);
    if (!collection || typeof route.pathId !== 'string') return [];
    if (isRichCatalogItem(route)) return [{ ...route }];
    return [{
      collectionId: route.collectionId,
      pathId: route.pathId || null,
      title: collection.title,
      learnerStatus: 'available',
      enrolled: false,
    } satisfies LearningPathCatalogItem];
  });
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function exercisePath(pathId: string, lessonId: string, exerciseId: string): string {
  return `/api/learning-paths/${segment(pathId)}/lessons/${segment(lessonId)}/exercises/${segment(exerciseId)}`;
}

@Injectable({ providedIn: 'root' })
export class CollectionLearningPathApiService {
  private readonly api = inject(ApiClientService);

  queryLearningPathCollectionIds(): Promise<LearningPathCatalogResponse> {
    return this.api.get('/api/learning-paths/collections');
  }

  queryCollectionLearningPath(collectionId: string): Promise<CollectionLearningPathView> {
    return this.api.get<CollectionLearningPathView>(`/api/learning-paths/collections/${segment(collectionId)}`);
  }

  queryLearningPath(pathId: string): Promise<CollectionLearningPathView> {
    return this.api.get<CollectionLearningPathView>(`/api/learning-paths/${segment(pathId)}`);
  }

  resolveLegacyExerciseRoute(
    pathId: string,
    lessonId: string,
    exerciseId: string,
  ): Promise<{ pathId: string; lessonId: string; exerciseId: string }> {
    return this.api.get(
      `/api/learning-paths/legacy/${segment(pathId)}/lessons/${segment(lessonId)}/exercises/${segment(exerciseId)}/route`,
    );
  }

  queryResumePoint(pathId: string): Promise<LearningPathResumeView> {
    return this.api.get<LearningPathResumeView>(`/api/learning-paths/${segment(pathId)}/resume`);
  }

  queryExerciseContext(pathId: string, lessonId: string, exerciseId: string): Promise<ExerciseContextView> {
    return this.api.get<{ context: ExerciseContextView }>(exercisePath(pathId, lessonId, exerciseId))
      .then((response) => response.context);
  }

  commandStartPath(pathId: string): Promise<LearningPathResumeView> {
    return this.api.post<LearningPathResumeView>(`/api/learning-paths/${segment(pathId)}/start`);
  }

  commandRemovePathEnrollment(pathId: string): Promise<{pathId: string; removed: boolean}> {
    return this.api.delete<{pathId: string; removed: boolean}>(
      `/api/learning-paths/${segment(pathId)}/enrollment`,
    );
  }

  commandStartExercise(pathId: string, lessonId: string, exerciseId: string, progressRevision = 0): Promise<LearningPathExerciseStartView> {
    return this.api.post<LearningPathExerciseStartView>(`${exercisePath(pathId, lessonId, exerciseId)}/start`, { progressRevision });
  }

  commandActivateVocabularyIntake(
    pathId: string,
    lessonId: string,
    exerciseId: string,
  ): Promise<VocabularyIntakeActivationView> {
    return this.api.post<VocabularyIntakeActivationView>(
      `${exercisePath(pathId, lessonId, exerciseId)}/vocabulary-intake/activate`,
    );
  }

  commandStartVocabularyMasteryCheck(
    pathId: string,
    lessonId: string,
    exerciseId: string,
  ): Promise<VocabularyMasteryCheckStartView> {
    return this.api.post<VocabularyMasteryCheckStartView>(
      `${exercisePath(pathId, lessonId, exerciseId)}/vocabulary-mastery-check/start`,
    );
  }

  commandStartVocabularySpelling(
    pathId: string,
    lessonId: string,
    exerciseId: string,
    scope: VocabularySpellingScope,
  ): Promise<VocabularySpellingStartView> {
    return this.api.post<VocabularySpellingStartView>(
      `${exercisePath(pathId, lessonId, exerciseId)}/vocabulary-spelling/start`,
      { scope },
    );
  }

  commandUploadSlideSequenceRecording(
    pathId: string,
    lessonId: string,
    exerciseId: string,
    slideId: string,
    recording: Blob,
  ): Promise<{ artifactId: string }> {
    const mimeType = recording.type || 'audio/webm';
    // CapacitorHttp's native bridge serializes File bodies as binary data,
    // while a bare Blob can fall through its JSON request-body path.
    const upload = new File([recording], 'speaking-recording', { type: mimeType });
    return this.api.post<{ artifactId: string }>(
      `${exercisePath(pathId, lessonId, exerciseId)}/slides/${segment(slideId)}/recordings`,
      upload,
      { 'Content-Type': mimeType },
    );
  }

  commandCompleteExercise(
    pathId: string,
    lessonId: string,
    exerciseId: string,
    outcome: CompletedLearningPathExerciseOutcome,
    progressRevision = 0,
  ): Promise<LearningPathExerciseCompletionView> {
    return this.api.post<LearningPathExerciseCompletionView>(
      `${exercisePath(pathId, lessonId, exerciseId)}/complete`,
      { outcome, progressRevision },
    );
  }

  queryWritingFeedbackHistory(pathId: string, lessonId: string, exerciseId: string, slideId: string): Promise<WritingFeedbackHistory> {
    return this.api.get(`${exercisePath(pathId, lessonId, exerciseId)}/slides/${segment(slideId)}/writing-feedback`);
  }

  commandSaveWritingFeedback(pathId: string, lessonId: string, exerciseId: string, slideId: string, request: WritingFeedbackSaveRequest): Promise<WritingSubmission> {
    return this.api.post<{ submission: WritingSubmission }>(
      `${exercisePath(pathId, lessonId, exerciseId)}/slides/${segment(slideId)}/writing-feedback`, request,
    ).then((response) => response.submission);
  }

  queryWritingFeedbackSubmission(id: string): Promise<WritingSubmission> {
    return this.api.get<{ submission: WritingSubmission }>(`/api/writing-feedback/${segment(id)}`)
      .then((response) => response.submission);
  }

  commandRetryWritingFeedback(id: string): Promise<WritingSubmission> {
    return this.api.post<{ submission: WritingSubmission }>(`/api/writing-feedback/${segment(id)}/retry`, {})
      .then((response) => response.submission);
  }

  commandCancelWritingFeedback(id: string): Promise<WritingSubmission> {
    return this.api.post<{ submission: WritingSubmission }>(`/api/writing-feedback/${segment(id)}/cancel`, {})
      .then((response) => response.submission);
  }
}
