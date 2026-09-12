import { ConflictError, NotFoundError, ValidationError } from "../../domain/errors.js";
import { MAXIMUM_PILOT_WORDS } from "../../domain/writing-feedback/WritingFeedbackTask.js";
import { canonicalWritingFeedbackJson } from "./writingFeedbackIdentity.js";

export const WRITING_FEEDBACK_LIMITS = Object.freeze({ maxWords: MAXIMUM_PILOT_WORDS, maxCharacters: 2000 });
const REQUEST_FIELDS = new Set(["expectedPathContentVersion", "draftText", "notes", "idempotencyKey", "parentSubmissionId"]);

function validateInput(value) {
  const valid = value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => REQUEST_FIELDS.has(key))
    && Number.isSafeInteger(value.expectedPathContentVersion) && value.expectedPathContentVersion > 0
    && typeof value.draftText === "string" && value.draftText.trim().length > 0
    && value.draftText.length <= WRITING_FEEDBACK_LIMITS.maxCharacters
    && (value.notes === undefined || (typeof value.notes === "string" && value.notes.length <= 2000))
    && typeof value.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,100}$/u.test(value.idempotencyKey)
    && (value.parentSubmissionId === undefined || (typeof value.parentSubmissionId === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value.parentSubmissionId)));
  if (!valid) throw new ValidationError("INVALID_WRITING_FEEDBACK_REQUEST", "Provide a bounded draft, optional notes and revision parent, and a stable idempotency key.");
  return { expectedPathContentVersion: value.expectedPathContentVersion, draftText: value.draftText, notes: value.notes ?? "", idempotencyKey: value.idempotencyKey, parentSubmissionId: value.parentSubmissionId ?? null };
}

function admissionError(enabled, draftText) {
  if (!enabled) return "WRITING_FEEDBACK_DISABLED";
  if (draftText.trim().split(/\s+/u).length > WRITING_FEEDBACK_LIMITS.maxWords) return "WRITING_FEEDBACK_INPUT_LIMIT";
  return null;
}

function submissionDto(record) {
  return {
    id: record.id,
    status: record.status,
    draftText: record.draftText,
    notes: record.notes ?? "",
    parentSubmissionId: record.parentSubmissionId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    feedback: record.result ?? null,
    errorCode: record.errorCode ?? null,
    attemptCount: record.attemptCount,
    contentVersion: record.contentVersion,
  };
}

export class WritingFeedback {
  constructor({ repository, taskResolver, enabled = false, retentionDays = 30, idFactory, hashFactory, clock = () => new Date(), cancelWork = () => {}, evaluationProfile = null }) {
    Object.assign(this, { repository, taskResolver, enabled, retentionDays, idFactory, hashFactory, clock, cancelWork, evaluationProfile });
  }

  async submit(userId, pathId, lessonId, exerciseId, slideId, rawInput) {
    const input = validateInput(rawInput);
    const context = await this.taskResolver.execute(userId, pathId, lessonId, exerciseId, slideId);
    if (input.expectedPathContentVersion !== context.pathContentVersion) {
      throw new ConflictError("WRITING_FEEDBACK_CONTENT_CHANGED", "The writing task changed. Reload it before saving this draft.");
    }
    const now = this.clock().toISOString();
    const errorCode = admissionError(this.enabled, input.draftText, context.taskContext);
    const record = {
      id: this.idFactory(), userId, ...context, ...input, evaluationProfile: this.evaluationProfile,
      requestHash: this.hashFactory(JSON.stringify({ pathId: context.pathId, lessonId: context.lessonId, exerciseId: context.exerciseId, slideId: context.slideId, exerciseStartedAt: context.exerciseStartedAt, contentVersion: context.contentVersion, evaluationProfile: canonicalWritingFeedbackJson(this.evaluationProfile), ...input })),
      status: errorCode ? "unavailable" : "queued", errorCode, result: null,
      attemptCount: 0, createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.parse(now) + this.retentionDays * 86_400_000).toISOString(),
    };
    return { submission: submissionDto(await this.repository.enqueue(record, { now })) };
  }

  async list(userId, pathId, lessonId, exerciseId, slideId) {
    const context = await this.taskResolver.execute(userId, pathId, lessonId, exerciseId, slideId, { forHistory: true });
    const records = await this.repository.listOwned(userId, {
      exerciseId: context.exerciseId, slideId: context.slideId, exerciseStartedAt: context.exerciseStartedAt,
    }, 10);
    const now = this.clock().getTime();
    return {
      currentContentVersion: context.contentVersion,
      pathContentVersion: context.pathContentVersion,
      availability: { enabled: this.enabled, ...WRITING_FEEDBACK_LIMITS },
      submissions: records.filter((record) => Date.parse(record.expiresAt) > now).map(submissionDto),
    };
  }

  async owned(userId, id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/u.test(id)) throw new NotFoundError("WRITING_FEEDBACK_NOT_FOUND", "Writing submission was not found.");
    const record = await this.repository.findOwned(userId, id);
    if (!record || Date.parse(record.expiresAt) <= this.clock().getTime()) throw new NotFoundError("WRITING_FEEDBACK_NOT_FOUND", "Writing submission was not found.");
    return record;
  }

  async get(userId, id) {
    return { submission: submissionDto(await this.owned(userId, id)) };
  }

  async retry(userId, id) {
    const record = await this.owned(userId, id);
    if (admissionError(this.enabled, record.draftText, record.taskContext)) return { submission: submissionDto(record) };
    return { submission: submissionDto(await this.repository.retryOwned(userId, id, { now: this.clock().toISOString() })) };
  }

  async cancel(userId, id) {
    await this.owned(userId, id);
    const record = await this.repository.cancelOwned(userId, id, this.clock().toISOString());
    this.cancelWork(id);
    return { submission: submissionDto(record) };
  }

  async delete(userId, id) {
    await this.owned(userId, id);
    if (!await this.repository.deleteOwned(userId, id)) throw new NotFoundError("WRITING_FEEDBACK_NOT_FOUND", "Writing submission was not found.");
    this.cancelWork(id);
  }
}
