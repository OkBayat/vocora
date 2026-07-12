export class GetLearningState {
  constructor({ learningStateRepository }) {
    this.learningStateRepository = learningStateRepository;
  }

  async execute(userId) {
    return this.learningStateRepository.findByUserId(userId);
  }
}
