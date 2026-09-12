import type { Observable } from 'rxjs';
import type { WritingFeedbackControllerFactory } from '../../../../shared/slide-exercise/writing-feedback-contracts';
import type { AdaptiveConversationControllerFactory } from '../../../../shared/slide-exercise/adaptive-conversation-contracts';
import type { NumberInputSlideExpansionHandler, PronunciationPracticeController, SelectionSlideExpansionHandler, SlideExerciseResult } from '../../../../shared/slide-exercise';
import type {
  CompletedLearningPathExerciseOutcome,
  LearningPathNodeState,
} from '../../../../domain/collection-learning-path/learning-path';

export interface ExerciseContext<TPayload = unknown> {
  readonly pathId: string;
  readonly exerciseId: string;
  readonly lessonId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly completionPolicy?: string;
  readonly state?: LearningPathNodeState;
  readonly config: Readonly<Record<string, unknown>>;
  readonly payload: TPayload;
  readonly ensureStarted?: () => Promise<boolean>;
  readonly selectionExpansion?: SelectionSlideExpansionHandler;
  readonly numberInputExpansion?: NumberInputSlideExpansionHandler;
  readonly pronunciationPractice?: PronunciationPracticeController;
  readonly writingFeedback?: WritingFeedbackControllerFactory;
  readonly adaptiveConversation?: AdaptiveConversationControllerFactory;
  readonly slideResult?: (result: SlideExerciseResult) => Promise<void>;
  readonly sequenceCompletion?: (results: readonly SlideExerciseResult[]) => Promise<void>;
}

export type ExerciseOutcome = CompletedLearningPathExerciseOutcome
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

export interface ExerciseComponent {
  readonly outcome: Observable<ExerciseOutcome>;
  load(context: ExerciseContext): void;
}
