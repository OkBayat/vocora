import { Injectable, inject } from '@angular/core';
import type { WritingFeedbackController } from '../../shared/slide-exercise/writing-feedback-contracts';
import { CollectionLearningPathApiService } from '../collection-learning-path/collection-learning-path-api.service';
import { WritingFeedbackSession } from './writing-feedback-session';
import { ApiError } from '../http/api-client.service';

@Injectable({ providedIn: 'root' })
export class WritingFeedbackService {
  private readonly api = inject(CollectionLearningPathApiService);

  create(
    scope: { pathId: string; lessonId: string; exerciseId: string; slideId: string; expectedPathContentVersion: number },
    ensureStarted: () => Promise<boolean> = async () => true,
  ): WritingFeedbackController {
    const { pathId, lessonId, exerciseId, slideId, expectedPathContentVersion } = scope;
    return new WritingFeedbackSession({
      history: async () => {
        const history = await this.api.queryWritingFeedbackHistory(pathId, lessonId, exerciseId, slideId);
        if (history.pathContentVersion !== expectedPathContentVersion) {
          throw new ApiError('The lesson changed.', 409, 'WRITING_FEEDBACK_CONTENT_CHANGED');
        }
        return history;
      },
      save: (request) => this.api.commandSaveWritingFeedback(pathId, lessonId, exerciseId, slideId, { ...request, expectedPathContentVersion }),
      read: (id) => this.api.queryWritingFeedbackSubmission(id),
      retry: (id) => this.api.commandRetryWritingFeedback(id),
      cancel: (id) => this.api.commandCancelWritingFeedback(id),
    }, ensureStarted, () => crypto.randomUUID());
  }
}
