// Immutable session/task snapshots surround a bounded, revisioned private state aggregate.
// Mutation callbacks are synchronous; provider and speech calls run outside transactions.
export class ConversationRepository {
  async create(_record, _options = {}) { throw new Error("ConversationRepository.create is not implemented."); }
  async findOwned(_userId, _id) { throw new Error("ConversationRepository.findOwned is not implemented."); }
  async listOwned(_userId, _scope, _limit = 5) { throw new Error("ConversationRepository.listOwned is not implemented."); }
  async mutateOwned(_userId, _id, _expectedRevision, _transform, _options = {}) { throw new Error("ConversationRepository.mutateOwned is not implemented."); }
  async retryJobOwned(_userId, _sessionId, _turnId, _options = {}) { throw new Error("ConversationRepository.retryJobOwned is not implemented."); }
  async cancelOwned(_userId, _id, _options = {}) { throw new Error("ConversationRepository.cancelOwned is not implemented."); }
  async deleteOwned(_userId, _id) { throw new Error("ConversationRepository.deleteOwned is not implemented."); }
  async purgeExpired(_now, _limit = 100) { throw new Error("ConversationRepository.purgeExpired is not implemented."); }
  async findCompletionEvidence(_userId, _ids) { throw new Error("ConversationRepository.findCompletionEvidence is not implemented."); }
}
