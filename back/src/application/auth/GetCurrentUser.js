import { AuthenticationError } from "../../domain/errors.js";

export class GetCurrentUser {
  constructor({ userRepository }) {
    this.userRepository = userRepository;
  }

  async execute(userId) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new AuthenticationError();
    }
    return user.toPublic();
  }
}
