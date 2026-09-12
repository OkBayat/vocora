import { LocalTextInferenceWorker } from "../local-text-inference/LocalTextInferenceWorker.js";
import { WritingFeedbackError } from "../../domain/writing-feedback/WritingFeedbackError.js";

export function writingFeedbackHandler(provider, enabled) {
  return { provider, enabled, prefix: "WRITING_FEEDBACK", isSafeError: (error) => error instanceof WritingFeedbackError,
    evaluate: (record, signal) => provider.evaluate({ draftText: record.draftText, draftVersion: record.id, taskContext: record.taskContext, contentVersion: record.contentVersion, locale: "en", signal }) };
}
/** Compatibility facade for isolated Writing consumers. Production uses one shared worker. */
export class WritingFeedbackWorker extends LocalTextInferenceWorker {
  constructor({ repository, provider, enabled = false, ...options }) {
    super({ ...options, handlers: { "writing-feedback": writingFeedbackHandler(provider, enabled) }, repository: {
      purgeExpired: (...args) => repository.purgeExpired(...args),
      claim: async ({ evaluationProfiles, ...args }) => {
        const record = await repository.claim({ ...args, evaluationProfile: evaluationProfiles["writing-feedback"] });
        return record ? { ...record, kind: "writing-feedback" } : null;
      },
      isClaimCurrent: async ({ userId, id, leaseToken, now }) => {
        if (repository.isClaimCurrent) return repository.isClaimCurrent({ userId, id, leaseToken, now });
        // Legacy isolated test ports predate the recheck. MySQL always exposes
        // findOwned; production uses the shared queue's stricter gate recheck.
        if (!repository.findOwned) return true;
        const row = await repository.findOwned(userId, id);
        return row?.status === "running" && row.leaseToken === leaseToken
          && (!row.leaseUntil || Date.parse(row.leaseUntil) > Date.parse(now));
      },
      finish: ({ kind: _kind, applyConversationResult: _apply, ...args }) => repository.finish(args),
    } });
  }
}
