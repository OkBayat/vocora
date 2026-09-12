import { createHash } from "node:crypto";
import { parseConversationDefinition } from "../../../domain/adaptive-conversation/ConversationDefinition.js";
import {
  resolveSlideSequenceDefinition,
  verifySlideSequenceCompletion,
} from "../../../domain/collection-learning-path/SlideSequenceExercise.js";

export class VerifySlideSequenceCompletion {
  constructor({ vocabularyReader, recordingArtifactRepository, conversationRepository }) {
    this.vocabularyReader = vocabularyReader;
    this.conversationRepository = conversationRepository;
    this.recordingArtifactRepository = recordingArtifactRepository;
  }

  async execute({ userId, path, lesson, exercise, outcome }) {
    const definition = resolveSlideSequenceDefinition(exercise);
    const scoped = definition.scope
      ? await this.vocabularyReader.findForScope(userId, definition.scope)
      : null;
    const rawResults = outcome?.evidence?.results;
    if (!Array.isArray(rawResults) || rawResults.length > 1000) return false;
    const artifactIds = rawResults
      .filter((result) => result?.slideType === "speaking-response")
      .map((result) => String(result?.data?.recordingArtifactId ?? "").trim())
      .filter(Boolean);
    if (artifactIds.some((id) => id.length > 64)) return false;
    const artifacts = artifactIds.length > 0
      ? await this.recordingArtifactRepository.findByPublicIds(userId, artifactIds)
      : [];
    const conversationIds = [...new Set(rawResults.filter((result) => result?.slideType === "adaptive-conversation")
      .map((result) => result?.data?.conversationEvidenceId))];
    if (conversationIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(id))) return false;
    if (conversationIds.length && (!this.conversationRepository || !path || !lesson)) return false;
    const receipts = conversationIds.length ? await this.conversationRepository.findCompletionEvidence(userId, conversationIds) : [];
    const versions = new Map(definition.slides.filter((slide) => slide.type === "adaptive-conversation").map((slide) =>
      [slide.id, createHash("sha256").update(JSON.stringify({ pathVersion: path?.contentVersion, config: parseConversationDefinition(slide.data) })).digest("hex")]));
    const conversationEvidence = new Map(receipts.filter((receipt) => receipt.contentVersion === versions.get(receipt.slideId)).map((receipt) => [receipt.id, receipt]));
    return verifySlideSequenceCompletion(exercise, outcome, scoped?.items ?? [], {
      userId,
      pathId: path?.id,
      lessonId: lesson?.id,
      conversationEvidence,
      exerciseId: exercise.id,
      exerciseStartedAt: exercise.progress?.startedAt,
      recordingArtifacts: new Map(artifacts.map((artifact) => [artifact.publicId, artifact])),
    });
  }
}
