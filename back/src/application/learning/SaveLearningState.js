import { LearningState } from "../../domain/learning/LearningState.js";
import { ValidationError } from "../../domain/errors.js";

export class SaveLearningState {
  constructor({ learningStateRepository }) {
    this.learningStateRepository = learningStateRepository;
  }

  async execute(userId, stateInput, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ValidationError(
        "INVALID_REVISION",
        "Revision must be a non-negative safe integer."
      );
    }

    const state = new LearningState(stateInput);
    const revision = await this.learningStateRepository.save(
      userId,
      state.value,
      expectedRevision
    );
    return { state: state.value, revision };
  }
}
