import { ConflictError, ValidationError } from "../../domain/errors.js";
import { resolveSlideSequenceDefinition, SLIDE_SEQUENCE_TYPE } from "../../domain/collection-learning-path/SlideSequenceExercise.js";
import { isLearningPathExerciseRepeatable } from "../../domain/collection-learning-path/LearningPathProgression.js";
import { parseWritingFeedbackTask } from "../../domain/writing-feedback/WritingFeedbackTask.js";
import { ensureLearningPathProgressAccess, loadPathById, projectedPathForUser, requireProjectedExercise, requireProjectedLesson } from "../collection-learning-path/learningPathSupport.js";

export class ResolveWritingFeedbackTask {
  constructor({ definitionReader, progressReader, accessReader, hashFactory }) {
    Object.assign(this, { definitionReader, progressReader, accessReader, hashFactory });
  }

  async execute(userId, pathId, lessonId, exerciseId, slideId, { forHistory = false } = {}) {
    const path = await loadPathById(this.definitionReader, pathId);
    await ensureLearningPathProgressAccess(this.accessReader, userId, path);
    const { projected } = await projectedPathForUser({ progressReader: this.progressReader, userId, path });
    const lesson = requireProjectedLesson(projected, lessonId);
    const exercise = requireProjectedExercise(lesson, exerciseId);
    const completedAccess = exercise.state === "completed" && (forHistory || isLearningPathExerciseRepeatable(exercise));
    if (exercise.state === "locked" || (!completedAccess && exercise.progress?.status !== "in_progress") || !exercise.progress?.startedAt) {
      throw new ConflictError("LEARNING_PATH_EXERCISE_NOT_STARTED", "Start the exercise before saving Writing feedback.");
    }
    if (typeof slideId !== "string" || !slideId || slideId.length > 160 || exercise.type !== SLIDE_SEQUENCE_TYPE) {
      throw new ValidationError("INVALID_WRITING_FEEDBACK_SLIDE", "Writing feedback requires a configured writing-response slide.");
    }
    const slide = resolveSlideSequenceDefinition(exercise).slides.find((candidate) => candidate.id === slideId);
    const taskContext = slide?.type === "writing-response" ? parseWritingFeedbackTask(slide.data) : null;
    if (!taskContext) throw new ValidationError("INVALID_WRITING_FEEDBACK_SLIDE", "Writing feedback requires a configured writing-response slide.");
    return {
      pathId: path.id, lessonId: lesson.id, exerciseId: exercise.id, slideId: slide.id,
      exerciseStartedAt: new Date(exercise.progress.startedAt).toISOString(),
      taskContext,
      pathContentVersion: path.contentVersion,
      contentVersion: this.hashFactory(JSON.stringify({ pathVersion: path.contentVersion, taskContext })),
    };
  }
}
