import { AuthenticationError } from "../../domain/errors.js";
import { User } from "../../domain/user/User.js";

export class LoginUser {
  constructor({ userRepository, passwordHasher }) {
    this.userRepository = userRepository;
    this.passwordHasher = passwordHasher;
  }

  async execute({ email, password }) {
    const normalizedEmail = User.normalizeEmail(email);

    if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72) {
      throw new AuthenticationError("INVALID_CREDENTIALS", "Email or password is incorrect.");
    }

    const user = await this.userRepository.findByEmail(normalizedEmail);
    const isValid = user && (await this.passwordHasher.compare(password, user.passwordHash));

    if (!isValid) {
      throw new AuthenticationError("INVALID_CREDENTIALS", "Email or password is incorrect.");
    }

    return user.toPublic();
  }
}
