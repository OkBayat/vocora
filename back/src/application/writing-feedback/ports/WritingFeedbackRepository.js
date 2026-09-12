// All snapshots are immutable. Mutations only change lifecycle, lease and feedback fields.
// An unbound evaluation profile may be assigned once, atomically with the first worker claim.
// A lease is global and survives cancellation/deletion until its worker finishes or expires.
export class WritingFeedbackRepository {
  async enqueue(_record, _options = {}) { throw new Error("WritingFeedbackRepository.enqueue is not implemented."); }
  async findOwned(_userId, _id) { throw new Error("WritingFeedbackRepository.findOwned is not implemented."); }
  async listOwned(_userId, _scope, _limit = 10) { throw new Error("WritingFeedbackRepository.listOwned is not implemented."); }
  async claim(_options) { throw new Error("WritingFeedbackRepository.claim is not implemented."); }
  async finish(_options) { throw new Error("WritingFeedbackRepository.finish is not implemented."); }
  async retryOwned(_userId, _id, _options = {}) { throw new Error("WritingFeedbackRepository.retryOwned is not implemented."); }
  async cancelOwned(_userId, _id, _now) { throw new Error("WritingFeedbackRepository.cancelOwned is not implemented."); }
  async deleteOwned(_userId, _id) { throw new Error("WritingFeedbackRepository.deleteOwned is not implemented."); }
  async purgeExpired(_now, _limit = 100) { throw new Error("WritingFeedbackRepository.purgeExpired is not implemented."); }
}
