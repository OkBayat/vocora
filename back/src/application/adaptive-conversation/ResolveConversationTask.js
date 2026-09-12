import { ConflictError, ValidationError } from "../../domain/errors.js";
import { resolveSlideSequenceDefinition, SLIDE_SEQUENCE_TYPE } from "../../domain/collection-learning-path/SlideSequenceExercise.js";
import { isLearningPathExerciseRepeatable } from "../../domain/collection-learning-path/LearningPathProgression.js";
import { parseConversationDefinition } from "../../domain/adaptive-conversation/ConversationDefinition.js";
import { ensureLearningPathProgressAccess, loadPathById, projectedPathForUser, requireProjectedExercise, requireProjectedLesson } from "../collection-learning-path/learningPathSupport.js";

export class ResolveConversationTask {
  constructor({ definitionReader, progressReader, accessReader, hashFactory }) { Object.assign(this, { definitionReader, progressReader, accessReader, hashFactory }); }
  async execute(userId, pathId, lessonId, exerciseId, slideId, { forHistory = false } = {}) {
    const path = await loadPathById(this.definitionReader, pathId);
    await ensureLearningPathProgressAccess(this.accessReader, userId, path);
    const { projected } = await projectedPathForUser({ progressReader: this.progressReader, userId, path });
    const lesson = requireProjectedLesson(projected, lessonId);
    const exercise = requireProjectedExercise(lesson, exerciseId);
    const completedAccess = exercise.state === "completed" && (forHistory || isLearningPathExerciseRepeatable(exercise));
    if (exercise.state === "locked" || (!completedAccess && exercise.progress?.status !== "in_progress") || !exercise.progress?.startedAt) throw new ConflictError("LEARNING_PATH_EXERCISE_NOT_STARTED", "Start the exercise before opening this conversation.");
    if (typeof slideId !== "string" || !slideId || slideId.length > 160 || exercise.type !== SLIDE_SEQUENCE_TYPE) throw new ValidationError("CONVERSATION_INVALID_SLIDE", "A configured conversation slide is required.");
    const slide = resolveSlideSequenceDefinition(exercise).slides.find((item) => item.id === slideId);
    if (slide?.type !== "adaptive-conversation") throw new ValidationError("CONVERSATION_INVALID_SLIDE", "A configured conversation slide is required.");
    const config = parseConversationDefinition(slide.data);
    return { pathId: path.id, lessonId: lesson.id, exerciseId: exercise.id, slideId: slide.id, exerciseStartedAt: new Date(exercise.progress.startedAt).toISOString(), pathContentVersion: path.contentVersion, config, contentVersion: this.hashFactory(JSON.stringify({ pathVersion: path.contentVersion, config })) };
  }
}
