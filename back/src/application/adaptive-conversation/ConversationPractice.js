import { AppError, NotFoundError } from "../../domain/errors.js";
import { conversationCanFinish, conversationDto, conversationError, conversationInput, conversationReceipt, createConversationState, requireConversationActive } from "./conversationState.js";

export class ConversationPractice {
  constructor({ repository, taskResolver, enabled = false, retentionDays = 30, idFactory, hashFactory, clock = () => new Date(), evaluationProfile = null, cancelSessionWork = () => {} }) {
    Object.assign(this, { repository, taskResolver, enabled, retentionDays, idFactory, hashFactory, clock, evaluationProfile, cancelSessionWork });
  }
  now() { return this.clock().toISOString(); }
  requireEnabled() { if (!this.enabled) throw new AppError(503, "CONVERSATION_DISABLED", "Conversation practice is currently unavailable."); }
  response(record) { return { session: conversationDto(record, this.now()), availability: { enabled: this.enabled } }; }
  async owned(userId, id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new NotFoundError("CONVERSATION_NOT_FOUND", "Conversation was not found.");
    const record = await this.repository.findOwned(userId, id);
    if (!record || Date.parse(record.expiresAt) <= Date.parse(this.now())) throw new NotFoundError("CONVERSATION_NOT_FOUND", "Conversation was not found.");
    return record;
  }
  async start(userId, pathId, lessonId, exerciseId, slideId, rawInput) {
    const input = conversationInput(rawInput, ["expectedPathContentVersion", "idempotencyKey"], ["expectedPathContentVersion", "idempotencyKey"]);
    this.requireEnabled();
    const context = await this.taskResolver.execute(userId, pathId, lessonId, exerciseId, slideId);
    if (input.expectedPathContentVersion !== context.pathContentVersion) throw conversationError("CONTENT_CHANGED", "The conversation task changed. Reload it before starting.");
    const now = this.now();
    const record = { id: this.idFactory(), userId, ...context, idempotencyKey: input.idempotencyKey, requestHash: this.hashFactory(JSON.stringify({ ...context, ...input, evaluationProfile: this.evaluationProfile })), evaluationProfile: this.evaluationProfile, createdAt: now, expiresAt: new Date(Date.parse(now) + this.retentionDays * 86400000).toISOString(), state: createConversationState(context.config, this.idFactory(), now) };
    return this.response(await this.repository.create(record, { now }));
  }
  async list(userId, pathId, lessonId, exerciseId, slideId) {
    const context = await this.taskResolver.execute(userId, pathId, lessonId, exerciseId, slideId, { forHistory: true });
    const records = await this.repository.listOwned(userId, { exerciseId: context.exerciseId, slideId: context.slideId, exerciseStartedAt: context.exerciseStartedAt }, 5);
    return { pathContentVersion: context.pathContentVersion, currentContentVersion: context.contentVersion, availability: { enabled: this.enabled }, sessions: records.filter((row) => Date.parse(row.expiresAt) > Date.parse(this.now())).map((row) => conversationDto(row, this.now())) };
  }
  async get(userId, id) { return this.response(await this.owned(userId, id)); }
  async finish(userId, id, rawInput) {
    const input = conversationInput(rawInput, ["expectedSessionRevision"], ["expectedSessionRevision"]);
    const existing = await this.owned(userId, id);
    if (existing.state.status === "completed" && existing.state.completionEvidenceId) return this.response(existing);
    const now = this.now();
    const record = await this.repository.mutateOwned(userId, id, input.expectedSessionRevision, (current) => {
      requireConversationActive(current, now);
      if (!conversationCanFinish(current, now)) throw conversationError("COMPLETION_NOT_READY", "Complete the required conversation turns before finishing.");
      const evidenceId = this.idFactory();
      return { state: { ...current.state, status: "completed", completionEvidenceId: evidenceId }, completion: conversationReceipt(current, evidenceId, now) };
    }, { now });
    return this.response(record);
  }
  async cancel(userId, id) {
    await this.owned(userId, id);
    const record = await this.repository.cancelOwned(userId, id, { now: this.now() });
    await this.cancelSessionWork(id);
    if (!record) throw new NotFoundError("CONVERSATION_NOT_FOUND", "Conversation was not found.");
    return this.response(record);
  }
  async delete(userId, id) {
    await this.owned(userId, id);
    if (!await this.repository.deleteOwned(userId, id)) throw new NotFoundError("CONVERSATION_NOT_FOUND", "Conversation was not found.");
    await this.cancelSessionWork(id);
  }
}
